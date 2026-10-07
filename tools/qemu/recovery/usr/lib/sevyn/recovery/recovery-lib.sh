#!/bin/busybox sh
# SevynOS recovery shared helpers.
#
# Sourced by recovery-menu.sh and the operation scripts. Everything here is
# either a pure function (safe to unit-test) or a small, well-defined
# side effect (mount/unmount). Sourcing this file has no side effects.
#
# The tree location defaults to the initramfs path but can be overridden
# for testing: SEVYN_RECOVERY_BASE=<tree> sh -c '. <tree>/recovery-lib.sh; …'
set -eu

SEVYN_RECOVERY_BASE="${SEVYN_RECOVERY_BASE:-/usr/lib/sevyn/recovery}"
RECOVERY_MNT_ROOT=/mnt/sevyn-root
RECOVERY_MNT_MEDIA=/mnt/sevyn-media

# ─── dialog wrapper ─────────────────────────────────────────────────
# Same branding pattern as the installer: every screen carries the
# SEVYNOS / RECOVERY backtitle.
rdialog() {
  command dialog --backtitle "SEVYNOS  /  RECOVERY" "$@"
}

# confirm_typed <title> <text> <word> — the user must type <word> exactly.
confirm_typed() {
  _ct_title="$1"
  _ct_text="$2"
  _ct_expected="$3"
  _ct_typed=$(rdialog --title "$_ct_title" \
    --inputbox "${_ct_text}\n\nType ${_ct_expected} to confirm, or press Cancel to go back." \
    15 68 3>&1 1>&2 2>&3 3>&-) || return 1
  [ "$_ct_typed" = "$_ct_expected" ]
}

# ─── Root partition discovery ───────────────────────────────────────
# The recovery GRUB entry passes no root= (recovery must boot without the
# main rootfs), so the root partition is located by hint, not by mount.

# cmdline_value <key> [cmdline] — print the value of key= on the kernel
# command line (the sevyn.rootuuid= hint the GRUB entry passes).
cmdline_value() {
  _cv_key="$1"
  _cv_cmdline="${2:-$(cat /proc/cmdline 2>/dev/null || true)}"
  for _cv_token in $_cv_cmdline; do
    case "$_cv_token" in
      "$_cv_key="*)
        printf '%s\n' "${_cv_token#$_cv_key=}"
        return 0
        ;;
    esac
  done
  return 1
}

# resolve_device_by_uuid <uuid> — print the /dev node via blkid.
resolve_device_by_uuid() {
  blkid -U "$1" 2>/dev/null
}

# root_device — print the installed-system root partition device.
# Order: kernel cmdline hint, then the SEVYNOS_ROOT filesystem label the
# installer writes, then an interactive picker as a last resort.
root_device() {
  _rd_uuid=$(cmdline_value "sevyn.rootuuid") || _rd_uuid=""
  if [ -n "$_rd_uuid" ]; then
    _rd_dev=$(resolve_device_by_uuid "$_rd_uuid" 2>/dev/null || true)
    [ -n "$_rd_dev" ] && [ -b "$_rd_dev" ] && {
      printf '%s\n' "$_rd_dev"
      return 0
    }
  fi
  _rd_dev=$(blkid -L SEVYNOS_ROOT 2>/dev/null || true)
  [ -n "$_rd_dev" ] && [ -b "$_rd_dev" ] && {
    printf '%s\n' "$_rd_dev"
    return 0
  }
  return 1
}

# pick_root_device — interactive dialog fallback listing ext4 partitions.
pick_root_device() {
  _pr_items=""
  for _pr_dev in /dev/sd* /dev/hd* /dev/vd* /dev/nvme*n*p* /dev/mmcblk*p*; do
    [ -b "$_pr_dev" ] || continue
    case "$_pr_dev" in
      *[0-9]) ;;
      *) continue ;;
    esac
    _pr_type=$(blkid -s TYPE -o value "$_pr_dev" 2>/dev/null || true)
    [ "$_pr_type" = "ext4" ] || continue
    _pr_label=$(blkid -s LABEL -o value "$_pr_dev" 2>/dev/null || true)
    _pr_size=$(blockdev --getsize64 "$_pr_dev" 2>/dev/null || echo 0)
    _pr_mib=$((_pr_size / 1048576))
    _pr_items="$_pr_items \"$_pr_dev\" \"${_pr_label:-no label} ($((_pr_mib / 1024))).$((_pr_mib % 1024 * 10 / 1024)) GiB\""
  done
  [ -n "$_pr_items" ] || return 1
  # shellcheck disable=SC2086
  eval "rdialog --title 'Select System Partition' \
    --menu 'Could not identify the SevynOS system partition automatically.\nChoose it manually:' \
    16 68 8 $_pr_items 3>&1 1>&2 2>&3 3>&-"
}

