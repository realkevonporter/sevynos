# SevynOS Recovery Environment

> User-facing guide: `docs/recovery-procedure.md`. This document is the
> engineering reference (design, contracts, verification).

The recovery environment is a self-contained boot option for installed
systems. It boots **without the main rootfs**: the GRUB entry passes no
`root=`, and the recovery initramfs only mounts kernel pseudo-filesystems
plus tmpfs scratch space. The installed system is mounted later, and only
by the specific operation the user chooses.

Recovery is menu-driven (dialog TUI). There is intentionally **no shell
prompt** anywhere in recovery — the SevynOS product rule (no Linux
shell/TTY for users) holds here too. Magic SysRq stays disabled, same as
the installed system.

## What's inside the recovery image

`tools/qemu/build-recovery-image.sh` (run at the end of `build-image.sh`
inside the Docker image build) assembles
`/artifacts/recovery-initramfs.cpio.gz` from:

- `tools/qemu/recovery/init` — PID 1: mounts proc/sys/dev/tmpfs, loads
  storage + USB-HID kernel modules, then runs the menu on `/dev/console`.
- `tools/qemu/recovery/usr/lib/sevyn/recovery/` — the dialog menu
  (`recovery-menu.sh`), shared helpers (`recovery-lib.sh`), the five
  operation scripts, and `grub-cfg-lib.sh` (copied in at build time).
- A static busybox (`/bin/busybox`, all applets), `dialog` + ncurses libs +
  terminfo, `fsck.ext4`/`e2fsck`, `fsck.vfat`, `blkid`, `unsquashfs` +
  their shared libraries, and a curated set of kernel modules
  (ext4/vfat/isofs, virtio-blk/nvme/ahci/USB-storage/MMC, USB HID) with a
  generated `modules.dep`. The modules must match the kernel they boot
  with — both are deployed together (see below).

The image is version-stamped (`VERSION` inside, `recovery-version.txt`
next to the artifacts) from the same `SEVYN_OS_VERSION` as the OS build.

## Deployment (install time)

1. `build-live-media.sh` puts `recovery-initramfs.cpio.gz` at `/boot` on
   the live media (and records it in `SHA256SUMS`).
2. `sevyn-installer.sh` copies it to `/boot/recovery-initramfs.cpio.gz`
   on the installed system, next to the kernel and main initramfs.
3. `sevyn-installer-chroot.sh` (`deploy_recovery`) stages the kernel and
   the recovery initramfs at `EFI/SevynOS/` on the ESP when one exists,
   and `tools/qemu/grub-cfg-lib.sh` writes the **"SevynOS Recovery"**
   GRUB entry:
   - **UEFI/ESP:** kernel + initramfs load from the ESP — recovery boots
     even if the entire root partition is destroyed.
   - **Legacy BIOS (no ESP):** they load from `/boot` on the root
     filesystem (best effort if the filesystem is damaged).
   - Both entries pass `sevyn.recovery=1` and `sevyn.rootuuid=<uuid>` but
     no `root=`.

Because the recovery image is built with the OS image and deployed by the
installer, it is kept in sync with the OS version by construction.

> **Kernel-update contract:** the recovery modules must match the booted
> kernel. Any future update flow that replaces `/boot/vmlinuz` must also
> refresh `EFI/SevynOS/vmlinuz` and `EFI/SevynOS/recovery-initramfs.cpio.gz`
> (rebuild the recovery image against the new kernel) or recovery will
> lose its storage drivers.

## The updates/previous rollback contract

`/var/lib/sevynos/updates/` layout (writers: the OS update service and
the boot-time applier `tools/qemu/sevyn-apply-update.sh`; reader:
recovery):

