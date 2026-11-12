#!/usr/bin/env python3
"""Build a mock dual-boot target disk for the M11 installer checks.

Creates a GPT disk image carrying a mock Windows 11 install (a FAT32
ESP holding /EFI/Microsoft/Boot/bootmgfw.efi + an NTFS partition with
the Microsoft basic-data type GUID) and, per --layout, free space,
no free space, or an old SevynOS install (ESP + SEVYN_DATA) with no
free space (the GF65 layout).

The mock Windows bootloader is a stand-in EFI binary, not a real
Windows install: by default a dummy file, or --bootmgfw <file> to
use a real EFI binary (the M11 check passes the sysroot's
grubx64.efi, so chainloading it drops to a GRUB prompt and proves
the chainload path executes the Windows bootloader).

Usage:
  make-mock-windows-disk.py --out disk.img --layout windows-free
  make-mock-windows-disk.py --out disk.img --layout windows-oldsevyn
  make-mock-windows-disk.py --out disk.img --layout windows-nofree
  Options: --windows-esp-mb (default 100), --windows-ntfs-mb (512),
           --free-mb (3072), --old-esp-mb (256), --old-data-mb (256),
           --bootmgfw <file>
"""

import argparse
import os
import subprocess
import sys
import tempfile

SECTOR = 512
MIB_SECTORS = 2048  # 1 MiB = 2048 sectors

ESP_TYPE = "C12A7328-F81F-11D2-BA4B-00A0C93EC93B"
MS_DATA_TYPE = "EBD0A0A2-B9E5-4433-87C0-68B6B72699C7"
LINUX_TYPE = "0FC63DAF-8483-4772-8E79-3D69D8477DE4"


