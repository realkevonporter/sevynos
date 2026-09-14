#!/bin/sh
set -eu
mkdir -p /artifacts
kernel="$(find /boot -maxdepth 1 -type f -name 'vmlinuz-*' | sort | tail -n 1)"
test -n "$kernel"
cp "$kernel" /artifacts/vmlinuz
kernel_version="${kernel#/boot/vmlinuz-}"
printf '%s\n' "$kernel_version" > /artifacts/kernel-version.txt
update-initramfs -u -k "$kernel_version"
cp "/boot/initrd.img-$kernel_version" /artifacts/initramfs.cpio.gz
mksquashfs / /artifacts/rootfs.squashfs \
  -noappend \
  -comp zstd \
  -Xcompression-level 15 \
  -wildcards \
  -p "/dev d 755 0 0" \
  -p "/proc d 755 0 0" \
  -p "/sys d 755 0 0" \
  -p "/run d 755 0 0" \
  -p "/tmp d 1777 0 0" \
  -p "/boot d 755 0 0" \
  -e artifacts "boot/*" "dev/*" "proc/*" "run/*" "sys/*" "tmp/*"
dd if=/dev/zero of=/artifacts/data-template.img bs=1M count=512 status=none
mkfs.ext4 -q -L SEVYN_DATA /artifacts/data-template.img
