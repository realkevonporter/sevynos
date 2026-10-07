#!/bin/busybox sh
# SevynOS Recovery — main menu (dialog TUI).
#
# Menu-driven only: every recovery operation is an explicit choice below.
# There is no shell prompt anywhere in recovery (SevynOS product rule).
set -eu

SEVYN_RECOVERY_BASE="${SEVYN_RECOVERY_BASE:-/usr/lib/sevyn/recovery}"
# shellcheck disable=SC1091
. "$SEVYN_RECOVERY_BASE/recovery-lib.sh"

# menu_items — "tag|label" lines; the single source of truth for the menu,
# also used by the unit tests to assert every operation exists.
menu_items() {
  cat <<'EOF'
rollback|Roll back to the previous OS update
reinstall|Reinstall SevynOS from install media (keeps your files)
reset|Factory reset (erase all user data)
diskcheck|Check disks for errors
logs|View system logs
reboot|Reboot
poweroff|Power off
EOF
}

show_menu() {
  _sm_args=""
  while IFS='|' read -r _sm_tag _sm_label; do
    [ -n "$_sm_tag" ] || continue
    _sm_args="$_sm_args \"$_sm_tag\" \"$_sm_label\""
  done <<EOF
$(menu_items)
EOF
  # shellcheck disable=SC2086
  eval "rdialog --title 'SevynOS Recovery' \
    --menu 'System recovery. Your installed system is NOT mounted;\neach operation below mounts it only if it needs to.\n\nChoose an action:' \
    20 70 7 $_sm_args 3>&1 1>&2 2>&3 3>&-"
}

op_failed() {
  rdialog --title "Operation Failed" \
    --msgbox "The operation did not complete.\n\n${1:-See /tmp/sevyn-recovery.log for details.}\n\nYour system was left as close to its prior state as possible." 12 64
}

main() {
  _version=$(cat "$SEVYN_RECOVERY_BASE/VERSION" 2>/dev/null || echo "unknown")
  rdialog --title "SevynOS Recovery" \
    --msgbox "Welcome to SevynOS Recovery ($_version).\n\nUse this environment to repair your system.\nNothing here touches your installed system until\nyou confirm an operation — and destructive actions\nask you to type a confirmation word.\n\nThere is no command shell in recovery." 14 62

  while true; do
    _choice=$(show_menu) || continue
    case "$_choice" in
      rollback)
        if "$SEVYN_RECOVERY_BASE/rollback.sh"; then
          :
        else
          op_failed "The rollback could not be completed."
        fi
        ;;
      reinstall)
        if "$SEVYN_RECOVERY_BASE/reinstall.sh"; then
          :
        else
          op_failed "The reinstall could not be completed."
        fi
        ;;
      reset)
        if "$SEVYN_RECOVERY_BASE/factory-reset.sh"; then
          :
        else
          op_failed "The factory reset could not be completed."
        fi
        ;;
      diskcheck)
        if "$SEVYN_RECOVERY_BASE/disk-check.sh"; then
          :
        else
          op_failed "The disk check could not be completed."
        fi
        ;;
      logs)
        "$SEVYN_RECOVERY_BASE/view-logs.sh" || true
        ;;
      reboot)
        if rdialog --title "Reboot" --yesno "Reboot the system now?" 7 40; then
          unmount_root 2>/dev/null || true
          sync
          reboot -f
        fi
        ;;
      poweroff)
        if rdialog --title "Power Off" --yesno "Power off the system now?" 7 40; then
          unmount_root 2>/dev/null || true
          sync
          poweroff -f
        fi
        ;;
    esac
  done
}

main "$@"
