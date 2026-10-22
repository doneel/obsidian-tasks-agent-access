#!/usr/bin/env bash
# Installs (or upgrades) obsidian-tasks-agent-access and configures it from environment variables.
# Needs no root: Node.js (if missing) and the CLI are installed under ~/.local.
# Safe to run at the start of every agent session: it skips work that is already done.
#
#   curl -fsSL https://raw.githubusercontent.com/doneel/obsidian-tasks-agent-access/master/install.sh | bash
#
# First run also needs an Obsidian login: the user runs `tasks login` once (or sets OBSIDIAN_AUTH_TOKEN),
# plus TASKS_REMOTE_VAULT and the other TASKS_* variables described in the README.
# TASKS_VERSION=v0.1.1 pins a release (default: latest). TASKS_UPGRADE=1 reinstalls even if present.
# TASKS_NO_PROFILE=1 skips adding ~/.local/bin to ~/.profile and ~/.bashrc.
set -euo pipefail

REPO="doneel/obsidian-tasks-agent-access"
ASSET="obsidian-tasks-agent-access.tgz"
VERSION="${TASKS_VERSION:-latest}"
if [ "$VERSION" = "latest" ]; then
  URL="https://github.com/$REPO/releases/latest/download/$ASSET"
else
  URL="https://github.com/$REPO/releases/download/$VERSION/$ASSET"
fi
URL="${TASKS_TARBALL:-$URL}"  # override for testing or a private mirror
LOCAL="$HOME/.local"
BIN="$LOCAL/bin"
mkdir -p "$BIN"
export PATH="$BIN:$PATH"

log() { echo "$*" >&2; }

node_ok() {
  command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ]
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi
}

# Official Node.js 22 build from nodejs.org, checksum-verified, unpacked into ~/.local/lib.
install_node() {
  local os arch base sums file expected tmp dir
  case "$(uname -s)" in Linux) os=linux ;; Darwin) os=darwin ;; *) log "Unsupported OS: $(uname -s)"; exit 1 ;; esac
  case "$(uname -m)" in x86_64 | amd64) arch=x64 ;; aarch64 | arm64) arch=arm64 ;; *) log "Unsupported CPU: $(uname -m)"; exit 1 ;; esac
  base="https://nodejs.org/dist/latest-v22.x"
  sums="$(curl -fsSL "$base/SHASUMS256.txt")"
  file="$(printf '%s\n' "$sums" | awk '{print $2}' | grep -E "^node-v22\.[0-9]+\.[0-9]+-$os-$arch\.tar\.gz$" | head -n1)"
  [ -n "$file" ] || { log "No Node.js 22 build found for $os-$arch"; exit 1; }
  expected="$(printf '%s\n' "$sums" | awk -v f="$file" '$2 == f {print $1}')"
  tmp="$(mktemp -d)"
  log "Installing ${file%.tar.gz} into $LOCAL/lib (Node.js was missing or older than 22)"
  curl -fsSL -o "$tmp/$file" "$base/$file"
  [ "$(sha256 "$tmp/$file")" = "$expected" ] || { log "Checksum mismatch for $file; aborting"; rm -rf "$tmp"; exit 1; }
  mkdir -p "$LOCAL/lib"
  tar -xzf "$tmp/$file" -C "$LOCAL/lib"
  rm -rf "$tmp"
  dir="$LOCAL/lib/${file%.tar.gz}"
  ln -sfn "$dir" "$LOCAL/lib/nodejs"
  for b in node npm npx; do ln -sf "$LOCAL/lib/nodejs/bin/$b" "$BIN/$b"; done
  hash -r
}

# Make ~/.local/bin available to later shells.
add_to_profile() {
  [ "${TASKS_NO_PROFILE:-0}" = "1" ] && return 0
  local line='export PATH="$HOME/.local/bin:$PATH"  # obsidian-tasks-agent-access'
  for f in "$HOME/.profile" "$HOME/.bashrc"; do
    grep -qsF '# obsidian-tasks-agent-access' "$f" || printf '\n%s\n' "$line" >> "$f"
  done
}

node_ok || install_node
add_to_profile

if ! command -v tasks >/dev/null 2>&1 || [ "${TASKS_UPGRADE:-0}" = "1" ]; then
  log "Installing obsidian-tasks-agent-access ($VERSION) into $LOCAL"
  npm install -g --prefix "$LOCAL" --no-fund --no-audit --loglevel=error "$URL" >&2
  hash -r
fi

exec tasks bootstrap --json "$@"
