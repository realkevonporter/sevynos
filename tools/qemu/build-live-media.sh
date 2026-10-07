#!/bin/sh
set -eu

iso_root=/tmp/sevynos-live-root
rm -rf "$iso_root"
mkdir -p "$iso_root/boot/grub" "$iso_root/live"
cp /artifacts/vmlinuz "$iso_root/boot/vmlinuz"
cp /artifacts/initramfs.cpio.gz "$iso_root/boot/initramfs.cpio.gz"
cp /artifacts/recovery-initramfs.cpio.gz "$iso_root/boot/recovery-initramfs.cpio.gz"
cp /artifacts/rootfs.squashfs "$iso_root/live/filesystem.squashfs"
cp /usr/local/share/sevynos/grub.cfg "$iso_root/boot/grub/grub.cfg"
# Version marker the recovery environment reads when reinstalling from media.
printf '%s\n' "${SEVYN_OS_VERSION:-0.1.0}" > "$iso_root/.sevyn-version"

grub-mkrescue -o /artifacts/sevynos-live.iso "$iso_root"

cd /artifacts
sha256sum \
  vmlinuz \
  initramfs.cpio.gz \
  recovery-initramfs.cpio.gz \
  rootfs.squashfs \
  data-template.img \
  sevynos-live.iso > SHA256SUMS
