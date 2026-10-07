#!/bin/sh
# SevynOS kernel lifecycle library (Phase 3 B3, shared shell helpers).
#
# Sourced (not executed) by:
#   - tools/qemu/sevyn-apply-update.sh — the boot-time update applier, which
#     installs versioned kernel+initramfs pairs from the update feed;
#   - tools/qemu/sevyn-boot-health.sh — sevyn_rollback_restore flips the
#     kernel pair back together with the rootfs snapshot (B2 pairing);
#   - the recovery environment's rollback.sh — same flip for the manual
#     rollback path (best-effort: older recovery images lack this file).
#
# Override points (hermetic tests):
#   SEVYN_UNSQUASHFS_BIN, SEVYN_STRINGS_BIN, SEVYN_SBSIGN_BIN,
#   SEVYN_SBVERIFY_BIN, SEVYN_OPENSSL_BIN, SEVYN_GRUB_CFG_LIB
#
# /boot layout produced by the kernel updater (all paths absolute):
#   vmlinuz-<kver>                  versioned kernel (never overwritten in place)
#   initramfs-<kver>.cpio.gz        versioned main initramfs
#   recovery-initramfs-<kver>.cpio.gz
#                                   versioned recovery image, modules built
#                                   against <kver> (C1 lockstep contract)
#   vmlinuz / initramfs.cpio.gz / recovery-initramfs.cpio.gz
#                                   install-time unversioned names; the
#                                   installer owns them and the updater never
#                                   writes them (they are the fallback pair
#                                   for the FIRST kernel update only).
#
# Pairing state: /var/lib/sevynos/updates/kernels.json
#   {"current": {"version","kernel","initramfs","recoveryInitramfs"},
#    "previous": {...} | null}
# The applier writes previous/kernels.json (inside the B2 snapshot slot)
# before extracting an update:
#   {"previousKernelVersion","previousKernel","previousInitramfs",
#    "previousRecoveryInitramfs","newKernelVersion"}
# so both rollback paths can flip the kernel together with the rootfs.

# sevyn_kernel_version <vmlinuz-path>
# Prints the kernel release string (e.g. "6.8.0-60-generic") parsed from the
# "Linux version ..." banner embedded in the image, or nothing when it
# cannot be determined.
sevyn_kernel_version() {
  _skv_strings="${SEVYN_STRINGS_BIN:-strings}"
  [ -f "$1" ] || return 0
  "$_skv_strings" "$1" 2>/dev/null |
    grep -m1 '^Linux version ' |
    awk '{ print $3 }' || true
}

# sevyn_image_modules_versions <rootfs.squashfs>
# Prints the kernel versions that have a module tree inside a rootfs image
# (the directory names under lib/modules/), one per line. Empty output
# means the image carries no kernel modules.
sevyn_image_modules_versions() {
  _smv_unsquashfs="${SEVYN_UNSQUASHFS_BIN:-unsquashfs}"
  [ -f "$1" ] || return 0
  "$_smv_unsquashfs" -l "$1" 2>/dev/null |
    sed -n 's|^squashfs-root/lib/modules/\([^/]*\)\(/.*\)\?$|\1|p' |
    sort -u || true
}

# sevyn_assert_kernel_modules_match <vmlinuz> <rootfs.squashfs>
# Fails loudly (message on stderr, nonzero exit) unless the kernel's
# version appears among the module trees inside the new rootfs. The two
# are built together; a mismatch would boot a kernel whose modules do not
# exist — fail the update instead.
sevyn_assert_kernel_modules_match() {
  _smm_kver=$(sevyn_kernel_version "$1")
  [ -n "$_smm_kver" ] || {
    echo "sevyn_assert_kernel_modules_match: cannot determine kernel version of $1" >&2
    return 1
  }
  _smm_mods=$(sevyn_image_modules_versions "$2")
  [ -n "$_smm_mods" ] || {
    echo "sevyn_assert_kernel_modules_match: no kernel modules found in $2" >&2
    return 1
  }
  if ! printf '%s\n' "$_smm_mods" | grep -qx -- "$_smm_kver"; then
    echo "sevyn_assert_kernel_modules_match: kernel $_smm_kver does not match modules in $2: $(printf '%s' "$_smm_mods" | tr '\n' ' ')" >&2
    return 1
  fi
  _smm_count=$(printf '%s\n' "$_smm_mods" | wc -l)
  if [ "$_smm_count" -gt 1 ]; then
    echo "sevyn_assert_kernel_modules_match: WARNING: $2 carries $_smm_count module trees; using $_smm_kver" >&2
  fi
  return 0
}

