# Codex Mobile Bridge

Local Linux service that exposes a loopback HTTP/SSE API and adapts the Codex
runtime for the Android client.

## Setup and Commands

```bash
cd backend
npm ci
npm run dev
```

Verification commands:

```bash
npm run typecheck
npm test
npm run build
npm run smoke:app-server
```

`smoke:app-server` starts a bridge on a temporary port, creates a real native
Codex conversation, and validates a read-only streamed run. It requires the
Codex CLI to be installed and signed in.

## Runtime

The bridge supports three runtimes:

- `app-server`: Codex app-server over stdio JSON-RPC; this is the default and
  recommended runtime.
- `sdk`: `@openai/codex-sdk` and the local Codex CLI.
- `mock`: deterministic runtime for tests and UI development.

Select a runtime before starting the bridge:

```bash
export CODEX_BRIDGE_RUNTIME=mock
npm run dev
```

The `codex` executable must be available in the service user's `PATH`.

## Configuration

Copy `.env.example` values into your service environment or shell. The server
does not automatically load `.env` files.

Important variables:

- `CODEX_BRIDGE_HOST`: bind address; keep the default `127.0.0.1`.
- `CODEX_BRIDGE_PORT`: loopback API port; default `8787`.
- `CODEX_BRIDGE_RUNTIME`: `app-server`, `sdk`, or `mock`.
- `CODEX_BRIDGE_WORKSPACE_ALLOWLIST`: colon-separated absolute Linux paths.
- `CODEX_BRIDGE_WORKSPACE_ALLOWLIST_FILE`: one allowed path per line.
- `CODEX_BRIDGE_SKIP_GIT_REPO_CHECK`: allow non-Git workspaces when `true`.

The normal allowlist file is:

```text
<repository>/config/workspaces.allowlist
```

Blank lines and lines beginning with `#` are ignored. The local file is outside
Git; use `config/workspaces.allowlist.example` as the template.

## Structure

- `src/server.ts`: process entrypoint.
- `src/app.ts`: HTTP/SSE router.
- `src/appServer/`: app-server JSON-RPC client and event mapping.
- `src/runtime/`: SDK and mock runtimes.
- `src/runs/`: active-run registry, replay, and stream reattachment.
- `src/threads/`: conversation service and store.
- `src/workspaces/`: workspace allowlist service.

## API

System:

- `GET /health`
- `GET /v1/capabilities`

Threads and runs:

- `GET /v1/threads`
- `POST /v1/threads`
- `GET /v1/threads/:threadId`
- `POST /v1/threads/:threadId/name`
- `POST /v1/threads/:threadId/archive`
- `POST /v1/threads/:threadId/cancel`
- `POST /v1/threads/:threadId/runs/stream`
- `POST /v1/threads/:threadId/runs`
- `GET /v1/runs/active`
- `GET /v1/runs/:runId`
- `GET /v1/runs/:runId/events/stream`

Workspaces and filesystem:

- `GET /v1/workspaces`
- `POST /v1/workspaces/add`
- `POST /v1/workspaces/remove`
- `POST /v1/workspaces/restore`
- `GET /v1/filesystem/roots`
- `GET /v1/filesystem/children?path=...`

Settings and account:

- `GET /v1/settings/models`
- `GET /v1/settings/config`
- `POST /v1/settings/config`
- `GET /v1/settings/account`
- `GET /v1/settings/features`

Apps, skills, and MCP:

- `GET /v1/apps`
- `GET /v1/skills`
- `GET /v1/mcp/servers`
- `POST /v1/mcp/resources/read`
- `POST /v1/mcp/reload`

Approvals and setup:

- `POST /v1/approvals/:approvalId/respond`
- `GET /v1/setup/ssh/status`

Capability-dependent endpoints return an error when the selected runtime does
not implement them. Query `GET /v1/capabilities` before enabling those controls.
