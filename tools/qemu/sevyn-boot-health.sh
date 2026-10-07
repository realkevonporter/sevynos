#!/bin/busybox sh
# SevynOS boot-health library: automatic update rollback.
#
# Sourced (never executed directly) by:
#   - tools/qemu/sevyn-installed-init   (PID 1: boot-attempt counting,
#     rollback trigger)
#   - tools/qemu/sevyn-apply-update.sh  (rollback mode: snapshot restore;
#     machine-state preservation shared with the apply path)
#
# Must stay POSIX sh (busybox ash): no bashisms. Tunables are environment
# overrides so tests can point the whole layout at temp dirs:
#   SEVYN_UPDATES_DIR        default /var/lib/sevynos/updates
#   SEVYN_UPDATE_TRUST_DIR   default /var/lib/sevynos/update-trust
#   SEVYN_OS_RELEASE_FILE    default /etc/sevynos-release
#   SEVYN_MACHINE_STATE_DIR  default /var/lib/sevynos
#   SEVYN_MAX_FAILED_BOOTS   default 3 (see below)
#   SEVYN_ROLLBACK_HISTORY_KEEP default 20
#   SEVYN_BOOT_HEALTH_LIB / SEVYN_APPLY_UPDATE_BIN / SEVYN_INIT_BIN
#   SEVYN_UNSQUASHFS_BIN / SEVYN_SHA256SUM_BIN
#   SEVYN_KERNEL_LIFECYCLE_LIB  default /usr/local/lib/sevyn-kernel-lifecycle-lib.sh
#                              (Phase 3 B3: the rollback kernel flip)
#
# ─── Design ──────────────────────────────────────────────────────────
# The pre-update snapshot is the single rollback slot, shared with the
# manual recovery environment (tools/qemu/recovery/.../rollback.sh):
#   updates/previous/
#     rootfs.squashfs   squashfs of the pre-update root tree, written by
#                       the applier's snapshot_previous before extracting
#                       an update (exactly one generation; each update
#                       replaces it)
#     version.json      {version, appliedAt, sha256} of the snapshot
#   update-trust/
#     previous.sha256   tamper-evident pin of the snapshot (root-only
#                       0700; the updates dir itself is session-writable)
#
# Other state (all under /var/lib/sevynos/, persistent across boots):
#   updates/boot-attempts      counter of consecutive boots that never
#                              reached a healthy desktop
#   updates/session-ready      marker written by Genesis on the first
#                              presented compositor frame; consumed by the
#                              next boot's init (session-writable dir)
#   updates/pending.json       staged update (Phase 2 update service)
#   updates/rollback-history.jsonl  append-only JSONL of rollback events
#
# Trust model: the snapshot holds the previously-VERIFIED rootfs. The
# running system was Ed25519 feed-signature-verified (Phase 3 B1) and
# sha256-verified (download + the applier's pre-extraction gate) at the
# moment it was applied, so snapshotting it needs no new provenance
# check. What must be guarded instead is the slot itself: rollback
# verifies the snapshot's sha256 against version.json, and — when the
# pin exists — against the root-only pin, and refuses to restore on
# mismatch (fail closed). A compromised session user can delete the slot
# (denial of rollback, logged) but can never plant an unverified payload
# for init to restore.
#
# The restore path uses only the snapshot, the counter, and busybox
# tooling (unsquashfs/sha256sum). It never executes or trusts the new
# (possibly broken) rootfs.
set -eu

