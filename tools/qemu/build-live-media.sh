#!/bin/sh
set -eu

iso_root=/tmp/sevynos-live-root
rm -rf "$iso_root"
mkdir -p "$iso_root/boot/grub" "$iso_root/live"
cp /artifacts/vmlinuz "$iso_root/boot/vmlinuz"
cp /artifacts/initramfs.cpio.gz "$iso_root/boot/initramfs.cpio.gz"
cp /artifacts/rootfs.squashfs "$iso_root/live/filesystem.squashfs"
cp /usr/local/share/sevynos/grub.cfg "$iso_root/boot/grub/grub.cfg"

grub-mkrescue -o /artifacts/sevynos-live.iso "$iso_root"

cd /artifacts
sha256sum \
  vmlinuz \
  initramfs.cpio.gz \
  rootfs.squashfs \
  data-template.img \
  sevynos-live.iso > SHA256SUMS
