#!/bin/busybox sh
# SevynOS pending-update applier.
#
# Runs as PID 1 on installed systems, exec'd from sevyn-installed-init when
# /var/lib/sevynos/updates/pending.json exists (written by the OS update
# service after a verified download). Extracts the staged rootfs.squashfs
# over / early in boot, preserving machine state, then re-execs the
# installed init.
#
# Rollback mode ("rollback" argument, exec'd by init via the boot-health
# library after SEVYN_MAX_FAILED_BOOTS boots without a healthy desktop):
# restores the pre-update snapshot over / using only the snapshot, the
# boot-attempt counter, and busybox tooling — the new (possibly broken)
# rootfs is never executed or trusted on this path. See
# tools/qemu/sevyn-boot-health.sh.
#
# Scope notes:
# - Kernel/initramfs are NOT updated (Phase 3 owns the kernel lifecycle).
# - Rollback: before extracting, the applier snapshots the pre-update root
#   tree to /var/lib/sevynos/updates/previous/ (version.json + squashfs).
#   The recovery environment verifies and restores that snapshot on user
#   request; the boot-health layer restores it automatically after
#   repeated failed boots. The sha256 gate before extraction remains the
#   protection against a corrupt payload. Signature verification is
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

abort() {
  log "SEVYN_UPDATE_ABORT: $1"
  mv "$PENDING" "$UPDATES_DIR/failed-$(date +%s).json" 2>/dev/null || true
  exec "$INIT"
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
    trust_dir="${SEVYN_UPDATE_TRUST_DIR:-/var/lib/sevynos/update-trust}"
    if mkdir -p "$trust_dir" 2>/dev/null; then
      chmod 0700 "$trust_dir" 2>/dev/null || true
      printf '%s\n' "$snap_sha" > "$trust_dir/previous.sha256" 2>/dev/null || true
      chmod 600 "$trust_dir/previous.sha256" 2>/dev/null || true
    fi
    log "SEVYN_UPDATE_SNAPSHOT_DONE version=$current_version"
  else
    log "SEVYN_UPDATE_NO_ROLLBACK: snapshot failed, see /tmp/sevyn-snapshot.log"
    rm -rf "$prev_dir"
    rm -f "${SEVYN_UPDATE_TRUST_DIR:-/var/lib/sevynos/update-trust}/previous.sha256"
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

snapshot_previous
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

# Restore machine state over the new image.
sevyn_restore_machine_state "$BACKUP"
# Drop the consumed payload and flag.
rm -rf "$UPDATES_DIR/$VERSION" "$PENDING"

log "SEVYN_UPDATE_APPLIED version=$VERSION"
exec "$INIT"
