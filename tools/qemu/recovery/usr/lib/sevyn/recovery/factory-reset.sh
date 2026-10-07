#!/bin/busybox sh
# SevynOS Recovery — factory reset.
#
# Wipes all user data but keeps the OS:
#   - every user home under /var/lib/sevyn/users
#   - the accounts registry + shadow (reset to empty)
#   - the matching Unix accounts in /etc/{passwd,shadow,group,gshadow}
#     (so the first-run wizard can recreate the admin user cleanly)
#   - the installer-generated sudoers grant
#   - the first-run onboarding flag (the setup wizard runs again)
#   - saved Wi-Fi networks and Bluetooth pairings
#
# Kept: the OS itself, system configuration, install/update records,
# machine identity, and third-party apps (they are installed system-wide;
# remove the ones you no longer want from the App Store afterwards).
set -eu

SEVYN_RECOVERY_BASE="${SEVYN_RECOVERY_BASE:-/usr/lib/sevyn/recovery}"
# shellcheck disable=SC1091
. "$SEVYN_RECOVERY_BASE/recovery-lib.sh"

# registered_usernames <root> — usernames from the accounts registry.
registered_usernames() {
  sed -n 's/.*"username"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    "$1/var/lib/sevyn/accounts/registry.json" 2>/dev/null | sort -u
}

# remove_unix_user <root> <username> — delete the user from the passwd,
# shadow, group and gshadow databases (no userdel in recovery), including
# group membership lists. Never touches root.
remove_unix_user() {
  _ru_root="$1"
  _ru_user="$2"
  case "$_ru_user" in
    "" | root | *[!a-z0-9_-]*) return 0 ;;
  esac
  for _ru_db in passwd shadow; do
    _ru_file="$_ru_root/etc/$_ru_db"
    [ -f "$_ru_file" ] || continue
    grep -v "^$_ru_user:" "$_ru_file" > "$_ru_file.tmp" || true
    cat "$_ru_file.tmp" > "$_ru_file"
    rm -f "$_ru_file.tmp"
  done
  for _ru_db in group gshadow; do
    _ru_file="$_ru_root/etc/$_ru_db"
    [ -f "$_ru_file" ] || continue
    grep -v "^$_ru_user:" "$_ru_file" > "$_ru_file.tmp" || true
    awk -F: -v user="$_ru_user" '
      BEGIN { OFS=":" }
      NF < 4 { print; next }
      {
        n = split($4, members, ","); out = ""
        for (i = 1; i <= n; i++) {
          if (members[i] != "" && members[i] != user)
            out = (out == "" ? members[i] : out "," members[i])
        }
        $4 = out; print
      }' "$_ru_file.tmp" > "$_ru_file.new" || true
    cat "$_ru_file.new" > "$_ru_file"
    rm -f "$_ru_file.tmp" "$_ru_file.new"
  done
  # Remove the user's mailbox if one exists.
  rm -f "$_ru_root/var/mail/$_ru_user" "$_ru_root/var/spool/mail/$_ru_user"
}

main() {
  _root=$(mount_root rw) || {
    rdialog --title "Factory Reset" \
      --msgbox "Could not find or mount the SevynOS system partition." 8 60
    return 1
  }

  _users=$(registered_usernames "$_root")
  _user_count=$(printf '%s\n' "$_users" | grep -c . || true)

  rdialog --title "Factory Reset" --yesno \
    "Erase ALL user data and restore SevynOS to a fresh state?\n\nThis permanently deletes:\n  - all user accounts and their files ($_user_count account(s))\n  - saved Wi-Fi networks and Bluetooth pairings\n\nThe operating system itself is kept. Afterwards the\nfirst-run setup wizard will run again." 15 64 || {
    unmount_root
    return 0
  }

  confirm_typed "Factory Reset" \
    "Type RESET to permanently erase all user data.\n\nThis cannot be undone." \
    "RESET" || {
    unmount_root
    return 0
  }

  rdialog --title "Factory Reset" --infobox "Erasing user data..." 5 40

  # 1. User homes.
  if [ -d "$_root/var/lib/sevyn/users" ]; then
    for _home in "$_root"/var/lib/sevyn/users/*; do
      [ -e "$_home" ] || continue
      rm -rf "$_home"
    done
  fi

  # 2. Accounts registry + shadow, reset to the empty shape the accounts
  # service expects ({"version":1,"users":[]}).
  mkdir -p "$_root/var/lib/sevyn/accounts"
  printf '{"version":1,"users":[]}\n' > "$_root/var/lib/sevyn/accounts/registry.json"
  printf '{}\n' > "$_root/var/lib/sevyn/accounts/shadow.json"
  chmod 0644 "$_root/var/lib/sevyn/accounts/registry.json"
  chmod 0600 "$_root/var/lib/sevyn/accounts/shadow.json"

  # 3. Matching Unix accounts (usernames from the pre-wipe registry).
  for _user in $_users; do
    remove_unix_user "$_root" "$_user"
  done
  # The installer writes one sudoers grant for the admin user.
  rm -f "$_root/etc/sudoers.d/sevyn-user"

  # 4. First-run onboarding flag: the setup wizard runs again next boot.
  rm -f "$_root/var/lib/sevynos/genesis/onboarding.json"

  # 5. Saved Wi-Fi networks and Bluetooth pairings.
  rm -f "$_root/var/lib/sevynos/wpa_supplicant.conf"
  rm -rf "$_root/var/lib/bluetooth"

  sync
  unmount_root
  rdialog --title "Factory Reset" \
    --msgbox "Factory reset complete.\n\nAll user data has been erased. Choose Reboot from the\nrecovery menu: the first-run setup wizard will guide\nyou through creating a new account." 11 62
  return 0
}

main "$@"