: "${SEVYN_UPDATES_DIR:=/var/lib/sevynos/updates}"
: "${SEVYN_UPDATE_TRUST_DIR:=/var/lib/sevynos/update-trust}"
: "${SEVYN_OS_RELEASE_FILE:=/etc/sevynos-release}"
# Root of the machine state preserved across apply/rollback (app/user
# state, Wi-Fi, genesis state). Overridable for tests; always
# /var/lib/sevynos on a real system.
: "${SEVYN_MACHINE_STATE_DIR:=/var/lib/sevynos}"
# Machine identity files preserved alongside. Overridable for tests;
# always /etc on a real system.
: "${SEVYN_ETC_DIR:=/etc}"
: "${SEVYN_UNSQUASHFS_BIN:=unsquashfs}"
: "${SEVYN_SHA256SUM_BIN:=sha256sum}"
: "${SEVYN_APPLY_UPDATE_BIN:=/usr/local/lib/sevynos/apply-update}"
: "${SEVYN_INIT_BIN:=/usr/local/lib/sevynos/installed-init}"
# Kernel lifecycle library (Phase 3 B3): sevyn_kernel_rollback_flip, used
# by sevyn_rollback_restore so the kernel pair flips together with the
# rootfs snapshot. Guarded: systems predating the kernel updater have no
# such file and no previous/kernels.json to flip.
: "${SEVYN_KERNEL_LIFECYCLE_LIB:=/usr/local/lib/sevyn-kernel-lifecycle-lib.sh}"
if [ -f "$SEVYN_KERNEL_LIFECYCLE_LIB" ]; then
  # shellcheck disable=SC1090
  . "$SEVYN_KERNEL_LIFECYCLE_LIB"
fi

# SEVYN_MAX_FAILED_BOOTS: consecutive boots without a healthy desktop
# before init automatically rolls back to the pre-update snapshot.
# 3 is deliberate: it tolerates up to two transient bad boots in a row
# (a flaky driver failing to probe, a hard power cut mid-boot, an
# interrupted apply) without discarding a good update, while a genuinely
# broken update still recovers within a few reboot cycles instead of
# leaving the machine bricked.
: "${SEVYN_MAX_FAILED_BOOTS:=3}"

# The rollback history log is disk-bounded: rotation keeps the most recent
# N events so a pathological boot loop cannot fill the disk.
: "${SEVYN_ROLLBACK_HISTORY_KEEP:=20}"

_PREVIOUS_DIR_NAME="previous"
_SNAPSHOT_NAME="rootfs.squashfs"
_SNAPSHOT_META_NAME="version.json"
_PIN_NAME="previous.sha256"
_COUNTER_NAME="boot-attempts"
_READY_NAME="session-ready"
_HISTORY_NAME="rollback-history.jsonl"
_PENDING_NAME="pending.json"

sevyn_boot_health_log() {
  # $1: message. Mirrors to the serial console like the init markers.
  echo "$1"
  if [ -c /dev/ttyS0 ]; then
    echo "$1" > /dev/ttyS0 2>/dev/null || true
  fi
}

_sevyn_utc_now() {
  date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date +%Y-%m-%dT%H:%M:%SZ
}

_sevyn_json_escape() {
  # Minimal JSON string escaper for our controlled alphabet (versions,
  # timestamps, fixed reason phrases). Strips newlines; escapes
  # backslashes and quotes.
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr -d '\n\r'
}

_sevyn_current_version() {
  version="$(sed -n 's/^VERSION_ID="\?\([^"]*\)"\?/\1/p' \
    "$SEVYN_OS_RELEASE_FILE" 2>/dev/null | head -n 1)"
  [ -n "$version" ] || version="unknown"
  printf '%s' "$version"
}

_sevyn_snapshot_file() {
  printf '%s' "$SEVYN_UPDATES_DIR/$_PREVIOUS_DIR_NAME/$_SNAPSHOT_NAME"
}

_sevyn_snapshot_meta_file() {
  printf '%s' "$SEVYN_UPDATES_DIR/$_PREVIOUS_DIR_NAME/$_SNAPSHOT_META_NAME"
}

_sevyn_snapshot_version() {
  # Prints the snapshot's version from version.json, or "unknown".
  to_version="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    "$(_sevyn_snapshot_meta_file)" 2>/dev/null | head -n 1)"
  [ -n "$to_version" ] || to_version="unknown"
  printf '%s' "$to_version"
}

_sevyn_snapshot_sha() {
  # Prints the snapshot's expected sha256 from version.json, or empty.
  sed -n 's/.*"sha256"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    "$(_sevyn_snapshot_meta_file)" 2>/dev/null | head -n 1
}

_sevyn_read_attempts() {
  attempts="$(cat "$SEVYN_UPDATES_DIR/$_COUNTER_NAME" 2>/dev/null || true)"
  case "$attempts" in
    '' | *[!0-9]*) printf '0\n' ;;
    *) printf '%s\n' "$attempts" ;;
  esac
}

