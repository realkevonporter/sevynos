#!/bin/sh
# SevynOS Installer — guided TUI system installer (v2.0.0)
# Runs from the live environment to install SevynOS to disk.
#
# Guided flow:
#   1. Welcome
#   2. Language + timezone
#   3. Disk selection (with clear size display)
#   4. User account creation (username, password, hostname)
#   5. Install mode (alongside / erase / manual partitioning)
#   6. Summary + explicit typed confirmation of destructive actions
#   7. Install with progress
#   8. Reboot
#
# Safety rules:
#   - Nothing is written to the target disk before the summary screen and an
#     explicit typed confirmation.
#   - "Erase" and "alongside/resize" require typing a confirmation word.
#   - Alongside mode shrinks the FILESYSTEM before the partition (never the
#     reverse), keeps a 1 GiB safety margin past the filesystem minimum, and
#     refuses filesystems the installer cannot resize.
#   - The live medium disk can never be selected as a target.
set -eu

INSTALLER_VERSION="2.0.0"
SEVYN_ROOT_MIN_MB=20480 # 20 GiB minimum for root
SEVYN_SWAP_MB=4096      # 4 GiB swap
SEVYN_ESP_MB=512        # 512 MiB EFI System Partition
SQUASHFS_PATH="/live/filesystem.squashfs"
INSTALLED_INIT="/usr/local/lib/sevynos/installed-init"
CHROOT_SCRIPT="/usr/local/bin/sevyn-installer-chroot"
GRUB_CFG_LIB="/usr/local/lib/sevyn-grub-cfg-lib.sh"
SECUREBOOT_SCRIPT="/usr/local/lib/sevyn-secure-boot.sh"
ACCOUNTS_SCRIPT="/usr/local/lib/sevyn-installer-accounts.mjs"
PARTITION_PLAN_SCRIPT="/usr/local/lib/sevyn-installer-partition-plan.mjs"
NODE_BIN="/usr/local/bin/node"

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
  [ -x "$NODE_BIN" ] || fail "Required tool 'node' is not available at $NODE_BIN."
  for helper in "$ACCOUNTS_SCRIPT" "$PARTITION_PLAN_SCRIPT"; do
    [ -f "$helper" ] || fail "Required installer helper is missing: $helper"
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

node_plan() {
  "$NODE_BIN" "$PARTITION_PLAN_SCRIPT" "$@"
}

plan_value() {
  # plan_value <plan-output> <key> — extract a key=value line (no eval).
  printf '%s\n' "$1" | sed -n "s/^$2=//p" | head -n 1
}

plan_ok() {
  [ "$(plan_value "$1" ok)" = "1" ]
}

plan_error() {
  plan_value "$1" error
}

# ─── Disk helpers ───────────────────────────────────────────────────
disk_sep() {
  # Partition device separator: nvme0n1p1 vs sda1
  case "$1" in
    *nvme* | *mmcblk*) printf 'p' ;;
    *) printf '' ;;
  esac
}

disk_size_mib() {
  bytes=$(blockdev --getsize64 "$1" 2>/dev/null || echo 0)
  echo $((bytes / 1048576))
}

fmt_gib() {
  # fmt_gib <mib> — human size like "29.8 GiB"
  mib=$1
  whole=$((mib / 1024))
  frac=$(((mib % 1024) * 10 / 1024))
  printf '%s.%s GiB' "$whole" "$frac"
}

parted_machine() {
  # Machine-parseable partition table for the planning helpers.
  parted -s --machine unit MiB print "$1" 2>/dev/null || true
}

ensure_disk_unmounted() {
  target_disk="$1"
  mounted=$(lsblk -n -o MOUNTPOINT "$target_disk" 2>/dev/null | grep -v '^$' || true)
  if [ -n "$mounted" ]; then
    # The live medium itself is never the target (filtered in detect_disks),
    # so any mount here is unexpected — refuse rather than unmount blindly.
    fail "Some partitions of $target_disk are mounted ($mounted). Unmount them before installing."
  fi
}

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
    case "$name" in loop* | ram* | zram* | sr* | fd* | dm-* | md*) continue ;; esac
    dev="/dev/$name"
    [ -b "$dev" ] || continue
    [ "$dev" = "$live_disk" ] && continue
    bytes=$(blockdev --getsize64 "$dev" 2>/dev/null || echo 0)
    [ "$bytes" -gt 0 ] 2>/dev/null || continue
    mib=$((bytes / 1048576))
    model=$(cat "$sys_device/device/model" 2>/dev/null | tr -s ' ' | sed 's/^ //;s/ $//' | tr -d '"`$\\' || true)
    [ -n "$model" ] || model="Internal or attached storage"
    printf '%s|%s|%s\n' "$dev" "$(fmt_gib "$mib")" "$model"
  done
}

detect_existing_os() {
  if command -v os-prober >/dev/null 2>&1; then
    os-prober 2>/dev/null || true
  fi
}

find_esp() {
  # Find an existing EFI System Partition on the target disk. Prints the
  # device path, or nothing when there is none.
  target_disk="$1"
  sep=$(disk_sep "$target_disk")
  esp=$(blkid -t PARTLABEL="EFI System Partition" -o device 2>/dev/null | grep "^${target_disk}${sep}" | head -n 1 || true)
  if [ -n "$esp" ]; then
    printf '%s\n' "$esp"
    return 0
  fi
  # Fall back to a vfat partition carrying the esp flag.
  parted_machine "$target_disk" | while IFS= read -r line; do
    case "$line" in
      [0-9]*:*)
        rec=${line%;}
        num=$(printf '%s' "$rec" | cut -d: -f1)
        fstype=$(printf '%s' "$rec" | cut -d: -f5 | tr 'A-Z' 'a-z')
        flags=$(printf '%s' "$rec" | cut -d: -f7)
        case "$fstype" in
          fat* | vfat)
            case ",$flags," in
              *,esp,*) printf '%s\n' "${target_disk}${sep}${num}" && return 0 ;;
            esac
            ;;
        esac
        ;;
    esac
  done
  return 1
}

is_uefi() {
  [ -d /sys/firmware/efi ]
}

# ─── Guided step 1: welcome ─────────────────────────────────────────
show_welcome() {
  dialog --title "SevynOS Installer v${INSTALLER_VERSION}" \
    --yes-label "Continue" \
    --no-label "Exit" \
    --yesno "\n  Welcome to SevynOS!\n\n  This installer will guide you step by step:\n\n    1. Language and timezone\n    2. Disk selection\n    3. Your user account\n    4. Installation type\n    5. Review and confirm\n\n  Nothing is written to your disks until the final\n  confirmation screen.\n\n  Make sure you have backed up important data." 20 64
}

# ─── Guided step 2: language + timezone ─────────────────────────────
select_language() {
  choice=$(dialog --title "Language" \
    --menu "Choose the display language for your SevynOS system:" \
    17 62 8 \
    "en_US.UTF-8" "English (US)" \
    "en_GB.UTF-8" "English (UK)" \
    "de_DE.UTF-8" "Deutsch" \
    "fr_FR.UTF-8" "Francais" \
    "es_ES.UTF-8" "Espanol" \
    "pt_BR.UTF-8" "Portugues (Brasil)" \
    "it_IT.UTF-8" "Italiano" \
    "nl_NL.UTF-8" "Nederlands" \
    3>&1 1>&2 2>&3 3>&-) || return 1
  SEVYN_LOCALE="$choice"
  log "Selected locale: $SEVYN_LOCALE"
}

