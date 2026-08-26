# Codex Mobile on Android over an Isolated WireGuard Tunnel

This runbook documents the complete Linux-to-Android setup validated on
2026-08-26 for this repository. It covers the Android toolchain, repository
checks, release APK build and installation, an isolated WireGuard server on the
Linux host, UFW rules, the Codex Bridge, device-side validation, and the
failures encountered during the original setup.

The existing `build-guide/README.md` remains the canonical SSH-tunnel guide.
This document describes the separate WireGuard design.

## 1. Validated Result and Current Scope

The validated local topology is:

```text
Samsung Android phone
  Wi-Fi address:       192.168.1.5
  WireGuard address:   10.77.77.2/32
  Codex Mobile URL:    http://10.77.77.1:8787
             |
             | WireGuard, UDP 51821
             | split route: only 10.77.77.1/32
             v
Linux host
  Wi-Fi address:       192.168.1.6
  private interface:   wg-codex, 10.77.77.1/24
  bridge listener:     10.77.77.1:8787/TCP
  Codex runtime:       app-server

Corporate VPN on the same Linux host
  interface:           wg0
  address:             10.0.0.34/32
  corporate peer:      10.0.0.1
  status:              left active and unchanged
```

Both Linux WireGuard interfaces were active simultaneously. The Android phone
successfully completed a WireGuard handshake, routed `10.77.77.1` through its
`tun0` interface, pinged the host without packet loss, and established a TCP
connection to port `8787`.

The current setup is validated on the same Wi-Fi network. Access from mobile
data is a separate final deployment step requiring a reachable public endpoint,
described in Section 22 below.

## 2. Security Model

The private tunnel is deliberately independent of the corporate VPN:

- Never modify `/etc/wireguard/wg0.conf` for this setup.
- Use the separate `wg-codex` interface and `wg-quick@wg-codex` service.
- Use a separate subnet, UDP port, server key, and phone key.
- On the phone, route only `10.77.77.1/32` through WireGuard.
- Do not set `AllowedIPs = 0.0.0.0/0`.
- Do not add NAT, masquerading, `PostUp`, `PostDown`, or forwarding rules.
- Keep UFW's routed-traffic default set to `deny`.
- Bind the Codex Bridge specifically to `10.77.77.1`, never `0.0.0.0`.
- Never forward TCP port `8787` on the Internet-facing router.
- The only Internet-facing port, if remote access is enabled later, is
  WireGuard UDP `51821`.

The bridge has no independent public-network authentication boundary. Its
network boundary is the authenticated WireGuard peer plus the host firewall.

The host already had IPv4 forwarding enabled, most likely for Docker:

```text
net.ipv4.ip_forward = 1
```

That setting was not changed. Isolation is maintained because the phone routes
only the host address, the server peer accepts only the phone address, UFW
defaults to `deny (routed)`, and no forwarding allow-rule was added for
`wg-codex`.

## 3. Environment Used During Validation

The validated machine and device were:

| Component | Validated value |
| --- | --- |
| Host OS | Ubuntu 24.04.4 LTS, x86_64 |
| Kernel | `7.0.0-30-generic` |
| Repository | `/home/techbrain/andre/codex-mobile-app` |
| Java | OpenJDK/Javac `17.0.20` |
| Node.js | `v25.9.0` |
| npm | `11.15.0` |
| Gradle wrapper | `9.3.1` |
| Android SDK | `/home/techbrain/Android/Sdk` |
| Android platform | API 36 |
| Build Tools | `35.0.0` and `36.0.0` |
| Platform Tools / ADB | `37.0.1-15733141` |
| NDK | `27.1.12297006` |
| CMake | `3.22.1` |
| Device | Samsung SM-A156M, Android 16/API 36 |
| Device serial | `RXCX903S3SZ` |
| Device ABI | `arm64-v8a` |
| Android package | `internal.codex.mobile` |
| App version | `0.1.0`, version code 1 |

Node.js 18 or newer is supported by the repository; CI currently uses Node.js
24. The exact Node.js version above records the validated workstation, not a
requirement to install Node.js 25.

## 4. Install Host Prerequisites

For Ubuntu or Debian, install the base packages:

```bash
sudo apt update
sudo apt install -y \
  git curl unzip jq \
  openjdk-17-jdk \
  wireguard-tools ufw
```

Install Node.js 18 or newer with the preferred package manager or version
manager. Confirm the tools:

```bash
node --version
npm --version
java -version
javac -version
wg --version
adb version
```

Install and authenticate the Codex CLI as the Linux user who owns the
workspaces and will run the bridge:

```bash
curl -fsSL https://chatgpt.com/codex/install.sh | sh
codex
codex login status
codex --version
```

Do not run the Codex Bridge as root.

