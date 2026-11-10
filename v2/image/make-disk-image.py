#!/usr/bin/env python3
"""Build the SevynOS v2 M7 GPT disk image for USB boot on bare metal.

Usage:
  make-disk-image.py --kernel <vmlinuz> --initramfs <initramfs.cpio.gz>
                     --version <version> --out <sevynos.img>
                     [--esp-mb 1152] [--data-mb 864]
                     [--make-data-disk <path>] [--sysroot <path>]

Layout (GPT, 1 MiB alignment, ~2.0 GiB total — under GitHub's 2 GB
release-asset limit):
  p1  EFI System, FAT32, 1152 MiB — the standard Ubuntu ESP layout
        (shim + GRUB in /EFI/ubuntu, fallback copies in /EFI/BOOT).
        1152 MiB holds THREE copies of the boot set at the sync peak:
        the M9 ESP sync preserves the old kernel + initramfs as .prev
        alongside the new ones, and esp_copy_verified writes each file
        to a temp name and renames it — so while the new initramfs is
        being written the ESP holds old + .prev + temp-new (~366 MiB
        each, ~1100 MiB total) + the EFI files. An 896 MiB ESP fits
        old + .prev but runs out of space on the temp for the new
        initramfs (ENOSPC, apply fails) — run10 proved it.
        The data partition shrinks to 864 MiB to keep the total under
        2 GiB (1152 + 864 = 2016 MiB): it still holds both A/B slots
        (~768 MiB) with ~96 MiB for user data.
        (shim + GRUB in /EFI/ubuntu, fallback copies in /EFI/BOOT):
        /EFI/BOOT/BOOTX64.EFI    shim (Microsoft-signed — boots with
                                 Secure Boot ON; the GF65's firmware
                                 trusts the Microsoft UEFI CA, which
                                 signs shim)
        /EFI/BOOT/grubx64.efi   GRUB (Canonical-signed; kept as a
                                 fallback — shim on the fallback path
                                 never loads it, see below)
        /EFI/BOOT/MokManager.efi mmx64.efi (shim's key manager)
        /EFI/BOOT/fbx64.efi      fallback loader
        /EFI/ubuntu/shimx64.efi  shim again (same signed binary)
        /EFI/ubuntu/grubx64.efi  GRUB (Canonical-signed; shim
                                 chainloads the file named grubx64.efi
                                 from its own directory and trusts it
                                 via its built-in Canonical vendor
                                 cert)
        /EFI/ubuntu/mmx64.efi   MokManager (shim looks for it beside
                                 itself when the user requests it)
        /EFI/ubuntu/BOOTX64.CSV  "shimx64.efi,ubuntu,,..." — the entry
                                 fbx64.efi reads to create the
                                 "ubuntu" boot option
        /EFI/ubuntu/grub.cfg     boot menu (loads /vmlinuz +
                                 /initramfs.cpio.gz with the SevynOS
                                 cmdline)
        /EFI/ubuntu/*.mod, *.lst GRUB modules (GRUB's built-in prefix
                                 is /EFI/ubuntu)

  Why the /EFI/ubuntu copies matter: OVMF boots the removable-media
  fallback path, /EFI/BOOT/BOOTX64.EFI. Shim on that path hands off
  to fbx64.efi, which scans /EFI/*/BOOTX64.CSV, creates a boot entry
  for the first one it finds (here: "ubuntu" -> /EFI/ubuntu/
  shimx64.efi), puts it first in BootOrder, starts it, and resets
  so the firmware boots the entry next time (shim -> fallback ->
  shim -> GRUB). WITHOUT /EFI/ubuntu/shimx64.efi + BOOTX64.CSV,
  fbx64 finds no boot option, prints "Reset System" and resets —
  and the firmware falls back to BOOTX64.EFI again, so the machine
  loops forever. That is exactly what the M7 check saw under TCG
  AND under real KVM (90 s, 70 resets, 0 boots): the reset is
  fbx64's, not shim's, and it is an image-layout bug, not a
  hypervisor quirk — the ESP was missing the whole /EFI/ubuntu
  half of Ubuntu's layout.
        /vmlinuz, /initramfs.cpio.gz   the built image (the bootloader
                                 loads from the ESP — it cannot read
                                 ext4, so the kernel lives here, not
                                 in a slot; see the A/B note below)
  p2  Sevyn data, ext4, LABEL=SEVYN_DATA, 864 MiB
        /slots/A/ + /slot-state.json (built by make-data-disk.py —
        same layout as the M6 data disk)

Why GRUB, not systemd-boot: Ubuntu's systemd-bootx64.efi ships
UNSIGNED (no certificate table), and so does shimx64.efi — the
signed shim is shimx64.efi.signed.latest. Shim only loads binaries
signed by a key it trusts (firmware db, its built-in Canonical
vendor cert, or a MOK key); an unsigned systemd-boot would be
refused with Secure Boot ON, and signing it ourselves would need a
MOK enrollment on first boot (a manual BIOS-screen step for Kevon).
GRUB is the standard Ubuntu Secure Boot chain (shim → GRUB →
kernel, all Canonical-signed after shim) and needs no BIOS change.

Built rootless (no loop mounts): mkfs.vfat + mtools for the ESP,
mkfs.ext4 + debugfs (via make-data-disk.py) for the data partition,
sgdisk for the GPT, dd to assemble.

A/B note (M9 closes the M7 gap): the updater downloads into the
idle slot on the data partition (M8), and the M9 ESP sync then copies
the new slot's kernel + initramfs onto the ESP (preserving the old
kernel as /vmlinuz.prev) and rewrites grub.cfg with a default entry
for the new slot and a "previous" entry for the good slot — so an
in-place update boots on bare metal, and a twice-failed slot falls
back to the good one. The image's initial grub.cfg stays
single-entry (slot A); the updater adds the previous entry on the
first ESP sync, when .prev files first exist. Until the nightly
signing key is provisioned, the feed ships unsigned and installed
systems refuse it — a new nightly still means a new sevynos.img
until then.

To boot the GF65: dd if=sevynos.img of=/dev/sdX bs=4M status=progress
(where sdX is the USB stick — NOT the internal NVMe), boot from USB,
pick SevynOS. It does NOT touch the internal NVMe/Windows install.
"""
import argparse
import math
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ESP_TYPE = "C12A7328-F81F-11D2-BA4B-00A0C93EC93B"
LINUX_TYPE = "0FC63DAF-8483-4772-8E79-3D69D8477DE4"
SECTOR = 512
ALIGN_SECTORS = 2048  # 1 MiB


