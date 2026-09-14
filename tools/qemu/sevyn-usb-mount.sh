#!/bin/sh
# SevynOS USB storage auto-mount
device="/dev/$1"
label=$(blkid -s LABEL -o value "$device" 2>/dev/null || echo "USB")
mount_point="/media/$1"
mkdir -p "$mount_point"
# Try common filesystem types
if mount -t vfat -o rw,uid=0,gid=0,umask=000,utf8 "$device" "$mount_point" 2>/dev/null; then
  echo "SEVYN_USB_MOUNTED device=$device label=$label mount=$mount_point fs=vfat"
elif mount -t ntfs3 -o rw,uid=0,gid=0,umask=000 "$device" "$mount_point" 2>/dev/null; then
  echo "SEVYN_USB_MOUNTED device=$device label=$label mount=$mount_point fs=ntfs"
elif mount -t ext4 -o rw "$device" "$mount_point" 2>/dev/null; then
  echo "SEVYN_USB_MOUNTED device=$device label=$label mount=$mount_point fs=ext4"
elif mount -t exfat -o rw,uid=0,gid=0,umask=000 "$device" "$mount_point" 2>/dev/null; then
  echo "SEVYN_USB_MOUNTED device=$device label=$label mount=$mount_point fs=exfat"
else
  rmdir "$mount_point" 2>/dev/null
  echo "SEVYN_USB_MOUNT_FAILED device=$device"
fi
