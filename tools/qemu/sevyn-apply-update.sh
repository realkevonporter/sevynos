#!/bin/busybox sh
# SevynOS pending-update applier.
#
# Runs as PID 1 on installed systems, exec'd from sevyn-installed-init when
# /var/lib/sevynos/updates/pending.json exists (written by the OS update
# service after a verified download). Extracts the staged rootfs.squashfs
# over / early in boot, preserving machine state, then re-execs the
# installed init.
#
# Kernel lifecycle (Phase 3 B3): when pending.json stages a kernel pair
# (kernelPath/kernelSha256 + initramfsPath/initramfsSha256, from feed
# "vmlinuz"/"initramfs" artifacts), the applier installs them as VERSIONED
# /boot files (vmlinuz-<kver>, initramfs-<kver>.cpio.gz) — never overwriting
# the running pair in place — keeps the previous pair, regenerates grub.cfg
# (new kernel default, previous kernel fallback, recovery entry preserved),
# and refreshes the recovery environment in lockstep (C1 contract:
# recovery-initramfs rebuilt against the new kernel's modules, ESP-staged
# recovery kernel refreshed). With a machine MOK present the new kernel is
# re-signed with it before landing in /boot (docs/secure-boot.md §7, C2
# hook); an unsigned kernel is refused when a MOK exists.
#
# Rollback mode ("rollback" argument, exec'd by init via the boot-health
# library after SEVYN_MAX_FAILED_BOOTS boots without a healthy desktop):
# restores the pre-update snapshot over / using only the snapshot, the
# counter, and busybox tooling — the new (possibly broken)
# rootfs is never executed or trusted on this path. See
# tools/qemu/sevyn-boot-health.sh.
#
# Scope notes:
# - Rollback: before extracting, the applier snapshots the pre-update root
#   tree to /var/lib/sevynos/updates/previous/ (version.json + squashfs)
#   plus previous/kernels.json (the pre-update kernel pair). The recovery
#   environment verifies and restores that snapshot on user request; the
#   boot-health layer restores it automatically after repeated failed
#   boots. The sha256 gate before extraction remains the protection
#   against a corrupt payload. Signature verification is
#   Phase 3 (B1).
# - Trust: the snapshot holds the previously-VERIFIED rootfs — the running
#   system was Ed25519 feed-signature-verified and sha256-verified when it
#   was applied. A sha256 pin in the root-only
#   /var/lib/sevynos/update-trust/ dir additionally guards the snapshot
#   for the automatic path (the updates dir is session-writable); rollback
#   refuses to restore when the pin mismatches (fail closed).
set -eu
export PATH=/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

PENDING="${SEVYN_PENDING_JSON:-${SEVYN_UPDATES_DIR:-/var/lib/sevynos/updates}/pending.json}"
INIT="${SEVYN_INIT_BIN:-/usr/local/lib/sevynos/installed-init}"
BACKUP=/tmp/sevyn-update-backup
# Canonical updates dir (overridable for tests); PENDING derives from it.
UPDATES_DIR="${SEVYN_UPDATES_DIR:-/var/lib/sevynos/updates}"

log() {
  echo "$1"
  if [ -c /dev/ttyS0 ]; then
    echo "$1" > /dev/ttyS0 2>/dev/null || true
  fi
}

