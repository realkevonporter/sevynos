#!/bin/sh
# SevynOS Secure Boot — install-time helper.
#
# Runs inside the target chroot during installation (invoked by
# sevyn-installer-chroot.sh). Implements the automatable part of the MOK
# (Machine Owner Key) flow documented in docs/secure-boot.md:
#
#   generate-mok      create the per-machine RSA-4096 MOK keypair
#   sign              sbsign the installed GRUB EFI binary, the kernel, and the
#                     ESP-staged recovery kernel with the MOK
#   queue-enrollment  attempt `mokutil --import` so the next boot lands in
#                     shim's MOK Manager for the one-time physical-presence
#                     enrollment (cannot be automated — by design)
#   status            print the recorded state
#
# Every step degrades gracefully when its tool is unavailable: a missing
# sbsign/mokutil must never brick an installation. Outcomes are recorded in
# /var/lib/sevyn/secureboot/state.json for the OS, the updater (Worker B3
# hook: kernel updates must re-sign), and tools/qemu/verify-secure-boot.sh.
#
# Environment:
#   SEVYN_SB_ROOT — filesystem root to operate on (default /). The test
#                   suite points this at a scratch directory, which also
#                   fakes the firmware sysfs tree ($ROOT/sys/firmware/efi)
#                   per test case: create it for a UEFI boot, omit it for
#                   a legacy boot.
#   SEVYN_SB_SBSIGN  — path to the sbsign binary (default: resolved from
#                      PATH). Set to the empty string to simulate a missing
#                      sbsign without touching PATH.
#   SEVYN_SB_MOKUTIL — path to the mokutil binary (default: resolved from
#                      PATH). Set to the empty string to simulate a missing
#                      mokutil without touching PATH.
set -eu

ROOT="${SEVYN_SB_ROOT:-/}"
SB_DIR="$ROOT/var/lib/sevyn/secureboot"
MOK_PRIV="$SB_DIR/MOK.priv"
MOK_PEM="$SB_DIR/MOK.pem"
MOK_DER="$SB_DIR/MOK.der"
MOK_PW_FILE="$SB_DIR/mok-enrollment-password"
STATE_FILE="$SB_DIR/state.json"

# Resolve external tools once. An explicitly empty override means "treat as
# missing"; an unset variable resolves from PATH exactly as before, so
# default (production) behavior is unchanged.
SBSIGN="${SEVYN_SB_SBSIGN-$(command -v sbsign 2>/dev/null || true)}"
MOKUTIL="${SEVYN_SB_MOKUTIL-$(command -v mokutil 2>/dev/null || true)}"

log() {
  echo "[sevyn-secure-boot] $*"
}

state_write() {
  # state_write <key> <value> — records a string value in state.json.
  # Values are machine-generated (timestamps, hex fingerprints, fixed reason
  # tokens), so no JSON escaping is required beyond the fixed key names.
  key="$1"
  value="$2"
  tmp="$STATE_FILE.tmp"
  if [ -f "$STATE_FILE" ]; then
    # Replace an existing key or append before the closing brace.
    if grep -q "\"$key\":" "$STATE_FILE"; then
      sed "s|\"$key\": *\"[^\"]*\"|\"$key\": \"$value\"|" "$STATE_FILE" > "$tmp"
    else
      sed '$d' "$STATE_FILE" > "$tmp"
      sed -i '$ s/$/,/' "$tmp"
      printf '  "%s": "%s"\n}\n' "$key" "$value" >> "$tmp"
    fi
  else
    printf '{\n  "%s": "%s"\n}\n' "$key" "$value" > "$tmp"
  fi
  mv "$tmp" "$STATE_FILE"
  chmod 0644 "$STATE_FILE"
}

fingerprint() {
  # SHA256 fingerprint of the MOK certificate, colon-free lowercase hex.
  openssl x509 -in "$MOK_PEM" -noout -fingerprint -sha256 2>/dev/null \
    | sed 's/^.*=//; s/://g' | tr 'A-Z' 'a-z'
}

cmd_generate_mok() {
  if ! command -v openssl >/dev/null 2>&1; then
    log "WARNING: openssl is missing; cannot generate the MOK. Recording and continuing."
    state_write "mok" "missing-openssl"
    return 0
  fi

  mkdir -p "$SB_DIR"
  chmod 0700 "$SB_DIR"

  if [ -f "$MOK_PRIV" ] && [ -f "$MOK_PEM" ]; then
    # Never regenerate over an existing key: previously signed artifacts
    # (and any enrolled MOK) would stop matching.
    log "MOK keypair already exists; keeping it."
    fp=$(fingerprint)
    state_write "mok" "present"
    state_write "fingerprint" "$fp"
    return 0
  fi

  log "Generating a new SevynOS Machine Owner Key (RSA-4096, self-signed)..."
  # keyUsage/extendedKeyUsage follow the UEFI signing conventions so the
  # certificate is usable both for sbsign and for db/MOK enrollment.
  if ! openssl req -newkey rsa:4096 -nodes \
    -keyout "$MOK_PRIV" \
    -x509 -days 36500 -outform PEM -out "$MOK_PEM" \
    -subj "/CN=SevynOS Machine Owner Key/" \
    -addext "keyUsage=digitalSignature" \
    -addext "extendedKeyUsage=codeSigning" 2>/dev/null; then
    log "WARNING: openssl key generation failed. Recording and continuing."
    state_write "mok" "generation-failed"
    return 0
  fi
  openssl x509 -in "$MOK_PEM" -outform DER -out "$MOK_DER" 2>/dev/null

  chmod 0600 "$MOK_PRIV"
  chmod 0644 "$MOK_PEM" "$MOK_DER"

  fp=$(fingerprint)
  log "MOK generated. Fingerprint (sha256): $fp"
  log "Private key: $MOK_PRIV (0600, root-only). Back it up — losing it means"
  log "future kernel updates cannot be signed for Secure Boot."
  state_write "mok" "generated"
  state_write "fingerprint" "$fp"
  state_write "generatedAt" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}

