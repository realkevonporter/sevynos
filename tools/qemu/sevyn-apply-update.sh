#!/bin/busybox sh
# SevynOS pending-update applier.
#
# Runs as PID 1 on installed systems, exec'd from sevyn-installed-init when
# /var/lib/sevynos/updates/pending.json exists (written by the OS update
# service after a verified download). Extracts the staged rootfs.squashfs
# over / early in boot, preserving machine state, then re-execs the
# installed init.
#
# Scope notes (Phase 1 minimal):
# - Kernel/initramfs are NOT updated (Phase 3 owns the kernel lifecycle).
# - No A/B rollback: the sha256 gate before extraction is the protection
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

[ -n "$VERSION" ] || abort "malformed pending.json (version)"
[ -n "$PAYLOAD" ] || abort "malformed pending.json (payloadPath)"
[ -n "$SHA" ] || abort "malformed pending.json (sha256)"
[ -f "$PAYLOAD" ] || abort "staged payload missing: $PAYLOAD"

log "SEVYN_UPDATE_VERIFYING version=$VERSION"
if ! echo "$SHA  $PAYLOAD" | sha256sum -c - >/dev/null 2>&1; then
  abort "sha256 mismatch for staged payload"
fi

log "SEVYN_UPDATE_APPLYING version=$VERSION"
rm -rf "$BACKUP"
mkdir -p "$BACKUP/etc"
# Machine state that must survive the new image: app/user state, saved Wi-Fi,
# genesis state, timezone, hostname, machine-id. The staged payload itself is
# excluded from the backup (it lives under updates/ and tmpfs may be small).
cp -a /var/lib/sevynos "$BACKUP/var-lib-sevynos"
rm -rf "$BACKUP/var-lib-sevynos/updates"
for name in timezone localtime hostname machine-id; do
  [ -e "/etc/$name" ] && cp -a "/etc/$name" "$BACKUP/etc/$name" || true
done

if ! unsquashfs -f -d / "$PAYLOAD" >/tmp/sevyn-unsquashfs.log 2>&1; then
  log "SEVYN_UPDATE_FAILED: extraction failed, see /tmp/sevyn-unsquashfs.log"
  abort "extraction failed"
fi

# Restore machine state over the new image.
cp -a "$BACKUP/var-lib-sevynos/." /var/lib/sevynos/
for name in timezone localtime hostname machine-id; do
  [ -e "$BACKUP/etc/$name" ] && cp -a "$BACKUP/etc/$name" "/etc/$name" || true
done
# Drop the consumed payload and flag.
rm -rf "/var/lib/sevynos/updates/$VERSION" "$PENDING"
rm -rf "$BACKUP"

log "SEVYN_UPDATE_APPLIED version=$VERSION"
exec "$INIT"