## 5. Configure Java and Android Environment Variables Permanently

Edit the login-shell profile:

```bash
nano ~/.profile
```

Append these lines at the end of the file:

```bash
export JAVA_HOME="/usr/lib/jvm/java-17-openjdk-amd64"
export ANDROID_HOME="$HOME/Android/Sdk"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
```

This is persistent because `~/.profile` is read by login shells. Apply it to
the current terminal without logging out:

```bash
source ~/.profile
```

Verify the selected tools and paths:

```bash
printf 'JAVA_HOME=%s\n' "$JAVA_HOME"
printf 'ANDROID_HOME=%s\n' "$ANDROID_HOME"
command -v java
command -v javac
command -v adb
command -v sdkmanager
java -version
javac -version
adb version
```

If `~/.bash_profile` or `~/.bash_login` exists, Bash may not read
`~/.profile`. Ensure the active login profile sources `~/.profile`, or place
the same exports in the profile Bash actually reads.

## 6. Install the Android SDK Components

Place the official Android command-line tools so `sdkmanager` is available at:

```text
$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager
```

Accept licenses and install all components used by this project:

```bash
yes | sdkmanager --licenses
```

```bash
sdkmanager \
  'platform-tools' \
  'platforms;android-36' \
  'build-tools;36.0.0' \
  'ndk;27.1.12297006' \
  'cmake;3.22.1'
```

Gradle also installed Build Tools `35.0.0` while resolving Android build
requirements on the validated host.

Create the ignored local SDK pointer from the repository root:

```bash
printf 'sdk.dir=%s\n' "$ANDROID_HOME" > mobile/android/local.properties
```

The validated file contains:

```text
sdk.dir=/home/techbrain/Android/Sdk
```

Verify installed SDK directories:

```bash
find "$ANDROID_HOME/platforms" \
     "$ANDROID_HOME/build-tools" \
     "$ANDROID_HOME/ndk" \
     "$ANDROID_HOME/cmake" \
  -mindepth 1 -maxdepth 1 -type d -print | sort
```

## 7. Prepare and Verify the Repository

From the repository root:

```bash
cd /home/techbrain/andre/codex-mobile-app
chmod +x scripts/*.sh mobile/android/gradlew
./scripts/setup_linux.sh
```

The equivalent explicit dependency and verification commands are:

```bash
npm --prefix backend ci
npm --prefix mobile ci
```

```bash
npm --prefix backend run typecheck
npm --prefix backend test
npm --prefix backend run build
npm --prefix backend run smoke:app-server
```

```bash
npm --prefix mobile run typecheck
npm --prefix mobile test
```

During the validated session:

- Backend type checking and build passed.
- All 33 backend tests passed.
- The real bridge-to-Codex app-server smoke test passed.
- Mobile type checking passed.
- All 12 mobile tests passed.

Confirm the workspace allowlist contains the repository path:

```bash
sed -n '1,120p' config/workspaces.allowlist
```

The file is local and ignored by Git.

## 8. Connect and Inspect the Android Device

On the phone, enable Developer Options and USB debugging. Connect it over USB
and accept the Android authorization prompt.

Run:

```bash
adb devices -l
```

The validated device appeared as:

```text
RXCX903S3SZ  device  product:a15xub model:SM_A156M device:a15x
```

Inspect Android and ABI details:

```bash
adb shell getprop ro.product.manufacturer
adb shell getprop ro.product.model
adb shell getprop ro.build.version.release
adb shell getprop ro.build.version.sdk
adb shell getprop ro.product.cpu.abilist
```

Check for an existing installation:

```bash
adb shell pm list packages | grep internal.codex.mobile
adb shell dumpsys package internal.codex.mobile \
  | grep -E 'versionCode|versionName|firstInstallTime|lastUpdateTime'
```

The phone already contained `internal.codex.mobile` version `0.1.0`. Its
certificate matched the repository debug keystore, so `adb install -r` could
replace it without uninstalling or clearing app data.

To inspect an existing APK and compare its signer:

```bash
installed_apk_path="$(
  adb shell pm path internal.codex.mobile \
    | sed 's/^package://' \
    | tr -d '\r'
)"
```

```bash
adb pull "$installed_apk_path" /tmp/codex-mobile-installed.apk
```

```bash
"$ANDROID_HOME/build-tools/36.0.0/apksigner" \
  verify --verbose --print-certs /tmp/codex-mobile-installed.apk
```

The validated signer certificate SHA-256 was:

```text
fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c
```

## 9. Configure the Mobile App for Direct WireGuard HTTP

The app reads build-time values from `mobile/.env.local`. Create this ignored
file from the repository root:

```bash
printf '%s\n' \
  'CODEX_MOBILE_GATEWAY=http' \
  'CODEX_MOBILE_API_BASE_URL=http://10.77.77.1:8787' \
  > mobile/.env.local
```

Verify it:

```bash
sed -n '1,20p' mobile/.env.local
```

Expected content:

```text
CODEX_MOBILE_GATEWAY=http
CODEX_MOBILE_API_BASE_URL=http://10.77.77.1:8787
```

During the first release build, the temporary address
`http://10.0.0.34:8787` was embedded before it was recognized as the corporate
VPN address. The file was subsequently corrected to `10.77.77.1`. A preference
saved in the app's Settings overrides the build-time default, so the already
installed APK did not need to be rebuilt for the final local test.

## 10. Keep Metro and Gradle Within the Host Memory Budget

The host had approximately 7.4 GiB RAM and 4 GiB swap. Parallel Gradle, native
C++ builds, Kotlin, and Metro exhausted memory during the first attempts.

The React Native block in `mobile/android/app/build.gradle` was updated to cap
Metro's worker pool:

```groovy
// Keep Metro within the memory budget of developer machines. Override with
// -PreactNativeMaxWorkers=N when more parallelism is desirable.
extraPackagerArgs = ["--max-workers", (findProperty('reactNativeMaxWorkers') ?: "1").toString()]
```

The build commands also use one Gradle worker, disable Gradle parallelism,
compile Kotlin in process, limit native build parallelism, and build only the
phone's `arm64-v8a` ABI.

Useful memory diagnostics used during the session were:

```bash
free -h
ps -eo pid,ppid,rss,comm,args --sort=-rss | head -n 15
dmesg -T | tail -n 30
```

Reading `dmesg` may require root privileges:

```bash
sudo dmesg -T | tail -n 30
```

## 11. Build Debug and Release APKs

The exact memory-constrained debug build command that succeeded during the
session was:

```bash
cd /home/techbrain/andre/codex-mobile-app/mobile/android
```

```bash
NODE_ENV=development \
CODEX_MOBILE_GATEWAY=http \
CODEX_MOBILE_API_BASE_URL=http://10.0.0.34:8787 \
CMAKE_BUILD_PARALLEL_LEVEL=1 \
./gradlew :app:assembleDebug \
  -PreactNativeArchitectures=arm64-v8a \
  -Pkotlin.compiler.execution.strategy=in-process \
  -Dorg.gradle.parallel=false \
  '-Dorg.gradle.jvmargs=-Xmx1536m -XX:MaxMetaspaceSize=384m' \
  --max-workers=1 \
  --no-daemon \
  --console=plain \
  --stacktrace
```

That address was later identified as the corporate VPN address. It is retained
here only to make the historical command record exact. New builds must use the
final `mobile/.env.local` value `http://10.77.77.1:8787`.

The debug APK is written to:

```text
mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

That debug APK does not contain a standalone `index.android.bundle`; it expects
a Metro development server. Use the release APK for a phone that must start
independently.

The final release command was:

```bash
cd /home/techbrain/andre/codex-mobile-app/mobile/android
```

```bash
NODE_ENV=production \
NODE_OPTIONS=--max-old-space-size=1536 \
CMAKE_BUILD_PARALLEL_LEVEL=1 \
./gradlew :app:assembleRelease \
  -PreactNativeArchitectures=arm64-v8a \
  -PreactNativeMaxWorkers=1 \
  -Pkotlin.compiler.execution.strategy=in-process \
  -Dorg.gradle.parallel=false \
  '-Dorg.gradle.jvmargs=-Xmx1024m -XX:MaxMetaspaceSize=384m' \
  --max-workers=1 \
  --no-daemon \
  --console=plain \
  --stacktrace
```

The successful build reported:

```text
BUILD SUCCESSFUL in 5m 32s
872 actionable tasks: 528 executed, 344 up-to-date
```

The output is:

```text
mobile/android/app/build/outputs/apk/release/app-release.apk
```

## 12. Validate the Release APK

From `mobile/android`:

```bash
release_apk=app/build/outputs/apk/release/app-release.apk
```

```bash
stat --printf='path=%n\nsize=%s bytes\nmodified=%y\n' "$release_apk"
sha256sum "$release_apk"
```

```bash
"$ANDROID_HOME/build-tools/36.0.0/apksigner" \
  verify --verbose --print-certs "$release_apk"
```

```bash
"$ANDROID_HOME/build-tools/36.0.0/aapt2" \
  dump badging "$release_apk" | head -n 20
```

```bash
unzip -l "$release_apk" \
  | grep -E 'index.android.bundle|app.config|lib/arm|lib/x86'
```

Inspect the embedded Expo configuration:

```bash
unzip -p "$release_apk" assets/app.config \
  | jq '{name,slug,version,android,extra}'
