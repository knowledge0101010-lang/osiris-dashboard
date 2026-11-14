#!/data/data/com.termux/files/usr/bin/bash
# ═══════════════════════════════════════════════════════════════
#  Claude Code on Android — Termux bootstrap
#
#  Run this ON THE PHONE, inside Termux:
#      bash android/termux-setup.sh
#
#  Installs the runtime Claude Code needs, sets up a persistent
#  tmux-backed session, and (optionally) an SSH server so a
#  workstation can reach the device over `adb forward`.
#
#  Runs without asking: package installation, the global Claude Code
#  install, and the claude-android wrapper.
#  Asks first: shared storage, the wake lock, and SSH access — the
#  three that widen what reaches the device. No credentials are
#  stored by this script.
# ═══════════════════════════════════════════════════════════════

set -euo pipefail

PREFIX_BIN="${PREFIX:-/data/data/com.termux/files/usr}/bin"
SETUP_MARKER="$HOME/.claude-android-setup"

# ── output helpers ───────────────────────────────────────────────
say()  { printf '\033[1;36m▸\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

ask() {
  # ask "question" -> 0 if yes. Defaults to no on a bare Enter.
  local reply
  printf '\033[1;35m?\033[0m %s [y/N] ' "$1"
  read -r reply || reply=n
  [ "${reply,,}" = "y" ] || [ "${reply,,}" = "yes" ]
}

# ── environment check ────────────────────────────────────────────
check_termux() {
  if [ ! -d "/data/data/com.termux" ]; then
    die "This script must run inside Termux on an Android device.
   Install Termux from F-Droid (the Play Store build is unmaintained):
     https://f-droid.org/packages/com.termux/"
  fi
  ok "Termux detected — $(uname -m), Android $(getprop ro.build.version.release 2>/dev/null || echo '?')"
}

# ── package installation ─────────────────────────────────────────
install_packages() {
  say "Updating Termux package index"
  pkg update -y >/dev/null 2>&1 || warn "package index update reported problems; continuing"

  local packages=(nodejs-lts git tmux openssh termux-api ripgrep)
  say "Installing: ${packages[*]}"
  pkg install -y "${packages[@]}"

  ok "node $(node --version) · npm $(npm --version) · git $(git --version | awk '{print $3}')"
}

# ── storage access ───────────────────────────────────────────────
setup_storage() {
  if [ -d "$HOME/storage" ]; then
    ok "Shared storage already linked at ~/storage"
    return
  fi
  say "Linking shared storage (Android will ask for permission)"
  if ask "Grant Termux access to shared storage? Needed to work on files outside Termux's private dir."; then
    termux-setup-storage
    sleep 2
    [ -d "$HOME/storage" ] && ok "Shared storage linked at ~/storage" || warn "storage link not created — permission may have been denied"
  else
    warn "Skipped. Claude Code will only see files under $HOME."
  fi
}

# ── Claude Code ──────────────────────────────────────────────────
install_claude() {
  if command -v claude >/dev/null 2>&1; then
    ok "Claude Code already installed — $(claude --version 2>/dev/null || echo 'version unknown')"
    if ask "Update to the latest version?"; then
      npm install -g @anthropic-ai/claude-code
    fi
    return
  fi

  say "Installing Claude Code"
  npm install -g @anthropic-ai/claude-code
  command -v claude >/dev/null 2>&1 \
    && ok "Claude Code installed — $(claude --version 2>/dev/null || echo 'ok')" \
    || die "install finished but 'claude' is not on PATH. Check: npm bin -g"
}

# ── wake lock ────────────────────────────────────────────────────
# Android aggressively kills background processes. Without a wake
# lock, a long Claude Code run dies the moment the screen turns off.
setup_wakelock() {
  say "Wake lock keeps long sessions alive when the screen is off"
  if ask "Acquire a Termux wake lock now?"; then
    termux-wake-lock && ok "Wake lock acquired (release later with: termux-wake-unlock)"
  else
    warn "Skipped. Long runs may be killed when the screen turns off."
  fi
}

# ── SSH access (opt-in) ──────────────────────────────────────────
# This is the "let my workstation reach this device" part. It is
# deliberately the most guarded step in the script.
setup_sshd() {
  cat <<'NOTE'

  ── Device access over SSH ────────────────────────────────────
  This starts Termux's SSH server on port 8022, bound to loopback
  (127.0.0.1) with password authentication disabled. An authorized
  public key is required — without one, sshd is not started.

  Loopback binding means nothing on your Wi-Fi can reach it. To get
  in from a workstation you need a USB cable and
  `adb forward tcp:8022 tcp:8022` — see android/bridge.sh.

  What this means: anything that can reach that forwarded port with
  your private key can run commands as you. Only enable it if you
  control the device and the machine you will connect from.
  ──────────────────────────────────────────────────────────────

NOTE
  if ! ask "Enable the SSH server on this device?"; then
    warn "Skipped. Run this script again later if you change your mind."
    return
  fi

  local keyfile="$HOME/.ssh/authorized_keys"
  mkdir -p "$HOME/.ssh"
  chmod 700 "$HOME/.ssh"

  if [ ! -s "$keyfile" ]; then
    cat <<'NOTE'

  No authorized public key found. A key is required: this setup disables
  password authentication, so there is no other way in.

  Paste your workstation's public key now — the contents of
  ~/.ssh/id_ed25519.pub — or press Enter to abort.

NOTE
    printf '  public key> '
    local pubkey
    read -r pubkey || pubkey=""
    if [ -z "$pubkey" ]; then
      warn "No key provided — sshd not started. Re-run this script when you have one."
      return
    fi
    printf '%s\n' "$pubkey" >> "$keyfile"
    ok "Public key added to $keyfile"
  else
    ok "authorized_keys already present ($(wc -l < "$keyfile") key(s))"
  fi
  chmod 600 "$keyfile"

  # Termux's sshd defaults to listening on every interface with password auth
  # available. That contradicts the access model this repo documents — reachable
  # only through `adb forward`, key auth only — so pin it explicitly rather than
  # trusting the defaults.
  local conf="$PREFIX/etc/ssh/sshd_config.d/claude-android.conf"
  mkdir -p "$(dirname "$conf")"
  cat > "$conf" <<'CONF'
# Written by android/termux-setup.sh — loopback only, keys only.
# Reachable from a workstation via: adb forward tcp:8022 tcp:8022
ListenAddress 127.0.0.1
ListenAddress ::1
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitEmptyPasswords no
PubkeyAuthentication yes
CONF
  chmod 600 "$conf"

  # Older Termux sshd_config may not carry the Include line the drop-in needs.
  if ! grep -qs '^Include .*sshd_config\.d' "$PREFIX/etc/ssh/sshd_config"; then
    printf '\nInclude %s/etc/ssh/sshd_config.d/*.conf\n' "$PREFIX" >> "$PREFIX/etc/ssh/sshd_config"
  fi

  say "Starting sshd on 127.0.0.1:8022"
  pkill sshd 2>/dev/null || true
  sshd

  # Report the settings that actually took effect, not the ones we asked for.
  local effective
  effective="$(sshd -T 2>/dev/null | awk '/^(listenaddress|passwordauthentication|kbdinteractiveauthentication) /')"
  if [ -n "$effective" ]; then
    printf '%s\n' "$effective" | sed 's/^/    /'
  else
    warn "could not read the effective sshd config — verify with: sshd -T"
  fi
  ok "sshd running. Username: $(whoami) · Port: 8022 · loopback only, key auth only"
  printf '    From your workstation:  ./android/bridge.sh ssh\n\n'
}

# ── shell integration ────────────────────────────────────────────
install_wrapper() {
  local src dest
  src="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/claude-android"
  dest="$PREFIX_BIN/claude-android"

  [ -f "$src" ] || { warn "claude-android wrapper not found next to this script; skipping"; return; }

  say "Installing the claude-android wrapper to $dest"
  install -m 755 "$src" "$dest"
  ok "Run it with: claude-android"
}

# ── main ─────────────────────────────────────────────────────────
main() {
  printf '\n\033[1m  Claude Code on Android — setup\033[0m\n\n'

  check_termux
  install_packages
  setup_storage
  install_claude
  install_wrapper
  setup_wakelock
  setup_sshd

  date -u +%FT%TZ > "$SETUP_MARKER"

  cat <<'DONE'

  ── Done ──────────────────────────────────────────────────────
  Start a session:        claude-android
  Reattach after closing: claude-android attach
  Authenticate:           claude   (then follow the login prompt)
  Release the wake lock:  termux-wake-unlock

  Small-screen tips:
    · Volume-Down acts as Ctrl in Termux (Vol-Down + C = Ctrl-C)
    · Long-press the terminal for the paste menu
    · tmux prefix is Ctrl-B; Ctrl-B then D detaches without killing
  ──────────────────────────────────────────────────────────────

DONE
}

main "$@"
