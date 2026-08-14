# Codex Mobile

Internal Android app built with Expo, React Native, and TypeScript on Linux.

## Setup

```bash
cd mobile
npm ci
```

Start Metro or the browser preview:

```bash
npm start
npm run web
```

If Metro reports a cache deserialization error:

```bash
npm run start:clear
```

The web preview uses `http://127.0.0.1:8787` by default. Override it for a
development session with:

```bash
export EXPO_PUBLIC_BRIDGE_URL=http://127.0.0.1:8787
npm start
```

A physical Android device uses `http://127.0.0.1:18080`, which is the local end
of the native SSH tunnel.

## SSH Build Configuration

`app.config.js` reads `CODEX_MOBILE_*` values at build time. A private-key
configuration looks like this:

```bash
export CODEX_MOBILE_GATEWAY=ssh_tunnel
export CODEX_MOBILE_SSH_TUNNEL_LOCAL_URL=http://127.0.0.1:18080
export CODEX_MOBILE_SSH_REMOTE_HOSTS='[YOUR_IPV6]:22,YOUR_PUBLIC_IPV4:39223'
export CODEX_MOBILE_SSH_USERNAME=codex-tunnel
export CODEX_MOBILE_SSH_AUTH_MODE=private_key
export CODEX_MOBILE_SSH_PRIVATE_KEY_PEM="$(< "$HOME/.ssh/codex_mobile_rsa")"
export CODEX_MOBILE_SSH_REMOTE_API_HOST=127.0.0.1
export CODEX_MOBILE_SSH_REMOTE_API_PORT=8787
export CODEX_MOBILE_ALLOW_EMBEDDED_SSH_SECRET=true
```

The native module is in `modules/codex-ssh-tunnel`. Expo Go cannot load local
native modules; use a development build or APK.

Embedding an SSH secret is suitable only for controlled internal builds. Use a
dedicated, restricted, per-device credential and rotate it when needed.

## Android Build

With Java 17 and the Android SDK configured:

```bash
cd android
./gradlew :app:assembleDebug \
  -PreactNativeArchitectures=arm64-v8a \
  --no-daemon --console=plain --stacktrace
```

See [../build-guide/README.md](../build-guide/README.md) for the complete Linux
host, SSH, and APK workflow.

## Checks

```bash
npm run typecheck
npm test
npm run web
```

## Structure

- `src/screens/`: primary app screens and screen-specific components.
- `src/components/`: reusable UI components.
- `src/state/BridgeProvider.tsx`: bridge client and central React state.
- `src/domain/`: bridge types, mentions, message parsing, and composer logic.
- `src/api/`: HTTP/SSE client.
- `src/transport/`: SSH tunnel manager.
- `src/config/`, `src/storage/`, `src/theme/`, `src/utils/`: configuration,
  preferences, styling, and utilities.
- `modules/codex-ssh-tunnel/`: native Android SSH tunnel module.
