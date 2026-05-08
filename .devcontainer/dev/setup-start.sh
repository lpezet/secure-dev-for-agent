#!/bin/bash
# postStartCommand — runs each time the container starts (including after restart).
# Refreshes git identity from the broker in case the GitHub App was reconfigured.
set -euo pipefail

echo "[setup-start] waiting for cred-gateway..."
for i in 1 2 3 4 5; do
  if curl -sf "$GITHUB_IDENTITY_URL" > /dev/null 2>&1; then
    break
  fi
  echo "[setup-start] cred-gateway not ready, retrying ($i/5)..."
  sleep 2
done

echo "[setup-start] fetching GitHub App identity from cred-gateway..."
IDENTITY_JSON=$(curl -sf "$GITHUB_IDENTITY_URL")
GIT_NAME=$(echo "$IDENTITY_JSON" | jq -r .name)
GIT_EMAIL=$(echo "$IDENTITY_JSON" | jq -r .email)
git config --global user.name "$GIT_NAME"
git config --global user.email "$GIT_EMAIL"
echo "[setup-start] git identity: $GIT_NAME <$GIT_EMAIL>"

echo "[setup-start] verifying proxy interception (gh through proxy with dummy GH_TOKEN)..."
if gh api /rate_limit > /dev/null 2>&1; then
  echo "[setup-start] proxy OK"
else
  echo "[setup-start] WARNING: gh api call failed; check proxy logs"
fi

echo "[setup-start] done."
