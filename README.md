# Codex Mobile App

Android companion for a Codex installation running on a Linux host. The app
reaches a loopback-only Node.js bridge through an SSH local port forward.

The mobile app is an operations client. Codex authentication, workspaces,
filesystem access, MCP servers, apps, skills, and approvals stay on the Linux
host.

## Supported Host

Linux is the supported development, bridge, SSH, and Android build environment.
CI runs on Ubuntu 24.04 with Node.js 24 and Java 17.

## Architecture

```text
Android app
  -> http://127.0.0.1:18080
  -> SSH local port forward
  -> Linux host 127.0.0.1:8787
  -> Codex Bridge (Node.js + TypeScript)
  -> codex app-server or @openai/codex-sdk
  -> local Codex CLI/runtime
```

The default runtime is `app-server`, which supports persisted conversations,
settings, model and account data, apps, skills, MCP resources, streaming, and
human-in-the-loop approvals. The `sdk` runtime is a simpler adapter and `mock`
is available for deterministic development and tests.

## Linux Quick Start

Install the system prerequisites first: Git, Node.js 18 or newer, npm, the
OpenSSH client, and Codex CLI. Java 17, the Android SDK, and `adb` are also
needed to build and install the APK.

Install Codex CLI using the official Linux installer, then run `codex` once to
sign in:

```bash
curl -fsSL https://chatgpt.com/codex/install.sh | sh
codex
```

From the repository root:

```bash
chmod +x scripts/*.sh mobile/android/gradlew
./scripts/setup_linux.sh
```

The setup script validates the host tools, creates the ignored local workspace
allowlist, installs locked dependencies, and runs backend and mobile checks.
For distro-specific packages, Android SDK setup, SSH hardening, and APK steps,
see [build-guide/README.md](build-guide/README.md).

## Run the Bridge

```bash
cd backend
npm run dev
```

The bridge binds to `127.0.0.1:8787` by default. In another terminal:

```bash
curl --fail --silent http://127.0.0.1:8787/health | jq
```

Select a different runtime when needed:

```bash
export CODEX_BRIDGE_RUNTIME=mock
npm run dev
```

Supported values are `app-server` (default), `sdk`, and `mock`.

Useful backend checks:

```bash
cd backend
npm run typecheck
npm test
npm run build
npm run smoke:app-server
```

The smoke test starts a temporary bridge and performs a real read-only Codex
run, so it requires a signed-in Codex CLI.

## Run the Mobile App

```bash
cd mobile
npm ci
npm run web
```

Web preview connects directly to `http://127.0.0.1:8787`. A physical Android
device uses `http://127.0.0.1:18080`, the local end of its SSH tunnel.

The native tunnel module lives in `mobile/modules/codex-ssh-tunnel/`. Expo Go
cannot load it; use an Android development build or APK for tunnel testing.

## Build an Android APK

After configuring the Android SDK and the `CODEX_MOBILE_*` environment
variables described in the build guide:

```bash
cd mobile/android
./gradlew :app:assembleDebug \
  -PreactNativeArchitectures=arm64-v8a \
  --no-daemon --console=plain --stacktrace
```

The debug APK is written to:

```text
mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

Install it on a connected device with:

```bash
adb install -r mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

## Workspaces

Allowed workspaces are read from `config/workspaces.allowlist`. The local file
is ignored by Git; copy `config/workspaces.allowlist.example` or let the Linux
setup script create it. Use one absolute Linux path per line.

The bridge also exposes workspace add, remove, and restore endpoints, so the
mobile app can update the allowlist without rebuilding the APK.

## Security Boundary

- Keep the bridge bound to `127.0.0.1`; do not expose port 8787 publicly.
- Use an unprivileged SSH account dedicated to this tunnel.
- Restrict that account with `AllowTcpForwarding local` and
  `PermitOpen 127.0.0.1:8787`.
- Use a unique SSH key for each device and rotate it if the APK or phone is
  lost.
- Treat every private key or password embedded in an APK as recoverable.

Run the Linux readiness validator after the bridge and SSH server are running:

```bash
./scripts/validate_ssh_tunnel_ready.sh
```

## Repository Layout

- `backend/`: loopback HTTP/SSE bridge and Codex runtime adapters.
- `mobile/`: Expo/React Native app and native Android SSH tunnel module.
- `build-guide/`: Linux host, SSH, Android SDK, build, and troubleshooting guide.
- `config/`: workspace allowlist template.
- `scripts/`: Linux setup, bridge smoke test, and SSH readiness validation.

The canonical HTTP/SSE endpoint list is in
[backend/README.md](backend/README.md). Mobile configuration and structure are
documented in [mobile/README.md](mobile/README.md).

Official Codex references:

- [Codex CLI](https://learn.chatgpt.com/docs/codex/cli)
- [Codex app-server](https://developers.openai.com/codex/app-server)
- [Codex SDK](https://developers.openai.com/codex/sdk)
