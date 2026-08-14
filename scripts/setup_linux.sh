#!/usr/bin/env bash

set -Eeuo pipefail

skip_install=false
skip_checks=false

usage() {
  cat <<'EOF'
Usage: ./scripts/setup_linux.sh [--skip-install] [--skip-checks]

Checks the Linux toolchain, creates the local workspace allowlist, installs
locked npm dependencies, and runs the repository verification commands.
EOF
}

while (($# > 0)); do
  case "$1" in
    --skip-install) skip_install=true ;;
    --skip-checks) skip_checks=true ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "This repository is supported on Linux hosts only." >&2
  exit 1
fi

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

step() {
  printf '\n[linux-setup] %s\n' "$1"
}

require_command() {
  local command_name="$1"
  local install_hint="$2"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'Missing required command: %s\n%s\n' "$command_name" "$install_hint" >&2
    exit 1
  fi
}

step "checking required tools"
require_command git "Install Git with your distribution package manager."
require_command node "Install Node.js 18 or newer (Node.js 24 is used in CI)."
require_command npm "Install npm with Node.js."
require_command codex "Install Codex CLI with: curl -fsSL https://chatgpt.com/codex/install.sh | sh"
require_command ssh "Install the OpenSSH client with your distribution package manager."

node_major="$(node --version | sed -E 's/^v([0-9]+).*/\1/')"
if [[ ! "$node_major" =~ ^[0-9]+$ ]] || ((node_major < 18)); then
  echo "Node.js 18 or newer is required; found $(node --version)." >&2
  exit 1
fi

printf 'Node:  %s\n' "$(node --version)"
printf 'npm:   %s\n' "$(npm --version)"
printf 'Codex: %s\n' "$(codex --version)"

if command -v java >/dev/null 2>&1; then
  java_version="$(java -version 2>&1 | head -n 1)"
  printf 'Java:  %s\n' "$java_version"
  if [[ ! "$java_version" =~ version[[:space:]]+\"17[.] ]]; then
    echo "Warning: CI and the documented Android toolchain use Java 17." >&2
  fi
else
  echo "Warning: Java 17 is required to build the Android APK." >&2
fi

android_sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
if [[ -z "$android_sdk" && -d "$HOME/Android/Sdk" ]]; then
  android_sdk="$HOME/Android/Sdk"
fi

if [[ -n "$android_sdk" && -d "$android_sdk" ]]; then
  printf 'SDK:   %s\n' "$android_sdk"
else
  echo "Warning: set ANDROID_HOME to a valid Android SDK before building the APK." >&2
fi

if command -v adb >/dev/null 2>&1; then
  printf 'ADB:   %s\n' "$(adb version | head -n 1)"
else
  echo "Warning: adb is required to install and debug the APK on a device." >&2
fi

allowlist_file="$repo_root/config/workspaces.allowlist"
if [[ ! -e "$allowlist_file" ]]; then
  step "creating config/workspaces.allowlist"
  umask 077
  printf '# Created by scripts/setup_linux.sh. One workspace path per line.\n%s\n' \
    "$repo_root" >"$allowlist_file"
else
  step "keeping existing config/workspaces.allowlist"
fi

if [[ "$skip_install" == false ]]; then
  step "installing locked backend dependencies"
  npm --prefix "$repo_root/backend" ci

  step "installing locked mobile dependencies"
  npm --prefix "$repo_root/mobile" ci
fi

if [[ "$skip_checks" == false ]]; then
  step "checking backend"
  npm --prefix "$repo_root/backend" run typecheck
  npm --prefix "$repo_root/backend" test
  npm --prefix "$repo_root/backend" run build

  step "checking mobile"
  npm --prefix "$repo_root/mobile" run typecheck
  npm --prefix "$repo_root/mobile" test
fi

printf '\nLinux setup is ready. Start the bridge with:\n  cd %q && npm run dev\n' \
  "$repo_root/backend"
