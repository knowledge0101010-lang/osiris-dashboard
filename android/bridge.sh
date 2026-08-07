#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
#  bridge.sh — connect a workstation to YOUR Android device
#
#  Runs on the workstation (not the phone). Wraps adb + ssh so a
#  Termux session on the device is reachable from a real keyboard.
#
#      ./android/bridge.sh pair 192.168.1.5:41234
#      ./android/bridge.sh connect 192.168.1.5:5555
#      ./android/bridge.sh devices
#      ./android/bridge.sh forward
#      ./android/bridge.sh ssh
#      ./android/bridge.sh push [src] [dest]
#      ./android/bridge.sh pull <src> [dest]
#      ./android/bridge.sh status
#      ./android/bridge.sh disconnect
#
#  Device access requires physical consent every time it is set up:
#  USB debugging or Wireless debugging must be enabled by hand in
#  Developer options, and wireless pairing shows a code on the
#  device screen that you must read and type. This script cannot
#  and does not bypass either. It stores no credentials.
# ═══════════════════════════════════════════════════════════════

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="$SCRIPT_DIR/.local"
SSH_PORT=8022
DEVICE_REPO_DIR="/data/data/com.termux/files/home/osiris"

say()  { printf '\033[1;36m▸\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

need_adb() {
  command -v adb >/dev/null 2>&1 || die "adb not found.
   macOS:  brew install --cask android-platform-tools
   Debian: sudo apt install android-tools-adb
   Or install Android Studio's platform-tools."
}

device_count() { adb devices | awk 'NR>1 && $2=="device"' | wc -l | tr -d ' '; }

require_device() {
  need_adb
  local n; n="$(device_count)"
  [ "$n" -ge 1 ] || die "no authorised device.
   1. On the device: Settings > About phone > tap 'Build number' 7 times
   2. Settings > System > Developer options > enable 'USB debugging'
   3. Plug in over USB and accept the 'Allow USB debugging?' prompt
   Then: ./android/bridge.sh devices"
  [ "$n" -eq 1 ] || warn "$n devices attached — adb will pick one; use ANDROID_SERIAL to choose"
}

# ── commands ─────────────────────────────────────────────────────

cmd_pair() {
  need_adb
  local target="${1:-}"
  [ -n "$target" ] || die "usage: bridge.sh pair <host:port>

   On the device: Settings > System > Developer options >
   Wireless debugging > 'Pair device with pairing code'.
   That screen shows an IP:PORT and a six-digit code.
   Pass the IP:PORT here; adb will ask for the code."

  cat <<NOTE

  Pairing with $target.
  The device will show a six-digit code — type it when prompted.
  This is the consent step; it cannot be automated away.

NOTE
  adb pair "$target"
  ok "paired. Now connect on the device's *debugging* port (a different port):"
  printf '    ./android/bridge.sh connect <host:port>\n'
}

cmd_connect() {
  need_adb
  local target="${1:-}"
  [ -n "$target" ] || die "usage: bridge.sh connect <host:port>
   The port is the one under 'Wireless debugging' (not the pairing port)."
  adb connect "$target"
  mkdir -p "$STATE_DIR"
  printf '%s\n' "$target" > "$STATE_DIR/last-device"
  cmd_devices
}

cmd_devices() {
  need_adb
  say "Attached devices"
  adb devices -l | sed 's/^/    /'
}

cmd_forward() {
  require_device
  say "Forwarding localhost:$SSH_PORT -> device:$SSH_PORT"
  adb forward "tcp:$SSH_PORT" "tcp:$SSH_PORT"
  ok "forward active. Test with: ./android/bridge.sh ssh"
}

cmd_ssh() {
  require_device
  adb forward "tcp:$SSH_PORT" "tcp:$SSH_PORT" >/dev/null

  local user
  user="$(adb shell 'echo $USER' 2>/dev/null | tr -d '\r' || true)"

  cat <<NOTE

  Opening a shell on the device over the adb-forwarded port.
  Termux's sshd must be running — start it on the device with:
      sshd
  or re-run: bash android/termux-setup.sh

NOTE
  # Termux's username is derived from the app's uid and varies per
  # install, so prefer whatever the user set in SSH_USER.
  exec ssh -p "$SSH_PORT" "${SSH_USER:-${user:-u0_a0}}@localhost"
}

cmd_push() {
  require_device
  local src="${1:-.}" dest="${2:-$DEVICE_REPO_DIR}"
  cat <<NOTE

  About to copy  $src
             to  device:$dest

  adb push overwrites files at the destination. Nothing is deleted,
  but same-named files are replaced.

NOTE
  printf '\033[1;35m?\033[0m Continue? [y/N] '
  local reply; read -r reply || reply=n
  [ "${reply,,}" = "y" ] || { warn "cancelled"; return 0; }

  adb push "$src" "$dest"
  ok "pushed"
  printf '    Termux cannot read /sdcard paths as its own home; if the files\n'
  printf "    landed somewhere unexpected, push to /sdcard/ and move them\n"
  printf '    on-device with: mv /sdcard/<name> ~/\n'
}

cmd_pull() {
  require_device
  local src="${1:-}" dest="${2:-.}"
  [ -n "$src" ] || die "usage: bridge.sh pull <device-path> [local-dest]"
  adb pull "$src" "$dest"
  ok "pulled to $dest"
}

cmd_status() {
  need_adb
  printf '\n\033[1m  bridge status\033[0m\n\n'
  local n; n="$(device_count)"
  if [ "$n" -ge 1 ]; then
    ok "$n device(s) authorised"
    adb devices -l | sed 's/^/    /'
    printf '\n'
    say "Device-side checks"
    adb shell 'command -v claude >/dev/null 2>&1 && echo "  claude: installed" || echo "  claude: NOT installed"' 2>/dev/null | tr -d '\r' || warn "could not query device"
    adb shell 'pgrep -x sshd >/dev/null 2>&1 && echo "  sshd: running" || echo "  sshd: not running"' 2>/dev/null | tr -d '\r' || true
  else
    warn "no authorised device"
  fi
  printf '\n'
  say "Active forwards"
  adb forward --list 2>/dev/null | sed 's/^/    /' || printf '    (none)\n'
  printf '\n'
}

cmd_disconnect() {
  need_adb
  adb forward --remove-all 2>/dev/null || true
  adb disconnect 2>/dev/null || true
  ok "forwards removed, wireless devices disconnected"
  printf '    A USB-attached device stays attached; unplug it to fully disconnect.\n'
}

usage() { sed -n '3,22p' "$0" | sed 's/^# \{0,2\}//;s/^#//'; }

main() {
  local cmd="${1:-status}"
  shift || true
  case "$cmd" in
    pair)           cmd_pair "$@" ;;
    connect)        cmd_connect "$@" ;;
    devices)        cmd_devices ;;
    forward)        cmd_forward ;;
    ssh)            cmd_ssh ;;
    push)           cmd_push "$@" ;;
    pull)           cmd_pull "$@" ;;
    status)         cmd_status ;;
    disconnect)     cmd_disconnect ;;
    -h|--help|help) usage ;;
    *)              die "unknown command: $cmd (try --help)" ;;
  esac
}

main "$@"