_sevyn_write_attempts() {
  # $1: new count. Followed by sync for fsync-equivalent durability: a
  # power cut immediately after boot must not lose the increment, or a
  # failing system could loop forever without ever reaching the threshold.
  printf '%s\n' "$1" > "$SEVYN_UPDATES_DIR/$_COUNTER_NAME"
  sync
}

_sevyn_rotate_history() {
  keep="$SEVYN_ROLLBACK_HISTORY_KEEP"
  history="$SEVYN_UPDATES_DIR/$_HISTORY_NAME"
  [ -f "$history" ] || return 0
  count="$(wc -l < "$history" 2>/dev/null || echo 0)"
  case "$count" in
    '' | *[!0-9]*) return 0 ;;
  esac
  # Rotate only once the log grows to 2x the keep size, to avoid
  # rewriting the file on every single event.
  if [ "$count" -gt "$((keep * 2))" ]; then
    tail -n "$keep" "$history" > "$history.tmp"
    mv "$history.tmp" "$history"
  fi
}

sevyn_record_history() {
  # $1 event, $2 from_version, $3 to_version, $4 reason. Appends one JSON
  # object per line; the Software Update UI reads the tail of this log.
  ts="$(_sevyn_utc_now)"
  line="$(printf '{"ts":"%s","event":"%s","fromVersion":"%s","toVersion":"%s","reason":"%s"}' \
    "$(_sevyn_json_escape "$ts")" "$(_sevyn_json_escape "$1")" \
    "$(_sevyn_json_escape "$2")" "$(_sevyn_json_escape "$3")" \
    "$(_sevyn_json_escape "$4")")"
  printf '%s\n' "$line" >> "$SEVYN_UPDATES_DIR/$_HISTORY_NAME"
  _sevyn_rotate_history
  sync
}

sevyn_boot_health_check() {
  # Per-boot entry point, called by PID 1 init before anything else runs
  # from the (possibly new) rootfs. Increments the boot-attempt counter,
  # or consumes the session-ready marker and resets it. When the counter
  # reaches SEVYN_MAX_FAILED_BOOTS, execs the applier's rollback mode
  # (does not return on the rollback path).
  mkdir -p "$SEVYN_UPDATES_DIR" "$SEVYN_UPDATE_TRUST_DIR"
  chmod 0700 "$SEVYN_UPDATE_TRUST_DIR" 2>/dev/null || true

  if [ -f "$SEVYN_UPDATES_DIR/$_READY_NAME" ]; then
    # The previous boot reached a healthy desktop: consume the marker and
    # reset. (Genesis also resets the counter when writing the marker;
    # this covers a crash between those two writes.)
    _sevyn_write_attempts 0
    rm -f "$SEVYN_UPDATES_DIR/$_READY_NAME"
    return 0
  fi

  attempts="$(_sevyn_read_attempts)"
  attempts="$((attempts + 1))"
  _sevyn_write_attempts "$attempts"
  sevyn_boot_health_log "SEVYN_BOOT_ATTEMPT count=$attempts"

  if [ "$attempts" -ge "$SEVYN_MAX_FAILED_BOOTS" ]; then
    sevyn_attempt_rollback "$attempts"
  fi
  return 0
}

