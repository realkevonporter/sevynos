#!/bin/busybox sh
# SevynOS Recovery — roll back to the pre-update snapshot.
#
# Reads /var/lib/sevynos/updates/previous/ (written by the boot-time update
# applier before it extracts an update): verifies version.json + the sha256
# of rootfs.squashfs, then restores the snapshot over the installed root
# while preserving user data, accounts, machine identity, update state,
# boot assets and logs (see restore_image_over_root in recovery-lib.sh).
set -eu

SEVYN_RECOVERY_BASE="${SEVYN_RECOVERY_BASE:-/usr/lib/sevyn/recovery}"
# shellcheck disable=SC1091
. "$SEVYN_RECOVERY_BASE/recovery-lib.sh"

main() {
  _root=$(mount_root rw) || {
    rdialog --title "Roll Back Update" \
      --msgbox "Could not find or mount the SevynOS system partition." 8 60
    return 1
  }

  if pending_update_present "$_root"; then
    rdialog --title "Roll Back Update" \
      --msgbox "An OS update is staged and waiting to be applied at the next boot.\n\nRolling back now would conflict with it: reboot once to let the\nupdate apply (or delete /var/lib/sevynos/updates/pending.json\nfrom the install media), then roll back if you still need to." 13 66
    unmount_root
    return 1
  fi

  _info=$(previous_snapshot_valid "$_root") || {
    rdialog --title "Roll Back Update" \
      --msgbox "No verified pre-update snapshot was found.\n\nRollbacks are available only for updates applied after this\nrecovery environment was installed: the update applier saves\na snapshot of your system before each update. If no update\nhas been applied yet, there is nothing to roll back to." 13 66
    unmount_root
    return 1
  }
  _version=${_info#version=}

  rdialog --title "Roll Back Update" --yesno \
    "Roll back SevynOS to version $_version\n(the state before the last update)?\n\nYour files, user accounts and settings are kept.\nOnly system files are restored." 11 64 || {
    unmount_root
    return 0
  }

  confirm_typed "Roll Back Update" \
    "This will replace system files with the pre-update snapshot (version $_version).\n\nYour files and accounts are kept, but anything installed\nat the system level after the update will be removed." \
    "ROLLBACK" || {
    unmount_root
    return 0
  }

  rdialog --title "Roll Back Update" --infobox "Restoring the pre-update system files...\nThis may take several minutes." 5 58
  if restore_image_over_root "$_root/var/lib/sevynos/updates/previous/rootfs.squashfs" "$_root"; then
    sync
    unmount_root
    rdialog --title "Roll Back Update" \
      --msgbox "Rollback to version $_version is complete.\n\nChoose Reboot from the recovery menu to start the\nrestored system." 10 60
    return 0
  fi

  unmount_root
  return 1
}

main "$@"
