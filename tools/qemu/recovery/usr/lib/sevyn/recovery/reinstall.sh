#!/bin/busybox sh
# SevynOS Recovery — reinstall from local install media.
#
# Finds attached SevynOS install media (USB/CD carrying
# /live/filesystem.squashfs), then restores the pristine OS image over the
# installed root while preserving user data, accounts, machine identity,
# update state, boot assets and logs. Kernel, initramfs and the recovery
# image in /boot are refreshed from the media, and the recovery payload on
# the ESP is re-deployed so it stays in sync with the reinstalled OS.
#
# This is a repair reinstall: it needs a mountable system partition. When
# the partition is unrecoverable, use the full installer from the live
# media instead.
set -eu

SEVYN_RECOVERY_BASE="${SEVYN_RECOVERY_BASE:-/usr/lib/sevyn/recovery}"
# shellcheck disable=SC1091
. "$SEVYN_RECOVERY_BASE/recovery-lib.sh"

# find_install_media — mount candidates read-only and look for the live
# image; prints the mount point, leaving the media mounted.
find_install_media() {
  for _fm_dev in /dev/sd* /dev/hd* /dev/vd* /dev/nvme*n*p* /dev/mmcblk*p* /dev/sr*; do
    [ -b "$_fm_dev" ] || continue
    case "$_fm_dev" in
      *[0-9] | *sr*) ;;
      *) continue ;;
    esac
    # Never pick a device that is already mounted (e.g. the system disk
    # if some other operation left it mounted).
    if grep -q "^$_fm_dev " /proc/mounts 2>/dev/null; then
      continue
    fi
    _fm_type=$(blkid -s TYPE -o value "$_fm_dev" 2>/dev/null || true)
    case "$_fm_type" in
      iso9660 | udf | vfat | ext4 | ext3 | ext2) ;;
      *) continue ;;
    esac
    mkdir -p "$RECOVERY_MNT_MEDIA"
    umount "$RECOVERY_MNT_MEDIA" 2>/dev/null || true
    if mount -t "$_fm_type" -o ro "$_fm_dev" "$RECOVERY_MNT_MEDIA" 2>/dev/null; then
      if [ -f "$RECOVERY_MNT_MEDIA/live/filesystem.squashfs" ]; then
        printf '%s\n' "$RECOVERY_MNT_MEDIA"
        return 0
      fi
      umount "$RECOVERY_MNT_MEDIA" 2>/dev/null || true
    fi
  done
  umount "$RECOVERY_MNT_MEDIA" 2>/dev/null || true
  return 1
}

# refresh_boot_from_media <root> <media> — copy kernel, initramfs and the
# recovery initramfs from the install media into /boot.
refresh_boot_from_media() {
  _rb_root="$1"
  _rb_media="$2"
  for _rb_file in vmlinuz initramfs.cpio.gz recovery-initramfs.cpio.gz; do
    if [ -f "$_rb_media/boot/$_rb_file" ]; then
      cp "$_rb_media/boot/$_rb_file" "$_rb_root/boot/$_rb_file" || return 1
    else
      return 1
    fi
  done
  return 0
}

# redeploy_recovery_to_esp <root> — copy the kernel + recovery initramfs to
# EFI/SevynOS/ on the ESP so the GRUB recovery entry keeps working.
redeploy_recovery_to_esp() {
  _re_root="$1"
  _re_esp=""
  for _re_dev in /dev/sd* /dev/hd* /dev/vd* /dev/nvme*n*p* /dev/mmcblk*p*; do
    [ -b "$_re_dev" ] || continue
    case "$_re_dev" in *[0-9]) ;; *) continue ;; esac
    _re_type=$(blkid -s TYPE -o value "$_re_dev" 2>/dev/null || true)
    [ "$_re_type" = "vfat" ] || continue
    mkdir -p /mnt/sevyn-esp
    umount /mnt/sevyn-esp 2>/dev/null || true
    if mount -t vfat -o rw "$_re_dev" /mnt/sevyn-esp 2>/dev/null; then
      if [ -d /mnt/sevyn-esp/EFI/SevynOS ]; then
        _re_esp="$_re_dev"
        break
      fi
      umount /mnt/sevyn-esp 2>/dev/null || true
    fi
  done
  [ -n "$_re_esp" ] || {
    umount /mnt/sevyn-esp 2>/dev/null || true
    return 1
  }
  cp "$_re_root/boot/vmlinuz" /mnt/sevyn-esp/EFI/SevynOS/vmlinuz || {
    umount /mnt/sevyn-esp 2>/dev/null || true
    return 1
  }
  cp "$_re_root/boot/recovery-initramfs.cpio.gz" \
    /mnt/sevyn-esp/EFI/SevynOS/recovery-initramfs.cpio.gz || {
    umount /mnt/sevyn-esp 2>/dev/null || true
    return 1
  }
  sync
  umount /mnt/sevyn-esp 2>/dev/null || true
  return 0
}