sevyn_attempt_rollback() {
  # $1: consecutive failed boot count. Existence pre-check, then hands
  # off to the applier's rollback mode (which verifies the snapshot
  # before extracting). Execs; does not return on the rollback path.
  if [ -f "$(_sevyn_snapshot_file)" ] && \
    [ -f "$(_sevyn_snapshot_meta_file)" ]; then
    sevyn_boot_health_log "SEVYN_ROLLBACK_TRIGGERED attempts=$1"
    exec "$SEVYN_APPLY_UPDATE_BIN" rollback
  fi
  sevyn_boot_health_log \
    "SEVYN_ROLLBACK_UNAVAILABLE reason=no-verified-snapshot attempts=$1"
  sevyn_record_history "rollback-unavailable" "$(_sevyn_current_version)" "" \
    "no verified pre-update snapshot after $1 boots without a healthy desktop"
  # Reset so a snapshot-less system does not re-log on every boot; the
  # counter climbs again and the event recurs every MAX_FAILED_BOOTS
  # boots as a periodic reminder in the log.
  _sevyn_write_attempts 0
  return 0
}

sevyn_verify_snapshot() {
  # Returns 0 iff the pre-update snapshot exists and its sha256 matches
  # version.json, and — when the tamper-evident pin exists — the pin.
  # The pin lives in the root-only trust dir, so the check is meaningful
  # even though the snapshot itself sits in the session-writable updates
  # dir. Prints the verified version on stdout on success.
  snapshot="$(_sevyn_snapshot_file)"
  [ -f "$snapshot" ] || return 1
  expected="$(_sevyn_snapshot_sha)"
  [ -n "$expected" ] || return 1
  actual="$("$SEVYN_SHA256SUM_BIN" "$snapshot" 2>/dev/null | cut -d' ' -f1 || true)"
  [ -n "$actual" ] || return 1
  [ "$actual" = "$expected" ] || return 1
  pin_file="$SEVYN_UPDATE_TRUST_DIR/$_PIN_NAME"
  if [ -f "$pin_file" ]; then
    pin="$(cat "$pin_file" 2>/dev/null || true)"
    [ -n "$pin" ] || return 1
    [ "$actual" = "$pin" ] || return 1
  fi
  _sevyn_snapshot_version
  return 0
}

sevyn_preserve_machine_state() {
  # $1: scratch dir (under /tmp). Backs up the machine state that must
  # survive the new image: app/user state, saved Wi-Fi, genesis state,
  # timezone, hostname, machine-id, and the account databases (the
  # payload carries build-time passwd/shadow/group/gshadow without the
  # installed users; restoring the machine's copies keeps logins working
  # after the update). The updates dir is excluded from the copy — its
  # bookkeeping (counter, history, snapshot) must survive as-is, and the
  # staged payload may be too large for tmpfs.
  dest="$1"
  rm -rf "$dest"
  mkdir -p "$dest/etc"
  cp -a "$SEVYN_MACHINE_STATE_DIR" "$dest/var-lib-sevynos"
  rm -rf "$dest/var-lib-sevynos/updates"
  for name in timezone localtime hostname machine-id passwd shadow group gshadow; do
    [ -e "$SEVYN_ETC_DIR/$name" ] && cp -a "$SEVYN_ETC_DIR/$name" "$dest/etc/$name" || true
  done
}

sevyn_restore_machine_state() {
  # $1: scratch dir from sevyn_preserve_machine_state. Restores machine
  # state over the freshly extracted image, then cleans up.
  dest="$1"
  cp -a "$dest/var-lib-sevynos/." "$SEVYN_MACHINE_STATE_DIR/"
  for name in timezone localtime hostname machine-id passwd shadow group gshadow; do
    [ -e "$dest/etc/$name" ] && cp -a "$dest/etc/$name" "$SEVYN_ETC_DIR/$name" || true
  done
  rm -rf "$dest"
}

