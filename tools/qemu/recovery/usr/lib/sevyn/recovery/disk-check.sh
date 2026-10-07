#!/bin/busybox sh
# SevynOS Recovery — check disks for errors (fsck).
#
# Checks the installed system partition and the EFI System Partition while
# they are unmounted (recovery never mounts them at boot, so this is the
# normal state). Read-only problems are reported; the user chooses whether
# to apply automatic repairs.
set -eu

SEVYN_RECOVERY_BASE="${SEVYN_RECOVERY_BASE:-/usr/lib/sevyn/recovery}"
# shellcheck disable=SC1091
. "$SEVYN_RECOVERY_BASE/recovery-lib.sh"

# device_mounted <dev> — 0 when the device is currently mounted.
device_mounted() {
  grep -q "^$1 " /proc/mounts 2>/dev/null
}

# find_esp_device — print the ESP device (vfat partition hosting EFI/SevynOS
# or carrying the ESP label), or nothing.
find_esp_device() {
  for _fe_dev in /dev/sd* /dev/hd* /dev/vd* /dev/nvme*n*p* /dev/mmcblk*p*; do
    [ -b "$_fe_dev" ] || continue
    case "$_fe_dev" in *[0-9]) ;; *) continue ;; esac
    _fe_type=$(blkid -s TYPE -o value "$_fe_dev" 2>/dev/null || true)
    [ "$_fe_type" = "vfat" ] || continue
    _fe_label=$(blkid -s LABEL -o value "$_fe_dev" 2>/dev/null || true)
    _fe_partlabel=$(blkid -s PARTLABEL -o value "$_fe_dev" 2>/dev/null || true)
    case "$_fe_label/$_fe_partlabel" in
      *SEVYN_EFI* | *"EFI System Partition"*)
        printf '%s\n' "$_fe_dev"
        return 0
        ;;
    esac
  done
  return 1
}

check_one() {
  _co_dev="$1"
  _co_desc="$2"
  _co_fsck="$3"

  if device_mounted "$_co_dev"; then
    rdialog --title "Check Disks" \
      --msgbox "$_co_desc ($_co_dev) is currently mounted.\nUnmount it before checking." 8 60
    return 1
  fi

  rdialog --title "Check Disks" --yesno \
    "Check $_co_desc ($_co_desc device $_co_dev)?\n\nFirst a read-only scan runs. If problems are found\nyou will be asked whether to repair them." 10 62 || return 0

  rdialog --title "Check Disks" --infobox "Scanning $_co_dev (read-only)..." 5 50
  _co_log=/tmp/sevyn-fsck.log
  : > "$_co_log"
  if $_co_fsck -n "$_co_dev" >>"$_co_log" 2>&1; then
    rdialog --title "Check Disks" --textbox "$_co_log" 18 70
    return 0
  fi

  rdialog --title "Check Disks" --textbox "$_co_log" 18 70
  if rdialog --title "Check Disks" --yesno \
    "Problems were found on $_co_dev.\n\nAttempt automatic repair? (Recommended.)" 9 58; then
    rdialog --title "Check Disks" --infobox "Repairing $_co_dev..." 5 50
    if $_co_fsck -p "$_co_dev" >>"$_co_log" 2>&1; then
      rdialog --title "Check Disks" \
        --msgbox "Repair of $_co_dev completed.\n\nReview the log:" 7 50
    else
      rdialog --title "Check Disks" \
        --msgbox "Automatic repair could not fix everything on $_co_dev.\n\nReview the log below; the disk may need replacing." 9 60
    fi
    rdialog --title "Check Disks" --textbox "$_co_log" 18 70
  fi
  return 0
}

main() {
  _root_dev=$(root_device) || _root_dev=$(pick_root_device) || {
    rdialog --title "Check Disks" \
      --msgbox "Could not identify the SevynOS system partition." 8 60
    return 1
  }

  check_one "$_root_dev" "the SevynOS system partition" "fsck.ext4"

  _esp_dev=$(find_esp_device 2>/dev/null || true)
  if [ -n "$_esp_dev" ]; then
    check_one "$_esp_dev" "the EFI System Partition" "fsck.vfat"
  fi

  rdialog --title "Check Disks" --msgbox "Disk check finished." 6 40
  return 0
}

main "$@"
