#!/bin/bash
# Block direct external connections from the dev container.
# All outbound traffic must go through mitmproxy on the Docker dev network.
# Runs as root (via sudo) on every container start; safe to re-run.
set -euo pipefail
IFS=$'\n\t'

echo "[firewall] saving Docker DNS NAT rules..."
DOCKER_DNS_RULES=$(iptables-save -t nat | grep "127\.0\.0\.11" || true)

echo "[firewall] flushing existing rules..."
iptables -F
iptables -X
iptables -t nat -F
iptables -t nat -X
iptables -t mangle -F
iptables -t mangle -X
ipset destroy agent-devnet 2>/dev/null || true

echo "[firewall] restoring Docker DNS NAT rules..."
if [ -n "$DOCKER_DNS_RULES" ]; then
    iptables -t nat -N DOCKER_OUTPUT     2>/dev/null || true
    iptables -t nat -N DOCKER_POSTROUTING 2>/dev/null || true
    echo "$DOCKER_DNS_RULES" | xargs -L 1 iptables -t nat
fi

# Detect the Docker dev network CIDR from the default-route interface.
IFACE=$(ip route show default | awk '{print $5; exit}')
DOCKER_NET=$(ip -4 addr show "$IFACE" | awk '/inet / {print $2; exit}')
[ -n "$DOCKER_NET" ] || { echo "[firewall] ERROR: cannot detect Docker network on $IFACE"; exit 1; }
echo "[firewall] Docker dev network: $DOCKER_NET (iface: $IFACE)"

ipset create agent-devnet hash:net
ipset add agent-devnet "$DOCKER_NET"

# Default-DROP policy — nothing gets through unless an explicit rule allows it.
iptables -P INPUT   DROP
iptables -P FORWARD DROP
iptables -P OUTPUT  DROP

# Loopback: required for Docker's embedded DNS resolver at 127.0.0.11.
iptables -A INPUT  -i lo -j ACCEPT
iptables -A OUTPUT -o lo -j ACCEPT

# Allow already-established connections (responses to permitted outbound).
iptables -A INPUT  -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT

# Allow all traffic within the Docker dev network (reaches proxy + cred-gateway).
# External internet access goes through the proxy, not directly from this container.
iptables -A INPUT  -m set --match-set agent-devnet src -j ACCEPT
iptables -A OUTPUT -m set --match-set agent-devnet dst -j ACCEPT

# Explicit REJECT gives immediate feedback instead of a silent timeout.
iptables -A OUTPUT -j REJECT --reject-with icmp-admin-prohibited

echo "[firewall] verifying direct external connections are blocked..."
# --noproxy '*' bypasses the HTTPS_PROXY env var so we test a raw connection.
if curl --connect-timeout 3 --noproxy '*' -s https://1.1.1.1 >/dev/null 2>&1; then
    echo "[firewall] ERROR: direct external connection succeeded — rules not working"
    exit 1
fi
echo "[firewall] OK: direct external connections are blocked"
echo "[firewall] done."