```

The validated artifact produced during the session had:

```text
size:   48181109 bytes
SHA256: 380c0acfbcf692caa07cbc29016bdb1dc1a77234235602620dc36dc01bbbabbf
```

That checksum belongs to the earlier build that embedded `10.0.0.34`; it will
change after rebuilding with the final `10.77.77.1` configuration.

The APK contained:

```text
assets/app.config
assets/index.android.bundle
lib/arm64-v8a/...
```

It used APK Signature Scheme v2 and the repository debug certificate. This is
acceptable for an internal build but not for public distribution. Configure a
private release keystore before distributing the app externally.

## 13. Install and Launch the App

Install or update while preserving the existing app data:

```bash
adb install -r \
  /home/techbrain/andre/codex-mobile-app/mobile/android/app/build/outputs/apk/release/app-release.apk
```

Google Play Protect may display an **Install anyway** confirmation. Approve it
on the phone; do not try to bypass that security prompt with ADB input events.

Launch and inspect the app:

```bash
adb shell am force-stop internal.codex.mobile
adb shell am start -W -n internal.codex.mobile/.MainActivity
sleep 8
adb shell pidof internal.codex.mobile
```

```bash
adb shell dumpsys activity activities \
  | grep -m 5 -E 'mResumedActivity|internal.codex.mobile'
```

```bash
app_pid="$(adb shell pidof internal.codex.mobile | tr -d '\r')"
adb logcat -d --pid="$app_pid" -t 500
```

Optional screenshot diagnostics used during the session:

```bash
adb exec-out screencap -p > /tmp/codex-mobile-screen.png
```

The release app loaded its embedded JavaScript bundle and displayed the Codex
Mobile home screen without a fatal exception.

Because `adb install -r` preserved app data, it also preserved the old bridge
preference `http://127.0.0.1:18080`. This saved preference took precedence over
the new APK default. The final URL was changed in the app under:

```text
Settings -> Bridge -> http://10.77.77.1:8787 -> Save URL
```

Do not clear app data merely to change the URL; clearing data also removes other
local preferences.

## 14. Install WireGuard on Android

Install the official free Android app:

```text
Name:      WireGuard
Developer: WireGuard Development Team
Package:   com.wireguard.android
```

Verify it over ADB:

```bash
adb shell pm list packages \
  | grep -E 'com.wireguard.android|internal.codex.mobile'
```

The WireGuard app is free and open source. A commercial VPN subscription is not
required when this Linux host is the server.

Android permits only one active VPN service per user/profile. That does not
affect the validated design because the corporate VPN runs on the Linux host,
not on the phone.

## 15. Audit the Existing Corporate VPN Before Making Changes

The following read-only checks were performed:

```bash
wg show
ip -brief address
ip route show table main
nmcli -t -f NAME,TYPE,DEVICE connection show --active
systemctl is-active wg-quick@wg0
systemctl status wg-quick@wg0 --no-pager -n 20
```

`wg show` required root privileges on this host, but the remaining output was
enough to identify the topology:

```text
wg0 address: 10.0.0.34/32
wg0 route:   10.0.0.1/32
service:     wg-quick@wg0 active
```

The host was a client of the corporate VPN, not its server. That invalidated
the initial idea of adding the phone to `wg0`.

The more complete read-only audit was:

```bash
ip rule show
ip route show table all
ss -lunp
ss -ltnp
command -v wg
command -v wg-quick
command -v ufw
command -v nft
command -v iptables
systemctl is-active ufw
systemctl is-active firewalld
systemctl is-active nftables
sysctl net.ipv4.ip_forward net.ipv6.conf.all.forwarding
```

Then inspect UFW with root privileges:

```bash
sudo ufw status verbose
```

Important validated defaults:

```text
Default: deny (incoming), allow (outgoing), deny (routed)
```

Pre-existing rules for UDP `51820` and forwarding from `wg0` to `eth0` were
left unchanged. The host currently used `wlo1`, so the `eth0` forwarding rule
appeared stale, but it was not removed because its ownership and purpose were
not established.

## 16. Create the Phone Tunnel and Keys

In the Android WireGuard app:

1. Tap `+`.
2. Select **Create from scratch**.
3. Name the tunnel `codex-mobile`.
4. Generate a private key in the app.
5. Set **Addresses** to `10.77.77.2/32`.
6. Leave DNS empty.
7. Copy only the displayed public key.

`/32` is a CIDR prefix meaning one IPv4 address. It is not a port number.

The validated phone public key was:

```text
HJ1tMiI6r/8GhOBfhyBYz8Q3US/h7R3+NOfaugOPiHI=
```

