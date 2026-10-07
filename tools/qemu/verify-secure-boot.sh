#!/bin/sh
# verify-secure-boot.sh — report the Secure Boot chain status of an installed
# SevynOS system.
#
# Usage: verify-secure-boot.sh [--root DIR]
#
# Checks, in order:
#   1. MOK keypair exists at /var/lib/sevyn/secureboot/ with 0600 on the
#      private key.
#   2. sbverify over each installed artifact (GRUB EFI binaries, kernel,
#      recovery kernel when present) against the MOK certificate.
#   3. Enrollment state: mokutil --list-enrolled when mokutil is available,
#      otherwise the installer's state.json.
#   4. Firmware Secure Boot state from efivars (best effort; needs root).
#
# Exit status: 0 when nothing FAILs (OK or SKIP only), 1 on any FAIL.
# This does not — and cannot — replace booting real Secure Boot hardware.
# See docs/secure-boot.md.
#
# Environment:
#   SEVYN_SB_SBVERIFY — path to the sbverify binary (default: resolved from
#                       PATH). Empty means "treat as missing".
#   SEVYN_SB_MOKUTIL  — path to the mokutil binary (default: resolved from
#                       PATH). Empty means "treat as missing", in which case
#                       enrollment state falls back to the installer's
#                       state.json instead of live firmware queries.
set -eu

ROOT="/"
while [ $# -gt 0 ]; do
  case "$1" in
    --root) ROOT="${2:-/}"; shift 2 ;;
    --root=*) ROOT="${1#--root=}"; shift ;;
    -h|--help)
      echo "usage: $0 [--root DIR]"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; echo "usage: $0 [--root DIR]" >&2; exit 2 ;;
  esac
done

SB_DIR="$ROOT/var/lib/sevyn/secureboot"
MOK_PRIV="$SB_DIR/MOK.priv"
MOK_PEM="$SB_DIR/MOK.pem"
STATE_FILE="$SB_DIR/state.json"

# Resolve external tools once; an explicitly empty override means "treat as
# missing", an unset variable resolves from PATH as before.
SBVERIFY="${SEVYN_SB_SBVERIFY-$(command -v sbverify 2>/dev/null || true)}"
MOKUTIL="${SEVYN_SB_MOKUTIL-$(command -v mokutil 2>/dev/null || true)}"

FAILURES=0
report() {
  # report <status> <item> <detail>
  printf '%-6s %-42s %s\n' "$1" "$2" "$3"
  [ "$1" != "FAIL" ] || FAILURES=$((FAILURES + 1))
}

fingerprint() {
  openssl x509 -in "$MOK_PEM" -noout -fingerprint -sha256 2>/dev/null \
    | sed 's/^.*=//; s/://g' | tr 'A-Z' 'a-z'
}

echo "SevynOS Secure Boot chain verification"
echo "target root: $ROOT"
echo ""

# ─── 1. Keypair ──────────────────────────────────────────────────────
if [ -f "$MOK_PRIV" ] && [ -f "$MOK_PEM" ]; then
  mode=$(stat -c '%a' "$MOK_PRIV" 2>/dev/null || echo "?")
  if [ "$mode" = "600" ]; then
    report "OK" "MOK keypair" "present; private key 0600; fingerprint $(fingerprint)"
  else
    report "FAIL" "MOK keypair" "private key mode is $mode, expected 600"
  fi
else
  report "FAIL" "MOK keypair" "missing ($SB_DIR/MOK.priv / MOK.pem)"
fi

# ─── 2. Artifact signatures ──────────────────────────────────────────
if [ -n "$SBVERIFY" ] && [ -f "$MOK_PEM" ]; then
  for artifact in \
    "$ROOT/boot/efi/EFI/SevynOS/grubx64.efi" \
    "$ROOT/boot/efi/EFI/BOOT/BOOTX64.EFI" \
    "$ROOT/boot/vmlinuz" \
    "$ROOT/boot/efi/EFI/SevynOS/vmlinuz"; do
    name="${artifact#$ROOT}"
    [ -f "$artifact" ] || continue
    if "$SBVERIFY" --cert "$MOK_PEM" "$artifact" >/dev/null 2>&1; then
      report "OK" "signature: $name" "valid, signed by the MOK"
    else
      report "FAIL" "signature: $name" "sbverify rejected the signature"
    fi
  done
  if [ ! -f "$ROOT/boot/vmlinuz" ]; then
    report "FAIL" "kernel" "/boot/vmlinuz missing from target"
  fi
elif [ ! -f "$MOK_PEM" ]; then
  report "SKIP" "artifact signatures" "no MOK certificate to verify against"
else
  report "SKIP" "artifact signatures" "sbverify is not installed"
fi

# ─── 3. Enrollment ───────────────────────────────────────────────────
if [ -n "$MOKUTIL" ] && [ -f "$MOK_PEM" ]; then
  fp=$(fingerprint)
  if "$MOKUTIL" --list-enrolled 2>/dev/null | grep -qi "$fp"; then
    report "OK" "MOK enrollment" "fingerprint found in enrolled keys"
  elif "$MOKUTIL" --list-new 2>/dev/null | grep -qi "$fp"; then
    report "OK" "MOK enrollment" "queued for enrollment (MOKNew); complete it at the MOK Manager on next boot"
  else
    report "FAIL" "MOK enrollment" "MOK neither enrolled nor queued"
  fi
elif [ -f "$STATE_FILE" ]; then
  enrollment=$(sed -n 's/.*"enrollment": *"\([^"]*\)".*/\1/p' "$STATE_FILE" | head -n 1)
  reason=$(sed -n 's/.*"enrollmentReason": *"\([^"]*\)".*/\1/p' "$STATE_FILE" | head -n 1)
  case "$enrollment" in
    queued) report "OK" "MOK enrollment" "queued at install time; complete it at the MOK Manager on next boot" ;;
    not-applicable) report "SKIP" "MOK enrollment" "not a UEFI install" ;;
    manual-required) report "SKIP" "MOK enrollment" "manual enrollment required ($reason); see docs/secure-boot.md" ;;
    "") report "SKIP" "MOK enrollment" "no enrollment record (mokutil unavailable)" ;;
    *) report "FAIL" "MOK enrollment" "unexpected state: $enrollment" ;;
  esac
else
  report "SKIP" "MOK enrollment" "mokutil unavailable and no installer state"
fi

# ─── 4. Firmware Secure Boot state (best effort) ─────────────────────
sb_var=""
for f in "$ROOT"/sys/firmware/efi/efivars/SecureBoot-*; do
  [ -f "$f" ] && sb_var="$f" && break
done
if [ -n "$sb_var" ]; then
  # The variable payload is 1 byte; od prints it as hex.
  val=$(od -An -tx1 "$sb_var" 2>/dev/null | tr -d ' \n' | tail -c 2)
  case "$val" in
    01) report "OK" "firmware Secure Boot" "enabled (SecureBoot=1)" ;;
    00) report "SKIP" "firmware Secure Boot" "disabled — signing is inert until it is enabled" ;;
    *) report "SKIP" "firmware Secure Boot" "unreadable value" ;;
  esac
else
  report "SKIP" "firmware Secure Boot" "efivars not accessible (needs root on UEFI hardware)"
fi

echo ""
if [ "$FAILURES" -gt 0 ]; then
  echo "RESULT: FAIL ($FAILURES check(s) failed)"
  exit 1
fi
echo "RESULT: PASS (no failures; SKIP items need real hardware or missing tools)"
