#!/bin/sh
# SevynOS Recovery Image Builder.
#
# Assembles the recovery initramfs (recovery-initramfs.cpio.gz) from the
# recovery tree (tools/qemu/recovery) plus a static busybox, dialog, disk
# and squashfs tools, and a curated set of storage/input kernel modules.
# Runs inside the image build (after build-image.sh wrote
# /artifacts/kernel-version.txt) and drops the artifact next to the other
# boot artifacts in /artifacts/.
#
# The result is a self-contained boot environment: it needs no root
# filesystem, only the kernel it ships next to (modules must match the
# kernel version they were built against).
set -eu

SRC="${SEVYN_RECOVERY_SRC:-/usr/local/src/sevyn-recovery}"
GRUB_CFG_LIB="${SEVYN_GRUB_CFG_LIB:-/usr/local/lib/sevyn-grub-cfg-lib.sh}"
KERNEL_LIFECYCLE_LIB="${SEVYN_KERNEL_LIFECYCLE_LIB:-/usr/local/lib/sevyn-kernel-lifecycle-lib.sh}"
ARTIFACTS="${SEVYN_ARTIFACTS:-/artifacts}"
OS_VERSION="${SEVYN_OS_VERSION:-0.1.0}"
# SEVYN_MODULES_DIR — when set, kernel modules are located under this
# directory instead of the host's /lib/modules (via `modinfo -k $KVER`).
# The update-time rebuild (Phase 3 B3) sets it to the NEW kernel's modules
# extracted from the staged rootfs, so the recovery image is built against
# the new kernel before the rootfs is replaced.
MODULES_DIR="${SEVYN_MODULES_DIR:-}"

log() { echo "[build-recovery-image] $*"; }
fail() { log "FATAL: $*"; exit 1; }

[ -d "$SRC" ] || fail "recovery tree not found: $SRC"
[ -f "$GRUB_CFG_LIB" ] || fail "GRUB config lib not found: $GRUB_CFG_LIB"
[ -f "$KERNEL_LIFECYCLE_LIB" ] || fail "kernel lifecycle lib not found: $KERNEL_LIFECYCLE_LIB"
[ -f "$ARTIFACTS/kernel-version.txt" ] || fail "kernel-version.txt missing; run build-image.sh first."
command -v cpio >/dev/null 2>&1 || fail "cpio is required."
command -v depmod >/dev/null 2>&1 || fail "depmod is required."
if [ -z "$MODULES_DIR" ]; then
  command -v modinfo >/dev/null 2>&1 || fail "modinfo is required."
else
  [ -d "$MODULES_DIR" ] || fail "SEVYN_MODULES_DIR is not a directory: $MODULES_DIR"
fi

KVER=$(cat "$ARTIFACTS/kernel-version.txt")
log "Building recovery initramfs for kernel $KVER (OS $OS_VERSION)"

STAGE=$(mktemp -d /tmp/sevyn-recovery-stage.XXXXXX)
mkdir -p "$STAGE"/bin "$STAGE"/sbin "$STAGE"/usr/bin "$STAGE"/usr/sbin \
  "$STAGE"/lib "$STAGE"/lib64 "$STAGE"/etc "$STAGE"/proc "$STAGE"/sys \
  "$STAGE"/dev "$STAGE"/tmp "$STAGE"/run \
  "$STAGE"/mnt/sevyn-root "$STAGE"/mnt/sevyn-media "$STAGE"/mnt/sevyn-esp