Public keys are not secrets. The phone private key must never leave the phone
or be pasted into a terminal, document, or chat.

Generate the independent server key on the Linux host:

```bash
sudo sh -c 'umask 077; wg genkey > /etc/wireguard/wg-codex.key'
```

```bash
sudo sh -c 'umask 077; wg pubkey < /etc/wireguard/wg-codex.key > /etc/wireguard/wg-codex.pub'
```

Verify modes and sizes without exposing the private key:

```bash
sudo stat -c '%n | size=%s | mode=%a | owner=%U:%G' \
  /etc/wireguard/wg-codex.key \
  /etc/wireguard/wg-codex.pub
```

Both files were approximately 45 bytes with mode `600` and owner `root:root`.

Display only the public key:

```bash
sudo cat /etc/wireguard/wg-codex.pub
```

The validated server public key was:

```text
RCjBdkYPJ90+JGmjh7P3Mdn9E+C/3hFTv0DDVL6oHi0=
```

## 17. Complete the Android Peer

In the `codex-mobile` tunnel, add a peer with:

| Field | Local validation value |
| --- | --- |
| Public key | `RCjBdkYPJ90+JGmjh7P3Mdn9E+C/3hFTv0DDVL6oHi0=` |
| Preshared key | empty |
| Endpoint | `192.168.1.6:51821` |
| Allowed IPs | `10.77.77.1/32` |
| Persistent keepalive | `25`, or empty for the first LAN-only test |

Persistent keepalive `25` means an authenticated maintenance packet is sent
every 25 seconds while idle. It is not a 25-second connection duration. It is
useful later across mobile-carrier and router NAT; the tunnel remains active
until it is disabled.

Save the tunnel. It cannot handshake until the Linux interface is created and
started.

## 18. Create `/etc/wireguard/wg-codex.conf` Safely

The session used a root-only helper that verified the generated server key,
validated the phone public key, refused to overwrite an existing config, wrote
the file atomically with mode `600`, and did not start any interface.

The helper below is the English-language equivalent of the exact helper used
during the session:

```bash
#!/usr/bin/env bash

set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Run this script with sudo." >&2
  exit 1
fi

readonly interface_name="wg-codex"
readonly config_file="/etc/wireguard/${interface_name}.conf"
readonly private_key_file="/etc/wireguard/${interface_name}.key"
readonly expected_server_public_key="RCjBdkYPJ90+JGmjh7P3Mdn9E+C/3hFTv0DDVL6oHi0="
readonly phone_public_key="HJ1tMiI6r/8GhOBfhyBYz8Q3US/h7R3+NOfaugOPiHI="

if [[ -e ${config_file} ]]; then
  echo "Refusing to overwrite ${config_file}." >&2
  exit 1
fi

if [[ ! -s ${private_key_file} ]]; then
  echo "Private key is absent or empty: ${private_key_file}" >&2
  exit 1
fi

actual_server_public_key="$(wg pubkey < "${private_key_file}")"
if [[ ${actual_server_public_key} != "${expected_server_public_key}" ]]; then
  echo "Private key does not match the confirmed public key." >&2
  exit 1
fi

phone_key_size="$(printf '%s' "${phone_public_key}" | base64 --decode | wc -c)"
if [[ ${phone_key_size} -ne 32 ]]; then
  echo "Phone public key is invalid." >&2
  exit 1
fi

umask 077
tmp_file="$(mktemp --tmpdir=/etc/wireguard wgcXXXXXX.conf)"
trap 'rm -f -- "${tmp_file}"' EXIT

private_key="$(<"${private_key_file}")"
cat > "${tmp_file}" <<EOF
[Interface]
Address = 10.77.77.1/24
ListenPort = 51821
PrivateKey = ${private_key}

[Peer]
PublicKey = ${phone_public_key}
AllowedIPs = 10.77.77.2/32
EOF
unset private_key

chmod 600 "${tmp_file}"
wg-quick strip "${tmp_file}" >/dev/null
ln "${tmp_file}" "${config_file}"
rm -f -- "${tmp_file}"
trap - EXIT

echo "Configuration created and validated: ${config_file}"
sed 's/^PrivateKey = .*/PrivateKey = (hidden)/' "${config_file}"
echo "No interface was started and no firewall rule was changed."
```

It was saved temporarily as `/tmp/configure-wg-codex.sh`, syntax-checked, and
executed:

```bash
bash -n /tmp/configure-wg-codex.sh
bash /tmp/configure-wg-codex.sh
sudo bash /tmp/configure-wg-codex.sh
```

The non-root execution intentionally returned `Run this script with sudo.`
The root execution created this validated configuration:

```ini
[Interface]
Address = 10.77.77.1/24
ListenPort = 51821
PrivateKey = <server-private-key-read-from-root-only-file>

[Peer]
PublicKey = HJ1tMiI6r/8GhOBfhyBYz8Q3US/h7R3+NOfaugOPiHI=
AllowedIPs = 10.77.77.2/32
```

There are intentionally no `PostUp`, `PostDown`, NAT, DNS, or forwarding
entries.

## 19. Add the Minimal UFW Rules

Allow the WireGuard handshake only through the current Wi-Fi interface:

```bash
sudo ufw allow in on wlo1 to any port 51821 proto udp comment 'WireGuard Codex'
```

Allow the bridge only through the authenticated private interface:

```bash
sudo ufw allow in on wg-codex to 10.77.77.1 port 8787 proto tcp comment 'Codex Bridge'
```

Inspect the result:

```bash
sudo ufw status numbered
```

The relevant validated rules were:

```text
51821/udp on wlo1                    ALLOW IN  Anywhere
10.77.77.1 8787/tcp on wg-codex     ALLOW IN  Anywhere
51821/udp (v6) on wlo1               ALLOW IN  Anywhere (v6)
```

Do not add a UFW `route` or `forward` rule for `wg-codex`.

If the host later switches from Wi-Fi to a wired interface, add an explicit
WireGuard UDP rule for that interface only after confirming its name. Do not
replace the interface-specific rule with an unnecessarily broad bridge rule.

## 20. Start and Validate the Private WireGuard Interface

Start it for the first test without enabling it at boot:

```bash
sudo systemctl start wg-quick@wg-codex
```

If this reports an error, stop and inspect it instead of repeatedly retrying:

```bash
sudo systemctl status wg-quick@wg-codex --no-pager -n 20
sudo journalctl -u wg-quick@wg-codex --since '10 minutes ago' --no-pager
```

On success, inspect the interface:

```bash
sudo systemctl status wg-quick@wg-codex --no-pager -n 20
sudo wg show wg-codex
ip -brief address show wg-codex
ip route show 10.77.77.0/24
```

Activate `codex-mobile` on the phone. The validated handshake showed:

```text
interface public key: RCjBdkYPJ90+JGmjh7P3Mdn9E+C/3hFTv0DDVL6oHi0=
listening port:       51821
peer public key:      HJ1tMiI6r/8GhOBfhyBYz8Q3US/h7R3+NOfaugOPiHI=
peer endpoint:        192.168.1.5:43523
allowed IPs:          10.77.77.2/32
latest handshake:     present
transfer:             bytes received and sent
```

The phone source port is ephemeral and may change. It does not need to equal
`51821`.

Confirm the phone route and reachability over ADB:

```bash
adb shell ip route get 10.77.77.1
adb shell ping -c 3 -W 2 10.77.77.1
```

Validated route:

```text
10.77.77.1 dev tun0 table 1051 src 10.77.77.2
```

The ping test received all three replies with 0% packet loss.

Confirm both Linux VPN services remain active:

```bash
ip -brief address show wg0
ip -brief address show wg-codex
systemctl is-active wg-quick@wg0
systemctl is-active wg-quick@wg-codex
```

Both returned `active` during validation.

After a successful test, enabling only the private interface at boot is an
optional follow-up that was not executed during the session:

```bash
sudo systemctl enable wg-quick@wg-codex
```

## 21. Start the Codex Bridge on the Private Address

Build the backend:

```bash
cd /home/techbrain/andre/codex-mobile-app/backend
npm run build
```

Start the validated production JavaScript directly in a foreground terminal:

```bash
NODE_ENV=production \
CODEX_BRIDGE_HOST=10.77.77.1 \
CODEX_BRIDGE_PORT=8787 \
npm start
```

Expected startup event:

```json
{"event":"bridge_listening","address":"http://10.77.77.1:8787","runtime":"app-server","workspace_allowlist":["/home/techbrain/andre/codex-mobile-app"]}
```

In another host terminal, verify the exact listener and health endpoint:

```bash
ss -ltn 'sport = :8787'
```

```bash
curl --fail --silent --show-error --max-time 5 \
  http://10.77.77.1:8787/health | jq
```

The validated response reported:

```json
{
  "status": "ok",
  "codex_ready": true,
  "auth": "ok",
  "active_transport": "app-server"
}
```

Android did not provide `curl` but did provide Toybox `nc`. Verify TCP from the
phone:

```bash
adb shell 'nc -z -w 5 10.77.77.1 8787; echo exit=$?'
```

Expected result:

```text
exit=0
```

Finally, in Codex Mobile set:

```text
Settings -> Bridge -> http://10.77.77.1:8787 -> Save URL
```

Return to the home screen and confirm the status changes from `offline` to
`online`. Select an allowed repository and create a conversation to validate a
real Codex run.

