#!/bin/sh
# SevynOS Installer — TUI-based system installer
# Runs from the live USB environment to install SevynOS to disk.
set -eu

INSTALLER_VERSION="1.0.0"
SEVYN_ROOT_MIN_MB=20480  # 20 GB minimum for root
SEVYN_SWAP_MB=4096       # 4 GB swap
SEVYN_ESP_MB=512          # 512 MB EFI System Partition
SQUASHFS_PATH="/live/filesystem.squashfs"
INSTALLED_INIT="/usr/local/lib/sevynos/installed-init"
CHROOT_SCRIPT="/usr/local/bin/sevyn-installer-chroot"

# Keep the installer visually consistent across different live environments.
# dialog reads this file at startup; the fallback colors remain usable on
# terminals that do not support the full palette.
SEVYN_DIALOGRC="/tmp/sevyn-dialogrc"
cat > "$SEVYN_DIALOGRC" <<'EOF'
screen_color = (WHITE,BLACK,OFF)
dialog_color = (WHITE,BLACK,OFF)
title_color = (BLACK,CYAN,ON)
border_color = (CYAN,BLACK,ON)
button_active_color = (BLACK,CYAN,ON)
button_inactive_color = (WHITE,BLACK,OFF)
item_selected_color = (BLACK,CYAN,ON)
tag_color = (CYAN,BLACK,ON)
inputbox_border_color = (CYAN,BLACK,ON)
gauge_color = (BLACK,CYAN,ON)
EOF
export DIALOGRC="$SEVYN_DIALOGRC"

# Add SevynOS branding to every screen without changing the installer flow.
dialog() {
  command dialog --backtitle "SEVYNOS  /  SYSTEM INSTALLER" "$@"
}

# ─── Logging ────────────────────────────────────────────────────────
log() {
  echo "[sevyn-installer] $*" >&2
  echo "[sevyn-installer] $*" >> /tmp/sevyn-install.log 2>/dev/null || true
}

fail() {
  log "FATAL: $*"
  if [ "${SEVYN_UNATTENDED:-0}" = "1" ]; then
    echo "SEVYN_INSTALL_FAILED: $*" > /dev/ttyS0 2>/dev/null || true
  elif command -v dialog >/dev/null 2>&1; then
    dialog --title "Installation Failed" --msgbox "Error: $*\n\nSee /tmp/sevyn-install.log for details." 10 60
  else
    echo "FATAL: $*" >&2
  fi
  exit 1
}

# ─── Checks ─────────────────────────────────────────────────────────
check_prerequisites() {
  for cmd in dialog parted blkid lsblk blockdev findmnt mount umount partprobe mkfs.vfat mkfs.ext4 mkswap unsquashfs chroot; do
    command -v "$cmd" >/dev/null 2>&1 || fail "Required tool '$cmd' is not available."
  done

  if [ ! -f "$SQUASHFS_PATH" ]; then
    # Try alternate location
    if [ -f /run/live/medium/live/filesystem.squashfs ]; then
      SQUASHFS_PATH="/run/live/medium/live/filesystem.squashfs"
    else
      fail "Cannot find SevynOS root filesystem (squashfs)."
    fi
  fi

  if [ "$(id -u)" -ne 0 ]; then
    fail "The installer must run as root."
  fi
}