# sevyn_grub_uuids <grub.cfg>
# Prints "root_uuid=<uuid>" then "esp_uuid=<uuid>", parsed from an existing
# grub.cfg. esp_uuid is set only when the recovery entry boots from the
# ESP (its linux line references /EFI/SevynOS/); legacy-BIOS configs
# whose recovery entry boots from /boot report an empty esp_uuid.
sevyn_grub_uuids() {
  awk '
    /^menuentry "SevynOS Recovery"/ { in_recovery = 1; rec_search = ""; rec_efi = 0 }
    /^}/ { in_recovery = 0 }
    /search --no-floppy --set=root --fs-uuid/ {
      for (i = 1; i <= NF; i++) if ($i == "--fs-uuid") uuid = $(i+1)
      if (in_recovery) rec_search = uuid; else if (root == "") root = uuid
    }
    in_recovery && /\/EFI\/SevynOS\// { rec_efi = 1 }
    END {
      print "root_uuid=" root
      if (rec_efi == 1) print "esp_uuid=" rec_search; else print "esp_uuid="
    }
  ' "$1"
}

# sevyn_json_get <file> <field>
# Minimal JSON reader for flat machine-generated objects (single-line
# string values). Prints the value or nothing.
sevyn_json_get() {
  sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$1" 2>/dev/null | head -n 1
}

# sevyn_kjson_get <file> <section> <field>
# Minimal JSON reader for kernels.json / previous/kernels.json (machine-
# generated, single-line string values). Prints the value or nothing.
sevyn_kjson_get() {
  sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*{[^}]*\"$3\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$1" 2>/dev/null | head -n 1
}

# sevyn_sb_fingerprint <mok-pem>
# Colon-free lowercase sha256 fingerprint of the MOK certificate.
sevyn_sb_fingerprint() {
  _sfp_openssl="${SEVYN_OPENSSL_BIN:-openssl}"
  "$_sfp_openssl" x509 -in "$1" -noout -fingerprint -sha256 2>/dev/null |
    sed 's/^.*=//; s/://g' | tr 'A-Z' 'a-z' || true
}

# sevyn_sb_state_write <state-file> <key> <value>
# Records a string value in the Secure Boot state.json (same format as
# sevyn-secure-boot.sh's state_write, docs/secure-boot.md §7).
sevyn_sb_state_write() {
  _ssw_file="$1"
  _ssw_key="$2"
  _ssw_value="$3"
  _ssw_tmp="$_ssw_file.tmp"
  if [ -f "$_ssw_file" ]; then
    if grep -q "\"$_ssw_key\":" "$_ssw_file"; then
      sed "s|\"$_ssw_key\": *\"[^\"]*\"|\"$_ssw_key\": \"$_ssw_value\"|" "$_ssw_file" >"$_ssw_tmp"
    else
      sed '$d' "$_ssw_file" >"$_ssw_tmp"
      sed -i '$ s/$/,/' "$_ssw_tmp"
      printf '  "%s": "%s"\n}\n' "$_ssw_key" "$_ssw_value" >>"$_ssw_tmp"
    fi
  else
    printf '{\n  "%s": "%s"\n}\n' "$_ssw_key" "$_ssw_value" >"$_ssw_tmp"
  fi
  mv "$_ssw_tmp" "$_ssw_file"
  chmod 0644 "$_ssw_file"
}

# sevyn_sign_boot_artifacts <mok-priv> <mok-pem> <artifact>...
# Signs boot artifacts with the machine MOK (the update-time equivalent of
# `sevyn-secure-boot.sh sign`, docs/secure-boot.md §7 — that helper only
# signs the unversioned install-time paths, while kernel updates install
# versioned files). Each artifact is signed to a temp file first so a
# failure never leaves a truncated binary behind. Returns nonzero when any
# artifact fails to sign; the caller must abort the update (an unsigned
# kernel on a Secure Boot machine is unbootable).
sevyn_sign_boot_artifacts() {
  _sba_sbsign="${SEVYN_SBSIGN_BIN:-sbsign}"
  _sba_priv="$1"
  _sba_pem="$2"
  shift 2
  command -v "$_sba_sbsign" >/dev/null 2>&1 || {
    echo "sevyn_sign_boot_artifacts: sbsign is not available" >&2
    return 1
  }
  for _sba_artifact in "$@"; do
    [ -f "$_sba_artifact" ] || {
      echo "sevyn_sign_boot_artifacts: artifact missing: $_sba_artifact" >&2
      return 1
    }
    _sba_tmp="$_sba_artifact.sbsign-tmp"
    if "$_sba_sbsign" --key "$_sba_priv" --cert "$_sba_pem" \
      --output "$_sba_tmp" "$_sba_artifact" >/dev/null 2>&1; then
      mv "$_sba_tmp" "$_sba_artifact"
    else
      rm -f "$_sba_tmp"
      echo "sevyn_sign_boot_artifacts: sbsign failed for $_sba_artifact" >&2
      return 1
    fi
  done
  return 0
}

