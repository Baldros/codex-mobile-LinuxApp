# Linux Build and Deployment Guide

This guide takes a Linux host from a fresh checkout to a working Android APK
connected to the Codex Bridge over an SSH tunnel. Commands for Debian and Ubuntu
are shown first; translate package names for another distribution.

For the independently validated design that runs a second WireGuard interface
alongside an existing corporate VPN, see
[WIREGUARD_ANDROID_RUNBOOK.md](WIREGUARD_ANDROID_RUNBOOK.md).

## 1. Architecture and Security Boundary

```text
Android 127.0.0.1:18080
  -> encrypted SSH connection to the Linux host
  -> SSH local forwarding to 127.0.0.1:8787
  -> Codex Bridge
  -> local Codex CLI and workspaces
```

Port 8787 must remain on loopback. Only the SSH service should be reachable from
the network. The Android app never needs direct access to the OpenAI API or to
the host filesystem.

## 2. Install Linux Prerequisites

On Debian or Ubuntu:

```bash
sudo apt update
sudo apt install -y \
  git curl unzip jq openssh-client openssh-server \
  openjdk-17-jdk adb
sudo systemctl enable --now ssh
```

On Fedora, the corresponding packages include `git`, `curl`, `unzip`, `jq`,
`openssh-clients`, `openssh-server`, `java-17-openjdk-devel`, and
`android-tools`; enable `sshd` instead of `ssh`.

Install Node.js 18 or newer using your distribution packages or preferred
version manager. CI uses Node.js 24. Confirm the toolchain:

```bash
node --version
npm --version
java -version
ssh -V
adb version
```

Install the Codex CLI with the official Linux installer and authenticate:

```bash
curl -fsSL https://chatgpt.com/codex/install.sh | sh
codex
codex login status
```

## 3. Install the Android SDK

Install Android Studio or the official Android command-line tools. This project
currently compiles against Android API 36.

For a command-line installation, arrange the tools so that `sdkmanager` is
under `$HOME/Android/Sdk/cmdline-tools/latest/bin`, then add these variables to
your shell profile:

```bash
export ANDROID_HOME="$HOME/Android/Sdk"
export PATH="$PATH:$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin"
```

Open a new terminal and install the required SDK components:

```bash
yes | sdkmanager --licenses
sdkmanager \
  'platform-tools' \
  'platforms;android-36' \
  'build-tools;36.0.0'
```

If Gradle cannot locate the SDK, create the ignored local configuration:

```bash
printf 'sdk.dir=%s\n' "$ANDROID_HOME" > mobile/android/local.properties
```

## 4. Prepare the Repository

From the repository root:

```bash
chmod +x scripts/*.sh mobile/android/gradlew
./scripts/setup_linux.sh
```

The script creates `config/workspaces.allowlist` with the checkout path. Add any
other permitted repositories as absolute paths, one per line:

```text
/home/your-user/src/codex-mobile-app
/home/your-user/src/another-project
```

## 5. Start and Verify the Bridge

Run the bridge as the Linux user who owns the Codex configuration and
workspaces:

```bash
cd backend
npm run dev
```

In a second terminal:

```bash
curl --fail --silent http://127.0.0.1:8787/health | jq
```

The response should report `codex_ready: true` and an `app-server` active
transport. For an end-to-end local test:

```bash
cd backend
npm run smoke:app-server
```

## 6. Create a Restricted SSH Tunnel Account

Create an unprivileged account that owns no project files and has no sudo
access:

```bash
sudo adduser --disabled-password --gecos '' codex-tunnel
```

Generate a separate RSA PEM key for the Android device:

```bash
mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
ssh-keygen -t rsa -b 4096 -m PEM -f "$HOME/.ssh/codex_mobile_rsa"
```

Install only its public key for the tunnel account:

```bash
sudo install -d -o codex-tunnel -g codex-tunnel -m 700 \
  /home/codex-tunnel/.ssh
sudo install -o codex-tunnel -g codex-tunnel -m 600 \
  "$HOME/.ssh/codex_mobile_rsa.pub" \
  /home/codex-tunnel/.ssh/authorized_keys
```

Create `/etc/ssh/sshd_config.d/90-codex-mobile.conf` with `sudoedit`:

```text
Match User codex-tunnel
    AuthenticationMethods publickey
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    AllowTcpForwarding local
    PermitOpen 127.0.0.1:8787
    GatewayPorts no
    X11Forwarding no
    AllowAgentForwarding no
    PermitTTY no
```

Validate before restarting the service:

```bash
sudo sshd -t
sudo systemctl restart ssh
```

Use `sshd` as the service name on distributions that name it that way. Verify a
local forward while the bridge is running:

```bash
ssh -N \
  -L 18080:127.0.0.1:8787 \
  -i "$HOME/.ssh/codex_mobile_rsa" \
  codex-tunnel@127.0.0.1
```

Then, in another terminal:

```bash
curl --fail http://127.0.0.1:18080/health
```

## 7. Configure Network Access

For same-network use, point the app at the host's LAN address and SSH port. For
mobile-data use, prefer a private overlay network or VPN. If you expose SSH
through a router, forward only the chosen public TCP port to the Linux SSH port
and restrict the host firewall to the smallest practical source range.

Never expose bridge port 8787. Confirm that the public endpoint is reachable
from outside the home network before building it into the APK.

## 8. Configure the Android Build

Build-time settings are read from the shell environment:

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

The host list is comma-separated. Bracket literal IPv6 addresses so the parser
can distinguish the address from its port.

These values are compiled into the application. A key embedded in an APK can
be extracted, so use a key dedicated to one device and revoke it by removing
its public-key line from `authorized_keys`.

## 9. Build and Install the APK

Connect an Android phone with USB debugging enabled and confirm authorization:

```bash
adb devices
```

Build the debug APK:

```bash
cd mobile/android
./gradlew :app:assembleDebug \
  -PreactNativeArchitectures=arm64-v8a \
  --no-daemon --console=plain --stacktrace
```

Install it:

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

For the current internal release build:

```bash
./gradlew :app:assembleRelease \
  -PreactNativeArchitectures=arm64-v8a \
  --no-daemon --console=plain --stacktrace
adb install -r app/build/outputs/apk/release/app-release.apk
```

The checked-in release configuration currently uses the debug signing key. Do
not distribute that artifact as a production release; configure a private
release keystore first.

## 10. Validate and Troubleshoot

Run the host validator while the bridge and SSH service are active:

```bash
./scripts/validate_ssh_tunnel_ready.sh
```

Useful diagnostics:

```bash
sudo journalctl -u ssh -u sshd --since '15 minutes ago'
ss -ltnp
curl --fail http://127.0.0.1:8787/health
adb logcat
```

Common failures:

- `codex_ready: false`: run `codex login status` as the bridge user and verify
  that `codex` is in that user's `PATH`.
- SSH authentication fails: verify ownership and modes on
  `/home/codex-tunnel/.ssh` and `authorized_keys`, then inspect the service log.
- Forwarding is denied: ensure `PermitOpen` exactly matches
  `127.0.0.1:8787` and restart the SSH service after `sshd -t` succeeds.
- Gradle cannot find Java: set `JAVA_HOME` to a Java 17 installation.
- Gradle cannot find the SDK: verify `ANDROID_HOME` and
  `mobile/android/local.properties`.
- Device is missing from `adb devices`: enable USB debugging, accept the phone's
  authorization prompt, and check USB permissions or udev rules.

## Credential Rotation

To revoke one device, remove its public key from
`/home/codex-tunnel/.ssh/authorized_keys`, restart the app tunnel, generate a new
per-device key, and rebuild the APK. Keep private keys, keystores, APKs, and
local environment files out of Git.