The foreground `npm start` process is temporary. Closing its terminal stops the
bridge.

## 22. Access From Mobile Data — Not Yet Executed

The local endpoint `192.168.1.6:51821` works only while the phone can reach the
host's home LAN. For mobile-data access:

1. Give the Linux host a fixed DHCP lease on the router.
2. Determine whether the Internet connection has a reachable public IPv4
   address or is behind carrier-grade NAT (CGNAT).
3. If public IPv4 is available, forward router UDP port `51821` to
   `192.168.1.6:51821`.
4. Use a DNS name with dynamic DNS if the public address changes.
5. Change only the phone peer's endpoint to `vpn.example.net:51821`.
6. Keep `AllowedIPs = 10.77.77.1/32`.
7. Test with Wi-Fi disabled on the phone.
8. Never forward TCP `8787`.

If the ISP uses CGNAT and does not provide a public endpoint, direct inbound
WireGuard cannot work without an external rendezvous/server, an IPv6 design, a
public VPS, or an overlay service. Do not weaken the firewall to work around
CGNAT.

## 23. Persistence After Reboot — Not Yet Executed

The WireGuard service can be enabled after local and remote tests pass:

```bash
sudo systemctl enable wg-quick@wg-codex
```

The bridge must run as `techbrain`, not root, because Codex authentication and
workspaces belong to that user. A user-level systemd service is appropriate,
but it was not installed during the validated session. Before creating one,
record the current Node.js binary because this host uses NVM:

```bash
command -v node
```

Validated path at the time of setup:

```text
/home/techbrain/.nvm/versions/node/v25.9.0/bin/node
```

Re-check that path after Node.js upgrades. A future user service should set:

```text
WorkingDirectory=/home/techbrain/andre/codex-mobile-app/backend
NODE_ENV=production
CODEX_BRIDGE_HOST=10.77.77.1
CODEX_BRIDGE_PORT=8787
```

It should start `backend/dist/server.js`, restart on failure, and run only after
the network and `wg-codex` are available. Treat this as a separate deployment
change and test its logs before enabling user lingering.

## 24. Using the Same App With Different Machines

The same `internal.codex.mobile` installation can connect to different Linux
hosts by changing the saved Bridge URL in Settings. It stores one active bridge
URL at a time; it does not currently provide named machine profiles or an
automatic host selector.

For multiple hosts:

- Give every host a distinct WireGuard address.
- Add only the necessary host addresses to the phone tunnel's `AllowedIPs`, or
  create separate phone tunnels.
- Change the Codex Mobile Bridge URL when switching hosts.
- Do not reuse server private keys across hosts.

A named host/profile picker would require an application feature change.

## 25. Troubleshooting and Recovery From Failures Seen in This Session

### 25.1 Gradle daemon disappeared during native compilation

Symptom:

```text
Gradle build daemon disappeared unexpectedly
```

Kernel diagnostics confirmed an out-of-memory kill. The first debug/release
attempts used too much parallelism. Use the constrained release command in
Section 11 and keep Metro at one worker.

The earlier release attempt that still exhausted memory at Metro used:

```bash
NODE_ENV=production \
CMAKE_BUILD_PARALLEL_LEVEL=1 \
./gradlew :app:assembleRelease \
  -PreactNativeArchitectures=arm64-v8a \
  -Pkotlin.compiler.execution.strategy=in-process \
  -Dorg.gradle.parallel=false \
  '-Dorg.gradle.jvmargs=-Xmx1536m -XX:MaxMetaspaceSize=512m' \
  --max-workers=1 \
  --no-daemon \
  --console=plain \
  --stacktrace
```

That command did not yet limit Metro's own worker pool. The permanent
`extraPackagerArgs` change plus `-PreactNativeMaxWorkers=1` solved it.

### 25.2 Metaspace warning after a successful build

Gradle reported that the single-use daemon would expire because 384 MiB
metaspace was tight. The build still completed successfully. If sufficient RAM
is available, raise only metaspace to 512 MiB while retaining one worker:

```text
-Dorg.gradle.jvmargs=-Xmx1024m -XX:MaxMetaspaceSize=512m
```

### 25.3 Debug APK opens only with Metro

The debug APK did not contain `assets/index.android.bundle`. Build and install
`assembleRelease` for a standalone internal APK.

### 25.4 App still uses `127.0.0.1:18080`

`adb install -r` preserves AsyncStorage preferences. Open Settings, replace the
Bridge URL with `http://10.77.77.1:8787`, and tap Save URL. The saved URL
overrides the APK's build-time default.

### 25.5 Play Protect holds `adb install -r`

The ADB installation can appear stuck while Android displays
`PlayProtectDialogsActivity`. Approve **Install anyway** on the physical phone.
The installation then returns:

