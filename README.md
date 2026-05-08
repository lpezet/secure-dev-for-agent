# Agent Credential Broker + Proxy

Local credential broker and mitmproxy-based egress proxy for running autonomous agents
(e.g. Claude Code) in a dev container without exposing long-lived credentials to the
agent's process.

## Quick start

1. Set up host credentials at `~/.config/agent-creds/`. See IMPLEMENTATION.md → Prerequisites.
2. Copy `.env.example` to `.env` and fill in `GITHUB_APP_ID` and `GITHUB_APP_INSTALLATION_ID`.
3. Open this repo in VSCode → "Reopen in Container".
4. Run the smoke test: `./scripts/smoke-test.sh`

## How it works

See IMPLEMENTATION.md.

## Operations

- Logs: `docker compose -f .devcontainer/compose.yaml logs -f broker proxy cred-gateway`
- Rotation: see IMPLEMENTATION.md → Operational Runbook
- Teardown: `docker compose -f .devcontainer/compose.yaml down -v`
- Recovery (if setup failed): re-run `/workspace/.devcontainer/dev/setup.sh` from inside the container