# Re-exec from tmpfs: unsquashfs is about to replace /usr/... and must not
# clobber the running script. Arguments are passed through (the "rollback"
# mode must survive the re-exec).
case "$0" in
  /tmp/*) ;;
  *)
    cp "$0" /tmp/sevyn-apply-update.sh
    exec /bin/busybox sh /tmp/sevyn-apply-update.sh "$@"
    ;;
esac

# Shared boot-health helpers: snapshot pin verification, machine state
# preservation, rollback history, and the automatic rollback restore.
# Sourced after the re-exec so the library itself is already in memory
# before /usr is replaced.
: "${SEVYN_BOOT_HEALTH_LIB:=/usr/local/lib/sevynos/boot-health}"
# shellcheck disable=SC1090
. "$SEVYN_BOOT_HEALTH_LIB"
# Kernel lifecycle helpers (versioned /boot install, module assertion,
# MOK signing, recovery lockstep, rollback kernel flip). Overridable for
# tests; sourced after the re-exec like the boot-health library. Guarded:
# environments predating the kernel updater (and hermetic tests that only
# exercise the rootfs path) have no such file.
: "${SEVYN_KERNEL_LIFECYCLE_LIB:=/usr/local/lib/sevyn-kernel-lifecycle-lib.sh}"
if [ -f "$SEVYN_KERNEL_LIFECYCLE_LIB" ]; then
  # shellcheck disable=SC1090
  . "$SEVYN_KERNEL_LIFECYCLE_LIB"
fi

case "${1:-}" in
  rollback)
    # Boot-health rollback: restore the pre-update snapshot. Never
    # depends on the new rootfs — only the snapshot, the counter, and
    # busybox tooling. Does not return (execs init).
    sevyn_rollback_restore
    ;;
esac

[ -f "$PENDING" ] || exec "$INIT"

VERSION=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$PENDING" | head -n 1)
PAYLOAD=$(sed -n 's/.*"payloadPath"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$PENDING" | head -n 1)
SHA=$(sed -n 's/.*"sha256"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$PENDING" | head -n 1)
# Kernel lifecycle pair (Phase 3 B3): flat fields, written by the OS update
# service when the feed carries "vmlinuz"/"initramfs" artifacts. A half
# pair (only one side staged) is malformed — fail loud below.
KERNEL_PATH=$(sed -n 's/.*"kernelPath"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$PENDING" | head -n 1)
KERNEL_SHA=$(sed -n 's/.*"kernelSha256"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$PENDING" | head -n 1)
INITRAMFS_PATH=$(sed -n 's/.*"initramfsPath"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$PENDING" | head -n 1)
INITRAMFS_SHA=$(sed -n 's/.*"initramfsSha256"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$PENDING" | head -n 1)

abort() {
  log "SEVYN_UPDATE_ABORT: $1"
  mv "$PENDING" "$UPDATES_DIR/failed-$(date +%s).json" 2>/dev/null || true
  exec "$INIT"
}

# fail_applied — Phase B (post-extraction) failure: the rootfs is already
# replaced, so "no partial state" is no longer possible. Log loudly,
# best-effort remove the newly installed /boot files and restore the
# grub.cfg backup (so the bootloader still points at the previous pair),
# then hand the machine to the boot-health layer: the pre-update snapshot
# plus the previous kernel pair can still roll the system back.
fail_applied() {
  log "SEVYN_UPDATE_FAILED: $1"
  if [ -n "${NEW_KVER:-}" ]; then
    rm -f "/boot/vmlinuz-$NEW_KVER" "/boot/initramfs-$NEW_KVER.cpio.gz" \
      "/boot/recovery-initramfs-$NEW_KVER.cpio.gz" 2>/dev/null || true
    if [ -f /boot/grub/grub.cfg.bak ]; then
      mv -f /boot/grub/grub.cfg.bak /boot/grub/grub.cfg 2>/dev/null || true
    fi
  fi
  mv "$PENDING" "$UPDATES_DIR/failed-$(date +%s).json" 2>/dev/null || true
  sync
  exec "$INIT"
}

# ─── Kernel lifecycle: Phase A (pre-extraction, abort is side-effect free) ───

# kernel_staged — 0 when pending.json stages a complete kernel pair.
kernel_staged() {
  [ -n "$KERNEL_PATH" ] && [ -n "$KERNEL_SHA" ] && \
    [ -n "$INITRAMFS_PATH" ] && [ -n "$INITRAMFS_SHA" ]
}

# kernel_preflight — verifies everything about the kernel update BEFORE
# anything on / is touched: artifact hashes, kernel version detection,
# kernel↔modules consistency with the new rootfs, the Secure Boot signing
# pre-check (docs/secure-boot.md §7), MOK signing of the staged kernel,
# and the recovery-image rebuild (C1 lockstep). Any failure aborts with
# no partial state.
kernel_preflight() {
  if [ -n "$KERNEL_PATH" ] || [ -n "$KERNEL_SHA" ] || \
     [ -n "$INITRAMFS_PATH" ] || [ -n "$INITRAMFS_SHA" ]; then
    if ! kernel_staged; then
      abort "malformed pending.json: half a kernel pair staged (kernel and initramfs must travel together)"
    fi
  else
    return 0
  fi
  # A staged kernel pair without the lifecycle library is unprocessable —
  # fail loud rather than silently skipping the kernel half of the update.
  command -v sevyn_kernel_version >/dev/null 2>&1 || \
    abort "kernel update staged but the kernel lifecycle library is missing: $SEVYN_KERNEL_LIFECYCLE_LIB"

  [ -f "$KERNEL_PATH" ] || abort "staged kernel missing: $KERNEL_PATH"
  [ -f "$INITRAMFS_PATH" ] || abort "staged initramfs missing: $INITRAMFS_PATH"
  log "SEVYN_KERNEL_UPDATE_VERIFYING"
  if ! echo "$KERNEL_SHA  $KERNEL_PATH" | sha256sum -c - >/dev/null 2>&1; then
    abort "sha256 mismatch for staged kernel"
  fi
  if ! echo "$INITRAMFS_SHA  $INITRAMFS_PATH" | sha256sum -c - >/dev/null 2>&1; then
    abort "sha256 mismatch for staged initramfs"
  fi

  NEW_KVER=$(sevyn_kernel_version "$KERNEL_PATH")
  [ -n "$NEW_KVER" ] || abort "cannot determine the staged kernel's version"
  CUR_KVER=$(uname -r 2>/dev/null || true)
  if [ -n "$CUR_KVER" ] && [ "$NEW_KVER" = "$CUR_KVER" ]; then
    log "SEVYN_KERNEL_UPDATE_SKIP: staged kernel $NEW_KVER is already running"
    KERNEL_PATH=""; KERNEL_SHA=""; INITRAMFS_PATH=""; INITRAMFS_SHA=""
    NEW_KVER=""
    return 0
  fi
  log "SEVYN_KERNEL_UPDATE: $CUR_KVER -> $NEW_KVER"

  # The new kernel's version must match the kernel modules inside the new
  # rootfs (they are built together). Fail the update loudly on mismatch.
  sevyn_assert_kernel_modules_match "$KERNEL_PATH" "$PAYLOAD" \
    || abort "kernel/modules version mismatch (see above)"

  # Secure Boot (docs/secure-boot.md §7, C2 hook): with a machine MOK
  # present, the new kernel must be signed with it BEFORE it lands in
  # /boot. Refuse to install an unsigned kernel when a MOK exists.
  mok_precheck_and_sign

  # Recovery lockstep (C1 contract, docs/recovery.md): rebuild the
  # recovery initramfs against the NEW kernel's modules now, while an
  # abort is still side-effect free. A kernel update that leaves a stale
  # recovery image is refused here.
  build_recovery_for_kernel
}

# mok_precheck_and_sign — implements the §7 hook. Signs the staged kernel
# in place (it is copied to /boot only in Phase B). Sets MOK_SIGNING=1 and
# MOK_FP/MOK_STATE when a MOK exists, so Phase B can record the signing.
mok_precheck_and_sign() {
  SB_DIR="${SEVYN_SECUREBOOT_DIR:-/var/lib/sevyn/secureboot}"
  MOK_PRIV="$SB_DIR/MOK.priv"
  MOK_PEM="$SB_DIR/MOK.pem"
  MOK_STATE="$SB_DIR/state.json"
  MOK_SIGNING=0
  MOK_FP=""
  if [ ! -f "$MOK_PRIV" ] || [ ! -f "$MOK_PEM" ]; then
    log "SEVYN_KERNEL_UPDATE: no machine MOK; kernel will be installed unsigned"
    return 0
  fi
  MOK_SIGNING=1
  MOK_FP=$(sevyn_sb_fingerprint "$MOK_PEM")
  if [ -f "$MOK_STATE" ]; then
    signed_with=$(sevyn_json_get "$MOK_STATE" "signedWith")
    if [ -n "$signed_with" ] && [ -n "$MOK_FP" ] && [ "$signed_with" != "$MOK_FP" ]; then
      abort "Secure Boot key mismatch: state.json signedWith=$signed_with != current MOK $MOK_FP; signing with the current key would ship an unbootable kernel"
    fi
  fi
  # C2's helper signs the unversioned install-time paths when it is
  # present on the system (PR #64); best-effort — the explicit signing
  # below is the §7 contract for the versioned update files.
  sb_helper="${SEVYN_SECUREBOOT_HELPER:-/usr/local/lib/sevyn-secure-boot.sh}"
  if [ -x "$sb_helper" ]; then
    log "SEVYN_KERNEL_UPDATE: running secure-boot helper (sign)"
    "$sb_helper" sign >/tmp/sevyn-sbsign-helper.log 2>&1 || \
      log "SEVYN_KERNEL_UPDATE: WARNING: secure-boot helper exited nonzero; continuing with explicit signing"
  fi
  if ! command -v "${SEVYN_SBSIGN_BIN:-sbsign}" >/dev/null 2>&1; then
    abort "machine MOK exists but sbsign is not installed; refusing to install an unsigned kernel"
  fi
  log "SEVYN_KERNEL_UPDATE: signing staged kernel with machine MOK ${MOK_FP:-unknown}"
  sevyn_sign_boot_artifacts "$MOK_PRIV" "$MOK_PEM" "$KERNEL_PATH" \
    || abort "MOK signing of the staged kernel failed; refusing to install an unsigned kernel"
  if ! sevyn_verify_signed "$KERNEL_PATH" "$MOK_PEM"; then
    abort "sbverify rejected the MOK-signed staged kernel"
  fi
  if command -v "${SEVYN_SBVERIFY_BIN:-sbverify}" >/dev/null 2>&1; then
    log "SEVYN_KERNEL_UPDATE: sbverify confirmed the MOK signature"
  else
    log "SEVYN_KERNEL_UPDATE: sbverify not available; trusting the sbsign exit status"
  fi
}

# build_recovery_for_kernel — rebuilds the recovery initramfs against the
# new kernel's modules (extracted from the staged payload) into
# $KUPDATE_WORK/artifacts/. Aborts on any failure: a kernel update that
# leaves a stale recovery image is a broken update.
build_recovery_for_kernel() {
  builder="${SEVYN_RECOVERY_BUILDER:-/usr/local/bin/build-sevyn-recovery-image}"
  unsquashfs_bin="${SEVYN_UNSQUASHFS_BIN:-unsquashfs}"
  KUPDATE_WORK="$UPDATES_DIR/$VERSION/kupdate-work"
  [ -x "$builder" ] || abort "recovery image builder missing: $builder"
  rm -rf "$KUPDATE_WORK"
  mkdir -p "$KUPDATE_WORK/artifacts"
  log "SEVYN_KERNEL_UPDATE: extracting new kernel modules from the staged payload"
  if ! "$unsquashfs_bin" -d "$KUPDATE_WORK/extract" \
      -e "lib/modules/$NEW_KVER/*" "$PAYLOAD" >/tmp/sevyn-kmod-extract.log 2>&1; then
    abort "cannot extract lib/modules/$NEW_KVER from the staged payload (see /tmp/sevyn-kmod-extract.log)"
  fi
  [ -d "$KUPDATE_WORK/extract/lib/modules/$NEW_KVER" ] \
    || abort "staged payload has no lib/modules/$NEW_KVER"
  if ! "$unsquashfs_bin" -d "$KUPDATE_WORK/extract" \
      -e "usr/local/src/sevyn-recovery/*" "$PAYLOAD" >/tmp/sevyn-rtree-extract.log 2>&1; then
    abort "cannot extract the recovery tree from the staged payload (see /tmp/sevyn-rtree-extract.log)"
  fi
  [ -f "$KUPDATE_WORK/extract/usr/local/src/sevyn-recovery/init" ] \
    || abort "staged payload has no recovery tree (usr/local/src/sevyn-recovery)"
  printf '%s\n' "$NEW_KVER" > "$KUPDATE_WORK/artifacts/kernel-version.txt"
  log "SEVYN_KERNEL_UPDATE: rebuilding the recovery initramfs for kernel $NEW_KVER"
  if ! SEVYN_RECOVERY_SRC="$KUPDATE_WORK/extract/usr/local/src/sevyn-recovery" \
       SEVYN_ARTIFACTS="$KUPDATE_WORK/artifacts" \
       SEVYN_OS_VERSION="$VERSION" \
       SEVYN_MODULES_DIR="$KUPDATE_WORK/extract/lib/modules/$NEW_KVER" \
       "$builder" >/tmp/sevyn-recovery-build.log 2>&1; then
    abort "recovery image rebuild failed for kernel $NEW_KVER (see /tmp/sevyn-recovery-build.log); refusing a kernel update that leaves a stale recovery image"
  fi
  (
    cd "$KUPDATE_WORK/artifacts" && \
      sha256sum -c recovery-initramfs.sha256 >/dev/null 2>&1
  ) || abort "rebuilt recovery image failed its sha256 check"
  log "SEVYN_KERNEL_UPDATE: recovery initramfs rebuilt for $NEW_KVER"
}

# record_previous_kernels — writes previous/kernels.json into the B2
# snapshot slot BEFORE extraction, so both rollback paths can flip the
# kernel pair together with the rootfs snapshot (a new rootfs with an old
# kernel, or vice versa, is a bricked combination).
record_previous_kernels() {
  [ -n "${NEW_KVER:-}" ] || return 0
  prev_dir="$UPDATES_DIR/previous"
  mkdir -p "$prev_dir"
  cur_kver=$(uname -r 2>/dev/null || true)
  if [ -n "$cur_kver" ] && [ -f "/boot/vmlinuz-$cur_kver" ] && \
     [ -f "/boot/initramfs-$cur_kver.cpio.gz" ]; then
    prev_kernel="/boot/vmlinuz-$cur_kver"
    prev_initramfs="/boot/initramfs-$cur_kver.cpio.gz"
    if [ -f "/boot/recovery-initramfs-$cur_kver.cpio.gz" ]; then
      prev_recovery="/boot/recovery-initramfs-$cur_kver.cpio.gz"
    else
      prev_recovery="/boot/recovery-initramfs.cpio.gz"
    fi
  else
    # Install-time layout (or first kernel update): unversioned names.
    cur_kver="${cur_kver:-unknown}"
    prev_kernel="/boot/vmlinuz"
    prev_initramfs="/boot/initramfs.cpio.gz"
    prev_recovery="/boot/recovery-initramfs.cpio.gz"
  fi
  for f in "$prev_kernel" "$prev_initramfs"; do
    [ -f "$f" ] || abort "previous kernel pair file missing: $f"
  done
  [ -f "$prev_recovery" ] || prev_recovery=""
  printf '{"previousKernelVersion":"%s","previousKernel":"%s","previousInitramfs":"%s","previousRecoveryInitramfs":"%s","newKernelVersion":"%s"}\n' \
    "$cur_kver" "$prev_kernel" "$prev_initramfs" "$prev_recovery" "$NEW_KVER" \
    > "$prev_dir/kernels.json"
  PREV_KERNEL="$prev_kernel"
  PREV_INITRAMFS="$prev_initramfs"
  PREV_RECOVERY="$prev_recovery"
  PREV_KVER="$cur_kver"
  log "SEVYN_KERNEL_UPDATE: previous pair recorded ($cur_kver)"
}

# ─── Kernel lifecycle: Phase B (post-extraction) ───

# install_kernel_files — installs the versioned pair into /boot, refreshes
# the ESP staging and the stable recovery names, regenerates grub.cfg
# (new kernel default, previous kernel fallback, recovery preserved),
# records kernels.json, and prunes superseded versioned pairs.
install_kernel_files() {
  [ -n "${NEW_KVER:-}" ] || return 0
  grub_lib="${SEVYN_GRUB_CFG_LIB:-/usr/local/lib/sevyn-grub-cfg-lib.sh}"
  [ -f "$grub_lib" ] || fail_applied "grub-cfg-lib missing: $grub_lib"
  # shellcheck disable=SC1090
  . "$grub_lib"
  [ -f /boot/grub/grub.cfg ] || fail_applied "/boot/grub/grub.cfg is missing; cannot regenerate the bootloader config"

  new_kernel="/boot/vmlinuz-$NEW_KVER"
  new_initramfs="/boot/initramfs-$NEW_KVER.cpio.gz"
  new_recovery="/boot/recovery-initramfs-$NEW_KVER.cpio.gz"
  log "SEVYN_KERNEL_UPDATE: installing versioned pair for $NEW_KVER"
  cp -f "$KERNEL_PATH" "$new_kernel" || fail_applied "cannot install $new_kernel"
  cp -f "$INITRAMFS_PATH" "$new_initramfs" || fail_applied "cannot install $new_initramfs"
  cp -f "$KUPDATE_WORK/artifacts/recovery-initramfs.cpio.gz" "$new_recovery" \
    || fail_applied "cannot install $new_recovery"
  # Stable names (installer parity): the legacy-BIOS recovery entry and
  # the ESP refresh below load these.
  cp -f "$KUPDATE_WORK/artifacts/recovery-initramfs.cpio.gz" \
    /boot/recovery-initramfs.cpio.gz || fail_applied "cannot refresh /boot/recovery-initramfs.cpio.gz"
  chmod 0644 "$new_kernel" "$new_initramfs" "$new_recovery" 2>/dev/null || true

  # ESP staging (C1 contract): the ESP-staged recovery kernel must be the
  # new (MOK-signed, when applicable) kernel, and the ESP recovery image
  # the rebuilt one. The ESP is not mounted this early in boot — mount it
  # by UUID from the current grub.cfg. A UEFI system whose ESP cannot be
  # mounted fails the kernel update (fail closed: a stale ESP recovery
  # kernel is a broken update).
  eval "$(sevyn_grub_uuids /boot/grub/grub.cfg)"
  esp_mnt=""
  if [ -n "${esp_uuid:-}" ]; then
    esp_mnt_target="${SEVYN_ESP_MOUNT:-/tmp/sevyn-esp}"
    if esp_mnt=$(sevyn_mount_esp "$esp_uuid" "$esp_mnt_target"); then
      mkdir -p "$esp_mnt/EFI/SevynOS"
      cp -f "$new_kernel" "$esp_mnt/EFI/SevynOS/vmlinuz" \
        || { sevyn_umount_esp "$esp_mnt"; fail_applied "cannot stage the ESP recovery kernel"; }
      cp -f "$new_recovery" "$esp_mnt/EFI/SevynOS/recovery-initramfs.cpio.gz" \
        || { sevyn_umount_esp "$esp_mnt"; fail_applied "cannot stage the ESP recovery image"; }
      sevyn_umount_esp "$esp_mnt"
      esp_mnt=""
      log "SEVYN_KERNEL_UPDATE: ESP staging refreshed"
    else
      fail_applied "cannot mount the ESP (UUID $esp_uuid); refusing a kernel update that leaves a stale ESP recovery kernel"
    fi
  fi

  # Regenerate grub.cfg: new kernel default, previous kernel fallback,
  # recovery entry preserved (ESP names for UEFI, versioned /boot pair
  # for legacy BIOS so its modules match its kernel).
  [ -n "${root_uuid:-}" ] || fail_applied "cannot parse the root UUID from grub.cfg"
  cp -f /boot/grub/grub.cfg /boot/grub/grub.cfg.bak
  SEVYN_KERNEL="$new_kernel" SEVYN_INITRAMFS="$new_initramfs" \
    SEVYN_PREV_KERNEL="$PREV_KERNEL" SEVYN_PREV_INITRAMFS="$PREV_INITRAMFS" \
    SEVYN_RECOVERY_KERNEL="$new_kernel" SEVYN_RECOVERY_INITRAMFS="$new_recovery" \
    sevyn_write_grub_cfg /boot/grub/grub.cfg "$root_uuid" "${esp_uuid:-}" \
    || fail_applied "grub.cfg regeneration failed"
  log "SEVYN_KERNEL_UPDATE: grub.cfg regenerated (default $NEW_KVER, fallback $PREV_KVER)"

  # Pairing state for future updates and for the rollback flip.
  printf '{"current":{"version":"%s","kernel":"%s","initramfs":"%s","recoveryInitramfs":"%s"},"previous":{"version":"%s","kernel":"%s","initramfs":"%s","recoveryInitramfs":"%s"}}\n' \
    "$NEW_KVER" "$new_kernel" "$new_initramfs" "$new_recovery" \
    "$PREV_KVER" "$PREV_KERNEL" "$PREV_INITRAMFS" "$PREV_RECOVERY" \
    > "$UPDATES_DIR/kernels.json"

  # Record the MOK signing (docs/secure-boot.md §7): which key signed the
  # installed kernel, so a later update can detect a key mismatch.
  if [ "${MOK_SIGNING:-0}" = "1" ] && [ -n "${MOK_FP:-}" ]; then
    sevyn_sb_state_write "$MOK_STATE" "signed" "true"
    sevyn_sb_state_write "$MOK_STATE" "signedAt" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    sevyn_sb_state_write "$MOK_STATE" "signedWith" "$MOK_FP"
  fi

  # Keep only the current + previous versioned pairs; the unversioned
  # install-time names belong to the installer and are never pruned.
  sevyn_prune_old_kernels /boot "$NEW_KVER" "$PREV_KVER"
  sync
  log "SEVYN_KERNEL_UPDATE_APPLIED version=$NEW_KVER"
}

# snapshot_previous — capture the pre-update system into
# /var/lib/sevynos/updates/previous/ so the recovery environment (or the
# automatic boot-health rollback) can roll back: version.json (version,
# timestamp, sha256) plus a squashfs of the pre-update root tree. Only one
# generation is kept; each update replaces it. Best-effort: if the
# snapshot cannot be taken (too little free space, missing tooling), the
# update still proceeds and rollback reports that no snapshot is
# available for it.
snapshot_previous() {
  updates_dir="${SEVYN_UPDATES_DIR:-/var/lib/sevynos/updates}"
  prev_dir=$updates_dir/previous
  # Overridable for tests; the real mksquashfs on a device.
  mksquashfs_bin="${SEVYN_MKSQUASHFS_BIN:-mksquashfs}"
  os_release_file="${SEVYN_OS_RELEASE_FILE:-/etc/sevynos-release}"
  current_version=$(sed -n 's/^VERSION_ID="\?\([^"]*\)"\?/\1/p' "$os_release_file" 2>/dev/null | head -n 1)
  [ -n "$current_version" ] || current_version="unknown"

  if ! command -v "$mksquashfs_bin" >/dev/null 2>&1; then
    log "SEVYN_UPDATE_NO_ROLLBACK: mksquashfs is not available"
    return 0
  fi
  free_kb=$(df -k / 2>/dev/null | awk 'NR==2 { print $4 }')
  if [ -z "$free_kb" ] || [ "$free_kb" -lt 6291456 ]; then
    log "SEVYN_UPDATE_NO_ROLLBACK: need 6 GiB free for the pre-update snapshot"
    return 0
  fi

  rm -rf "$prev_dir"
  mkdir -p "$prev_dir"
  log "SEVYN_UPDATE_SNAPSHOT: capturing the pre-update system (version $current_version)"
  if "$mksquashfs_bin" / "$prev_dir/rootfs.squashfs.tmp" \
    -noappend -comp zstd \
    -wildcards \
    -e 'proc/*' 'sys/*' 'dev/*' 'run/*' 'tmp/*' 'media/*' 'mnt/*' \
    'var/lib/sevynos/updates/*' 'boot/*' \
    >/tmp/sevyn-snapshot.log 2>&1; then
    mv "$prev_dir/rootfs.squashfs.tmp" "$prev_dir/rootfs.squashfs"
    snap_sha=$(sha256sum "$prev_dir/rootfs.squashfs" | cut -d' ' -f1)
    applied_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    printf '{"version":"%s","appliedAt":"%s","sha256":"%s"}\n' \
      "$current_version" "$applied_at" "$snap_sha" > "$prev_dir/version.json"
    # Tamper-evident pin for the automatic boot-health rollback path: the
    # updates dir is session-writable, so the pin lives in the root-only
    # trust dir. Automatic rollback verifies the pin before restoring.
    trust_dir="${SEVYN_UPDATE_TRUST_DIR:-/var/lib/sevyn/update-trust}"
    if mkdir -p "$trust_dir" 2>/dev/null; then
      chmod 0700 "$trust_dir" 2>/dev/null || true
      printf '%s\n' "$snap_sha" > "$trust_dir/previous.sha256" 2>/dev/null || true
      chmod 600 "$trust_dir/previous.sha256" 2>/dev/null || true
    fi
    log "SEVYN_UPDATE_SNAPSHOT_DONE version=$current_version"
  else
    log "SEVYN_UPDATE_NO_ROLLBACK: snapshot failed, see /tmp/sevyn-snapshot.log"
    rm -rf "$prev_dir"
    rm -f "${SEVYN_UPDATE_TRUST_DIR:-/var/lib/sevyn/update-trust}/previous.sha256"
  fi
  return 0
}

[ -n "$VERSION" ] || abort "malformed pending.json (version)"
[ -n "$PAYLOAD" ] || abort "malformed pending.json (payloadPath)"
[ -n "$SHA" ] || abort "malformed pending.json (sha256)"
[ -f "$PAYLOAD" ] || abort "staged payload missing: $PAYLOAD"

log "SEVYN_UPDATE_VERIFYING version=$VERSION"
if ! echo "$SHA  $PAYLOAD" | sha256sum -c - >/dev/null 2>&1; then
  abort "sha256 mismatch for staged payload"
fi

# Kernel pre-flight runs before the snapshot: every check here aborts
# with no partial state (nothing on / has been touched yet).
kernel_preflight

snapshot_previous
# The kernel pairing record must land in the snapshot slot AFTER
# snapshot_previous (which recreates previous/) and BEFORE extraction.
record_previous_kernels

log "SEVYN_UPDATE_APPLYING version=$VERSION"
# Machine state that must survive the new image: app/user state, saved Wi-Fi,
# genesis state, timezone, hostname, machine-id, and the account databases
# (the payload carries build-time passwd/shadow/group/gshadow without the
# installed users; restoring the machine's copies keeps logins and sudo
# working after the update). The staged payload itself is excluded from the
# backup (it lives under updates/ and tmpfs may be small).
sevyn_preserve_machine_state "$BACKUP"

if ! "${SEVYN_UNSQUASHFS_BIN:-unsquashfs}" -f -d / "$PAYLOAD" >/tmp/sevyn-unsquashfs.log 2>&1; then
  log "SEVYN_UPDATE_FAILED: extraction failed, see /tmp/sevyn-unsquashfs.log"
  abort "extraction failed"
fi

# Kernel install runs after the rootfs extraction (the new modules are now
# live at /lib/modules/<new>) but before the machine state is restored;
# failures here use fail_applied (loud + best-effort /boot cleanup, then
# the boot-health rollback safety net).
install_kernel_files

# Restore machine state over the new image.
sevyn_restore_machine_state "$BACKUP"
# Drop the consumed payload and flag.
rm -rf "$UPDATES_DIR/$VERSION" "$PENDING"

log "SEVYN_UPDATE_APPLIED version=$VERSION"
exec "$INIT"