def run(cmd, env=None, **kw):
    r = subprocess.run(cmd, capture_output=True, text=True, env=env, **kw)
    if r.returncode != 0:
        print(f"command failed: {' '.join(map(str, cmd))}", file=sys.stderr)
        print(r.stdout, file=sys.stderr)
        print(r.stderr, file=sys.stderr)
        raise SystemExit(1)
    return r


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--kernel", required=True)
    ap.add_argument("--initramfs", required=True)
    ap.add_argument("--version", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--esp-mb", type=int, default=1152)
    ap.add_argument("--data-mb", type=int, default=864)
    ap.add_argument("--make-data-disk", default=None)
    ap.add_argument("--sysroot", default="/")
    args = ap.parse_args()

    kernel = Path(args.kernel)
    initramfs = Path(args.initramfs)
    out = Path(args.out)
    for p in (kernel, initramfs):
        if not p.is_file():
            print(f"missing: {p}", file=sys.stderr)
            return 1
    make_data_disk = Path(args.make_data_disk or
                          Path(__file__).with_name("make-data-disk.py"))
    if not make_data_disk.is_file():
        print(f"missing: {make_data_disk}", file=sys.stderr)
        return 1
    sysroot = Path(args.sysroot)
    # The SIGNED shim (Microsoft-signed). shimx64.efi itself is
    # UNSIGNED — OVMF refuses it with Secure Boot ON ("Access
    # Denied"); the signed one is shimx64.efi.signed.latest.
    shim = sysroot / "usr/lib/shim/shimx64.efi.signed.latest"
    # The Canonical-signed GRUB (shim trusts it via its built-in
    # Canonical vendor cert). Ubuntu's systemd-boot is unsigned and
    # cannot be chainloaded by shim under Secure Boot.
    grub = sysroot / "usr/lib/grub/x86_64-efi-signed/grubx64.efi.signed"
    grub_mods = sysroot / "usr/lib/grub/x86_64-efi"
    grub_font = sysroot / "usr/share/grub/unicode.pf2"
    mmx = sysroot / "usr/lib/shim/mmx64.efi"
    fbx = sysroot / "usr/lib/shim/fbx64.efi"
    # fbx64.efi reads this to create the "ubuntu" boot entry (see the
    # layout note above): "shimx64.efi,ubuntu,,This is the boot entry
    # for ubuntu". Without it fbx64 finds no boot option and resets
    # forever — the M7 reset loop (TCG and KVM alike).
    csv = sysroot / "usr/lib/shim/BOOTX64.CSV"
    for p in (shim, grub, mmx, fbx, csv):
        if not p.is_file():
            print(f"missing bootloader file: {p}", file=sys.stderr)
            print("hint: install shim-signed + grub-efi-amd64-signed in "
                  "the sysroot", file=sys.stderr)
            return 1
    if not grub_mods.is_dir():
        print(f"missing GRUB modules dir: {grub_mods}", file=sys.stderr)
        print("hint: install grub-efi-amd64 in the sysroot", file=sys.stderr)
        return 1

    tmp = Path(tempfile.mkdtemp(prefix="sevynos-disk-"))
    try:
        return build(tmp, args, kernel, initramfs, make_data_disk, sysroot,
                     shim, grub, grub_mods, grub_font, mmx, fbx, csv)
    finally:
        # A failed run must not leave a ~1.5 GiB temp dir behind
        # (on a 512M /tmp tmpfs that also breaks the NEXT run).
        shutil.rmtree(tmp, ignore_errors=True)


def build(tmp, args, kernel, initramfs, make_data_disk, sysroot,
          shim, grub, grub_mods, grub_font, mmx, fbx, csv):
    out = Path(args.out)
    esp_img = tmp / "esp.img"
    data_img = tmp / "data.img"

    # --- ESP (FAT32) ---------------------------------------------------
    esp_sectors = args.esp_mb * 1024 * 1024 // SECTOR
    print(f"ESP: {args.esp_mb} MiB FAT32")
    run(["mkfs.vfat", "-F", "32", "-C", "-n", "SEVYNESP",
         str(esp_img), str(args.esp_mb * 1024)])
    mtools_env = dict(os.environ, MTOOLS_SKIP_CHECK="1")
    for d in ("::/EFI", "::/EFI/BOOT", "::/EFI/ubuntu"):
        run(["mmd", "-i", str(esp_img), d], env=mtools_env)
    for src, dst in [
        (shim, "::/EFI/BOOT/BOOTX64.EFI"),
        (grub, "::/EFI/BOOT/grubx64.efi"),
        (mmx, "::/EFI/BOOT/MokManager.efi"),
        (fbx, "::/EFI/BOOT/fbx64.efi"),
        # Standard Ubuntu layout: shim + GRUB (+ MokManager + the CSV
        # fbx64 reads) in /EFI/ubuntu. Without shimx64.efi and
        # BOOTX64.CSV here, fbx64 finds no boot option and resets
        # forever (the M7 loop) — see the module docstring.
        (shim, "::/EFI/ubuntu/shimx64.efi"),
        (grub, "::/EFI/ubuntu/grubx64.efi"),
        (mmx, "::/EFI/ubuntu/mmx64.efi"),
        (csv, "::/EFI/ubuntu/BOOTX64.CSV"),
        (kernel, "::/vmlinuz"),
        (initramfs, "::/initramfs.cpio.gz"),
    ]:
        run(["mcopy", "-i", str(esp_img), str(src), dst], env=mtools_env)
    # GRUB's built-in prefix is /EFI/ubuntu: grub.cfg + the modules
    # live there. The kernel cmdline: console=tty0 first, ttyS0 last
    # — the kernel logs to both, and /dev/console is the LAST console
    # listed, so the init's output goes to the serial (the harness
    # reads it) while the GF65's display still shows the kernel boot
    # messages.
    grub_cfg = tmp / "grub.cfg"
    grub_cfg.write_text(
        "# SevynOS boot menu (GRUB, loaded by shim under Secure Boot).\n"
        "set timeout=3\n"
        "set default=0\n"
        "menuentry \"SevynOS\" {\n"
        "    linux /vmlinuz console=tty0 console=ttyS0 sevyn.slot=A\n"
        "    initrd /initramfs.cpio.gz\n"
        "}\n")
    run(["mcopy", "-i", str(esp_img), str(grub_cfg), "::/EFI/ubuntu/grub.cfg"],
        env=mtools_env)
    # GRUB modules + lists, one mcopy for the lot (GRUB loads what it
    # needs from its prefix dir on demand).
    mod_files = sorted(
        str(p) for p in grub_mods.iterdir()
        if p.suffix in (".mod", ".lst") or p.name in ("moddep.lst",))
    run(["mcopy", "-i", str(esp_img), *mod_files, "::/EFI/ubuntu/"],
        env=mtools_env)
    if grub_font.is_file():
        run(["mcopy", "-i", str(esp_img), str(grub_font),
             "::/EFI/ubuntu/unicode.pf2"], env=mtools_env)
    r = run(["mdir", "-i", str(esp_img), "-/", "::"], env=mtools_env)
    # mdir shows 8.3 names in columns ("BOOTX64  EFI") and long names
    # after the short name ("MOKMAN~1 EFI ... MokManager.efi"), so the
    # needles are substrings that match either form. All-lowercase
    # 8.3 names (grub.cfg, linux.mod) are stored WITHOUT a long-name
    # entry, so they show as "grub     cfg" — no dot — and cannot be
    # needle-checked here; they get targeted mdir checks below.
    for needle in ("BOOTX64", "grubx64", "MokManager", "fbx64",
                   "shimx64", "vmlinuz", "initramfs"):
        assert needle in r.stdout, f"ESP missing {needle}:\n{r.stdout}"
    # Targeted existence checks (mdir exits non-zero if the file is
    # missing, and run() raises on that). The /EFI/ubuntu half is
    # the one fbx64 needs — assert it explicitly, since a missing
    # shimx64.efi/BOOTX64.CSV there is the silent M7 reset loop.
    for p in ("::/EFI/ubuntu/grub.cfg", "::/EFI/ubuntu/linux.mod",
              "::/EFI/ubuntu/normal.mod", "::/EFI/ubuntu/shimx64.efi",
              "::/EFI/ubuntu/grubx64.efi", "::/EFI/ubuntu/mmx64.efi",
              "::/EFI/ubuntu/BOOTX64.CSV"):
        run(["mdir", "-i", str(esp_img), p], env=mtools_env)
    print("ESP ready")

    # --- Data partition (ext4, LABEL=SEVYN_DATA) ------------------------
    print(f"data partition: {args.data_mb} MiB ext4 (LABEL=SEVYN_DATA)")
    run([sys.executable, str(make_data_disk),
         "--kernel", str(kernel), "--initramfs", str(initramfs),
         "--version", args.version, "--out", str(data_img),
         "--size-mb", str(args.data_mb), "--label", "SEVYN_DATA"])
    data_sectors = math.ceil(data_img.stat().st_size / SECTOR)

    # --- GPT + assembly -------------------------------------------------
    esp_start = ALIGN_SECTORS
    esp_end = esp_start + esp_sectors - 1
    data_start = esp_end + 1
    data_end = data_start + data_sectors - 1
    total_sectors = data_end + 1 + ALIGN_SECTORS  # trailing slack for the backup GPT
    print(f"disk image: {total_sectors * SECTOR // (1024 * 1024)} MiB "
          f"(ESP {esp_start}..{esp_end}, data {data_start}..{data_end})")
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "wb") as f:
        f.truncate(total_sectors * SECTOR)
    run(["sgdisk", "--clear",
         f"--new=1:{esp_start}:{esp_end}", f"--typecode=1:{ESP_TYPE}",
         "--change-name=1:EFI System",
         f"--new=2:{data_start}:{data_end}", f"--typecode=2:{LINUX_TYPE}",
         "--change-name=2:Sevyn data",
         str(out)])
    run(["dd", f"if={esp_img}", f"of={out}", "bs=512",
         f"seek={esp_start}", "conv=notrunc", "status=none"])
    run(["dd", f"if={data_img}", f"of={out}", "bs=512",
         f"seek={data_start}", "conv=notrunc", "status=none"])

    # --- Verify ----------------------------------------------------------
    r = run(["sgdisk", "-p", str(out)])
    assert "EFI System" in r.stdout and "Sevyn data" in r.stdout, \
        f"partition table wrong:\n{r.stdout}"
    run(["sgdisk", "-v", str(out)])
    esp_off = esp_start * SECTOR
    r = run(["mdir", "-i", f"{out}@@{esp_off}", "-/", "::"], env=mtools_env)
    for needle in ("BOOTX64", "grubx64", "MokManager", "fbx64",
                   "shimx64", "vmlinuz", "initramfs"):
        assert needle in r.stdout, f"assembled ESP missing {needle}:\n{r.stdout}"
    for p in ("::/EFI/ubuntu/grub.cfg", "::/EFI/ubuntu/linux.mod",
              "::/EFI/ubuntu/normal.mod", "::/EFI/ubuntu/shimx64.efi",
              "::/EFI/ubuntu/grubx64.efi", "::/EFI/ubuntu/mmx64.efi",
              "::/EFI/ubuntu/BOOTX64.CSV"):
        run(["mdir", "-i", f"{out}@@{esp_off}", p], env=mtools_env)
    print(f"disk image ready: {out} "
          f"({total_sectors * SECTOR // (1024 * 1024)} MiB)")
    print("boot it: dd if=sevynos.img of=/dev/sdX bs=4M status=progress "
          "(sdX = the USB stick, NOT the internal disk)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