select_timezone() {
  # Curated list of common zones; filtered to what the live image ships.
  zones=""
  for zone in \
    "UTC|Coordinated Universal Time" \
    "America/New_York|US Eastern" \
    "America/Chicago|US Central" \
    "America/Denver|US Mountain" \
    "America/Los_Angeles|US Pacific" \
    "America/Anchorage|Alaska" \
    "Pacific/Honolulu|Hawaii" \
    "America/Toronto|Toronto" \
    "America/Vancouver|Vancouver" \
    "America/Mexico_City|Mexico City" \
    "America/Sao_Paulo|Sao Paulo" \
    "America/Buenos_Aires|Buenos Aires" \
    "Europe/London|London" \
    "Europe/Berlin|Berlin" \
    "Europe/Paris|Paris" \
    "Europe/Madrid|Madrid" \
    "Europe/Rome|Rome" \
    "Europe/Amsterdam|Amsterdam" \
    "Europe/Zurich|Zurich" \
    "Europe/Stockholm|Stockholm" \
    "Europe/Athens|Athens" \
    "Europe/Istanbul|Istanbul" \
    "Europe/Moscow|Moscow" \
    "Africa/Cairo|Cairo" \
    "Africa/Lagos|Lagos" \
    "Africa/Johannesburg|Johannesburg" \
    "Asia/Dubai|Dubai" \
    "Asia/Karachi|Karachi" \
    "Asia/Kolkata|Kolkata" \
    "Asia/Dhaka|Dhaka" \
    "Asia/Bangkok|Bangkok" \
    "Asia/Singapore|Singapore" \
    "Asia/Hong_Kong|Hong Kong" \
    "Asia/Shanghai|Shanghai" \
    "Asia/Tokyo|Tokyo" \
    "Asia/Seoul|Seoul" \
    "Australia/Sydney|Sydney" \
    "Pacific/Auckland|Auckland"; do
    zone_name=${zone%%|*}
    zone_label=${zone#*|}
    if [ -f "/usr/share/zoneinfo/$zone_name" ]; then
      zones="$zones \"$zone_name\" \"$zone_label\""
    fi
  done
  if [ -z "$zones" ]; then
    fail "No timezone data found in the live environment."
  fi
  # shellcheck disable=SC2086
  choice=$(eval "dialog --title 'Timezone' \
    --menu 'Choose your timezone:' \
    20 62 13 $zones 3>&1 1>&2 2>&3 3>&-") || return 1
  SEVYN_TIMEZONE="$choice"
  log "Selected timezone: $SEVYN_TIMEZONE"
}

# ─── Guided step 3: disk selection ──────────────────────────────────
select_disk() {
  disks=$(detect_disks)
  if [ -z "$disks" ]; then
    fail "No suitable disks found for installation."
  fi

  items=""
  while IFS='|' read -r dev size model; do
    [ -n "$dev" ] || continue
    # Partition/disk labels come from the hardware; strip eval-hostile chars.
    safe_model=$(printf '%s' "$model" | tr -d '"`$\\')
    items="$items \"$dev\" \"$size - $safe_model\""
  done <<EOF
$disks
EOF

  # shellcheck disable=SC2086
  eval "dialog --title 'Select Installation Disk' \
    --menu 'Choose the disk where SevynOS will be installed.\nThe disk running this live session is never listed.' \
    16 70 6 $items 3>&1 1>&2 2>&3 3>&-"
}

disk_detail_text() {
  # Human-readable summary of the disk: size, partitions, detected OSes.
  target_disk="$1"
  mib=$(disk_size_mib "$target_disk")
  detail="Disk: $target_disk ($(fmt_gib "$mib"))\n"
  detail="${detail}\nPartitions:\n"
  parts_summary=$(parted_machine "$target_disk" | while IFS= read -r line; do
    case "$line" in
      [0-9]*:*)
        rec=${line%;}
        num=$(printf '%s' "$rec" | cut -d: -f1)
        size=$(printf '%s' "$rec" | cut -d: -f4)
        fstype=$(printf '%s' "$rec" | cut -d: -f5)
        name=$(printf '%s' "$rec" | cut -d: -f6)
        [ -z "$fstype" ] && fstype="(no filesystem)"
        printf '  #%s  %s  %s %s\n' "$num" "$size" "$fstype" "$name"
        ;;
    esac
  done)
  if [ -z "$parts_summary" ]; then
    detail="${detail}  (no partition table / empty disk)\n"
  else
    detail="${detail}${parts_summary}\n"
  fi
  existing_os=$(detect_existing_os)
  if [ -n "$existing_os" ]; then
    detail="${detail}\nDetected operating systems:\n"
    detail="${detail}$(printf '%s\n' "$existing_os" | while IFS=: read -r part name _loader _type; do
      printf '  - %s (%s)\n' "${name:-Unknown OS}" "$part"
    done)\n"
  else
    detail="${detail}\nNo other operating systems detected.\n"
  fi
  printf '%b' "$detail"
}

# ─── Guided step 4: user account ────────────────────────────────────
prompt_username() {
  while true; do
    name=$(dialog --title "Create Your Account" \
      --inputbox "Choose a username for your administrator account.\n\nLowercase letters, digits, _ and - (max 32 chars).\nThe root account will be locked; this user gets sudo." \
      13 64 "${SEVYN_USERNAME:-}" 3>&1 1>&2 2>&3 3>&-) || return 1
    result=$(node_plan validate-username "$name")
    if plan_ok "$result"; then
      SEVYN_USERNAME="$name"
      return 0
    fi
    dialog --title "Invalid Username" --msgbox "$(plan_error "$result")" 8 64
  done
}

prompt_fullname() {
  SEVYN_FULLNAME=$(dialog --title "Create Your Account" \
    --inputbox "Your full name (shown on the login screen):" \
    9 64 "${SEVYN_FULLNAME:-}" 3>&1 1>&2 2>&3 3>&-) || return 1
}