# ─── Disk Detection ─────────────────────────────────────────────────
detect_disks() {
  live_source=$(findmnt -n -o SOURCE /run/live/medium 2>/dev/null || true)
  if [ -z "$live_source" ]; then
    live_source=$(awk '$2 == "/run/live/medium" { print $1; exit }' /proc/mounts 2>/dev/null || true)
  fi
  live_disk=""
  case "$live_source" in
    /dev/*)
      live_name=${live_source#/dev/}
      live_parent=$(lsblk -n -o PKNAME "$live_source" 2>/dev/null | head -n 1 | tr -d ' ')
      [ -n "$live_parent" ] && live_name="$live_parent"
      live_disk="/dev/$live_name"
      ;;
  esac

  # /sys/block is stable even when a device has no transport or model string.
  for sys_device in /sys/block/*; do
    [ -e "$sys_device" ] || continue
    name=${sys_device##*/}
    case "$name" in loop*|ram*|zram*|sr*|fd*|dm-*|md*) continue ;; esac
    dev="/dev/$name"
    [ -b "$dev" ] || continue
    [ "$dev" = "$live_disk" ] && continue
    bytes=$(blockdev --getsize64 "$dev" 2>/dev/null || echo 0)
    [ "$bytes" -gt 0 ] 2>/dev/null || continue
    size=$(lsblk -dn -o SIZE "$dev" 2>/dev/null | tr -d ' ')
    [ -n "$size" ] || size="$((bytes / 1073741824))G"
    model=$(cat "$sys_device/device/model" 2>/dev/null | tr -s ' ' | sed 's/^ //;s/ $//' || true)
    [ -n "$model" ] || model="Internal or attached storage"
    printf '%s (%s) %s\n' "$dev" "$size" "$model"
  done
}

detect_existing_os() {
  if command -v os-prober >/dev/null 2>&1; then
    os-prober 2>/dev/null || true
  fi
}

find_esp() {
  # Find an existing EFI System Partition on the target disk
  target_disk="$1"
  blkid -t PARTLABEL="EFI System Partition" -o device 2>/dev/null | while IFS= read -r dev; do
    case "$dev" in
      "${target_disk}"*) echo "$dev"; return 0 ;;
    esac
  done
  # Also check for vfat partitions with boot flag
  parted -s "$target_disk" print 2>/dev/null | grep -i "esp\|boot" | grep -i "fat" | awk '{print $1}' | while IFS= read -r num; do
    if [ -n "$num" ]; then
      echo "${target_disk}${num}"
      return 0
    fi
  done
  return 1
}

# ─── Welcome Screen ─────────────────────────────────────────────────
show_welcome() {
  dialog --title "SevynOS Installer v${INSTALLER_VERSION}" \
    --yes-label "Continue" \
    --no-label "Exit" \
    --yesno "\n  Welcome to SevynOS!\n\n  This installer will guide you through installing\n  SevynOS on your computer.\n\n  You can install SevynOS:\n  • Alongside your existing operating system (dual-boot)\n  • On the entire disk (erases everything)\n\n  Make sure you have backed up important data.\n\n  Press 'Continue' to proceed or 'Exit' to return to the live desktop." 18 62
}

# ─── Disk Selection ──────────────────────────────────────────────────
select_disk() {
  disks=$(detect_disks)
  if [ -z "$disks" ]; then
    fail "No suitable disks found for installation."
  fi

  # Build dialog menu items
  menu_items=""
  disk_count=0
  echo "$disks" | while IFS= read -r line; do
    disk_count=$((disk_count + 1))
    printf '%s\n' "$line"
  done > /tmp/sevyn-disks.txt

  items=""
  while IFS= read -r line; do
    dev=$(echo "$line" | awk '{print $1}')
    desc=$(echo "$line" | sed "s|$dev ||")
    items="$items $dev \"$desc\""
  done < /tmp/sevyn-disks.txt

  # Keep dialog's UI on the terminal while returning only the selected tag.
  eval "dialog --title 'Select Installation Disk' \
    --menu 'Choose the disk where SevynOS will be installed:' \
    15 65 5 $items 3>&1 1>&2 2>&3 3>&-"
}

# ─── Installation Mode ──────────────────────────────────────────────
select_mode() {
  target_disk="$1"
  disk_size_bytes=$(blockdev --getsize64 "$target_disk" 2>/dev/null || echo 0)
  disk_size_gb=$((disk_size_bytes / 1073741824))

  # Check for existing partitions
  existing_parts=$(lsblk -n -o NAME,FSTYPE,SIZE,LABEL "$target_disk" 2>/dev/null | tail -n +1)
  existing_os=$(detect_existing_os)

  dialog --title "Installation Type" \
    --menu "Disk: $target_disk (${disk_size_gb} GB)\n\nHow would you like to install SevynOS?" \
    16 65 3 \
    "alongside" "Install alongside existing OS (dual-boot)" \
    "erase" "Erase disk and install SevynOS" \
    "cancel" "Cancel installation" \
    3>&1 1>&2 2>&3 3>&-
}

