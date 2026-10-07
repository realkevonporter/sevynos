#!/bin/busybox sh
# SevynOS Recovery — view system logs.
#
# Shows the kernel log (no mount needed) and, after mounting the installed
# system read-only, the on-disk logs under /var/log.
set -eu

SEVYN_RECOVERY_BASE="${SEVYN_RECOVERY_BASE:-/usr/lib/sevyn/recovery}"
# shellcheck disable=SC1091
. "$SEVYN_RECOVERY_BASE/recovery-lib.sh"

show_text() {
  _st_title="$1"
  _st_file="$2"
  rdialog --title "$_st_title" --textbox "$_st_file" 22 78
}

main() {
  dmesg > /tmp/sevyn-dmesg.log 2>/dev/null || echo "(no kernel log available)" > /tmp/sevyn-dmesg.log

  while true; do
    _choice=$(rdialog --title "System Logs" \
      --menu "Choose a log to view:" 14 60 4 \
      "kernel" "Kernel log (this boot)" \
      "system" "Installed system logs (/var/log)" \
      "back" "Back to the recovery menu" \
      3>&1 1>&2 2>&3 3>&-) || return 0
    case "$_choice" in
      kernel)
        show_text "Kernel Log" /tmp/sevyn-dmesg.log
        ;;
      system)
        _root=$(mount_root ro) || {
          rdialog --title "System Logs" \
            --msgbox "Could not find or mount the SevynOS system partition." 8 60
          continue
        }
        _items=""
        _n=0
        for _log in "$_root"/var/log/*; do
          [ -f "$_log" ] || continue
          _name=${_log##*/}
          _size=$(wc -c < "$_log" 2>/dev/null | tr -d ' ' || echo 0)
          _items="$_items \"$_name\" \"$((_size / 1024)) KiB\""
          _n=$((_n + 1))
        done
        if [ "$_n" -eq 0 ]; then
          rdialog --title "System Logs" --msgbox "No log files found in /var/log." 7 50
          unmount_root
          continue
        fi
        # shellcheck disable=SC2086
        _pick=$(eval "rdialog --title 'System Logs' \
          --menu 'Installed system logs (read-only):' \
          18 64 10 $_items 3>&1 1>&2 2>&3 3>&-") || {
          unmount_root
          continue
        }
        case "$_pick" in
          "" | *[!a-zA-Z0-9._-]*)
            unmount_root 2>/dev/null || true
            continue
            ;;
        esac
        show_text "Log: $_pick" "$_root/var/log/$_pick"
        unmount_root
        ;;
      back)
        return 0
        ;;
    esac
  done
}

main "$@"