prompt_password() {
  while true; do
    pw1=$(dialog --title "Create Your Account" \
      --insecure --passwordbox "Choose a password (at least 8 characters):" \
      9 64 3>&1 1>&2 2>&3 3>&-) || return 1
    pw2=$(dialog --title "Create Your Account" \
      --insecure --passwordbox "Type the password again to confirm:" \
      9 64 3>&1 1>&2 2>&3 3>&-) || return 1
    if [ ${#pw1} -lt 8 ]; then
      dialog --title "Weak Password" --msgbox "The password must be at least 8 characters long." 7 60
      continue
    fi
    case "$pw1" in
      *:*)
        dialog --title "Invalid Password" --msgbox "The password may not contain a colon (:)." 7 60
        continue
        ;;
    esac
    if [ "$pw1" != "$pw2" ]; then
      dialog --title "Passwords Differ" --msgbox "The two passwords did not match. Try again." 7 60
      continue
    fi
    SEVYN_PASSWORD="$pw1"
    pw1=""; pw2=""
    return 0
  done
}

prompt_hostname() {
  while true; do
    name=$(dialog --title "Computer Name" \
      --inputbox "Choose a name for this computer (hostname):" \
      9 64 "${SEVYN_HOSTNAME:-sevynos}" 3>&1 1>&2 2>&3 3>&-) || return 1
    result=$(node_plan validate-hostname "$name")
    if plan_ok "$result"; then
      SEVYN_HOSTNAME=$(plan_value "$result" normalized)
      return 0
    fi
    dialog --title "Invalid Hostname" --msgbox "$(plan_error "$result")" 8 64
  done
}

create_user() {
  prompt_username || return 1
  prompt_fullname || return 1
  prompt_password || return 1
  prompt_hostname || return 1
  log "Account configured: user=$SEVYN_USERNAME host=$SEVYN_HOSTNAME"
}

# ─── Typed confirmation ─────────────────────────────────────────────
confirm_typed() {
  # confirm_typed <title> <text> <word> — the user must type <word> exactly.
  title="$1"
  text="$2"
  expected="$3"
  typed=$(dialog --title "$title" \
    --inputbox "${text}\n\nType ${expected} (in capitals) to confirm, or press Cancel to go back." \
    16 68 3>&1 1>&2 2>&3 3>&-) || return 1
  if [ "$typed" = "$expected" ]; then
    return 0
  fi
  dialog --title "$title" --msgbox "Confirmation did not match. No changes were made." 7 60
  return 1
}

# ─── Guided step 5: install mode ────────────────────────────────────
select_mode() {
  target_disk="$1"
  disk_detail_text "$target_disk" > /tmp/sevyn-disk-detail.txt
  dialog --title "Disk: $target_disk" --textbox /tmp/sevyn-disk-detail.txt 18 72
  rm -f /tmp/sevyn-disk-detail.txt
  dialog --title "Installation Type" \
    --menu "How would you like to install SevynOS on $target_disk?" \
    15 68 4 \
    "alongside" "Install alongside (shrink a partition)" \
    "erase" "Erase the entire disk" \
    "manual" "Partition manually (advanced)" \
    "cancel" "Cancel installation" \
    3>&1 1>&2 2>&3 3>&-
}

# ─── Partition: Erase Entire Disk ────────────────────────────────────
# Planning is side-effect free; execute_* runs only after the summary screen
# and typed confirmation.
plan_erase_dry_run() {
  target_disk="$1"
  log "Planning erase install on $target_disk"

  ERASE_DISK_MIB=$(disk_size_mib "$target_disk")
  plan=$(node_plan erase-plan "$ERASE_DISK_MIB")
  plan_ok "$plan" || fail "Cannot plan erase install: $(plan_error "$plan")"

  ERASE_BIOS_START=$(plan_value "$plan" bios_start)
  ERASE_BIOS_END=$(plan_value "$plan" bios_end)
  ERASE_ESP_START=$(plan_value "$plan" esp_start)
  ERASE_ESP_END=$(plan_value "$plan" esp_end)
  ERASE_ROOT_START=$(plan_value "$plan" root_start)
  ERASE_ROOT_END=$(plan_value "$plan" root_end)
  ERASE_SWAP_START=$(plan_value "$plan" swap_start)
  ERASE_DISK_END=$(plan_value "$plan" disk_end)
  return 0
}

execute_erase_plan() {
  target_disk="$1"
  log "Partitioning $target_disk (erase mode)"
  parted -s "$target_disk" mklabel gpt || fail "Failed to create partition table."
  # A tiny BIOS boot partition keeps the same GPT disk bootable on legacy BIOS;
  # UEFI firmware uses the FAT32 ESP that follows it.
  # The final partition runs to 100%: an exact-MiB end equal to the disk size
  # is rejected by parted as out of range.
  parted -s "$target_disk" \
    mkpart BIOSBOOT "${ERASE_BIOS_START}MiB" "${ERASE_BIOS_END}MiB" \
    set 1 bios_grub on \
    mkpart SEVYN_EFI fat32 "${ERASE_ESP_START}MiB" "${ERASE_ESP_END}MiB" \
    set 2 esp on \
    mkpart "SevynOS" ext4 "${ERASE_ROOT_START}MiB" "${ERASE_ROOT_END}MiB" \
    mkpart "swap" linux-swap "${ERASE_SWAP_START}MiB" 100% \
    || fail "Failed to create partitions."

  partprobe "$target_disk" 2>/dev/null || true
  sleep 2

  sep=$(disk_sep "$target_disk")
  ESP_DEV="${target_disk}${sep}2"
  ROOT_DEV="${target_disk}${sep}3"
  SWAP_DEV="${target_disk}${sep}4"

  log "Formatting ESP: $ESP_DEV"
  mkfs.vfat -F 32 -n SEVYN_EFI "$ESP_DEV" >&2 || fail "Failed to format the EFI partition."
  log "Formatting root: $ROOT_DEV"
  mkfs.ext4 -q -L SEVYNOS_ROOT "$ROOT_DEV" >&2 || fail "Failed to format the root partition."
  log "Creating swap: $SWAP_DEV"
  mkswap -L SEVYN_SWAP "$SWAP_DEV" >&2 || fail "Failed to create swap."
}

# ─── Partition: Alongside Existing OS ────────────────────────────────
probe_fs_min_mib() {
  # probe_fs_min_mib <device> <fstype> — smallest size (MiB) the filesystem
  # can shrink to, probed with filesystem-native tooling.
  dev="$1"
  fstype="$2"
  case "$fstype" in
    ntfs)
      command -v ntfsresize >/dev/null 2>&1 || fail "ntfsresize is not available; cannot resize the NTFS partition safely."
      info=$(ntfsresize --info --force "$dev" 2>/dev/null || true)
      bytes=$(printf '%s\n' "$info" | sed -n 's/.*You might resize at \([0-9][0-9]*\) bytes.*/\1/p' | head -n 1)
      [ -n "$bytes" ] || fail "Could not determine the minimum NTFS size for $dev."
      echo $((bytes / 1048576))
      ;;
    ext4 | ext3 | ext2)
      # The filesystem must be unmounted (checked by the caller).
      e2fsck -f -y "$dev" >/tmp/sevyn-e2fsck.log 2>&1 || true
      blocks=$(resize2fs -P "$dev" 2>/dev/null | sed -n 's/.*filesystem: \([0-9][0-9]*\).*/\1/p' | head -n 1)
      blocksize=$(tune2fs -l "$dev" 2>/dev/null | sed -n 's/^Block size: *\([0-9][0-9]*\).*/\1/p' | head -n 1)
      [ -n "$blocks" ] && [ -n "$blocksize" ] || fail "Could not determine the minimum ext size for $dev."
      echo $(((blocks * blocksize) / 1048576 + 1))
      ;;
    *)
      fail "Unsupported filesystem for resize: $fstype"
      ;;
  esac
}