# ─── Partition: Erase Entire Disk ────────────────────────────────────
partition_erase() {
  target_disk="$1"
  log "Partitioning $target_disk (erase mode)"

  if [ "${SEVYN_UNATTENDED:-0}" != "1" ]; then
    dialog --title "⚠ WARNING — DATA LOSS ⚠" \
      --yes-label "Yes, I understand" \
      --no-label "Cancel" \
      --yesno "\n  ALL DATA ON $target_disk WILL BE PERMANENTLY ERASED.\n\n  This cannot be undone.\n\n  Are you absolutely sure you want to continue?" 12 60 || return 1
  fi

  # Create GPT partition table
  parted -s "$target_disk" mklabel gpt || fail "Failed to create partition table."

  disk_size_mb=$(($(blockdev --getsize64 "$target_disk") / 1048576))
  swap_start=$((disk_size_mb - SEVYN_SWAP_MB))
  root_start=$((SEVYN_ESP_MB + 1))
  root_end=$((swap_start - 1))

  if [ "$root_end" -lt "$((root_start + SEVYN_ROOT_MIN_MB))" ]; then
    fail "Disk is too small. Need at least $((SEVYN_ROOT_MIN_MB + SEVYN_ESP_MB + SEVYN_SWAP_MB)) MB."
  fi

  # Create partitions
  # A tiny BIOS boot partition makes the same GPT disk bootable on legacy BIOS.
  # UEFI firmware uses the following FAT32 ESP.
  root_start=$((SEVYN_ESP_MB + 4))
  parted -s "$target_disk" \
    mkpart BIOSBOOT 1MiB 3MiB \
    set 1 bios_grub on \
    mkpart SEVYN_EFI fat32 3MiB "$((SEVYN_ESP_MB + 3))MiB" \
    set 2 esp on \
    mkpart "SevynOS" ext4 "${root_start}MiB" "${root_end}MiB" \
    mkpart "swap" linux-swap "${swap_start}MiB" 100% \
    || fail "Failed to create partitions."

  # Wait for kernel to re-read partition table
  partprobe "$target_disk" 2>/dev/null || true
  sleep 2

  # Determine partition device names
  case "$target_disk" in
    *nvme*|*mmcblk*) sep="p" ;;
    *) sep="" ;;
  esac
  ESP_DEV="${target_disk}${sep}2"
  ROOT_DEV="${target_disk}${sep}3"
  SWAP_DEV="${target_disk}${sep}4"

  # Format partitions
  log "Formatting ESP: $ESP_DEV"
  mkfs.vfat -F 32 -n SEVYN_EFI "$ESP_DEV" >&2 || fail "Failed to format EFI partition."

  log "Formatting root: $ROOT_DEV"
  mkfs.ext4 -q -L SEVYNOS_ROOT "$ROOT_DEV" >&2 || fail "Failed to format root partition."

  log "Creating swap: $SWAP_DEV"
  mkswap -L SEVYN_SWAP "$SWAP_DEV" >&2 || fail "Failed to create swap."
}