# sevyn_verify_signed <artifact> <mok-pem>
# 0 when sbverify confirms the artifact's signature against the MOK (or
# when sbverify is unavailable — the caller logs that verification was
# skipped); 1 when sbverify reports a bad signature.
sevyn_verify_signed() {
  _svs_sbverify="${SEVYN_SBVERIFY_BIN:-sbverify}"
  command -v "$_svs_sbverify" >/dev/null 2>&1 || return 0
  "$_svs_sbverify" --cert "$2" "$1" >/dev/null 2>&1
}

# sevyn_esp_dir <root>
# Prints <root>/boot/efi/EFI/SevynOS when the ESP staging dir exists there.
sevyn_esp_dir() {
  if [ -d "$1/boot/efi/EFI/SevynOS" ]; then
    printf '%s\n' "$1/boot/efi/EFI/SevynOS"
  fi
}

# sevyn_mount_esp <esp-uuid> <mountpoint>
# Mounts the ESP (vfat, rw) at <mountpoint> so the kernel updater / the
# rollback flip can refresh the ESP-staged recovery kernel + recovery
# image (C1 lockstep contract). Prints the mountpoint on success, nothing
# on failure (the caller decides: the applier refuses the kernel update,
# the rollback flip reports failure). The caller must unmount afterwards.
# Resolution order: /dev/disk/by-uuid (no tool dependency), then blkid -U.
sevyn_mount_esp() {
  _sme_uuid="$1"
  _sme_mnt="$2"
  [ -n "$_sme_uuid" ] || return 1
  _sme_dev=""
  if [ -b "/dev/disk/by-uuid/$_sme_uuid" ]; then
    _sme_dev="/dev/disk/by-uuid/$_sme_uuid"
  elif command -v blkid >/dev/null 2>&1; then
    _sme_dev=$(blkid -U "$_sme_uuid" 2>/dev/null || true)
  fi
  [ -n "$_sme_dev" ] && [ -b "$_sme_dev" ] || return 1
  # vfat needs its helpers; the running kernel's modules are on /.
  modprobe vfat >/dev/null 2>&1 || true
  mkdir -p "$_sme_mnt"
  if mount -t vfat -o rw "$_sme_dev" "$_sme_mnt" >/dev/null 2>&1; then
    printf '%s\n' "$_sme_mnt"
    return 0
  fi
  return 1
}

# sevyn_umount_esp <mountpoint>
# Best-effort unmount after sevyn_mount_esp.
sevyn_umount_esp() {
  umount "$1" >/dev/null 2>&1 || true
}

# sevyn_prune_old_kernels <boot-dir> <keep-version>...
# Removes versioned kernel/initramfs/recovery files whose version is not in
# the keep set. Never touches the unversioned install-time names — the
# installer owns those.
sevyn_prune_old_kernels() {
  _spk_boot="$1"
  shift
  for _spk_file in "$_spk_boot"/vmlinuz-* "$_spk_boot"/initramfs-*.cpio.gz \
    "$_spk_boot"/recovery-initramfs-*.cpio.gz; do
    [ -e "$_spk_file" ] || continue
    _spk_base=$(basename "$_spk_file")
    case "$_spk_base" in
      vmlinuz-*) _spk_ver="${_spk_base#vmlinuz-}" ;;
      initramfs-*.cpio.gz) _spk_ver="${_spk_base#initramfs-}"; _spk_ver="${_spk_ver%.cpio.gz}" ;;
      recovery-initramfs-*.cpio.gz)
        _spk_ver="${_spk_base#recovery-initramfs-}"
        _spk_ver="${_spk_ver%.cpio.gz}"
        ;;
    esac
    _spk_keep=0
    for _spk_want in "$@"; do
      if [ "$_spk_ver" = "$_spk_want" ]; then _spk_keep=1; break; fi
    done
    if [ "$_spk_keep" = "0" ]; then
      rm -f "$_spk_file"
    fi
  done
}