select_shrink_partition() {
  # select_shrink_partition <disk> — let the user pick which partition to
  # shrink. Prints the partition number.
  target_disk="$1"
  needed_mb=$((SEVYN_ROOT_MIN_MB + SEVYN_SWAP_MB))
  menu=$(parted_machine "$target_disk" | node_plan parts-menu)
  count=$(plan_value "$menu" count)
  if [ -z "$count" ] || [ "$count" -eq 0 ]; then
    fail "No partitions found on $target_disk."
  fi

  items=""
  default=""
  biggest=0
  while IFS= read -r line; do
    case "$line" in
      part:*)
        tag=${line%%=*}
        desc=${line#*=}
        num=${tag#part:}
        size=${desc%% *}
        safe_desc=$(printf '%s' "$desc" | tr -d '"`$\\')
        case "$desc" in
          *\ ntfs* | *\ ext4* | *\ ext3* | *\ ext2*)
            if [ "$size" -gt "$biggest" ] 2>/dev/null; then
              biggest=$size
              default="$tag"
            fi
            items="$items \"$tag\" \"$safe_desc\""
            ;;
        esac
        ;;
    esac
  done <<EOF
$menu
EOF
  if [ -z "$items" ]; then
    fail "No resizable partition found on $target_disk (need NTFS or ext2/3/4 with at least $((needed_mb / 1024)) GiB freeable)."
  fi

  # shellcheck disable=SC2086
  eval "dialog --title 'Shrink Which Partition?' \
    --default-item '$default' \
    --menu 'SevynOS needs $((needed_mb / 1024)) GiB. Choose the partition to shrink.\nOnly NTFS and ext2/3/4 partitions can be resized safely.' \
    16 70 6 $items 3>&1 1>&2 2>&3 3>&-" | sed 's/^part://'
}


# ─── Partition: Manual ──────────────────────────────────────────────
select_manual_partition() {
  # select_manual_partition <disk> <purpose> <title> — pick one partition.
  target_disk="$1"
  purpose="$2"
  title="$3"
  menu=$(parted_machine "$target_disk" | node_plan parts-menu)
  items=""
  while IFS= read -r line; do
    case "$line" in
      part:*)
        tag=${line%%=*}
        desc=${line#*=}
        safe_desc=$(printf '%s' "$desc" | tr -d '"`$\\')
        items="$items \"$tag\" \"$safe_desc\""
        ;;
    esac
  done <<EOF
$menu
EOF
  [ -n "$items" ] || fail "No partitions found on $target_disk."
  # shellcheck disable=SC2086
  eval "dialog --title '$title' \
    --menu '$purpose' \
    16 70 6 $items 3>&1 1>&2 2>&3 3>&-" | sed "s|^${target_disk}||;s/^part://" | {
    read -r num
    sep=$(disk_sep "$target_disk")
    printf '%s\n' "${target_disk}${sep}${num}"
  }
}

plan_manual_dry_run() {
  # Planning (cfdisk + partition selection + validation) is side-effect free
  # apart from the user's own edits inside cfdisk; execute_manual_plan runs
  # only after the summary screen and typed confirmation.
  target_disk="$1"
  log "Manual partitioning on $target_disk"
  ensure_disk_unmounted "$target_disk"

  if command -v cfdisk >/dev/null 2>&1; then
    dialog --title "Manual Partitioning" \
      --yes-label "Open cfdisk" \
      --no-label "Back" \
      --yesno "\n  The cfdisk partition editor will open now.\n\n  Create the partitions SevynOS needs:\n    - EFI System Partition (FAT32, 512 MiB) on UEFI systems\n    - root partition (at least $((SEVYN_ROOT_MIN_MB / 1024)) GiB)\n    - swap partition ($((SEVYN_SWAP_MB / 1024)) GiB, optional)\n\n  Write the table with [ Write ], then quit with [ Quit ].\n  Afterwards you will tell the installer which\n  partitions to use." 17 64 || return 1
    cfdisk "$target_disk" || log "cfdisk exited without changes (or with an error)"
    partprobe "$target_disk" 2>/dev/null || true
    sleep 2
  else
    dialog --title "Manual Partitioning" \
      --msgbox "cfdisk is not available in this live environment.\n\nPartition the disk with another tool, then choose\n'Manual' again once the partitions exist." 10 60
    return 1
  fi

  MANUAL_ROOT=$(select_manual_partition "$target_disk" \
    "Which partition becomes the SevynOS root?\n\nWARNING: it will be FORMATTED (all data destroyed)." \
    "Root Partition") || return 1
  [ -n "$MANUAL_ROOT" ] || return 1

  MANUAL_ESP=""
  if is_uefi; then
    MANUAL_ESP=$(select_manual_partition "$target_disk" \
      "Which partition is the EFI System Partition?\n\nIt will be MOUNTED but never formatted." \
      "EFI System Partition") || return 1
    esp_fs=$(blkid -s TYPE -o value "$MANUAL_ESP" 2>/dev/null || true)
    case "$esp_fs" in
      vfat | fat32 | fat16) ;;
      *) fail "$MANUAL_ESP is '$esp_fs', not a FAT filesystem. Refusing to use it as the ESP." ;;
    esac
  fi

  MANUAL_SWAP=$(select_manual_partition "$target_disk" \
    "Which partition becomes swap? (Choose the root partition again to skip swap.)" \
    "Swap Partition") || return 1
  if [ "$MANUAL_SWAP" = "$MANUAL_ROOT" ]; then
    MANUAL_SWAP=""
  fi

  root_mib=$(( $(blockdev --getsize64 "$MANUAL_ROOT" 2>/dev/null || echo 0) / 1048576 ))
  if [ "$root_mib" -lt "$SEVYN_ROOT_MIN_MB" ]; then
    fail "The chosen root partition is $(fmt_gib "$root_mib"); SevynOS needs at least $(fmt_gib "$SEVYN_ROOT_MIN_MB")."
  fi
  return 0
}

execute_manual_plan() {
  log "Formatting root: $MANUAL_ROOT"
  mkfs.ext4 -q -L SEVYNOS_ROOT "$MANUAL_ROOT" >&2 || fail "Failed to format the root partition."
  if [ -n "$MANUAL_SWAP" ]; then
    log "Creating swap: $MANUAL_SWAP"
    mkswap -L SEVYN_SWAP "$MANUAL_SWAP" >&2 || fail "Failed to create swap."
  fi
  ROOT_DEV="$MANUAL_ROOT"
  ESP_DEV="$MANUAL_ESP"
  SWAP_DEV="$MANUAL_SWAP"
}

# ─── Guided step 6: summary + confirm ───────────────────────────────
show_summary() {
  target_disk="$1"
  mode="$2"
  disk_mib=$(disk_size_mib "$target_disk")

  case "$mode" in
    erase)
      mode_text="Erase the ENTIRE disk ($target_disk, $(fmt_gib "$disk_mib"))"
      destructive="ALL data on $target_disk will be PERMANENTLY ERASED."
      ;;
    alongside)
      mode_text="Install alongside (shrink partition $ALONGSIDE_PART → $(fmt_gib "$ALONGSIDE_SHRUNK_TO"))"
      destructive="Partition $ALONGSIDE_DEV will be resized from $(fmt_gib "$ALONGSIDE_WAS") to $(fmt_gib "$ALONGSIDE_SHRUNK_TO")."
      ;;
    manual)
      mode_text="Use manually prepared partitions"
      destructive="Root $MANUAL_ROOT will be FORMATTED.${MANUAL_SWAP:+ Swap $MANUAL_SWAP will be erased.}"
      ;;
  esac

  dialog --title "Review Installation" \
    --yes-label "Install Now" \
    --no-label "Go Back" \
    --yesno "\n  Please review your choices:\n\n    Language:   $SEVYN_LOCALE\n    Timezone:   $SEVYN_TIMEZONE\n    Computer:   $SEVYN_HOSTNAME\n    User:       $SEVYN_USERNAME ($SEVYN_FULLNAME)\n    Disk:       $target_disk ($(fmt_gib "$disk_mib"))\n    Mode:       $mode_text\n\n  $destructive\n\n  A final typed confirmation is required next." 22 70
}

