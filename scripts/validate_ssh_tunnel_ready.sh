#!/usr/bin/env bash

set -Eeuo pipefail

api_host="127.0.0.1"
api_port=8787
ssh_port=22
public_ssh_port=""
skip_bridge_health=false
check_public_ip=false
failures=0

usage() {
  cat <<'EOF'
Usage: ./scripts/validate_ssh_tunnel_ready.sh [options]

Options:
  --api-host HOST          Bridge address (default: 127.0.0.1)
  --api-port PORT          Bridge port (default: 8787)
  --ssh-port PORT          Local sshd port (default: 22)
  --public-ssh-port PORT   Public/router SSH port shown in the checklist
  --skip-bridge-health     Do not require the bridge to be running
  --check-public-ip        Query api.ipify.org for the observed public IP
EOF
}

while (($# > 0)); do
  case "$1" in
    --api-host) api_host="${2:?Missing value for --api-host}"; shift ;;
    --api-port) api_port="${2:?Missing value for --api-port}"; shift ;;
    --ssh-port) ssh_port="${2:?Missing value for --ssh-port}"; shift ;;
    --public-ssh-port) public_ssh_port="${2:?Missing value for --public-ssh-port}"; shift ;;
    --skip-bridge-health) skip_bridge_health=true ;;
    --check-public-ip) check_public_ip=true ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

section() { printf '\n== %s ==\n' "$1"; }
ok() { printf 'OK: %s\n' "$1"; }
warn() { printf 'WARN: %s\n' "$1" >&2; }
fail() { printf 'FAIL: %s\n' "$1" >&2; failures=$((failures + 1)); }

section "Linux host"
if [[ "$(uname -s)" == "Linux" ]]; then
  ok "running on Linux ($(uname -r))"
else
  fail "this validator supports Linux hosts only"
fi

section "Codex"
if command -v codex >/dev/null 2>&1; then
  ok "$(codex --version) at $(command -v codex)"
else
  fail "Codex CLI was not found in PATH"
fi

section "OpenSSH"
if command -v ssh >/dev/null 2>&1; then
  ok "SSH client found at $(command -v ssh)"
else
  fail "OpenSSH client was not found"
fi

if command -v sshd >/dev/null 2>&1; then
  ok "sshd found at $(command -v sshd)"
else
  fail "OpenSSH server was not found"
fi

sshd_active=false
if command -v systemctl >/dev/null 2>&1; then
  if systemctl is-active --quiet ssh 2>/dev/null || systemctl is-active --quiet sshd 2>/dev/null; then
    sshd_active=true
  fi
elif command -v pgrep >/dev/null 2>&1 && pgrep -x sshd >/dev/null 2>&1; then
  sshd_active=true
fi

if [[ "$sshd_active" == true ]]; then
  ok "OpenSSH server is running"
else
  fail "OpenSSH server is not running (check the ssh or sshd service)"
fi

if command -v ss >/dev/null 2>&1; then
  if ss -H -ltn | awk -v port=":$ssh_port" '$4 ~ port "$" { found=1 } END { exit !found }'; then
    ok "SSH port $ssh_port is listening"
  else
    fail "no TCP listener was found on SSH port $ssh_port"
  fi
else
  warn "ss is unavailable; skipped local listener checks"
fi

section "Bridge health"
health_url="http://${api_host}:${api_port}/health"
if [[ "$skip_bridge_health" == true ]]; then
  warn "bridge health check skipped"
elif ! command -v curl >/dev/null 2>&1; then
  fail "curl is required to check $health_url"
elif health="$(curl --fail --silent --show-error --max-time 5 "$health_url")"; then
  ok "$health_url responded"
  printf '%s\n' "$health"
else
  fail "bridge health did not respond at $health_url"
fi

if [[ "$check_public_ip" == true ]]; then
  section "Public IP"
  if public_ip="$(curl --fail --silent --show-error --max-time 5 https://api.ipify.org)"; then
    ok "observed public IP: $public_ip"
  else
    warn "could not query the public IP"
  fi
fi

section "Mobile checklist"
public_port="${public_ssh_port:-$ssh_port}"
printf '%s\n' \
  "- Bridge on Linux: $health_url" \
  "- Tunnel on Android: http://127.0.0.1:18080/health" \
  "- Public SSH port $public_port must reach this host's port $ssh_port" \
  "- Restrict the tunnel user with: PermitOpen ${api_host}:${api_port}" \
  "- Run the final test with the phone disconnected from Wi-Fi"

section "Result"
if ((failures > 0)); then
  printf '%d validation check(s) failed.\n' "$failures" >&2
  exit 1
fi

echo "Linux host is ready for SSH tunnel validation."