```text
Performing Streamed Install
Success
```

### 25.6 `wg show` returns `Operation not permitted`

Inspect WireGuard runtime details with root privileges:

```bash
sudo wg show wg-codex
```

The private key remains displayed as `(hidden)`.

### 25.7 Server key generation was broken by a pasted newline

The first long command was accidentally split between `/` and
`etc/wireguard/wg-codex.pub`. Do not run this malformed form:

```text
... wg pubkey > /
  etc/wireguard/wg-codex.pub
```

It left an empty private-key file and no public-key file. The state was checked
without displaying secrets:

```bash
sudo stat -c '%n | size=%s bytes | mode=%a | owner=%U:%G' \
  /etc/wireguard/wg-codex.key \
  /etc/wireguard/wg-codex.pub
```

Observed result:

```text
/etc/wireguard/wg-codex.key | size=0 bytes | mode=600 | owner=root:root
wg-codex.pub: No such file or directory
```

Because the private key was confirmed empty, it was safely regenerated using
the two short commands in Section 16. Never overwrite a non-empty key without
first determining whether it is already used by a peer.

### 25.8 Ping works but an Android HTTP command prints no response

Samsung's Toybox `nc` behavior differs from desktop netcat. The first raw HTTP
attempt used this command:

```bash
adb shell 'printf "GET /health HTTP/1.1\r\nHost: 10.77.77.1\r\nConnection: close\r\n\r\n" | nc -w 8 10.77.77.1 8787'
```

It did not return useful output. The available Toybox options were inspected
with:

```bash
adb shell nc --help
```

Use zero-I/O mode and inspect its exit status instead:

```bash
adb shell 'nc -z -w 5 10.77.77.1 8787; echo exit=$?'
```

`exit=0` confirms TCP connectivity. The Codex Mobile app itself is the final
HTTP/SSE client test.

### 25.9 WireGuard handshakes locally but not on mobile data

The phone endpoint is still the private LAN address `192.168.1.6:51821`.
Complete the router/public-endpoint work in Section 22. Check CGNAT before
changing firewall rules.

### 25.10 Stop the private VPN without affecting the corporate VPN

Stop only the dedicated service:

```bash
sudo systemctl stop wg-quick@wg-codex
```

Do not stop `wg-quick@wg0`.

To stop the temporary bridge, press `Ctrl+C` in its `npm start` terminal.

## 26. Final Validation Checklist

- [x] Java 17 and ADB installed and persistent in the shell profile.
- [x] Android SDK API 36, Build Tools, NDK, and CMake present.
- [x] Samsung device authorized over USB.
- [x] Backend typecheck, tests, build, and real Codex smoke test passed.
- [x] Mobile typecheck and tests passed.
- [x] Release APK built, signed, inspected, and installed.
- [x] Release app launched without a fatal exception.
- [x] Corporate `wg0` left active and unchanged.
- [x] Independent `wg-codex` keys and configuration created.
- [x] UFW permits only UDP `51821` on `wlo1` and TCP `8787` on `wg-codex`.
- [x] UFW routed traffic remains denied.
- [x] Phone WireGuard handshake succeeded.
- [x] Phone route uses `tun0` with source `10.77.77.2`.
- [x] Phone ping to `10.77.77.1` succeeded with 0% loss.
- [x] Both `wg0` and `wg-codex` were active simultaneously.
- [x] Bridge health reported Codex ready, authenticated, and using app-server.
- [x] Phone TCP connection to `10.77.77.1:8787` succeeded.
- [x] Codex Mobile Bridge URL changed to `http://10.77.77.1:8787`.
- [ ] Router/public endpoint configured for mobile-data access.
- [ ] `wg-quick@wg-codex` enabled at boot after remote testing.
- [ ] Bridge installed as a persistent non-root user service.
- [ ] Dedicated production Android release keystore configured if distribution
      expands beyond internal use.

## 27. Files Changed or Created During the Setup

Repository-local files:

```text
mobile/.env.local
mobile/android/local.properties
mobile/android/app/build.gradle
mobile/android/app/build/outputs/apk/release/app-release.apk
```

The first two and build outputs are ignored by Git. `build.gradle` contains the
tracked Metro worker-limit change.

Root-owned host files:

```text
/etc/wireguard/wg-codex.key
/etc/wireguard/wg-codex.pub
/etc/wireguard/wg-codex.conf
```

Temporary helper and diagnostics:

```text
/tmp/configure-wg-codex.sh
/tmp/codex-mobile-installed.apk
/tmp/codex-mobile-screen.png
/tmp/codex-mobile-app-screen.png
```

No file under `/etc/wireguard` for `wg0` was edited by this procedure.