# sevyn_kernel_rollback_flip <root>
# Rollback-path kernel flip (B2 pairing contract): after the pre-update
# rootfs snapshot is restored over <root>, the kernel must flip with it —
# a new rootfs with an old kernel (or vice versa) is a bricked
# combination. Reads <root>/var/lib/sevynos/updates/previous/kernels.json
# (written by the applier before extracting the update), verifies the
# recorded previous pair still exists under <root>/boot, then:
#   - regenerates grub.cfg: previous pair becomes the default entry, the
#     failed update's kernel becomes the fallback;
#   - refreshes the ESP staging (EFI/SevynOS/vmlinuz +
#     recovery-initramfs.cpio.gz) and the /boot stable recovery name from
#     the previous pair;
#   - swaps current/previous in <root>/var/lib/sevynos/updates/kernels.json.
# Prints SEVYN_KERNEL_ROLLBACK_* progress lines. Returns 0 when there is
# nothing to flip (no kernels.json — e.g. a rootfs-only update) or the
# flip succeeded; 1 when the flip failed (the caller must NOT consider the
# rollback complete — the boot-health layer retries on the next boot).
sevyn_kernel_rollback_flip() {
  _krf_root="$1"
  _krf_prev_json="$_krf_root/var/lib/sevynos/updates/previous/kernels.json"
  _krf_kernels_json="$_krf_root/var/lib/sevynos/updates/kernels.json"
  _krf_grub_lib="${SEVYN_GRUB_CFG_LIB:-/usr/local/lib/sevyn-grub-cfg-lib.sh}"

  [ -f "$_krf_prev_json" ] || {
    echo "SEVYN_KERNEL_ROLLBACK_SKIP: no previous/kernels.json (rootfs-only update)"
    return 0
  }

  _krf_ver=$(sevyn_json_get "$_krf_prev_json" "previousKernelVersion")
  _krf_kernel=$(sevyn_json_get "$_krf_prev_json" "previousKernel")
  _krf_initramfs=$(sevyn_json_get "$_krf_prev_json" "previousInitramfs")
  _krf_recovery=$(sevyn_json_get "$_krf_prev_json" "previousRecoveryInitramfs")
  _krf_new_ver=$(sevyn_json_get "$_krf_prev_json" "newKernelVersion")

  [ -n "$_krf_ver" ] && [ -n "$_krf_kernel" ] && [ -n "$_krf_initramfs" ] || {
    echo "SEVYN_KERNEL_ROLLBACK_FAILED: previous/kernels.json is malformed" >&2
    return 1
  }
  for _krf_file in "$_krf_kernel" "$_krf_initramfs" "$_krf_recovery"; do
    [ -f "$_krf_root$_krf_file" ] || {
      echo "SEVYN_KERNEL_ROLLBACK_FAILED: previous pair file missing: $_krf_file" >&2
      return 1
    }
  done

  # The failed update's pair (for the fallback entry): prefer the
  # versioned names under /boot, derived from newKernelVersion.
  _krf_new_kernel="/boot/vmlinuz-$_krf_new_ver"
  _krf_new_initramfs="/boot/initramfs-$_krf_new_ver.cpio.gz"
  [ -f "$_krf_root$_krf_new_kernel" ] || _krf_new_kernel=""
  [ -f "$_krf_root$_krf_new_initramfs" ] || _krf_new_initramfs=""

  [ -f "$_krf_grub_lib" ] || {
    echo "SEVYN_KERNEL_ROLLBACK_FAILED: grub-cfg-lib not found: $_krf_grub_lib" >&2
    return 1
  }
  # shellcheck disable=SC1090
  . "$_krf_grub_lib"

  _krf_grub_cfg="$_krf_root/boot/grub/grub.cfg"
  [ -f "$_krf_grub_cfg" ] || {
    echo "SEVYN_KERNEL_ROLLBACK_FAILED: grub.cfg missing: $_krf_grub_cfg" >&2
    return 1
  }
  eval "$(sevyn_grub_uuids "$_krf_grub_cfg")"
  [ -n "${root_uuid:-}" ] || {
    echo "SEVYN_KERNEL_ROLLBACK_FAILED: cannot parse root UUID from grub.cfg" >&2
    return 1
  }

  echo "SEVYN_KERNEL_ROLLBACK_FLIP: kernel $_krf_new_ver -> $_krf_ver"
  cp "$_krf_grub_cfg" "$_krf_grub_cfg.bak" 2>/dev/null || true
  # The legacy-BIOS recovery entry boots from /boot, so it must follow the
  # flip too (its modules must match its kernel — C1 lockstep contract).
  if [ -n "$_krf_new_kernel" ]; then
    SEVYN_KERNEL="$_krf_kernel" SEVYN_INITRAMFS="$_krf_initramfs" \
      SEVYN_PREV_KERNEL="$_krf_new_kernel" SEVYN_PREV_INITRAMFS="$_krf_new_initramfs" \
      SEVYN_RECOVERY_KERNEL="$_krf_kernel" SEVYN_RECOVERY_INITRAMFS="$_krf_recovery" \
      sevyn_write_grub_cfg "$_krf_grub_cfg" "$root_uuid" "${esp_uuid:-}" || {
      echo "SEVYN_KERNEL_ROLLBACK_FAILED: grub.cfg regeneration failed" >&2
      return 1
    }
  else
    # The failed kernel's files are gone (should not happen — /boot is
    # never pruned below the current+previous pair); fall back to a
    # config with the previous pair only.
    SEVYN_KERNEL="$_krf_kernel" SEVYN_INITRAMFS="$_krf_initramfs" \
      SEVYN_RECOVERY_KERNEL="$_krf_kernel" SEVYN_RECOVERY_INITRAMFS="$_krf_recovery" \
      sevyn_write_grub_cfg "$_krf_grub_cfg" "$root_uuid" "${esp_uuid:-}" || {
      echo "SEVYN_KERNEL_ROLLBACK_FAILED: grub.cfg regeneration failed" >&2
      return 1
    }
  fi

  # Refresh the stable boot names from the previous pair: the /boot
  # recovery image name the legacy-BIOS recovery entry loads, and the ESP
  # staging (EFI/SevynOS/vmlinuz + recovery-initramfs.cpio.gz) for UEFI.
  # The ESP is not mounted at this point (both PID 1 paths run before
  # mount -a), so mount it by UUID first.
  cp -f "$_krf_root$_krf_recovery" "$_krf_root/boot/recovery-initramfs.cpio.gz" || {
    echo "SEVYN_KERNEL_ROLLBACK_FAILED: cannot refresh /boot/recovery-initramfs.cpio.gz" >&2
    return 1
  }
  _krf_esp_mnt=""
  if [ -n "${esp_uuid:-}" ]; then
    _krf_esp_mnt="${SEVYN_ESP_MOUNT:-/tmp/sevyn-esp}"
    if _krf_esp_mnt=$(sevyn_mount_esp "$esp_uuid" "$_krf_esp_mnt"); then
      mkdir -p "$_krf_esp_mnt/EFI/SevynOS"
      cp -f "$_krf_root$_krf_kernel" "$_krf_esp_mnt/EFI/SevynOS/vmlinuz" || {
        echo "SEVYN_KERNEL_ROLLBACK_FAILED: cannot refresh ESP kernel" >&2
        sevyn_umount_esp "$_krf_esp_mnt"
        return 1
      }
      cp -f "$_krf_root$_krf_recovery" "$_krf_esp_mnt/EFI/SevynOS/recovery-initramfs.cpio.gz" || {
        echo "SEVYN_KERNEL_ROLLBACK_FAILED: cannot refresh ESP recovery image" >&2
        sevyn_umount_esp "$_krf_esp_mnt"
        return 1
      }
      sevyn_umount_esp "$_krf_esp_mnt"
      _krf_esp_mnt=""
    else
      echo "SEVYN_KERNEL_ROLLBACK_FAILED: cannot mount the ESP (UUID $esp_uuid)" >&2
      return 1
    fi
  fi

  # Swap current/previous in the pairing state so the next kernel update
  # snapshots the right "previous" pair.
  if [ -f "$_krf_kernels_json" ]; then
    _krf_new_json=$(sed \
      -e 's/"current"[[:space:]]*:/"current-TMP":/' \
      -e 's/"previous"[[:space:]]*:/"current":/' \
      -e 's/"current-TMP"[[:space:]]*:/"previous":/' \
      "$_krf_kernels_json")
    printf '%s\n' "$_krf_new_json" >"$_krf_kernels_json"
  fi

  echo "SEVYN_KERNEL_ROLLBACK_DONE: default kernel is now $_krf_ver"
  return 0
}