# ─── Partition: Alongside Existing OS ────────────────────────────────
partition_alongside() {
  target_disk="$1"
  log "Partitioning $target_disk (alongside mode)"

  # Find the largest partition to shrink
  largest_part=""
  largest_size=0
  parted -s "$target_disk" unit MiB print 2>/dev/null | grep -E '^ *[0-9]' | while IFS= read -r line; do
    part_num=$(echo "$line" | awk '{print $1}')
    part_size=$(echo "$line" | awk '{print $4}' | sed 's/MiB//')
    if [ "${part_size:-0}" -gt "$largest_size" ] 2>/dev/null; then
      largest_size="$part_size"
      largest_part="$part_num"
      echo "$largest_part $largest_size" > /tmp/sevyn-largest-part.txt
    fi
  done

  if [ ! -f /tmp/sevyn-largest-part.txt ]; then
    fail "Could not find a partition to resize."
  fi

  read -r largest_part largest_size < /tmp/sevyn-largest-part.txt
  needed_mb=$((SEVYN_ROOT_MIN_MB + SEVYN_SWAP_MB + 1024))
  new_size=$((largest_size - needed_mb))

  if [ "$new_size" -lt 10240 ]; then
    fail "Not enough space. The largest partition (${largest_size} MB) is too small to resize. Need at least $((needed_mb + 10240)) MB."
  fi

  case "$target_disk" in
    *nvme*|*mmcblk*) sep="p" ;;
    *) sep="" ;;
  esac
  shrink_dev="${target_disk}${sep}${largest_part}"

  dialog --title "⚠ WARNING — PARTITION RESIZE ⚠" \
    --yes-label "Yes, I understand" \
    --no-label "Cancel" \
    --yesno "\n  Partition $shrink_dev will be resized from\n  ${largest_size} MB to ${new_size} MB.\n\n  This will free $((largest_size - new_size)) MB for SevynOS.\n\n  Make sure you have backed up your data.\n\n  Continue?" 14 60 || return 1

  # Resize the partition
  log "Resizing partition $largest_part to ${new_size}MiB"
  parted -s "$target_disk" resizepart "$largest_part" "${new_size}MiB" \
    || fail "Failed to resize partition $largest_part."

  # Try to resize the filesystem if it's NTFS or ext4
  fs_type=$(blkid -s TYPE -o value "$shrink_dev" 2>/dev/null || true)
  case "$fs_type" in
    ntfs)
      if command -v ntfsresize >/dev/null 2>&1; then
        ntfsresize -f -s "${new_size}M" "$shrink_dev" 2>/dev/null || log "NTFS resize warning (non-fatal)"
      fi
      ;;
    ext4|ext3|ext2)
      e2fsck -f -y "$shrink_dev" 2>/dev/null || true
      resize2fs "$shrink_dev" "${new_size}M" 2>/dev/null || log "ext resize warning (non-fatal)"
      ;;
  esac

  # Check for existing ESP
  existing_esp=$(find_esp "$target_disk" || true)

  # Get the end of the resized partition as start for new partitions
  free_start="${new_size}"
  swap_start=$((free_start + SEVYN_ROOT_MIN_MB))

  # Create SevynOS root partition
  parted -s "$target_disk" \
    mkpart "SevynOS" ext4 "${free_start}MiB" "${swap_start}MiB" \
    || fail "Failed to create SevynOS root partition."

  # Create swap partition
  parted -s "$target_disk" \
    mkpart "swap" linux-swap "${swap_start}MiB" "$((swap_start + SEVYN_SWAP_MB))MiB" \
    || fail "Failed to create swap partition."

  partprobe "$target_disk" 2>/dev/null || true
  sleep 2

  # Find the new partition numbers
  new_parts=$(parted -s "$target_disk" print 2>/dev/null | grep -c '^ *[0-9]')
  root_num=$((new_parts - 1))
  swap_num=$new_parts

  ROOT_DEV="${target_disk}${sep}${root_num}"
  SWAP_DEV="${target_disk}${sep}${swap_num}"

  # Create or use existing ESP
  if [ -n "$existing_esp" ]; then
    ESP_DEV="$existing_esp"
    log "Using existing ESP: $ESP_DEV"
  else
    # Create ESP at the beginning if there isn't one (unlikely for UEFI systems)
    ESP_DEV="${target_disk}${sep}1"
    log "Warning: No existing ESP found. Using $ESP_DEV"
  fi

  # Format root and swap
  log "Formatting root: $ROOT_DEV"
  mkfs.ext4 -q -L SEVYNOS_ROOT "$ROOT_DEV" >&2 || fail "Failed to format root partition."

  log "Creating swap: $SWAP_DEV"
  mkswap -L SEVYN_SWAP "$SWAP_DEV" >&2 || fail "Failed to create swap."
}

