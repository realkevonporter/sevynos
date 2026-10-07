#!/bin/busybox sh
# SevynOS pending-update applier.
#
# Runs as PID 1 on installed systems, exec'd from sevyn-installed-init when
# /var/lib/sevynos/updates/pending.json exists (written by the OS update
# service after a verified download). Extracts the staged rootfs.squashfs
# over / early in boot, preserving machine state, then re-execs the
# installed init.
#
# Scope notes:
# - Kernel/initramfs are NOT updated (Phase 3 owns the kernel lifecycle).
# - Rollback: before extracting, the applier snapshots the pre-update root
#   tree to /var/lib/sevynos/updates/previous/ (version.json + squashfs).
#   The recovery environment verifies and restores that snapshot on user
#   request. The sha256 gate before extraction remains the protection
#   against a corrupt payload. Signature verification is Phase 3.
set -eu
export PATH=/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

PENDING=/var/lib/sevynos/updates/pending.json
INIT=/usr/local/lib/sevynos/installed-init
BACKUP=/tmp/sevyn-update-backup

log() {
  echo "$1"
  if [ -c /dev/ttyS0 ]; then
    echo "$1" > /dev/ttyS0 2>/dev/null || true
  fi
}

# Re-exec from tmpfs: unsquashfs is about to replace /usr/... and must not
# clobber the running script.
case "$0" in
  /tmp/*) ;;
  *)
    cp "$0" /tmp/sevyn-apply-update.sh
    exec /bin/busybox sh /tmp/sevyn-apply-update.sh inner
    ;;
esac

[ -f "$PENDING" ] || exec "$INIT"

VERSION=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$PENDING" | head -n 1)
PAYLOAD=$(sed -n 's/.*"payloadPath"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$PENDING" | head -n 1)
SHA=$(sed -n 's/.*"sha256"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$PENDING" | head -n 1)

abort() {
  log "SEVYN_UPDATE_ABORT: $1"
  mv "$PENDING" "/var/lib/sevynos/updates/failed-$(date +%s).json" 2>/dev/null || true
  exec "$INIT"
}

# snapshot_previous — capture the pre-update system into
# /var/lib/sevynos/updates/previous/ so the recovery environment can roll
# back: version.json (version, timestamp, sha256) plus a squashfs of the
# pre-update root tree. Only one generation is kept; each update replaces
# it. Best-effort: if the snapshot cannot be taken (too little free space,
# missing tooling), the update still proceeds and recovery reports that no
# rollback is available for it.
snapshot_previous() {
  updates_dir=/var/lib/sevynos/updates
  prev_dir=$updates_dir/previous
  current_version=$(sed -n 's/^VERSION_ID="\?\([^"]*\)"\?/\1/p' /etc/sevynos-release 2>/dev/null | head -n 1)
  [ -n "$current_version" ] || current_version="unknown"

  if ! command -v mksquashfs >/dev/null 2>&1; then
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
  if mksquashfs / "$prev_dir/rootfs.squashfs.tmp" \
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
    log "SEVYN_UPDATE_SNAPSHOT_DONE version=$current_version"
  else
    log "SEVYN_UPDATE_NO_ROLLBACK: snapshot failed, see /tmp/sevyn-snapshot.log"
    rm -rf "$prev_dir"
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
rm -rf "$BACKUP"
mkdir -p "$BACKUP/etc"
# Machine state that must survive the new image: app/user state, saved Wi-Fi,
# genesis state, timezone, hostname, machine-id, and the account databases
# (the payload carries build-time passwd/shadow/group/gshadow without the
# installed users; restoring the machine's copies keeps logins and sudo
# working after the update). The staged payload itself is excluded from the
# backup (it lives under updates/ and tmpfs may be small).
cp -a /var/lib/sevynos "$BACKUP/var-lib-sevynos"
rm -rf "$BACKUP/var-lib-sevynos/updates"
for name in timezone localtime hostname machine-id passwd shadow group gshadow; do
  [ -e "/etc/$name" ] && cp -a "/etc/$name" "$BACKUP/etc/$name" || true
done

if ! unsquashfs -f -d / "$PAYLOAD" >/tmp/sevyn-unsquashfs.log 2>&1; then
  log "SEVYN_UPDATE_FAILED: extraction failed, see /tmp/sevyn-unsquashfs.log"
  abort "extraction failed"
fi

# Restore machine state over the new image.
cp -a "$BACKUP/var-lib-sevynos/." /var/lib/sevynos/
for name in timezone localtime hostname machine-id passwd shadow group gshadow; do
  [ -e "$BACKUP/etc/$name" ] && cp -a "$BACKUP/etc/$name" "/etc/$name" || true
done
# Drop the consumed payload and flag.
rm -rf "/var/lib/sevynos/updates/$VERSION" "$PENDING"
rm -rf "$BACKUP"

log "SEVYN_UPDATE_APPLIED version=$VERSION"
exec "$INIT"
