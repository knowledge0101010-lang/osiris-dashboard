#!/usr/bin/env bash
#
# OSIRIS — device info collector
#
# Pulls the four things /api/device-intel can reason about off an Android
# handset over adb, scrubs the hardware identifiers, and writes a single
# file you can paste into the MY DEVICE tab (or POST to the API).
#
#   ./scripts/collect-device-info.sh                 # first connected device
#   ./scripts/collect-device-info.sh -s <serial>     # a specific device
#   ./scripts/collect-device-info.sh -o out.txt      # choose the output path
#   ./scripts/collect-device-info.sh --raw           # skip redaction (careful)
#
# Requires: adb on PATH, USB debugging enabled, and the host authorised on
# the phone. Read-only — nothing is installed, changed, or uploaded.

set -euo pipefail

SERIAL=""
OUTPUT="device-info-$(date +%Y%m%d-%H%M%S).txt"
REDACT=1

usage() {
  sed -n '3,15p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    -s|--serial) SERIAL="${2:?-s needs a serial}"; shift 2 ;;
    -o|--output) OUTPUT="${2:?-o needs a path}"; shift 2 ;;
    --raw)       REDACT=0; shift ;;
    -h|--help)   usage 0 ;;
    *)           echo "unknown option: $1" >&2; usage 1 ;;
  esac
done

command -v adb >/dev/null 2>&1 || {
  echo "adb not found on PATH. Install Android platform-tools first." >&2
  exit 127
}

ADB=(adb)
[ -n "$SERIAL" ] && ADB=(adb -s "$SERIAL")

if ! "${ADB[@]}" get-state >/dev/null 2>&1; then
  echo "No device in 'device' state. Check the USB cable, enable USB debugging," >&2
  echo "and accept the RSA prompt on the phone. Current list:" >&2
  adb devices -l >&2
  exit 1
fi

# Run a shell command on the device; never abort the whole script if one of
# the optional sections is unsupported on this ROM.
dev() { "${ADB[@]}" shell "$@" 2>/dev/null || true; }

section() { printf '\n### %s\n' "$1"; }

collect() {
  printf '# OSIRIS device info — collected %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  section 'getprop'
  dev getprop

  section 'battery (dumpsys battery)'
  dev dumpsys battery

  section 'third-party packages (pm list packages -3)'
  dev pm list packages -3

  section 'security-relevant settings'
  printf 'adb_enabled: %s\n' "$(dev settings get global adb_enabled | tr -d '\r')"
  printf 'development_settings_enabled: %s\n' "$(dev settings get global development_settings_enabled | tr -d '\r')"
  printf 'install_non_market_apps: %s\n' "$(dev settings get secure install_non_market_apps | tr -d '\r')"

  section 'device admin / accessibility (manual review)'
  printf 'device_admins: %s\n' "$(dev settings get secure device_admin_apps | tr -d '\r')"
  printf 'enabled_accessibility_services: %s\n' "$(dev settings get secure enabled_accessibility_services | tr -d '\r')"
}

# Identifier scrubbing. Mirrors src/lib/device-intel.ts so the file is already
# safe to share before it ever reaches the analyser.
redact() {
  sed -E \
    -e 's/^(\[?(ro\.serialno|ro\.boot\.serialno|ro\.ril\.oem\.imei[0-9]?|gsm\.sim\.operator\.iso-country)\]?):.*/\1: REDACTED/I' \
    -e 's/\b89[0-9]{17,18}\b/REDACTED_ICCID/g' \
    -e 's/\b[0-9]{15,17}\b/REDACTED_IMEI/g' \
    -e 's/\b([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}\b/REDACTED_MAC/g' \
    -e 's/\+[0-9]{9,15}\b/REDACTED_PHONE/g' \
    -e 's/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/REDACTED_EMAIL/g'
}

if [ "$REDACT" -eq 1 ]; then
  collect | redact > "$OUTPUT"
  NOTE='identifiers redacted'
else
  collect > "$OUTPUT"
  NOTE='RAW — contains IMEI/serial, do not share'
fi

printf 'Wrote %s (%s lines, %s)\n' "$OUTPUT" "$(wc -l < "$OUTPUT" | tr -d ' ')" "$NOTE"
printf 'Paste it into RECON > MY DEVICE, or:\n'
printf '  curl -s localhost:3000/api/device-intel -H "Content-Type: application/json" \\\n'
printf '    --data "$(jq -Rs "{input: .}" < %s)"\n' "$OUTPUT"