# mount_root [ro|rw] — mount the installed rootfs; prints the mount point.
mount_root() {
  _mr_mode="${1:-ro}"
  _mr_dev=$(root_device) || _mr_dev=$(pick_root_device) || return 1
  mkdir -p "$RECOVERY_MNT_ROOT"
  if mountpoint -q "$RECOVERY_MNT_ROOT" 2>/dev/null; then
    printf '%s\n' "$RECOVERY_MNT_ROOT"
    return 0
  fi
  mount -t ext4 -o "$_mr_mode" "$_mr_dev" "$RECOVERY_MNT_ROOT" || return 1
  printf '%s\n' "$RECOVERY_MNT_ROOT"
}

unmount_root() {
  mountpoint -q "$RECOVERY_MNT_ROOT" 2>/dev/null || return 0
  umount "$RECOVERY_MNT_ROOT"
}

# ─── OS update state contract ───────────────────────────────────────
# /var/lib/sevynos/updates/ layout (written by the OS update service and
# the boot-time applier, read by recovery):
#   pending.json        staged update waiting to be applied at next boot
#   <VERSION>/          staged payload directory (removed after apply)
#   failed-<ts>.json    records of failed applies
#   previous/           pre-update rollback snapshot (written by the
#                       boot-time applier before extracting an update):
#     version.json      {"version","appliedAt","sha256"}
#     rootfs.squashfs   squashfs of the pre-update root tree
#                       (excludes boot, updates, and pseudo filesystems)

# pending_update_present <root> — 0 when a staged update is waiting.
pending_update_present() {
  [ -f "$1/var/lib/sevynos/updates/pending.json" ]
}

# previous_snapshot_valid <root> — 0 when updates/previous/ is a complete,
# integrity-verified rollback snapshot; prints "version=<v>".
previous_snapshot_valid() {
  _ps_prev="$1/var/lib/sevynos/updates/previous"
  [ -f "$_ps_prev/version.json" ] || return 1
  [ -f "$_ps_prev/rootfs.squashfs" ] || return 1
  _ps_version=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    "$_ps_prev/version.json" | head -n 1)
  _ps_sha=$(sed -n 's/.*"sha256"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    "$_ps_prev/version.json" | head -n 1)
  [ -n "$_ps_version" ] || return 1
  [ -n "$_ps_sha" ] || return 1
  _ps_actual=$(sha256sum "$_ps_prev/rootfs.squashfs" 2>/dev/null | cut -d' ' -f1)
  [ "$_ps_actual" = "$_ps_sha" ] || return 1
  printf 'version=%s\n' "$_ps_version"
  return 0
}

# ─── Restore (rollback / reinstall) ─────────────────────────────────
# restore_preserved_prefixes — newline-separated path prefixes, relative to
# the root mount, that survive an image restore: user data, accounts,
# machine identity, update state, boot assets, logs, mount points.
restore_preserved_prefixes() {
  cat <<'EOF'
boot
var/lib/sevyn/users
var/lib/sevyn/accounts
var/lib/sevynos/updates
etc/hostname
etc/hosts
etc/timezone
etc/localtime
etc/machine-id
var/log
media
mnt
proc
sys
dev
run
tmp
EOF
}

# path_preserved <rel-path> — 0 when the path survives an image restore.
path_preserved() {
  _pp_rel="$1"
  _pp_prefixes=$(restore_preserved_prefixes)
  while IFS= read -r _pp_prefix; do
    [ -n "$_pp_prefix" ] || continue
    case "$_pp_rel" in
      "$_pp_prefix" | "$_pp_prefix"/*) return 0 ;;
    esac
  done <<EOF
$_pp_prefixes
EOF
  return 1
}

# manifest_paths — read `unsquashfs -ll` output on stdin, print normalized
# "/..." paths, one per line, deduplicated.
manifest_paths() {
  sed 's/.*squashfs-root//' |
    sed 's/^[[:space:]]*//' |
    awk '{ if ($0 == "") print "/"; else if ($0 ~ /^\//) print $0; else print "/" $0 }' |
    sort -u
}

# restore_moved_paths — the preserved paths moved aside before extraction.
# A subset of the preserved prefixes: exactly the trees the image also
# contains, so extraction cannot clobber current user/machine state. The
# account databases are user state, not OS state: the image carries
# build-time copies without the installed users.
restore_moved_paths() {
  cat <<'EOF'
var/lib/sevyn/users
var/lib/sevyn/accounts
etc/hostname
etc/hosts
etc/timezone
etc/localtime
etc/machine-id
etc/passwd
etc/shadow
etc/group
etc/gshadow
EOF
}