| Path                       | Contents                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------- |
| `pending.json`             | staged update waiting to be applied at next boot                                      |
| `<VERSION>/`               | staged payload directory (removed after apply)                                        |
| `failed-<ts>.json`         | records of failed applies                                                             |
| `previous/`                | **pre-update rollback snapshot** (one generation, replaced per update)                |
| `previous/version.json`    | `{"version","appliedAt","sha256"}`                                                    |
| `previous/rootfs.squashfs` | squashfs of the pre-update root tree (excludes `boot`, `updates`, pseudo-filesystems) |

The applier writes the snapshot **before** extracting an update. It is
best-effort: if `mksquashfs` is missing or fewer than 6 GiB are free on
`/`, the update still proceeds and recovery reports that no rollback is
available for it (`SEVYN_UPDATE_NO_ROLLBACK` in the boot log).

Recovery's rollback verifies `version.json` and the snapshot's sha256,
refuses to run while a `pending.json` is staged, then restores the image
over the mounted root via `restore_image_over_root`:

1. Preserved trees are moved aside (instant same-filesystem renames):
   user homes, the accounts registry/shadow, the Unix account databases
   (`passwd`, `shadow`, `group`, `gshadow` — user state, not OS state),
   machine identity (`hostname`, `hosts`, `timezone`, `localtime`,
   `machine-id`).
2. The snapshot is extracted over the root (`unsquashfs -f`).
3. Preserved trees are moved back.
4. Files present on the root but absent from the snapshot manifest are
   deleted, except preserved prefixes (`boot`, user data, accounts,
   `updates`, logs, mount points). If the manifest cannot be produced,
   nothing is deleted.

Rollback keeps your files, accounts and settings; only system files are
restored. The snapshot's `/etc/sevynos-release` is restored too, so the
reported OS version rolls back as well.

## Operations

- **Roll back to the previous OS update** — as above; typed confirmation
  (`ROLLBACK`).
- **Reinstall SevynOS from install media** — scans attached disks for a
  volume carrying `/live/filesystem.squashfs`, mounts it read-only, and
  runs the same `restore_image_over_root` with the pristine image
  (repair reinstall: your files are kept). Then refreshes
  `/boot/{vmlinuz,initramfs.cpio.gz,recovery-initramfs.cpio.gz}` from the
  media, regenerates `grub.cfg` if missing, and re-deploys the recovery
  payload to the ESP. Typed confirmation (`REINSTALL`). Needs a mountable
  system partition; for a destroyed partition, boot the full installer
  from the live media instead.
- **Factory reset** — wipes all user data, keeps the OS: every home under
  `/var/lib/sevyn/users`, the accounts registry/shadow (reset to empty),
  the matching Unix accounts in `/etc/{passwd,shadow,group,gshadow}`
  (never `root`), the installer sudoers grant, the first-run onboarding
  flag (so the setup wizard runs again), saved Wi-Fi networks and
  Bluetooth pairings. Kept: the OS, system config, install/update
  records, machine identity, and third-party apps (installed system-wide;
  remove unwanted ones from the App Store afterwards). Typed confirmation
  (`RESET`).
- **Check disks for errors** — read-only `fsck` scan of the system
  partition and the ESP while unmounted, with an opt-in automatic repair
  pass; results shown in a scrollable dialog box.
- **View system logs** — kernel log (no mount needed) plus `/var/log`
  from the installed system mounted read-only.
- **Reboot / Power off** — confirmed, then `reboot -f` / `poweroff -f`.

## Limitations (honest)

- Legacy BIOS installs boot recovery from `/boot` on the rootfs — a
  destroyed root filesystem defeats it there; UEFI installs are
  independent via the ESP.
- No network in recovery (no network-dependent operations exist).
- Rollback needs the pre-update snapshot: updates applied before this
  recovery shipped, or applied when disk space was short, have no
  snapshot.
- Filenames with newlines defeat the extraneous-file pruning parser
  (they are left alone, never wrongly deleted).
- A reinstall from media preserves the current Unix account databases;
  if a future OS release adds new system users, use the full installer.

## Manual QEMU verification (acceptance run)