# ─── Progress gauge ─────────────────────────────────────────────────
start_gauge() {
  # start_gauge <title> — progress goes to fd 3 as "NNN" / "# text" lines.
  if [ "${SEVYN_UNATTENDED:-0}" = "1" ]; then
    return 0
  fi
  rm -f /tmp/sevyn-gauge-fifo
  mkfifo /tmp/sevyn-gauge-fifo
  dialog --title "$1" --gauge "Preparing..." 7 60 0 < /tmp/sevyn-gauge-fifo &
  GAUGE_PID=$!
  # Opening the writer unblocks dialog's reader.
  exec 3> /tmp/sevyn-gauge-fifo
}

gauge() {
  # gauge <percent> [text]
  if [ "${SEVYN_UNATTENDED:-0}" = "1" ]; then
    return 0
  fi
  printf '%s\n' "$1" >&3 2>/dev/null || true
  if [ -n "${2:-}" ]; then
    printf '# %s\n' "$2" >&3 2>/dev/null || true
  fi
}

stop_gauge() {
  if [ "${SEVYN_UNATTENDED:-0}" = "1" ]; then
    return 0
  fi
  exec 3>&- 2>/dev/null || true
  wait "$GAUGE_PID" 2>/dev/null || true
  rm -f /tmp/sevyn-gauge-fifo
}

# ─── Guided step 7: install ─────────────────────────────────────────
install_system() {
  esp_dev="$1"
  root_dev="$2"
  swap_dev="$3"
  target_disk="$4"

  target="/mnt/sevynos"
  mkdir -p "$target"

  start_gauge "Installing SevynOS"
  gauge 3 "Mounting partitions..."

  log "Mounting root partition $root_dev"
  mount "$root_dev" "$target" || { stop_gauge; fail "Failed to mount root partition."; }

  if [ -n "$esp_dev" ]; then
    mkdir -p "$target/boot/efi"
    log "Mounting ESP $esp_dev"
    mount "$esp_dev" "$target/boot/efi" || { stop_gauge; fail "Failed to mount EFI partition."; }
  else
    log "No ESP (legacy BIOS install)"
  fi

  # Extract rootfs, feeding unsquashfs progress into the gauge.
  log "Extracting SevynOS filesystem (this may take several minutes)..."
  gauge 5 "Extracting system files..."
  : > /tmp/sevyn-unsquashfs.log
  unsquashfs -f -d "$target" "$SQUASHFS_PATH" > /tmp/sevyn-unsquashfs.log 2>&1 &
  unsquashfs_pid=$!
  (
    while kill -0 "$unsquashfs_pid" 2>/dev/null; do
      pct=$(grep -o '[0-9][0-9]*%' /tmp/sevyn-unsquashfs.log 2>/dev/null | tail -n 1 | tr -d '%' || true)
      if [ -n "$pct" ]; then
        # Map extraction 0-100% onto gauge 5-82%.
        mapped=$((5 + pct * 77 / 100))
        gauge "$mapped" "Extracting system files... ${pct}%"
      fi
      sleep 1
    done
  ) &
  progress_pid=$!
  if ! wait "$unsquashfs_pid"; then
    kill "$progress_pid" 2>/dev/null || true
    stop_gauge
    fail "Failed to extract the SevynOS filesystem."
  fi
  kill "$progress_pid" 2>/dev/null || true
  wait "$progress_pid" 2>/dev/null || true

  # Generate fstab
  gauge 84 "Writing system configuration..."
  log "Generating /etc/fstab"
  root_uuid=$(blkid -s UUID -o value "$root_dev")
  [ -n "$root_uuid" ] || { stop_gauge; fail "Cannot read the root filesystem UUID."; }

  mkdir -p "$target/etc"
  {
    printf '# SevynOS /etc/fstab - generated by sevyn-installer\n'
    printf '# <device>                                 <mount>     <type>  <options>       <dump> <pass>\n'
    printf 'UUID=%s    /           ext4    errors=remount-ro   0      1\n' "$root_uuid"
    if [ -n "$esp_dev" ]; then
      esp_uuid=$(blkid -s UUID -o value "$esp_dev")
      printf 'UUID=%s     /boot/efi   vfat    umask=0077          0      1\n' "$esp_uuid"
    fi
    if [ -n "$swap_dev" ]; then
      swap_uuid=$(blkid -s UUID -o value "$swap_dev")
      printf 'UUID=%s    none        swap    sw                  0      0\n' "$swap_uuid"
    fi
  } > "$target/etc/fstab"

  # Hostname
  printf '%s\n' "$SEVYN_HOSTNAME" > "$target/etc/hostname"
  cat > "$target/etc/hosts" <<EOF
127.0.0.1   localhost
127.0.1.1   $SEVYN_HOSTNAME
::1         localhost ip6-localhost ip6-loopback
EOF

  # Install the installed-mode init script
  if [ -f "$INSTALLED_INIT" ]; then
    cp "$INSTALLED_INIT" "$target/init"
    chmod 0755 "$target/init"
  fi

  # Copy kernel and initramfs to installed system
  gauge 88 "Installing kernel..."
  kernel_source=""
  initramfs_source=""
  recovery_source=""
  for candidate in /boot/vmlinuz /run/live/medium/boot/vmlinuz /lib/live/mount/medium/boot/vmlinuz; do
    if [ -f "$candidate" ]; then kernel_source="$candidate"; break; fi
  done
  for candidate in /boot/initramfs.cpio.gz /run/live/medium/boot/initramfs.cpio.gz /lib/live/mount/medium/boot/initramfs.cpio.gz; do
    if [ -f "$candidate" ]; then initramfs_source="$candidate"; break; fi
  done
  for candidate in /boot/recovery-initramfs.cpio.gz /run/live/medium/boot/recovery-initramfs.cpio.gz /lib/live/mount/medium/boot/recovery-initramfs.cpio.gz; do
    if [ -f "$candidate" ]; then recovery_source="$candidate"; break; fi
  done
  [ -n "$kernel_source" ] || { stop_gauge; fail "Cannot locate the installation kernel on the live media."; }
  [ -n "$initramfs_source" ] || { stop_gauge; fail "Failed to install the initramfs on the live media."; }
  [ -n "$recovery_source" ] || { stop_gauge; fail "Cannot locate the recovery initramfs on the live media."; }
  cp "$kernel_source" "$target/boot/vmlinuz" || { stop_gauge; fail "Failed to install the kernel."; }
  cp "$initramfs_source" "$target/boot/initramfs.cpio.gz" || { stop_gauge; fail "Failed to install the initramfs."; }
  # The recovery environment ships with the OS image and is deployed by the
  # chroot step (GRUB entry + ESP staging), keeping it in sync with the OS.
  cp "$recovery_source" "$target/boot/recovery-initramfs.cpio.gz" || { stop_gauge; fail "Failed to install the recovery initramfs."; }

  # Write the chroot configuration (no password — that travels via env).
  # printf (not a heredoc) so values containing $ or backticks stay literal.
  gauge 90 "Creating your user account..."
  mkdir -p "$target/tmp" "$target/var/lib/sevyn/accounts"
  {
    printf 'SEVYN_INSTALL_USER=%s\n' "$SEVYN_USERNAME"
    printf 'SEVYN_INSTALL_UID=1000\n'
    printf 'SEVYN_INSTALL_FULLNAME=%s\n' "$SEVYN_FULLNAME"
    printf 'SEVYN_INSTALL_LOCALE=%s\n' "$SEVYN_LOCALE"
    printf 'SEVYN_INSTALL_TIMEZONE=%s\n' "$SEVYN_TIMEZONE"
    printf 'SEVYN_INSTALL_MODE=%s\n' "$INSTALL_MODE"
    printf 'SEVYN_INSTALL_VERSION=%s\n' "$INSTALLER_VERSION"
  } > "$target/tmp/sevyn-install-config"
  chmod 0600 "$target/tmp/sevyn-install-config"

  # Run chroot setup
  log "Running post-installation configuration..."
  if [ -f "$CHROOT_SCRIPT" ]; then
    cp "$CHROOT_SCRIPT" "$target/tmp/sevyn-chroot-setup"
    cp "$ACCOUNTS_SCRIPT" "$target/tmp/sevyn-installer-accounts.mjs"
    [ -f "$GRUB_CFG_LIB" ] || { stop_gauge; fail "Required installer helper is missing: $GRUB_CFG_LIB"; }
    cp "$GRUB_CFG_LIB" "$target/tmp/sevyn-grub-cfg-lib.sh"
    if [ -f "$SECUREBOOT_SCRIPT" ]; then
      cp "$SECUREBOOT_SCRIPT" "$target/tmp/sevyn-secure-boot.sh"
      chmod 0755 "$target/tmp/sevyn-secure-boot.sh"
    else
      log "WARNING: Secure Boot helper is missing from the live media: $SECUREBOOT_SCRIPT; MOK setup will be skipped."
    fi
    chmod 0755 "$target/tmp/sevyn-chroot-setup"

    # Bind-mount essential filesystems for chroot
    mount --bind /dev "$target/dev"
    mount --bind /dev/pts "$target/dev/pts" 2>/dev/null || true
    mount -t proc proc "$target/proc"
    mount -t sysfs sysfs "$target/sys"
    mount -t efivarfs efivarfs "$target/sys/firmware/efi/efivars" 2>/dev/null || true

    gauge 92 "Installing bootloader..."
    if ! SEVYN_INSTALL_PASSWORD="$SEVYN_PASSWORD" chroot "$target" /tmp/sevyn-chroot-setup "$target_disk" "$esp_dev" "$root_dev"; then
      stop_gauge
      fail "Post-installation configuration failed."
    fi
    SEVYN_PASSWORD=""

    # Cleanup chroot mounts and secrets
    umount "$target/sys/firmware/efi/efivars" 2>/dev/null || true
    umount "$target/sys" 2>/dev/null || true
    umount "$target/proc" 2>/dev/null || true
    umount "$target/dev/pts" 2>/dev/null || true
    umount "$target/dev" 2>/dev/null || true
    rm -f "$target/tmp/sevyn-chroot-setup" "$target/tmp/sevyn-installer-accounts.mjs" \
      "$target/tmp/sevyn-grub-cfg-lib.sh" "$target/tmp/sevyn-secure-boot.sh" \
      "$target/tmp/sevyn-install-config"
  fi

  # Capture the Secure Boot state while the target is still mounted; the
  # enrollment screen (guided flow) and the install log (unattended) use it.
  capture_secure_boot_state "$target"

  # Cleanup
  gauge 98 "Finishing up..."
  sync
  if [ -n "$esp_dev" ]; then
    umount "$target/boot/efi" 2>/dev/null || true
  fi
  umount "$target" 2>/dev/null || true
  gauge 100 "Done."
  stop_gauge

  log "Installation complete."
}