# ─── Recovery tree ────────────────────────────────────────────────
cp -a "$SRC/init" "$STAGE/init"
cp -a "$SRC/usr" "$STAGE/usr"
cp "$GRUB_CFG_LIB" "$STAGE/usr/lib/sevyn/recovery/grub-cfg-lib.sh"
# Kernel lifecycle lib: lets the recovery rollback flip the kernel pair
# together with the rootfs snapshot (Phase 3 B3 pairing contract).
# Sourced opportunistically by rollback.sh — older recovery images lack
# it and skip the flip.
cp "$KERNEL_LIFECYCLE_LIB" "$STAGE/usr/lib/sevyn/recovery/kernel-lifecycle-lib.sh"
printf '%s\n' "$OS_VERSION" > "$STAGE/usr/lib/sevyn/recovery/VERSION"
chmod 0755 "$STAGE/init"
chmod 0755 "$STAGE"/usr/lib/sevyn/recovery/*.sh

# Static device nodes the kernel needs before /init mounts devtmpfs.
mknod "$STAGE/dev/console" c 5 1
mknod "$STAGE/dev/null" c 1 3

# ─── Binaries + their shared libraries ────────────────────────────
copy_with_libs() {
  # copy_with_libs <host-path> <stage-relative-dest>
  src="$1"
  dest="$2"
  [ -f "$src" ] || fail "required binary missing: $src"
  mkdir -p "$STAGE/$(dirname "$dest")"
  cp -aL "$src" "$STAGE/$dest"
  ldd "$src" 2>/dev/null |
    awk '{ if ($2 == "=>") print $3; else if ($1 ~ /^\//) print $1 }' |
    sort -u |
    while IFS= read -r lib; do
      [ -n "$lib" ] || continue
      case "$lib" in
        /lib/* | /usr/lib/*) ;;
        *) continue ;;
      esac
      rel="${lib#/}"
      if [ ! -e "$STAGE/$rel" ]; then
        mkdir -p "$STAGE/$(dirname "$rel")"
        cp -aL "$lib" "$STAGE/$rel"
      fi
    done
}

# busybox-static ships the static binary the whole environment runs on.
copy_with_libs /bin/busybox bin/busybox
ln -sf busybox "$STAGE/bin/sh"

copy_with_libs /usr/bin/dialog usr/bin/dialog
copy_with_libs /sbin/fsck.ext4 sbin/fsck.ext4
copy_with_libs /sbin/e2fsck sbin/e2fsck
copy_with_libs /sbin/fsck.vfat sbin/fsck.vfat
copy_with_libs /sbin/blkid sbin/blkid
copy_with_libs /usr/bin/unsquashfs usr/bin/unsquashfs

# ncurses terminal database for dialog.
if [ -f /usr/share/terminfo/l/linux ]; then
  mkdir -p "$STAGE/usr/share/terminfo/l"
  cp -a /usr/share/terminfo/l/linux "$STAGE/usr/share/terminfo/l/linux"
else
  fail "terminfo entry for 'linux' not found."
fi

# ─── Kernel modules ───────────────────────────────────────────────
# Curated set: storage (SATA/NVMe/virtio/USB/MMC), filesystems the
# recovery mounts (ext4, vfat, iso9660), and USB HID for keyboards.
# Everything is best-effort per module: a kernel built without one simply
# loses that hardware path in recovery.
find_module() {
  # find_module <name> — print the .ko path for a module, or nothing.
  _fm_mod="$1"
  if [ -n "$MODULES_DIR" ]; then
    find "$MODULES_DIR" \
      \( -name "$_fm_mod.ko" -o -name "$_fm_mod.ko.zst" \
         -o -name "$_fm_mod.ko.xz" -o -name "$_fm_mod.ko.gz" \) \
      2>/dev/null | head -n 1
  else
    modinfo -k "$KVER" -n "$_fm_mod" 2>/dev/null || true
  fi
}
RECOVERY_MODULES="ext4 mbcache jbd2 vfat fat nls_cp437 nls_iso8859-1 isofs \
  virtio_blk virtio_pci virtio_ring virtio nvme nvme_core \
  ahci libahci libata sd_mod sr_mod cdrom \
  usb_storage uas xhci_pci xhci_hcd ehci_pci ehci_hcd uhci_hcd \
  usb_common usbcore hid hid_generic usbhid \
  mmc_core mmc_block sdhci sdhci_pci"
for mod in $RECOVERY_MODULES; do
  ko=$(find_module "$mod")
  if [ -z "$ko" ] || [ ! -f "$ko" ]; then
    log "WARNING: kernel module '$mod' not found; skipping."
    continue
  fi
  rel="${ko#/}"
  # With SEVYN_MODULES_DIR the .ko lives outside /lib/modules/<kver>;
  # re-root it so the stage layout stays canonical.
  case "$rel" in
    lib/modules/*) ;;
    *) rel="lib/modules/$KVER/${ko##*/}" ;;
  esac
  mkdir -p "$STAGE/$(dirname "$rel")"
  cp -a "$ko" "$STAGE/$rel"
done
depmod -b "$STAGE" "$KVER" 2>/dev/null || log "WARNING: depmod reported issues."
[ -f "$STAGE/lib/modules/$KVER/modules.dep" ] ||
  fail "modules.dep was not generated for $KVER."

# ─── Archive ──────────────────────────────────────────────────────
(
  cd "$STAGE" &&
    find . -print0 | cpio --format=newc --create --null 2>/dev/null
) | gzip -9 > "$ARTIFACTS/recovery-initramfs.cpio.gz"
sha256sum "$ARTIFACTS/recovery-initramfs.cpio.gz" |
  awk '{ print $1 }' > "$ARTIFACTS/recovery-initramfs.sha256"
printf '%s\n' "$OS_VERSION" > "$ARTIFACTS/recovery-version.txt"

size=$(du -h "$ARTIFACTS/recovery-initramfs.cpio.gz" | cut -f1)
log "Wrote $ARTIFACTS/recovery-initramfs.cpio.gz ($size)"
rm -rf "$STAGE"
