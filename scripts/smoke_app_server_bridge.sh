#!/usr/bin/env bash

set -Eeuo pipefail

workspace=""
host="127.0.0.1"
port=18787
timeout_seconds=90
skip_build=false
keep_server=false

usage() {
  cat <<'EOF'
Usage: ./scripts/smoke_app_server_bridge.sh [options]

Options:
  --workspace PATH       Workspace used for the real Codex run
  --host HOST            Bridge bind host (default: 127.0.0.1)
  --port PORT            Bridge port (default: 18787)
  --timeout SECONDS      Health and request timeout (default: 90)
  --skip-build           Reuse the existing backend dist directory
  --keep-server          Leave the test bridge and its temporary files running
EOF
}

while (($# > 0)); do
  case "$1" in
    --workspace) workspace="${2:?Missing value for --workspace}"; shift ;;
    --host) host="${2:?Missing value for --host}"; shift ;;
    --port) port="${2:?Missing value for --port}"; shift ;;
    --timeout) timeout_seconds="${2:?Missing value for --timeout}"; shift ;;
    --skip-build) skip_build=true ;;
    --keep-server) keep_server=true ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
backend_dir="$repo_root/backend"
workspace="${workspace:-$repo_root}"
workspace="$(realpath -- "$workspace")"
base_url="http://${host}:${port}"
temp_dir="$(mktemp -d -t codex-mobile-smoke.XXXXXX)"
allowlist_file="$temp_dir/workspaces.allowlist"
stdout_log="$temp_dir/bridge.out.log"
stderr_log="$temp_dir/bridge.err.log"
server_pid=""
completed=false

step() { printf '[smoke] %s\n' "$1"; }

cleanup() {
  local status=$?
  if [[ "$status" -ne 0 ]]; then
    printf '\nBridge stdout (tail):\n' >&2
    tail -n 80 "$stdout_log" 2>/dev/null >&2 || true
    printf '\nBridge stderr (tail):\n' >&2
    tail -n 80 "$stderr_log" 2>/dev/null >&2 || true
  fi

  if [[ "$keep_server" == false ]]; then
    if [[ -n "$server_pid" ]] && kill -0 "$server_pid" 2>/dev/null; then
      kill "$server_pid" 2>/dev/null || true
      wait "$server_pid" 2>/dev/null || true
    fi
    rm -rf -- "$temp_dir"
  elif [[ "$completed" == true ]]; then
    printf 'Bridge PID: %s\nLogs and temporary allowlist: %s\n' "$server_pid" "$temp_dir"
  fi
}
trap cleanup EXIT

for command_name in node npm curl codex realpath; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Required command not found: $command_name" >&2
    exit 1
  fi
done

if command -v ss >/dev/null 2>&1 && \
  ss -H -ltn | awk -v port=":$port" '$4 ~ port "$" { found=1 } END { exit !found }'; then
  echo "Port ${host}:${port} is already in use." >&2
  exit 1
fi

if [[ "$skip_build" == false ]]; then
  step "building backend"
  npm --prefix "$backend_dir" run build
fi

printf '%s\n' "$workspace" >"$allowlist_file"

step "starting bridge on $base_url"
(
  cd "$backend_dir"
  exec env \
    CODEX_BRIDGE_HOST="$host" \
    CODEX_BRIDGE_PORT="$port" \
    CODEX_BRIDGE_RUNTIME=app-server \
    CODEX_BRIDGE_WORKSPACE_ALLOWLIST="$workspace" \
    CODEX_BRIDGE_WORKSPACE_ALLOWLIST_FILE="$allowlist_file" \
    CODEX_BRIDGE_SKIP_GIT_REPO_CHECK=false \
    node dist/server.js
) >"$stdout_log" 2>"$stderr_log" &
server_pid=$!

deadline=$((SECONDS + timeout_seconds))
health=""
while ((SECONDS < deadline)); do
  if ! kill -0 "$server_pid" 2>/dev/null; then
    echo "Bridge exited before becoming healthy." >&2
    exit 1
  fi

  if health="$(curl --fail --silent --show-error --max-time 3 "$base_url/health" 2>/dev/null)" && \
    printf '%s' "$health" | node -e '
      let input = "";
      process.stdin.on("data", chunk => input += chunk);
      process.stdin.on("end", () => {
        const value = JSON.parse(input);
        process.exit(value.active_transport === "app-server" && value.codex_ready === true ? 0 : 1);
      });
    '; then
    break
  fi
  sleep 0.5
done

if [[ -z "$health" ]] || ! printf '%s' "$health" | node -e '
  let input = "";
  process.stdin.on("data", chunk => input += chunk);
  process.stdin.on("end", () => process.exit(JSON.parse(input).codex_ready === true ? 0 : 1));
'; then
  echo "Bridge did not become healthy within ${timeout_seconds}s." >&2
  exit 1
fi
step "health check passed"

create_payload="$(node -e '
  console.log(JSON.stringify({
    title: `Linux smoke ${new Date().toISOString()}`,
    workspace: process.argv[1]
  }));
' "$workspace")"
create_response="$(curl --fail --silent --show-error --max-time "$timeout_seconds" \
  -H 'Content-Type: application/json' -X POST --data "$create_payload" \
  "$base_url/v1/threads")"
thread_id="$(printf '%s' "$create_response" | node -e '
  let input = "";
  process.stdin.on("data", chunk => input += chunk);
  process.stdin.on("end", () => {
    const value = JSON.parse(input);
    if (!value.thread?.id) process.exit(1);
    process.stdout.write(value.thread.id);
  });
')"
step "created thread $thread_id"

run_payload="$(node -e '
  console.log(JSON.stringify({
    message: "Codex Mobile Bridge Linux smoke test. Do not modify files or run commands. Reply only: smoke app-server ok.",
    cwd: process.argv[1],
    approval_policy: "never",
    sandbox_mode: "read-only",
    network_access_enabled: false
  }));
' "$workspace")"
sse_file="$temp_dir/run.sse"
curl --fail --silent --show-error --no-buffer --max-time "$timeout_seconds" \
  -H 'Content-Type: application/json' -X POST --data "$run_payload" \
  "$base_url/v1/threads/$thread_id/runs/stream" >"$sse_file"

agent_message="$(node - "$sse_file" <<'NODE'
const fs = require("node:fs");
const content = fs.readFileSync(process.argv[2], "utf8");
const events = content.trim().split(/\r?\n\r?\n/).map((block) => {
  let event = "message";
  const data = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  let parsed = null;
  try { parsed = JSON.parse(data.join("\n")); } catch {}
  return { event, data: parsed };
});
const done = events.filter((item) => item.event === "done").at(-1);
const message = events.filter((item) => item.event === "agent_message").at(-1);
if (!done || done.data?.status !== "completed") {
  console.error(`Run did not complete successfully: ${JSON.stringify(done?.data ?? null)}`);
  process.exit(1);
}
if (!message?.data?.text) {
  console.error("Run stream did not contain a final agent_message event.");
  process.exit(1);
}
process.stdout.write(message.data.text);
NODE
)"

completed=true
printf '\nSMOKE OK\nBridge: %s\nThread: %s\nWorkspace: %s\nAgent: %s\n' \
  "$base_url" "$thread_id" "$workspace" "$agent_message"