# ─── Secure Boot state capture + enrollment screen ──────────────────
# The chroot step writes /var/lib/sevyn/secureboot/state.json; capture the
# fields the installer screens need while the target is still mounted.
SB_MOK_FP=""; SB_SIGNED=""; SB_ENROLLMENT=""; SB_ENROLL_REASON=""; SB_PW=""

capture_secure_boot_state() {
  target="$1"
  sb_dir="$target/var/lib/sevyn/secureboot"
  state_file="$sb_dir/state.json"
  [ -f "$state_file" ] || { log "No Secure Boot state recorded."; return 0; }
  SB_MOK_FP=$(sed -n 's/.*"fingerprint": *"\([^"]*\)".*/\1/p' "$state_file" | head -n 1)
  SB_SIGNED=$(sed -n 's/.*"signed": *"\([^"]*\)".*/\1/p' "$state_file" | head -n 1)
  SB_ENROLLMENT=$(sed -n 's/.*"enrollment": *"\([^"]*\)".*/\1/p' "$state_file" | head -n 1)
  SB_ENROLL_REASON=$(sed -n 's/.*"enrollmentReason": *"\([^"]*\)".*/\1/p' "$state_file" | head -n 1)
  if [ -f "$sb_dir/mok-enrollment-password" ]; then
    SB_PW=$(cat "$sb_dir/mok-enrollment-password")
  fi
  log "Secure Boot state: signed=$SB_SIGNED enrollment=$SB_ENROLLMENT"
}

show_secure_boot_enrollment() {
  # One-time MOK enrollment screen. Only meaningful on UEFI installs where a
  # MOK was generated; on legacy BIOS there is no Secure Boot to enroll into.
  [ -d /sys/firmware/efi ] || { log "Legacy BIOS install; skipping the Secure Boot enrollment screen."; return 0; }
  [ -n "$SB_MOK_FP" ] || { log "No MOK was generated; skipping the Secure Boot enrollment screen."; return 0; }

  fp_pretty=$(printf '%s' "$SB_MOK_FP" | sed 's/\(..\)/\1:/g; s/:$//' | tr 'a-z' 'A-Z')

  case "$SB_ENROLLMENT" in
    queued)
      intro="  A SevynOS Machine Owner Key (MOK) was generated during\n  installation and queued for enrollment. On the next boot,\n  the MOK Manager will open automatically — complete the\n  one-time enrollment there so the signed bootloader and\n  kernel are trusted."
      ;;
    *)
      intro="  A SevynOS Machine Owner Key (MOK) was generated during\n  installation, but it could not be queued automatically\n  ($SB_ENROLL_REASON).\n\n  After your first boot, enroll it manually (this needs a\n  Microsoft-signed shim — see docs/secure-boot.md):\n\n    sudo mokutil --import /var/lib/sevyn/secureboot/MOK.der\n\n  then reboot and follow the MOK Manager steps below."
      ;;
  esac

  dialog --title "Secure Boot — One-Time Key Enrollment" \
    --msgbox "\n$intro\n\n  Your key fingerprint (verify this in the MOK Manager):\n  $fp_pretty\n\n  Enrollment password (type it once at the MOK Manager):\n  >>>  $SB_PW  <<<\n\n  Write it down — you will type it on the next reboot.\n\n  ── At the MOK Manager screen ──\n\n  1. Select \"Enroll MOK\" and press Enter.\n  2. Optionally select \"View key 0\" and check the\n     fingerprint above matches. If it does not, go\n     Back and do NOT enroll.\n  3. Select \"Continue\".\n  4. When asked \"Enroll the key(s)?\", select \"Yes\".\n  5. Type the enrollment password above, press Enter.\n  6. Select \"Reboot\".\n\n  You need a physical keyboard — this cannot be done\n  remotely, by design. If you mistype, the menu returns\n  and you can try again.\n\n  SevynOS does not claim full Secure Boot support yet;\n  this key prepares the machine for it. Details:\n  docs/secure-boot.md" 32 72
}

