# Agent Credential Broker + Proxy

Local credential broker and mitmproxy-based egress proxy for running autonomous agents
(e.g. Claude Code) in a dev container without exposing long-lived credentials to the
agent's process.

## Quick start

1. Complete the [Prerequisites](#prerequisites) below (GitHub App + credential files).
2. Copy `.devcontainer/.env.example` to `.devcontainer/.env` and fill in `GITHUB_APP_ID` and `GITHUB_APP_INSTALLATION_ID`.
3. Open this repo in VSCode → "Reopen in Container".
4. Run the smoke test: `./scripts/smoke-test.sh`

## How it works

```
┌─────────────────────────────────────────┐
│            Dev Container                │
|       (Claude Code, git, gh)            │
│  HTTPS_PROXY=http://proxy:8080          │  network: dev
│  GIT_CREDENTIAL_URL=cred-gateway        │
│  No credentials, no .env, no API keys   │
└────┬─────────────────────────┬──────────┘
     │ HTTPS (intercepted)     │ git creds, etc.
     ▼                         ▼
┌──────────────┐   ┌─────────────────────┐
│    Proxy     │   │   Cred Gateway      │
│  mitmproxy   │   │  nginx, whitelist:  │
│  + addons    │   │  /github/credential │
│              │   │  /github/identity   │
└──────┬───────┘   └──────────┬──────────┘
       │                      │
       │   network: secure    │
       │   (no dev access)    │
       ▼                      ▼
┌─────────────────────────────────────────┐
│               Broker                    │
│  - Reads .pem / api keys from /secrets  │
│  - Mints GitHub installation tokens     │
│  - Mints Cloudflare scoped tokens       │
│  - /anthropic/key reachable only by     │
│    proxy on `secure` network            │
└────────────────┬────────────────────────┘
                 │
                 ▼
      ┌───────────────────────────────────────┐
      │                 Host                  │
      │  ~/.config/secure-dev-for-agent/      │
      │  credentials → broker  (read-only)    │
      │  allowlist.txt → proxy (read-only)    │
      └───────────────────────────────────────┘
```

Two networks keep credentials out of the dev container:

- `secure` — broker, proxy, cred-gateway. The dev container is **not** on this network.
- `dev` — dev, proxy, cred-gateway. Used by dev to reach the proxy (HTTPS) and the gateway (git credentials).

The broker is on `secure` only. The dev container cannot reach it by hostname or IP. The only broker-adjacent endpoints reachable from the dev container are the two paths nginx explicitly whitelists in `cred-gateway`.

## Prerequisites

### GitHub App setup

Create a GitHub App with the following **repository permissions** (minimum):

- Contents: Read & Write
- Metadata: Read (auto-included)
- Pull requests: Read & Write
- Issues: Read & Write (if your agent files issues)
- Workflows: Read & Write (only if the agent edits `.github/workflows/`)

No webhook required.

**Steps**:

1. GitHub → Settings → Developer settings → GitHub Apps → New GitHub App
2. Generate a private key and download the `.pem` file
3. Note the **App ID** (visible on the App's settings page)
4. Install the App on the org/account where you want it to act: "Install App" tab → choose target → choose repos
5. After install, note the **Installation ID**: it's the trailing number in the URL, e.g. `https://github.com/settings/installations/78901234` → ID is `78901234`. Or run `gh api /app/installations` once authenticated as the App.
6. The App must be installed on **every** repo the agent will touch.

### Credential files and allowlist

```bash
mkdir -p ~/.config/secure-dev-for-agent
chmod 700 ~/.config/secure-dev-for-agent

# GitHub App private key
cp /path/to/your-app.private-key.pem ~/.config/secure-dev-for-agent/github-app.pem

# Anthropic API key (single line, no trailing newline — use printf)
# space before command to prevent history (in most shells)
 printf 'sk-ant-...' > ~/.config/secure-dev-for-agent/anthropic.key
# or use read -rs
# read -rs KEY && printf '%s' "$KEY" > ~/.config/secure-dev-for-agent/anthropic.key

# Cloudflare token with "User API Tokens:Edit" permission (only needed if using Cloudflare)
# space before command to prevent history (in most shells)
 printf '...' > ~/.config/secure-dev-for-agent/cloudflare-minter.token
# or use read -rs
# read -rs KEY && printf '%s' "$KEY" > ~/.config/secure-dev-for-agent/cloudflare-minter.token

chmod 600 ~/.config/secure-dev-for-agent/*

# Proxy allowlist — controls which external domains the proxy will forward to.
# Copy the template from the repo and customise as needed.
cp .devcontainer/allowlist.txt ~/.config/secure-dev-for-agent/allowlist.txt
```

If `allowlist.txt` is absent the proxy starts in permissive mode (all destinations allowed) and logs a warning. Add or remove domains and restart the proxy to apply changes:

```bash
docker compose -f .devcontainer/compose.yaml restart proxy
```

### `.devcontainer/.env`

```
GITHUB_APP_ID=123456
GITHUB_APP_INSTALLATION_ID=78901234
```

This file must live in `.devcontainer/` alongside `compose.yaml`. Docker Compose resolves `.env` relative to the compose file, so a `.env` at the repo root is not picked up — including when VSCode's "Reopen in Container" triggers the compose stack.

## Operations

- Logs: `docker compose -f .devcontainer/compose.yaml logs -f broker proxy cred-gateway`
- Teardown: `docker compose -f .devcontainer/compose.yaml down -v`
- Recovery (if setup failed): re-run `/workspace/.devcontainer/dev/setup.sh` from inside the container

### Rotating the GitHub App private key

1. On the host: replace `~/.config/secure-dev-for-agent/github-app.pem` with the new key
2. `docker compose -f .devcontainer/compose.yaml restart broker`
3. Wait up to 5 minutes for proxy token caches to expire, OR restart the proxy immediately:
   `docker compose -f .devcontainer/compose.yaml restart proxy`

### Rotating the Anthropic API key

1. On the host: overwrite `~/.config/secure-dev-for-agent/anthropic.key` with the new key (use `printf`, not `echo`, to avoid a trailing newline)
2. `docker compose -f .devcontainer/compose.yaml restart broker proxy`
   (proxy restart is needed because the proxy caches the key for 5 minutes)

### Rotating the Cloudflare minter token

1. Create a new minter token in the Cloudflare dashboard (User API Tokens:Edit permission)
2. Replace `~/.config/secure-dev-for-agent/cloudflare-minter.token` on the host
3. `docker compose -f .devcontainer/compose.yaml restart broker`
4. Existing scoped tokens minted by the old minter remain valid until their `expires_on`

### Rotating the mitmproxy CA cert

The CA cert is persisted in the `proxy-certs` named volume. To force regeneration:

```bash
docker compose -f .devcontainer/compose.yaml down
docker volume rm agent-dev_proxy-certs
docker compose -f .devcontainer/compose.yaml up -d
```

Then rebuild the dev container in VSCode ("Dev Containers: Rebuild Container") so `postCreateCommand` reinstalls the new cert.

# Testing/Troubleshooting

## The architecture

```
[dev container]
	|
 [dev]          ← the VS Code workspace container
 [proxy]        ← mitmproxy intercepts all outbound traffic, injects credentials
 [broker]       ← holds secrets, issues tokens on demand
 [cred-gateway] ← nginx, exposes GitHub credentials/identity to dev container
```

## Logs

Any HTTPS request that reaches the proxy but isn't in the allowlist is logged. Since all HTTP/HTTPS traffic is forced through the proxy via iptables, this is the log for discovering which domains to allow.

To see blocked domains, run (outside the container):

```bash
docker compose -f .devcontainer/compose.yaml logs proxy | grep BLOCKED
```

Or tail it live while triggering your workflow:

```bash
docker compose -f .devcontainer/compose.yaml logs -f proxy | grep BLOCKED
```

The output will look like:

```bash
allowlist: BLOCKED CONNECT api.someservice.com
```

That host is what you add to your `~/.config/secure-dev-for-agent/allowlist.txt`, then restart the proxy:

```bash
docker compose -f .devcontainer/compose.yaml restart proxy
```

Note: iptables only blocks traffic that tries to bypass the proxy entirely (non-HTTP protocols, raw TCP to external IPs). Since it REJECTs rather than DROPs, those failures return immediately rather than timing out — but they won't appear in any log file without adding a LOG rule.

## What you can test individually

1. `broker` — build and smoke-test the HTTP server

```bash
cd .devcontainer
docker build -t test-broker ./broker
# Run without real secrets to verify it starts and /healthz responds:
docker run --rm \
-e GITHUB_APP_ID=dummy \
-e GITHUB_APP_INSTALLATION_ID=dummy \
-e GITHUB_APP_PRIVATE_KEY_PATH=/dev/null \
-e ANTHROPIC_API_KEY_PATH=/dev/null \
-e CLOUDFLARE_MINTER_TOKEN_PATH=/dev/null \
-p 8080:8080 test-broker
# test healthz
curl http://localhost:8080/healthz
```

2. `proxy` — build and verify mitmproxy starts

```bash
cd .devcontainer
docker build -t test-proxy ./proxy
# --user mitmproxy
docker run --rm -v $PWD/proxy/addons:/addons:ro -e BROKER_URL=http://localhost:9999 test-proxy
# Check that the CA cert gets generated:
docker exec $(docker ps -q --filter ancestor=test-proxy) ls /home/mitmproxy/.mitmproxy/
```

3. `cred-gateway` — validate config, then verify the whitelist/deny rules

```bash
cd .devcontainer
# Validate nginx config syntax (--add-host needed: nginx resolves upstream hostnames at test time)
docker run --rm \
  --add-host broker:127.0.0.1 \
  -v $PWD/cred-gateway/nginx.conf:/etc/nginx/conf.d/default.conf:ro \
  nginx:alpine nginx -t

# Run it and test the whitelist (broker absence causes 502 on proxied routes, which is expected)
docker run --rm -d --name test-cred-gateway \
  --add-host broker:127.0.0.1 \
  -v $PWD/cred-gateway/nginx.conf:/etc/nginx/conf.d/default.conf:ro \
  -p 8081:80 nginx:alpine

# /healthz → 200 (nginx handles this directly, no broker needed)
curl -s -o /dev/null -w "%{http_code}" http://localhost:8081/healthz

# /anthropic/key → 403 (nginx deny rule — proves whitelist is enforced without broker)
curl -s -o /dev/null -w "%{http_code}" http://localhost:8081/anthropic/key

# /github/token → 403 (only /github/credential is whitelisted, not /github/token)
curl -s -o /dev/null -w "%{http_code}" http://localhost:8081/github/token

# /github/credential → 502 (whitelisted, but broker unreachable — expected in isolation)
curl -s -o /dev/null -w "%{http_code}" http://localhost:8081/github/credential

docker stop test-cred-gateway
```

4. `dev` — build the workspace image and verify installed tools

```bash
cd .devcontainer
docker build -t test-dev ./dev

# Verify the tools baked into the image are present
docker run --rm test-dev gh --version
docker run --rm test-dev wrangler --version
docker run --rm test-dev jq --version
docker run --rm test-dev node --version

# Verify the vscode user exists (devcontainer.json sets remoteUser: vscode)
docker run --rm test-dev id vscode
```

5. **Full stack without VS Code** — run `docker compose` directly from the `.devcontainer` dir:

```bash
cd .devcontainer
GITHUB_APP_ID=x GITHUB_APP_INSTALLATION_ID=x docker compose up --build -d

# All four services should reach "healthy" (broker, proxy, cred-gateway) or "running" (dev)
docker compose ps

# Network isolation: broker must NOT be reachable from the dev container
docker compose exec dev curl --max-time 2 http://broker:8080/healthz
# → curl: (6) Could not resolve host / (28) Connection timed out — both are correct

# proxy policy must block tunnelled requests to broker (policy.py)
docker compose exec dev curl -s -o /dev/null -w "%{http_code}" \
  --proxy http://proxy:8080 http://broker:8080/healthz
# → 403

# cred-gateway healthz (nginx-native, no broker call)
docker compose exec dev curl -sf http://cred-gateway/healthz
# → ok

# cred-gateway must deny endpoints that would expose raw credentials
docker compose exec dev curl -s -o /dev/null -w "%{http_code}" http://cred-gateway/anthropic/key
# → 403
docker compose exec dev curl -s -o /dev/null -w "%{http_code}" http://cred-gateway/github/token
# → 403

# cred-gateway must allow whitelisted endpoints (502 expected — dummy creds can't mint a real token)
docker compose exec dev curl -s -o /dev/null -w "%{http_code}" http://cred-gateway/github/credential
# → 502

# Tear down when done
docker compose down -v
# To delete volumes and images (or restart from scratch, good when making changes and ensuring everything is up-to-date when re-running)
# docker compose -f .devcontainer/compose.yaml down  --rmi all -v
```

With real credentials configured (`.devcontainer/.env` + `~/.config/secure-dev-for-agent/`), run `./scripts/smoke-test.sh` from inside the dev container for end-to-end validation including live API calls.

The `dev` container's `setup.sh` and `setup-start.sh` scripts are also independently runnable if you exec into a running `dev` container.