# ─── Install System ─────────────────────────────────────────────────
install_system() {
  esp_dev="$1"
  root_dev="$2"
  swap_dev="$3"
  target_disk="$4"

  target="/mnt/sevynos"
  mkdir -p "$target"

  log "Mounting root partition $root_dev"
  mount "$root_dev" "$target" || fail "Failed to mount root partition."

  mkdir -p "$target/boot/efi"
  log "Mounting ESP $esp_dev"
  mount "$esp_dev" "$target/boot/efi" || fail "Failed to mount EFI partition."

  # Extract rootfs
  log "Extracting SevynOS filesystem (this may take several minutes)..."
  dialog --title "Installing SevynOS" --infobox "Extracting and verifying system files...\n\nThis may take several minutes." 7 58
  if ! unsquashfs -f -d "$target" "$SQUASHFS_PATH" >/tmp/sevyn-unsquashfs.log 2>&1; then
    fail "Failed to extract the SevynOS filesystem."
  fi

  # Generate fstab
  log "Generating /etc/fstab"
  root_uuid=$(blkid -s UUID -o value "$root_dev")
  esp_uuid=$(blkid -s UUID -o value "$esp_dev")
  swap_uuid=$(blkid -s UUID -o value "$swap_dev")

  mkdir -p "$target/etc"
  cat > "$target/etc/fstab" <<EOF
# SevynOS /etc/fstab — generated by sevyn-installer
# <device>                                 <mount>     <type>  <options>       <dump> <pass>
UUID=$root_uuid    /           ext4    errors=remount-ro   0      1
UUID=$esp_uuid     /boot/efi   vfat    umask=0077          0      1
UUID=$swap_uuid    none        swap    sw                  0      0
EOF

  # Set hostname
  echo "sevynos" > "$target/etc/hostname"
  cat > "$target/etc/hosts" <<EOF
127.0.0.1   localhost
127.0.1.1   sevynos
::1         localhost ip6-localhost ip6-loopback
EOF

  # Install the installed-mode init script
  if [ -f "$INSTALLED_INIT" ]; then
    cp "$INSTALLED_INIT" "$target/init"
    chmod 0755 "$target/init"
  fi

  # Copy kernel and initramfs to installed system
  kernel_source=""
  initramfs_source=""
  for candidate in /boot/vmlinuz /run/live/medium/boot/vmlinuz /lib/live/mount/medium/boot/vmlinuz; do
    if [ -f "$candidate" ]; then kernel_source="$candidate"; break; fi
  done
  for candidate in /boot/initramfs.cpio.gz /run/live/medium/boot/initramfs.cpio.gz /lib/live/mount/medium/boot/initramfs.cpio.gz; do
    if [ -f "$candidate" ]; then initramfs_source="$candidate"; break; fi
  done
  [ -n "$kernel_source" ] || fail "Cannot locate the installation kernel on the live media."
  [ -n "$initramfs_source" ] || fail "Cannot locate the installation initramfs on the live media."
  cp "$kernel_source" "$target/boot/vmlinuz" || fail "Failed to install the kernel."
  cp "$initramfs_source" "$target/boot/initramfs.cpio.gz" || fail "Failed to install the initramfs."

  # Run chroot setup
  log "Running post-installation configuration..."
  if [ -f "$CHROOT_SCRIPT" ]; then
    cp "$CHROOT_SCRIPT" "$target/tmp/sevyn-chroot-setup"
    chmod 0755 "$target/tmp/sevyn-chroot-setup"

    # Bind-mount essential filesystems for chroot
    mount --bind /dev "$target/dev"
    mount --bind /dev/pts "$target/dev/pts" 2>/dev/null || true
    mount -t proc proc "$target/proc"
    mount -t sysfs sysfs "$target/sys"
    mount -t efivarfs efivarfs "$target/sys/firmware/efi/efivars" 2>/dev/null || true

    chroot "$target" /tmp/sevyn-chroot-setup "$target_disk" "$esp_dev" "$root_dev" || fail "Bootloader installation failed."

    # Cleanup chroot mounts
    umount "$target/sys/firmware/efi/efivars" 2>/dev/null || true
    umount "$target/sys" 2>/dev/null || true
    umount "$target/proc" 2>/dev/null || true
    umount "$target/dev/pts" 2>/dev/null || true
    umount "$target/dev" 2>/dev/null || true
    rm -f "$target/tmp/sevyn-chroot-setup"
  fi

  # Cleanup
  sync
  umount "$target/boot/efi" 2>/dev/null || true
  umount "$target" 2>/dev/null || true

  log "Installation complete."
}