# ─── Guided step 8: completion ──────────────────────────────────────
show_complete() {
  dialog --title "Installation Complete" \
    --yes-label "Reboot Now" \
    --no-label "Continue Live" \
    --yesno "\n  SevynOS has been installed successfully!\n\n  Your account: $SEVYN_USERNAME\n  The root account is locked; use your password with\n  sudo from the Terminal app if you need it.\n\n  Remove the installation media and reboot to start\n  using SevynOS.\n\n  Reboot now?" 16 60
}

# ─── Unattended install (CI / automated provisioning) ───────────────
parse_unattended_options() {
  for argument in $(cat /proc/cmdline); do
    case "$argument" in
      sevyn.install.erase=*) unattended_target=${argument#sevyn.install.erase=} ;;
      sevyn.install.user=*) SEVYN_USERNAME=${argument#sevyn.install.user=} ;;
      sevyn.install.password=*) SEVYN_PASSWORD=${argument#sevyn.install.password=} ;;
      sevyn.install.fullname=*) SEVYN_FULLNAME=${argument#sevyn.install.fullname=} ;;
      sevyn.install.hostname=*) SEVYN_HOSTNAME=${argument#sevyn.install.hostname=} ;;
      sevyn.install.locale=*) SEVYN_LOCALE=${argument#sevyn.install.locale=} ;;
      sevyn.install.timezone=*) SEVYN_TIMEZONE=${argument#sevyn.install.timezone=} ;;
    esac
  done
  # /proc/cmdline turns spaces into nothing; underscores stand in for spaces.
  SEVYN_FULLNAME=$(printf '%s' "${SEVYN_FULLNAME:-}" | tr '_' ' ')
}