main() {
  _media=$(find_install_media) || {
    rdialog --title "Reinstall SevynOS" \
      --msgbox "No SevynOS install media was found.\n\nAttach a USB drive or disc containing the SevynOS\ninstaller and try again." 10 60
    return 1
  }

  _root=$(mount_root rw) || {
    rdialog --title "Reinstall SevynOS" \
      --msgbox "Could not mount the SevynOS system partition.\n\nIf the partition is damaged beyond repair, boot the\nfull installer from the install media instead." 10 62
    umount "$RECOVERY_MNT_MEDIA" 2>/dev/null || true
    return 1
  }

  _media_version=$(cat "$_media/.sevyn-version" 2>/dev/null || echo "unknown")
  rdialog --title "Reinstall SevynOS" --yesno \
    "Reinstall SevynOS from the attached install media\n(version $_media_version)?\n\nSystem files are replaced with pristine copies.\nYour files, user accounts and settings are kept." 11 64 || {
    unmount_root
    umount "$RECOVERY_MNT_MEDIA" 2>/dev/null || true
    return 0
  }

  confirm_typed "Reinstall SevynOS" \
    "System files will be replaced with pristine copies from the install media.\n\nYour files and accounts are kept, but system-level changes\nmade after installation will be lost." \
    "REINSTALL" || {
    unmount_root
    umount "$RECOVERY_MNT_MEDIA" 2>/dev/null || true
    return 0
  }

  rdialog --title "Reinstall SevynOS" --infobox "Reinstalling system files from install media...\nThis may take several minutes." 5 58
  if ! restore_image_over_root "$_media/live/filesystem.squashfs" "$_root"; then
    unmount_root
    umount "$RECOVERY_MNT_MEDIA" 2>/dev/null || true
    return 1
  fi

  if ! refresh_boot_from_media "$_root" "$_media"; then
    rdialog --title "Reinstall SevynOS" \
      --msgbox "System files were restored, but the kernel files on the\ninstall media were incomplete. The system may not boot;\nreinstall from the full installer instead." 10 64
    unmount_root
    umount "$RECOVERY_MNT_MEDIA" 2>/dev/null || true
    return 1
  fi

  # Regenerate the bootloader config if it is missing or damaged, then
  # re-deploy the recovery payload to the ESP (best effort on BIOS systems
  # without an ESP).
  if [ ! -s "$_root/boot/grub/grub.cfg" ]; then
    _uuid=$(cmdline_value "sevyn.rootuuid") || _uuid=""
    if [ -z "$_uuid" ]; then
      _dev=$(root_device 2>/dev/null || true)
      _uuid=$(blkid -s UUID -o value "$_dev" 2>/dev/null || true)
    fi
    if [ -n "$_uuid" ]; then
      # shellcheck disable=SC1091
      . "$SEVYN_RECOVERY_BASE/grub-cfg-lib.sh"
      mkdir -p "$_root/boot/grub"
      sevyn_write_grub_cfg "$_root/boot/grub/grub.cfg" "$_uuid"
    fi
  fi
  if ! redeploy_recovery_to_esp "$_root"; then
    # Legacy BIOS installs have no ESP: the GRUB recovery entry boots
    # from /boot, which refresh_boot_from_media already updated.
    :
  fi

  sync
  unmount_root
  umount "$RECOVERY_MNT_MEDIA" 2>/dev/null || true
  rdialog --title "Reinstall SevynOS" \
    --msgbox "Reinstall complete.\n\nChoose Reboot from the recovery menu to start the\nrepaired system." 9 58
  return 0
}

main "$@"