sevyn_rollback_restore() {
  # Applier "rollback" mode, exec'd by init after SEVYN_MAX_FAILED_BOOTS
  # boots without a healthy desktop. Restores the pre-update snapshot
  # over / using only the snapshot, the counter, and busybox tooling —
  # the new (possibly broken) rootfs is never executed or trusted here.
  # Execs init when done; does not return.
  #
  # The snapshot is intentionally NOT consumed: it stays in place for the
  # manual recovery environment's "Roll Back Update" menu entry, which
  # shares this slot.
  if ! to_version="$(sevyn_verify_snapshot)"; then
    sevyn_boot_health_log \
      "SEVYN_ROLLBACK_ABORTED reason=snapshot-verification-failed"
    sevyn_record_history "rollback-aborted" "$(_sevyn_current_version)" "" \
      "pre-update snapshot failed verification; refusing to restore an unverified payload"
    exec "$SEVYN_INIT_BIN"
  fi
  snapshot="$(_sevyn_snapshot_file)"
  from_version="$(_sevyn_current_version)"

  # A stale pending.json would re-apply the broken update on the next
  # boot — move it aside instead of rollback→re-apply looping forever.
  if [ -f "$SEVYN_UPDATES_DIR/$_PENDING_NAME" ]; then
    mv "$SEVYN_UPDATES_DIR/$_PENDING_NAME" \
      "$SEVYN_UPDATES_DIR/failed-$(date +%s).json" 2>/dev/null || true
    sevyn_boot_health_log "SEVYN_ROLLBACK_CLEARED_PENDING_UPDATE"
  fi

  sevyn_boot_health_log \
    "SEVYN_ROLLBACK_RESTORING from=$from_version to=$to_version"
  state_backup="/tmp/sevyn-rollback-state"
  sevyn_preserve_machine_state "$state_backup"
  if ! "$SEVYN_UNSQUASHFS_BIN" -f -d / "$snapshot" \
    >/tmp/sevyn-rollback-unsquashfs.log 2>&1; then
    sevyn_boot_health_log "SEVYN_ROLLBACK_FAILED reason=extraction-failed"
    sevyn_record_history "rollback-failed" "$from_version" "$to_version" \
      "unsquashfs extraction of the pre-update snapshot failed; will retry next boot"
    # Deliberately NOT resetting the counter: the next boot retries the
    # restore rather than giving up on a broken system.
    exec "$SEVYN_INIT_BIN"
  fi
  sevyn_restore_machine_state "$state_backup"

  # Kernel pairing (Phase 3 B3): the restored snapshot carries the OLD
  # kernel modules, so the kernel must flip back with it — a new rootfs
  # with an old kernel (or vice versa) is a bricked combination.
  # previous/kernels.json (written by the applier before extracting the
  # update) names the pre-update pair; the flip regenerates grub.cfg
  # (previous pair default, failed kernel fallback) and refreshes the ESP
  # staging + the /boot recovery image. When there was no kernel update
  # the flip is a no-op. A failed flip is NOT swallowed: the counter is
  # left alone so the next boot retries the rollback.
  if command -v sevyn_kernel_rollback_flip >/dev/null 2>&1; then
    if ! sevyn_kernel_rollback_flip /; then
      sevyn_boot_health_log "SEVYN_ROLLBACK_FAILED reason=kernel-flip-failed"
      sevyn_record_history "rollback-failed" "$from_version" "$to_version" \
        "kernel pair flip failed; will retry next boot"
      exec "$SEVYN_INIT_BIN"
    fi
  fi

  _sevyn_write_attempts 0
  sevyn_record_history "rollback" "$from_version" "$to_version" \
    "$SEVYN_MAX_FAILED_BOOTS consecutive boots without a healthy desktop"
  sync
  sevyn_boot_health_log \
    "SEVYN_ROLLBACK_COMPLETE from=$from_version to=$to_version"
  exec "$SEVYN_INIT_BIN"
}