# ─── Completion ──────────────────────────────────────────────────────
show_complete() {
  dialog --title "Installation Complete" \
    --yes-label "Reboot Now" \
    --no-label "Continue Live" \
    --yesno "\n  SevynOS has been installed successfully!\n\n  Remove the USB drive and reboot to start\n  using SevynOS.\n\n  Your existing operating system will appear\n  in the GRUB boot menu for dual-boot.\n\n  Would you like to reboot now?" 14 55
}

# ═════════════════════════════════════════════════════════════════════
# Main
# ═════════════════════════════════════════════════════════════════════
main() {
  log "SevynOS Installer v${INSTALLER_VERSION} started"
  check_prerequisites

  unattended_target=""
  case " $(cat /proc/cmdline 2>/dev/null || true) " in
    *" sevyn.install.erase="*)
      for argument in $(cat /proc/cmdline); do
        case "$argument" in
          sevyn.install.erase=*) unattended_target=${argument#sevyn.install.erase=} ;;
        esac
      done
      ;;
  esac

  if [ -n "$unattended_target" ]; then
    case "$unattended_target" in /dev/*) ;; *) fail "Invalid unattended installation target." ;; esac
    [ -b "$unattended_target" ] || fail "Unattended target does not exist: $unattended_target"
    log "Unattended erase installation target: $unattended_target"
    target_disk="$unattended_target"
    SEVYN_UNATTENDED=1
    export SEVYN_UNATTENDED
    if [ -c /dev/ttyS0 ]; then exec >/dev/ttyS0 2>&1; fi
    partition_erase "$target_disk"
    install_system "$ESP_DEV" "$ROOT_DEV" "$SWAP_DEV" "$target_disk"
    log "SEVYN_INSTALL_COMPLETE"
    echo "SEVYN_INSTALL_COMPLETE" > /dev/ttyS0 2>/dev/null || true
    sync
    poweroff -f
    exit 0
  fi

  show_welcome || exit 0

  target_disk=$(select_disk) || exit 0
  if [ -z "$target_disk" ]; then
    exit 0
  fi
  log "Selected disk: $target_disk"

  mode=$(select_mode "$target_disk") || exit 0
  log "Selected mode: $mode"

  case "$mode" in
    erase)
      partition_erase "$target_disk" || exit 1
      ;;
    alongside)
      partition_alongside "$target_disk" || exit 1
      ;;
    cancel)
      exit 0
      ;;
    *)
      fail "Unknown installation mode: $mode"
      ;;
  esac

  [ -b "$ESP_DEV" ] || fail "EFI partition was not created: $ESP_DEV"
  [ -b "$ROOT_DEV" ] || fail "Root partition was not created: $ROOT_DEV"
  [ -b "$SWAP_DEV" ] || fail "Swap partition was not created: $SWAP_DEV"
  install_system "$ESP_DEV" "$ROOT_DEV" "$SWAP_DEV" "$target_disk"

  if show_complete; then
    sync
    reboot -f
  fi
}

main "$@"
