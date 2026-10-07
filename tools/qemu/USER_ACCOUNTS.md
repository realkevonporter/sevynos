# SevynOS User Accounts (Phase 2)

How the installer provisions the first user, what files form the accounts
contract, and how recovery works now that the desktop no longer runs as root.

## The contract (owned by the accounts workstream)

The canonical contract lives in `services/accounts` (`account-paths.ts`,
`account-service.ts`). The installer writes exactly that shape — two files
under `/var/lib/sevyn/accounts/`, plus home directories under
`/var/lib/sevyn/users/`:

- `registry.json` — `{ "version": 1, "users": [ { username, uid, fullName,
createdAt } ] }`. `createdAt` is epoch milliseconds (`Date.now()`).
  No secrets are stored here, ever. Mode `0644`.
- `shadow.json` — `{ "version": 1, "entries": { username: {
algorithm, n, r, p, saltBase64, hashBase64, updatedAt } } }`.
  Mode **`0600`**, owned by the user's uid (the desktop session runs as
  the user and must read it for lock-screen verification). `algorithm`
  is `"scrypt"` with `n=16384, r=8, p=1`, 16-byte salt, 64-byte key,
  both base64 — the exact parameters `services/accounts` verifies, so
  installer-created passwords work with no migration step.

Example `registry.json`:

```json
{
  "version": 1,
  "users": [
    {
      "username": "kevon",
      "uid": 1000,
      "fullName": "Kevon Porter",
      "createdAt": 1790000000000
    }
  ]
}
```

Example `shadow.json`:

```json
{
  "version": 1,
  "entries": {
    "kevon": {
      "algorithm": "scrypt",
      "n": 16384,
      "r": 8,
      "p": 1,
      "saltBase64": "base64…",
      "hashBase64": "base64…",
      "updatedAt": 1790000000000
    }
  }
}
```

Username rules mirror `services/accounts` exactly: `^[a-z_][a-z0-9_-]{0,31}$`,
max 32 chars, and the reserved names `root admin administrator guest
system sevyn daemon bin sys nobody operator superuser` are rejected.
Passwords must be 8–256 characters.

The installer also writes `/var/lib/sevyn/install.json`
(`installedAt`, `installerVersion`, `mode`, `locale`, `timezone`, `user`)
so tooling can tell how a system was provisioned.

## What the installer creates

`sevyn-installer-chroot.sh` (`create_user`) provisions, in order:

1. A real Unix account (`useradd -m -d /var/lib/sevyn/users/<name> -u 1000`,
   shell `/usr/sbin/nologin` — SevynOS users never get a Linux shell;
   the desktop session is launched via `setpriv` with numeric ids). The
   Unix home IS the accounts home (`/var/lib/sevyn/users/<name>`), so the
   desktop runtime, the accounts service, and the OS agree.
2. The Unix password (same secret, via `chpasswd`) — this is what `sudo`
   authenticates against.
3. Membership in the `sudo` group, plus `/etc/sudoers.d/sevyn-user`
   (validated with `visudo -c`) granting `NOPASSWD` for exactly
   `/sbin/poweroff`, `/sbin/reboot`, `/sbin/halt` and
   `/usr/local/bin/request-genesis-shutdown` so the session can power off
   without a shell. Everything else requires the user's password.
4. The two contract files above (written by
   `tools/qemu/installer-accounts.mjs`, unit-tested).
5. A home directory skeleton: the accounts-service standard set
   (`Desktop`, `Documents`, `Downloads`, `Pictures`, `Music`, `Videos`)
   plus `Projects` (the default Sevyn Code workspace), owned by the user.
6. **The root account is locked** (`passwd -l root`) — but only when a
   user was actually created. Unattended installs without
   `sevyn.install.user=` skip account creation and leave root alone.

## The desktop session runs as the user

`start-genesis.sh` detects the installed user from `registry.json`
(`{ version, users }` shape, with a sed fallback). While still root it
`chown`s the session paths (`/run/sevynos`, `/var/lib/sevyn`, the
weston/genesis logs) to the user, then re-execs itself with
`setpriv --reuid/--regid/--clear-groups`. `HOME` is the accounts home
(`/var/lib/sevyn/users/<name>`). Serial markers:

- `SEVYN_SESSION_USER=<name>` / `SEVYN_SESSION_WHOAMI=uid=…` on success
- `SEVYN_SESSION_USER_FALLBACK_ROOT reason=…` when it stays root

Live sessions (no registry) and user-less installs keep running as root,
exactly as before.

## Recovery path

Root login is locked on installed systems, but recovery is preserved:

- The Terminal app runs the `sevyn` CLI **as the user**.
- The user authenticates `sudo` with their account password (set at
  install time). `sevyn system power shutdown|restart` works without a
  shell: it drives `request-genesis-shutdown` (and the
  `/run/sevynos/reboot-requested` marker for restart), which the desktop
  session owns.
- `sevyn.install.user=` / `sevyn.install.password=` / `sevyn.install.fullname=` /
  `sevyn.install.hostname=` / `sevyn.install.locale=` /
  `sevyn.install.timezone=` kernel cmdline options provision the same
  account unattended (CI smoke path).

## First-run setup wizard

The setup wizard (`applications/setup-wizard`) detects existing accounts
through the accounts registry: when `registry.json` is non-empty it
shows "An account (…) already exists on this system" and skips creation,
so an installer-created user never conflicts with it.