def run(argv, env=None):
    e = dict(os.environ)
    e["MTOOLS_SKIP_CHECK"] = "1"
    if env:
        e.update(env)
    r = subprocess.run(argv, env=e, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(
            f"command failed ({r.returncode}): {' '.join(argv)}\n{r.stdout}{r.stderr}"
        )
    return r.stdout


def dd_into(src, dst, offset_sectors):
    run(["dd", f"if={src}", f"of={dst}", "bs=512",
         f"seek={offset_sectors}", "conv=notrunc", "status=none"])


def make_fat32(path, size_mb, label, files):
    """files: dict guest-path -> host-path (or text content as bytes)."""
    with open(path, "wb") as f:
        f.truncate(size_mb * 1024 * 1024)
    run(["mkfs.vfat", "-F", "32", "-n", label, path])
    # mmd exits 1 with NO output when the directory already exists,
    # so track what we created instead of parsing its error.
    made = set()
    for guest in files:
        d = os.path.dirname(guest).strip("/")
        if d:
            parts = d.split("/")
            cur = ""
            for part in parts:
                cur += "/" + part
                if cur in made:
                    continue
                made.add(cur)
                run(["mmd", "-i", path, f"::{cur}"])
    for guest, host in files.items():
        run(["mcopy", "-i", path, "-o", host, f"::{guest}"])


def make_ntfs(path, size_mb, label):
    with open(path, "wb") as f:
        f.truncate(size_mb * 1024 * 1024)
    run(["mkfs.ntfs", "-f", "-F", "-L", label, path])


def make_ext4(path, size_mb, label):
    with open(path, "wb") as f:
        f.truncate(size_mb * 1024 * 1024)
    run(["mkfs.ext4", "-q", "-L", label, path])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--layout", required=True,
                    choices=["windows-free", "windows-oldsevyn",
                             "windows-nofree"])
    ap.add_argument("--windows-esp-mb", type=int, default=100)
    ap.add_argument("--windows-ntfs-mb", type=int, default=512)
    ap.add_argument("--free-mb", type=int, default=3072)
    ap.add_argument("--old-esp-mb", type=int, default=256)
    ap.add_argument("--old-data-mb", type=int, default=256)
    ap.add_argument("--bootmgfw", default=None)
    args = ap.parse_args()

    layout = args.layout
    # Partition plan: (num, size_mb or None for "to end", type, name)
    parts = [
        (1, args.windows_esp_mb, ESP_TYPE, "EFI System Partition"),
        (2, args.windows_ntfs_mb, MS_DATA_TYPE, "Windows"),
    ]
    if layout == "windows-oldsevyn":
        parts.append((3, args.old_esp_mb, ESP_TYPE, "Old SevynOS ESP"))
        parts.append((4, args.old_data_mb, LINUX_TYPE, "Old SevynOS data"))
    free_mb = args.free_mb if layout == "windows-free" else 0
    fixed_mb = sum(p[1] for p in parts)
    # 1 MiB GPT head + parts + free run + 1 MiB GPT tail.
    total_mb = 1 + fixed_mb + free_mb + 1
    with open(args.out, "wb") as f:
        f.truncate(total_mb * 1024 * 1024)
    run(["sgdisk", "--zap-all", "--clear", args.out])

    start = MIB_SECTORS  # sector 2048
    slices = {}  # num -> (slice path, start sector, size_mb)
    for num, size_mb, ptype, name in parts:
        end = start + size_mb * MIB_SECTORS - 1
        run(["sgdisk",
             f"--new={num}:{start}:{end}",
             f"--typecode={num}:{ptype}",
             f"--change-name={num}:{name}",
             args.out])
        slices[num] = (start, size_mb)
        start = end + 1

    # Slices can be >1 GiB: /tmp is a 512M tmpfs in the sandbox, so
    # keep them next to the output disk (real disk in CI and tests).
    with tempfile.TemporaryDirectory(
            dir=os.path.dirname(os.path.abspath(args.out))) as td:
        # p1: Windows ESP with the mock bootmgfw.
        bootmgfw = args.bootmgfw
        if bootmgfw is None:
            bootmgfw = os.path.join(td, "bootmgfw.efi")
            with open(bootmgfw, "wb") as f:
                f.write(b"MOCK-BOOTMGFW\x00" + b"\x00" * 4096)
        esp_slice = os.path.join(td, "win-esp.img")
        make_fat32(esp_slice, slices[1][1], "SYSTEM", {
            "/EFI/Microsoft/Boot/bootmgfw.efi": bootmgfw,
            "/EFI/Microsoft/Boot/bootmgr.efi": bootmgfw,
        })
        dd_into(esp_slice, args.out, slices[1][0])
        # p2: Windows NTFS.
        ntfs_slice = os.path.join(td, "win-ntfs.img")
        make_ntfs(ntfs_slice, slices[2][1], "Windows")
        dd_into(ntfs_slice, args.out, slices[2][0])
        if layout == "windows-oldsevyn":
            # p3: old SevynOS ESP (grub.cfg mentions SevynOS).
            cfg = os.path.join(td, "old-grub.cfg")
            with open(cfg, "w") as f:
                f.write("# Mock old SevynOS grub.cfg\n"
                        "set timeout=5\n"
                        "menuentry \"SevynOS\" {\n"
                        "  linux /vmlinuz root=LABEL=SEVYN_DATA\n"
                        "}\n")
            old_esp = os.path.join(td, "old-esp.img")
            make_fat32(old_esp, slices[3][1], "OLDESP", {
                "/EFI/ubuntu/grub.cfg": cfg,
                "/EFI/ubuntu/shimx64.efi": bootmgfw,
                "/vmlinuz": bootmgfw,
            })
            dd_into(old_esp, args.out, slices[3][0])
            # p4: old SevynOS data.
            old_data = os.path.join(td, "old-data.img")
            make_ext4(old_data, slices[4][1], "SEVYN_DATA")
            dd_into(old_data, args.out, slices[4][0])

    print(f"mock disk: {args.out} layout={layout} size={total_mb} MiB")
    print(run(["sgdisk", "-p", args.out]).strip())
    return 0


if __name__ == "__main__":
    sys.exit(main())