Prerequisites: the VPS build box (`45.63.94.145`), which has Docker and
QEMU. Build the image and boot media first:

```sh
# on the VPS, in /root/sevynos
docker build -f tools/qemu/Dockerfile --build-arg SEVYN_OS_VERSION=0.1.0 -t sevynos-image .
docker create --name sevynos-artifacts sevynos-image
docker cp sevynos-artifacts:/artifacts ./artifacts
```

1. **Artifacts exist.**
   `ls artifacts/` shows `recovery-initramfs.cpio.gz`,
   `recovery-initramfs.sha256`, `recovery-version.txt`, and the ISO's
   `/boot` contains `recovery-initramfs.cpio.gz` (mount the ISO or
   `xorriso -osir` to inspect). `SHA256SUMS` lists the recovery image.

2. **Install to a disk image** (unattended, UEFI):

   ```sh
   qemu-img create -f qcow2 /tmp/sevyn-disk.qcow2 32G
   qemu-system-x86_64 -machine q35 -bios /usr/share/OVMF/OVMF_CODE.fd \
     -drive file=/tmp/sevyn-disk.qcow2,format=qcow2,if=virtio \
     -cdrom artifacts/sevynos-live.iso -boot order=d \
     -kernel artifacts/vmlinuz -initrd artifacts/initramfs.cpio.gz \
     -append "sevyn.install.erase=/dev/vda sevyn.install.user=tester ..." \
     -serial stdio -display none
   ```

   (See `tools/qemu/install-smoke.mjs` for the exact harness.)
   After install, mount the disk image's ESP and root and check:
   - `/boot/efi/EFI/SevynOS/{vmlinuz,recovery-initramfs.cpio.gz}` exist.
   - `/boot/grub/grub.cfg` contains a `SevynOS Recovery` entry loading
     `/EFI/SevynOS/vmlinuz` + `/EFI/SevynOS/recovery-initramfs.cpio.gz`
     with `sevyn.recovery=1`, and no `root=` on that linux line.
   - `/boot/recovery-initramfs.cpio.gz` exists on the rootfs.

3. **Recovery boots without the rootfs.** Boot the disk image, interrupt
   GRUB (serial console), select **SevynOS Recovery**. Expected: the
   recovery welcome dialog, then the 7-item menu. To prove the rootfs is
   untouched, corrupt it first in a scratch copy (e.g. `dd` zeros over
   the first 100 MiB of the root partition) — recovery must still boot
   from the ESP.

4. **Rollback.** On a healthy install, craft a staged update:
   place a `pending.json` + payload under `/var/lib/sevynos/updates/`
   (or run the real updater), reboot, and watch the serial log for
   `SEVYN_UPDATE_SNAPSHOT_DONE`. Then boot recovery → **Roll back…** →
   confirm. Expected: success message naming the previous version;
   after reboot, `/etc/sevynos-release` shows the old version and user
   files are intact. Also verify the refusal path: with a `pending.json`
   still staged, rollback must refuse with the "staged update" message.

5. **Factory reset.** Recovery → **Factory reset** → type `RESET`.
   Expected: `/var/lib/sevyn/users` empty, registry reset to
   `{"version":1,"users":[]}`, the test user's `/etc/passwd` entry gone
   (`root` intact). Reboot → the first-run setup wizard appears.

6. **Disk check + logs.** Recovery → **Check disks** → run the read-only
   scan on the system partition (expect a clean report). **View system
   logs** → kernel log displays; installed-system logs list appears
   after the read-only mount.

7. **Reinstall from media.** Attach the live ISO as a second CD/USB,
   recovery → **Reinstall…** → type `REINSTALL`. Expected: system files
   restored from media, `/boot` refreshed, user files kept, reboot into
   a working desktop.

Unit tests: `node --test tools/qemu/recovery.test.mjs` (13 tests:
GRUB generation, snapshot contract, preserved-path rules, menu
completeness, Unix-account cleanup, stash/restore round-trip).
