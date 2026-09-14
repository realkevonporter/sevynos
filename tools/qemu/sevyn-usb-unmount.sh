#!/bin/sh
mount_point="/media/$1"
if mountpoint -q "$mount_point" 2>/dev/null; then
  umount "$mount_point" 2>/dev/null || umount -l "$mount_point" 2>/dev/null
  rmdir "$mount_point" 2>/dev/null
  echo "SEVYN_USB_UNMOUNTED device=/dev/$1 mount=$mount_point"
fi