run_unattended() {
  unattended_target=""
  SEVYN_USERNAME=""; SEVYN_PASSWORD=""; SEVYN_FULLNAME=""
  SEVYN_HOSTNAME="sevynos"; SEVYN_LOCALE="en_US.UTF-8"; SEVYN_TIMEZONE="UTC"
  parse_unattended_options
  [ -n "$unattended_target" ] || return 1

  case "$unattended_target" in /dev/*) ;; *) fail "Invalid unattended installation target." ;; esac
  [ -b "$unattended_target" ] || fail "Unattended target does not exist: $unattended_target"
  log "Unattended erase installation target: $unattended_target"
  SEVYN_UNATTENDED=1
  export SEVYN_UNATTENDED
  if [ -c /dev/ttyS0 ]; then exec > /dev/ttyS0 2>&1; fi

  if [ -n "$SEVYN_USERNAME" ]; then
    result=$(node_plan validate-username "$SEVYN_USERNAME")
    plan_ok "$result" || fail "Invalid sevyn.install.user: $(plan_error "$result")"
    [ ${#SEVYN_PASSWORD} -ge 8 ] || fail "sevyn.install.password must be at least 8 characters."
    case "$SEVYN_PASSWORD" in
      *:* ) fail "sevyn.install.password may not contain a colon (:)." ;;
    esac
    result=$(node_plan validate-hostname "$SEVYN_HOSTNAME")
    plan_ok "$result" || fail "Invalid sevyn.install.hostname: $(plan_error "$result")"
    SEVYN_HOSTNAME=$(plan_value "$result" normalized)
    [ -f "/usr/share/zoneinfo/$SEVYN_TIMEZONE" ] || fail "Unknown timezone: $SEVYN_TIMEZONE"
    log "Unattended install will create user $SEVYN_USERNAME"
  else
    log "Unattended install without a user account (session will run as root)"
  fi

  INSTALL_MODE="unattended"
  plan_erase_dry_run "$unattended_target"
  execute_erase_plan "$unattended_target"
  [ -b "$ESP_DEV" ] || fail "EFI partition was not created: $ESP_DEV"
  [ -b "$ROOT_DEV" ] || fail "Root partition was not created: $ROOT_DEV"
  [ -b "$SWAP_DEV" ] || fail "Swap partition was not created: $SWAP_DEV"
  install_system "$ESP_DEV" "$ROOT_DEV" "$SWAP_DEV" "$unattended_target"
  SEVYN_PASSWORD=""
  if [ -n "$SB_MOK_FP" ]; then
    log "Secure Boot MOK fingerprint: $SB_MOK_FP (signed=$SB_SIGNED enrollment=$SB_ENROLLMENT)"
    log "MOK enrollment password is stored 0600 at /var/lib/sevyn/secureboot/mok-enrollment-password on the installed system"
  fi
  log "SEVYN_INSTALL_COMPLETE"
  echo "SEVYN_INSTALL_COMPLETE" > /dev/ttyS0 2>/dev/null || true
  sync
  poweroff -f
  exit 0
}

# ═════════════════════════════════════════════════════════════════════
# Main
# ═════════════════════════════════════════════════════════════════════
main() {
  log "SevynOS Installer v${INSTALLER_VERSION} started"
  check_prerequisites

  run_unattended && exit 0

  # Defaults (overridden by the guided steps)
  SEVYN_LOCALE="en_US.UTF-8"
  SEVYN_TIMEZONE="UTC"
  SEVYN_HOSTNAME="sevynos"
  SEVYN_USERNAME=""
  SEVYN_FULLNAME=""
  SEVYN_PASSWORD=""

  show_welcome || exit 0
  select_language || exit 0
  select_timezone || exit 0

  target_disk=$(select_disk) || exit 0
  if [ -z "$target_disk" ]; then
    exit 0
  fi
  log "Selected disk: $target_disk"

  create_user || exit 0

  mode=$(select_mode "$target_disk") || exit 0
  log "Selected mode: $mode"
  INSTALL_MODE="$mode"

  # Nothing touches the disk until after the summary screen: every mode
  # plans first (side-effect free), then executes after typed confirmation.
  case "$mode" in
    erase)
      plan_erase_dry_run "$target_disk" || exit 1
      ;;
    alongside)
      plan_alongside_dry_run "$target_disk" || exit 1
      ;;
    manual)
      plan_manual_dry_run "$target_disk" || exit 1
      ;;
    cancel | *)
      exit 0
      ;;
  esac

  show_summary "$target_disk" "$mode" || exit 0

  case "$mode" in
    erase)
      confirm_typed "WARNING - ALL DATA WILL BE ERASED" \
        "EVERYTHING on $target_disk ($(fmt_gib "$ERASE_DISK_MIB")) will be PERMANENTLY DESTROYED,\nincluding all partitions, operating systems and personal files.\n\nThe new layout will be:\n  1. BIOS boot (3 MiB)\n  2. EFI System Partition ($(fmt_gib "$SEVYN_ESP_MB"))\n  3. SevynOS root ($(fmt_gib "$((ERASE_ROOT_END - ERASE_ROOT_START))"))\n  4. swap ($(fmt_gib "$SEVYN_SWAP_MB"))\n\nType ERASE to proceed. This cannot be undone." \
        "ERASE" || exit 1
      execute_erase_plan "$target_disk" || exit 1
      ;;
    alongside)
      confirm_typed "WARNING - PARTITION WILL BE RESIZED" \
        "Partition $ALONGSIDE_DEV ($ALONGSIDE_FSTYPE) will be shrunk from $(fmt_gib "$ALONGSIDE_WAS") to $(fmt_gib "$ALONGSIDE_SHRUNK_TO").\n\nType RESIZE to proceed. This cannot be undone." \
        "RESIZE" || exit 1
      execute_alongside_plan "$target_disk" || exit 1
      ;;
    manual)
      confirm_typed "WARNING - PARTITIONS WILL BE FORMATTED" \
        "$MANUAL_ROOT will be FORMATTED (all data destroyed).${MANUAL_SWAP:+\n$MANUAL_SWAP will be erased as swap.}\n\nType FORMAT to proceed. This cannot be undone." \
        "FORMAT" || exit 1
      execute_manual_plan "$target_disk" || exit 1
      ;;
  esac

  [ -b "$ROOT_DEV" ] || fail "Root partition is missing: $ROOT_DEV"
  if [ "$mode" = "erase" ] || [ "$mode" = "alongside" ]; then
    [ -b "$SWAP_DEV" ] || fail "Swap partition is missing: $SWAP_DEV"
  fi
  install_system "$ESP_DEV" "$ROOT_DEV" "$SWAP_DEV" "$target_disk"
  SEVYN_PASSWORD=""

  show_secure_boot_enrollment
  if show_complete; then
    sync
    reboot -f
  fi
}

# ─── Alongside: plan now, execute after the summary ─────────────────
# Pure planning (reads only) happens before the summary screen; the
# destructive execute_* step runs only after typed confirmation.
plan_alongside_dry_run() {
  target_disk="$1"
  ensure_disk_unmounted "$target_disk"

  needed_mb=$((SEVYN_ROOT_MIN_MB + SEVYN_SWAP_MB))
  part_num=$(select_shrink_partition "$target_disk") || return 1
  [ -n "$part_num" ] || return 1

  sep=$(disk_sep "$target_disk")
  ALONGSIDE_DEV="${target_disk}${sep}${part_num}"
  ALONGSIDE_FSTYPE=$(blkid -s TYPE -o value "$ALONGSIDE_DEV" 2>/dev/null || true)
  case "$ALONGSIDE_FSTYPE" in
    ntfs | ext4 | ext3 | ext2) ;;
    *) fail "Partition $ALONGSIDE_DEV has an unsupported filesystem ($ALONGSIDE_FSTYPE)." ;;
  esac

  dialog --title "Checking Filesystem" \
    --infobox "Measuring how far partition $part_num can shrink safely...\nThis may take a minute." 6 58
  ALONGSIDE_FSMIN=$(probe_fs_min_mib "$ALONGSIDE_DEV" "$ALONGSIDE_FSTYPE")
  log "Filesystem minimum for $ALONGSIDE_DEV: ${ALONGSIDE_FSMIN} MiB"

  disk_mib=$(disk_size_mib "$target_disk")
  plan=$(parted_machine "$target_disk" | node_plan alongside-plan "$part_num" "$ALONGSIDE_FSMIN" "$needed_mb" "$disk_mib")
  if ! plan_ok "$plan"; then
    dialog --title "Cannot Install Alongside" --msgbox "$(plan_error "$plan")" 12 68
    return 1
  fi

  ALONGSIDE_WAS=$(plan_value "$plan" current_size)
  ALONGSIDE_SHRUNK_TO=$(plan_value "$plan" shrink_to)
  ALONGSIDE_FREED=$(plan_value "$plan" freed)
  ALONGSIDE_FREE_START=$(plan_value "$plan" free_start)
  ALONGSIDE_ROOT_START=$(plan_value "$plan" root_start)
  ALONGSIDE_ROOT_END=$(plan_value "$plan" root_end)
  ALONGSIDE_SWAP_START=$(plan_value "$plan" swap_start)
  ALONGSIDE_SWAP_END=$(plan_value "$plan" swap_end)
  ALONGSIDE_PART="$part_num"

  ALONGSIDE_ESP=$(find_esp "$target_disk" || true)
  if [ -z "$ALONGSIDE_ESP" ] && is_uefi; then
    fail "No EFI System Partition found on $target_disk. Alongside install on a UEFI system needs one; use manual partitioning."
  fi
  return 0
}

execute_alongside_plan() {
  target_disk="$1"
  sep=$(disk_sep "$target_disk")

  # 1. Shrink the filesystem FIRST — never the partition first.
  log "Shrinking $ALONGSIDE_FSTYPE filesystem on $ALONGSIDE_DEV to ${ALONGSIDE_SHRUNK_TO}MiB"
  case "$ALONGSIDE_FSTYPE" in
    ntfs)
      ntfsresize --force -s "${ALONGSIDE_SHRUNK_TO}M" "$ALONGSIDE_DEV" >&2 \
        || fail "Failed to shrink the NTFS filesystem on $ALONGSIDE_DEV."
      ;;
    ext4 | ext3 | ext2)
      resize2fs "$ALONGSIDE_DEV" "${ALONGSIDE_SHRUNK_TO}M" >&2 \
        || fail "Failed to shrink the ext filesystem on $ALONGSIDE_DEV."
      ;;
  esac

  # 2. Now shrink the partition to match.
  log "Resizing partition $ALONGSIDE_PART to ${ALONGSIDE_SHRUNK_TO}MiB"
  parted -s "$target_disk" resizepart "$ALONGSIDE_PART" "${ALONGSIDE_SHRUNK_TO}MiB" \
    || fail "Failed to resize partition $ALONGSIDE_PART."

  # 3. Create SevynOS partitions in the freed space.
  parted -s "$target_disk" \
    mkpart "SevynOS" ext4 "${ALONGSIDE_ROOT_START}MiB" "${ALONGSIDE_ROOT_END}MiB" \
    || fail "Failed to create the SevynOS root partition."
  parted -s "$target_disk" \
    mkpart "swap" linux-swap "${ALONGSIDE_SWAP_START}MiB" "${ALONGSIDE_SWAP_END}MiB" \
    || fail "Failed to create the swap partition."

  partprobe "$target_disk" 2>/dev/null || true
  sleep 2

  new_parts=$(parted -s --machine "$target_disk" print 2>/dev/null | grep -c '^[0-9]*:' || true)
  root_num=$((new_parts - 1))
  swap_num=$new_parts
  ROOT_DEV="${target_disk}${sep}${root_num}"
  SWAP_DEV="${target_disk}${sep}${swap_num}"
  if [ -n "$ALONGSIDE_ESP" ]; then
    ESP_DEV="$ALONGSIDE_ESP"
    log "Reusing existing ESP: $ESP_DEV (not formatted)"
  else
    ESP_DEV=""
    log "No ESP (legacy BIOS system)"
  fi

  log "Formatting root: $ROOT_DEV"
  mkfs.ext4 -q -L SEVYNOS_ROOT "$ROOT_DEV" >&2 || fail "Failed to format the root partition."
  log "Creating swap: $SWAP_DEV"
  mkswap -L SEVYN_SWAP "$SWAP_DEV" >&2 || fail "Failed to create swap."
}

main "$@"