cmd_sign() {
  if [ ! -f "$MOK_PRIV" ] || [ ! -f "$MOK_PEM" ]; then
    log "WARNING: no MOK keypair; skipping signing."
    state_write "signed" "false"
    state_write "signReason" "no-key"
    return 0
  fi
  if [ -z "$SBSIGN" ]; then
    log "WARNING: sbsign is missing; artifacts left unsigned. Recording and continuing."
    state_write "signed" "false"
    state_write "signReason" "no-sbsign"
    return 0
  fi

  signed_any=0
  for artifact in \
    "$ROOT/boot/efi/EFI/SevynOS/grubx64.efi" \
    "$ROOT/boot/efi/EFI/BOOT/BOOTX64.EFI" \
    "$ROOT/boot/vmlinuz" \
    "$ROOT/boot/efi/EFI/SevynOS/vmlinuz"; do
    [ -f "$artifact" ] || continue
    # sbsign replaces the signature in place; sign to a temp file first so a
    # failure never leaves a truncated artifact behind.
    tmp="$artifact.sbsign-tmp"
    if "$SBSIGN" --key "$MOK_PRIV" --cert "$MOK_PEM" --output "$tmp" "$artifact" >/dev/null 2>&1; then
      mv "$tmp" "$artifact"
      log "Signed: ${artifact#$ROOT}"
      signed_any=1
    else
      rm -f "$tmp"
      log "WARNING: sbsign failed for ${artifact#$ROOT}; leaving it unsigned."
    fi
  done

  fp=$(fingerprint)
  if [ "$signed_any" = "1" ]; then
    state_write "signed" "true"
    state_write "signedAt" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    state_write "signedWith" "$fp"
    log "Artifacts signed with MOK $fp"
  else
    state_write "signed" "false"
    state_write "signReason" "no-artifacts"
    log "WARNING: no signable artifacts found."
  fi
}

cmd_queue_enrollment() {
  # mokutil and the MOK Manager are part of shim. Without a signed shim there
  # is no MOK Manager screen; without UEFI variables there is nowhere to
  # queue the key. All of these are recorded, not fatal.
  #
  # The firmware check comes first: on a non-UEFI boot enrollment does not
  # apply at all, so a missing mokutil there must not be misreported as
  # "manual enrollment required".
  if [ ! -f "$MOK_DER" ]; then
    log "WARNING: no MOK certificate; cannot queue enrollment."
    state_write "enrollment" "no-key"
    return 0
  fi
  if [ ! -d "$ROOT/sys/firmware/efi" ]; then
    log "Not a UEFI boot; MOK enrollment does not apply."
    state_write "enrollment" "not-applicable"
    state_write "enrollmentReason" "no-uefi"
    return 0
  fi
  if [ -z "$MOKUTIL" ]; then
    log "mokutil is not installed; the MOK cannot be queued automatically."
    log "Manual enrollment: mokutil --import $MOK_DER (needs a signed shim; see docs/secure-boot.md)"
    state_write "enrollment" "manual-required"
    state_write "enrollmentReason" "no-mokutil"
    return 0
  fi

  # The enrollment password is typed once, at the MOK Manager screen, on the
  # next reboot. Generate it, store it 0600 (deleted after enrollment is
  # confirmed), and feed it to mokutil non-interactively when possible.
  pw=$(tr -dc 'abcdefghjkmnpqrstuvwxyz23456789' < /dev/urandom | head -c 16)
  printf '%s' "$pw" > "$MOK_PW_FILE"
  chmod 0600 "$MOK_PW_FILE"

  log "Queueing the MOK for enrollment (mokutil --import)..."
  if printf '%s\n%s\n' "$pw" "$pw" | timeout 30 "$MOKUTIL" --import "$MOK_DER" >/dev/null 2>&1; then
    log "MOK queued for enrollment. The next reboot will open the MOK Manager;"
    log "complete the one-time enrollment there (the installer shows the steps)."
    state_write "enrollment" "queued"
  else
    log "WARNING: mokutil --import did not complete non-interactively."
    log "The key is ready at $MOK_DER; enroll manually after first boot."
    state_write "enrollment" "manual-required"
    state_write "enrollmentReason" "mokutil-interactive"
  fi
}

cmd_status() {
  if [ -f "$STATE_FILE" ]; then
    cat "$STATE_FILE"
  else
    echo '{"mok": "unknown"}'
  fi
}

usage() {
  echo "usage: $0 {generate-mok|sign|queue-enrollment|status}" >&2
  exit 2
}

case "${1:-}" in
  generate-mok) cmd_generate_mok ;;
  sign) cmd_sign ;;
  queue-enrollment) cmd_queue_enrollment ;;
  status) cmd_status ;;
  *) usage ;;
esac
