# Agent Credential Broker + Proxy

Local credential broker and mitmproxy-based egress proxy for running autonomous agents
(e.g. Claude Code) in a dev container without exposing long-lived credentials to the
agent's process.

## Quick start

1. Complete the [Prerequisites](#prerequisites) below (GitHub App + credential files).
2. Copy `.env.example` to `.env` and fill in `GITHUB_APP_ID` and `GITHUB_APP_INSTALLATION_ID`.
3. Open this repo in VSCode → "Reopen in Container".
4. Run the smoke test: `./scripts/smoke-test.sh`

## How it works

```
┌─────────────────────────────────────────┐
│  dev container (Claude Code, git, gh)   │
│  HTTPS_PROXY=http://proxy:8080          │  network: dev
│  GIT_CREDENTIAL_URL=cred-gateway        │
│  No credentials, no .env, no API keys   │
└────┬─────────────────────────┬──────────┘
     │ HTTPS (intercepted)     │ git creds only
     ▼                         ▼
┌──────────────┐   ┌─────────────────────┐
│  proxy       │   │  cred-gateway       │
│  mitmproxy   │   │  nginx, whitelist:  │
│  + addons    │   │  /github/credential │
│              │   │  /github/identity   │
└──────┬───────┘   └──────────┬──────────┘
       │                      │
       │     network: secure  │
       │     (no dev access)  │
       ▼                      ▼
┌─────────────────────────────────────────┐
│  broker                                 │
│  - Reads .pem / api keys from /secrets  │
│  - Mints GitHub installation tokens     │
│  - Mints Cloudflare scoped tokens       │
│  - /anthropic/key reachable only by     │
│    proxy on `secure` network            │
└─────────────────────────────────────────┘
             │
             ▼
        ~/.config/agent-creds/
        (read-only bind mount)
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

### Credential files

```bash
mkdir -p ~/.config/agent-creds
chmod 700 ~/.config/agent-creds

# GitHub App private key
cp /path/to/your-app.private-key.pem ~/.config/agent-creds/github-app.pem

# Anthropic API key (single line, no trailing newline — use printf)
printf 'sk-ant-...' > ~/.config/agent-creds/anthropic.key

# Cloudflare token with "User API Tokens:Edit" permission (only needed if using Cloudflare)
printf '...' > ~/.config/agent-creds/cloudflare-minter.token

chmod 600 ~/.config/agent-creds/*
```

### `.env` at repo root

```
GITHUB_APP_ID=123456
GITHUB_APP_INSTALLATION_ID=78901234
```

## Operations

- Logs: `docker compose -f .devcontainer/compose.yaml logs -f broker proxy cred-gateway`
- Teardown: `docker compose -f .devcontainer/compose.yaml down -v`
- Recovery (if setup failed): re-run `/workspace/.devcontainer/dev/setup.sh` from inside the container

### Rotating the GitHub App private key

1. On the host: replace `~/.config/agent-creds/github-app.pem` with the new key
2. `docker compose -f .devcontainer/compose.yaml restart broker`
3. Wait up to 5 minutes for proxy token caches to expire, OR restart the proxy immediately:
   `docker compose -f .devcontainer/compose.yaml restart proxy`

### Rotating the Anthropic API key

1. On the host: overwrite `~/.config/agent-creds/anthropic.key` with the new key (use `printf`, not `echo`, to avoid a trailing newline)
2. `docker compose -f .devcontainer/compose.yaml restart broker proxy`
   (proxy restart is needed because the proxy caches the key for 5 minutes)

### Rotating the Cloudflare minter token

1. Create a new minter token in the Cloudflare dashboard (User API Tokens:Edit permission)
2. Replace `~/.config/agent-creds/cloudflare-minter.token` on the host
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