# stash_preserved <root> <keepdir> — move restore_moved_paths aside.
# Same-filesystem renames are instant.
stash_preserved() {
  _sp_root="$1"
  _sp_keep="$2"
  rm -rf "$_sp_keep"
  mkdir -p "$_sp_keep"
  _sp_moved=$(restore_moved_paths)
  while IFS= read -r _sp_rel; do
    [ -n "$_sp_rel" ] || continue
    if [ -e "$_sp_root/$_sp_rel" ]; then
      mkdir -p "$_sp_keep/$(dirname "$_sp_rel")"
      mv "$_sp_root/$_sp_rel" "$_sp_keep/$_sp_rel"
    fi
  done <<EOF
$_sp_moved
EOF
}

# restore_preserved_back <root> <keepdir> — move preserved trees back.
restore_preserved_back() {
  _rp_root="$1"
  _rp_keep="$2"
  [ -d "$_rp_keep" ] || return 0
  _rp_moved=$(restore_moved_paths)
  while IFS= read -r _rp_rel; do
    [ -n "$_rp_rel" ] || continue
    if [ -e "$_rp_keep/$_rp_rel" ]; then
      mkdir -p "$_rp_root/$(dirname "$_rp_rel")"
      rm -rf "$_rp_root/$_rp_rel"
      mv "$_rp_keep/$_rp_rel" "$_rp_root/$_rp_rel"
    fi
  done <<EOF
$_rp_moved
EOF
}

# prune_extraneous <root> <image> — delete files on the root that are not in
# the image manifest and not under a preserved prefix. Depth-first so
# directories empty out before their own removal is attempted.
# Safety: if the manifest cannot be produced or is empty, nothing is
# deleted (an empty manifest would otherwise nuke the whole tree).
prune_extraneous() {
  _pe_root="$1"
  _pe_image="$2"
  _pe_raw=$(mktemp /tmp/sevyn-manifest-raw.XXXXXX)
  _pe_manifest=$(mktemp /tmp/sevyn-manifest.XXXXXX)
  _pe_prefixes=$(mktemp /tmp/sevyn-prefixes.XXXXXX)
  _pe_dellist=$(mktemp /tmp/sevyn-dellist.XXXXXX)
  _pe_cleanup() {
    rm -f "$_pe_raw" "$_pe_manifest" "$_pe_prefixes" "$_pe_dellist"
  }
  if ! unsquashfs -ll "$_pe_image" > "$_pe_raw" 2>/dev/null; then
    _pe_cleanup
    return 1
  fi
  manifest_paths < "$_pe_raw" > "$_pe_manifest"
  if [ ! -s "$_pe_manifest" ]; then
    _pe_cleanup
    return 1
  fi
  restore_preserved_prefixes | sed 's/^/\//' > "$_pe_prefixes"
  (cd "$_pe_root" && find . -xdev -depth -mindepth 1) |
    awk -v m="$_pe_manifest" -v p="$_pe_prefixes" '
      BEGIN {
        while ((getline line < m) > 0) manifest[line] = 1
        while ((getline line < p) > 0) prefixes[++np] = line
        close(m); close(p)
      }
      {
        rel = $0; sub(/^\.\//, "", rel); path = "/" rel
        if (path in manifest) next
        for (i = 1; i <= np; i++) {
          pre = prefixes[i]
          if (path == pre || index(path, pre "/") == 1) next
        }
        print path
      }
    ' > "$_pe_dellist"
  while IFS= read -r _pe_del; do
    rm -rf "$_pe_root$_pe_del" || true
  done < "$_pe_dellist"
  _pe_cleanup
  return 0
}

# restore_image_over_root <image.squashfs> <root-mount>
# Replaces the OS files on the mounted root with the image contents while
# preserving user data, accounts, machine identity, update state, boot
# assets and logs. Used by both rollback (pre-update snapshot) and
# reinstall (pristine media image).
restore_image_over_root() {
  _ri_image="$1"
  _ri_root="$2"
  _ri_keep="$_ri_root/var/lib/sevynos/updates/restore-keep"

  # 1. Move preserved trees aside (same-filesystem renames are instant).
  stash_preserved "$_ri_root" "$_ri_keep"

  # 2. Extract the image over the root.
  if ! unsquashfs -f -d "$_ri_root" "$_ri_image" >/tmp/sevyn-restore-extract.log 2>&1; then
    restore_preserved_back "$_ri_root" "$_ri_keep"
    rm -rf "$_ri_keep"
    return 1
  fi

  # 3. Move preserved trees back, then drop files the image never had.
  restore_preserved_back "$_ri_root" "$_ri_keep"
  rm -rf "$_ri_keep"
  prune_extraneous "$_ri_root" "$_ri_image"
  return 0
}
