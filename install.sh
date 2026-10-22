#!/usr/bin/env bash
# Installs (or upgrades) obsidian-tasks-agent-access and configures it from environment variables.
# Safe to run at the start of every agent session: it skips work that is already done.
#
#   curl -fsSL https://raw.githubusercontent.com/doneel/obsidian-tasks-agent-access/master/install.sh | bash
#
# Required on first run: OBSIDIAN_AUTH_TOKEN, TASKS_REMOTE_VAULT. See README for the other TASKS_* variables.
# TASKS_VERSION=v0.1.0 pins a release (default: latest). TASKS_UPGRADE=1 reinstalls even if present.
set -euo pipefail

REPO="doneel/obsidian-tasks-agent-access"
ASSET="obsidian-tasks-agent-access.tgz"
VERSION="${TASKS_VERSION:-latest}"
if [ "$VERSION" = "latest" ]; then
  URL="https://github.com/$REPO/releases/latest/download/$ASSET"
else
  URL="https://github.com/$REPO/releases/download/$VERSION/$ASSET"
fi

if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  echo "obsidian-tasks-agent-access needs Node.js 22 or newer (found: $(node --version 2>/dev/null || echo none))" >&2
  exit 1
fi

[ -x "$HOME/.local/bin/tasks" ] && export PATH="$HOME/.local/bin:$PATH"
if ! command -v tasks >/dev/null 2>&1 ||[ "${TASKS_UPGRADE:-0}" = "1" ]; then
  prefix="$(npm prefix -g)"
  if [ -w "$prefix" ] || [ -w "$prefix/lib" ]; then
    npm install -g --no-fund --no-audit "$URL" >&2
  else
    # no write access to the global prefix (common in containers without root)
    prefix="$HOME/.local"
    npm install -g --prefix "$prefix" --no-fund --no-audit "$URL" >&2
    export PATH="$prefix/bin:$PATH"
    echo "Installed to $prefix/bin; add it to PATH for later sessions: export PATH=\"$prefix/bin:\$PATH\"" >&2
  fi
fi

exec tasks bootstrap --json "$@"
