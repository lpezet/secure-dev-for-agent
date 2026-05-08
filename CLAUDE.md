# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A VSCode dev container setup that runs autonomous agents (Claude Code) without exposing long-lived credentials to the agent's process. The agent's outbound HTTPS traffic is intercepted by mitmproxy, which injects credentials fetched from a broker the agent cannot reach directly.

## Commands

**Bring up the full stack (from repo root, outside the container):**
```bash
docker compose -f .devcontainer/compose.yaml up --build
```

**Smoke test — run inside the dev container after opening in VSCode:**
```bash
./scripts/smoke-test.sh
```

**Logs:**
```bash
docker compose -f .devcontainer/compose.yaml logs -f broker proxy cred-gateway
```

**Teardown (removes named volumes including the mitmproxy CA cert):**
```bash
docker compose -f .devcontainer/compose.yaml down -v
```

**Rebuild and test a single service image:**
```bash
# From repo root
docker build -t test-broker .devcontainer/broker
docker build -t test-proxy .devcontainer/proxy
docker build -t test-dev .devcontainer/dev
```

**Validate nginx config without running a container:**
```bash
docker run --rm \
  -v $PWD/.devcontainer/cred-gateway/nginx.conf:/etc/nginx/conf.d/default.conf:ro \
  nginx:alpine nginx -t
```

**Recovery if setup.sh failed mid-run (idempotent, run inside dev container):**
```bash
/workspace/.devcontainer/dev/setup.sh
```

**Restart a service after rotating a credential:**
```bash
docker compose -f .devcontainer/compose.yaml restart broker
docker compose -f .devcontainer/compose.yaml restart broker proxy  # for Anthropic key rotation
```

**Force-regenerate the mitmproxy CA cert:**
```bash
docker compose -f .devcontainer/compose.yaml down
docker volume rm agent-dev_proxy-certs
docker compose -f .devcontainer/compose.yaml up -d
# Then: Dev Containers: Rebuild Container in VSCode
```

**Debug the proxy with a web UI (swap into proxy/Dockerfile CMD temporarily):**
```
mitmweb --web-host 0.0.0.0 --web-port 8081 --listen-host 0.0.0.0 --listen-port 8080 ...
```
And publish port 8081 in compose.yaml.

## Architecture

```
[dev container]  ──HTTPS──►  [proxy: mitmproxy]  ──injects creds──►  external APIs
     │                              │
     │ git creds only               │ fetches creds from broker
     ▼                              ▼
[cred-gateway: nginx]  ──────►  [broker: Node.js]  ──reads──►  ~/.config/agent-creds/
```

**Two Docker networks enforce the security boundary:**

- `secure`: broker + proxy + cred-gateway. Dev container is **not** on this network.
- `dev`: dev + proxy + cred-gateway.

The broker is on `secure` only. Docker DNS will not resolve `broker` from within the dev container, and there is no route even if it did. The only broker-adjacent surface reachable from dev is the two nginx-whitelisted paths on cred-gateway.

### broker (`broker/server.js`)

Node.js HTTP server on `:8080`. Reads credentials from `/secrets` (bind-mounted from `~/.config/agent-creds/` on the host, read-only). Exposes:

| Path | Who calls it | Notes |
|---|---|---|
| `/github/token` | proxy `github.py` | Installation token, cached with 5-min safety window |
| `/github/credential` | cred-gateway → dev git helper | Same token in `git credential` format |
| `/github/identity` | cred-gateway → setup-start.sh | App name+email for `git config`, lifetime-cached |
| `/anthropic/key` | proxy `anthropic.py` | Reads key file on each uncached call |
| `/cloudflare/token?profile=` | proxy `cloudflare.py` | Mints scoped token via Cloudflare API, cached per profile |
| `/healthz` | Docker healthcheck | |

The broker makes direct outbound HTTPS calls to `api.github.com` and `api.cloudflare.com` — it does **not** go through the proxy. Routing through the proxy would be circular (proxy fetches creds from broker to authenticate outbound calls).

### proxy (`proxy/addons/`)

mitmproxy with four addons loaded in order:

- **`policy.py`** — blocks any request destined for `broker` or `cred-gateway` hostnames (defense-in-depth; Docker network isolation is the primary control)
- **`github.py`** — matches `api.github.com` and `uploads.github.com` only. Fetches token from broker, injects as `Authorization: token ...`. Strips whatever the client sent. **Does not match `github.com`** — git push/pull goes through the credential helper path, not here.
- **`anthropic.py`** — matches `api.anthropic.com`. Injects the API key. Blocks `/v1/organizations/*` (Admin API). Uses `responseheaders` hook + `flow.response.stream = True` for SSE to avoid buffering streamed responses.
- **`cloudflare.py`** — matches `api.cloudflare.com`. Injects a scoped token. Caller can hint a profile via `X-Cf-Profile` header (stripped before forwarding); defaults to `workers-deploy`.

All addons cache credentials with a 5-minute TTL (`cachetools.TTLCache`). A 401 from GitHub clears the cache immediately.

### cred-gateway (`cred-gateway/nginx.conf`)

nginx:alpine with two whitelisted paths:
- `GET /github/credential` — proxies to `broker:8080/github/credential`
- `GET /github/identity` — proxies to `broker:8080/github/identity`

Everything else returns 403. `/anthropic/key`, `/github/token`, and `/cloudflare/token` are intentionally not exposed — exposing them would allow the dev container to exfiltrate raw credentials.

### dev container (`dev/`)

Based on `mcr.microsoft.com/devcontainers/typescript-node:20`. Has `gh` CLI and `wrangler` pre-installed.

`setup.sh` (postCreateCommand, idempotent):
1. Installs the mitmproxy CA cert into the system trust store
2. Wires `git credential.helper` to `curl $GIT_CREDENTIAL_URL`
3. Forces `gh` to use HTTPS (not SSH) to prevent bypassing the proxy
4. Verifies broker is unreachable — exits non-zero if it is (security boundary broken)
5. Calls `setup-start.sh`

`setup-start.sh` (postStartCommand, runs on every restart):
1. Fetches GitHub App identity from cred-gateway and writes `git config user.name/email`
2. Smoke-checks that `gh api /rate_limit` works through the proxy

## Non-obvious invariants

**`GH_TOKEN=proxy-injected` and `CLOUDFLARE_API_TOKEN=proxy-injected` are dummy values.** They exist to satisfy client-side "am I authenticated?" checks in `gh` and `wrangler`. The proxy strips them at the wire level and injects real tokens. Do not replace them with real values — the whole point is that dev never holds real credentials.

**`github.py` must not match `github.com`.** Git push/pull to `github.com` goes through the HTTPS credential helper (via cred-gateway), not through token injection. Adding `github.com` to the addon would conflict with git's HTTP Basic auth handshake inside the MITMed tunnel.

**`anthropic.py` uses `responseheaders`, not `response`.** Accessing `flow.response.content` for a streamed response would buffer the entire body. The addon sets `flow.response.stream = True` in `responseheaders` so SSE chunks pass through immediately.

**The broker's `identityCache` is lifetime-cached.** If the GitHub App is renamed, restart the broker to refresh it. All other caches are TTL-based (5 minutes).

**CA cert persistence.** The mitmproxy CA cert lives in the `proxy-certs` named Docker volume, shared between the `proxy` container (where it's generated) and the `dev` container (read-only). The proxy's healthcheck gates on the cert file existing, so `postCreateCommand` cannot race cert generation. Removing the volume forces cert regeneration and requires a container rebuild.

**`credential.useHttpPath false` in git config** means one installation token is used for all repos regardless of path. This is intentional — the GitHub App's installation already scopes which repos it can access.

**Do not add `USER mitmproxy` to `proxy/Dockerfile`.** The base image (`mitmproxy/mitmproxy`) ships with a `docker-entrypoint.sh` that runs `usermod` (requires root) to align the `mitmproxy` user's UID with the mounted volume owner, then drops privileges via `gosu mitmproxy`. Adding `USER mitmproxy` makes the entrypoint run as non-root, causing `usermod` to fail with "operation not permitted". The `USER root` + `RUN pip install` block is correct; the entrypoint handles the privilege drop. Proxy stdout is also block-buffered when not attached to a tty — add `-e PYTHONUNBUFFERED=1` or `-it` when testing standalone to see logs in real time.

## Adding a new credential provider

1. Add a credential file path env var under `broker` in `compose.yaml`
2. Add a route in `broker/server.js` (follow existing pattern; expose via cred-gateway only if dev tools need raw access — almost never)
3. Add a new addon in `proxy/addons/` following the `anthropic.py` or `cloudflare.py` pattern
4. Register the addon with `-s /addons/your-addon.py` in `proxy/Dockerfile` CMD
5. Add a smoke-test section verifying injection works AND the broker endpoint is unreachable from dev
