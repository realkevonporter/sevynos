#!/usr/bin/env python3
"""Host-side tests for `sevyn install` (M11 dual-boot installer +
installer v2: any disk, whole-disk format, portable USB).

Builds the sevyn CLI with the host gcc, builds mock disks with
v2/image/make-mock-windows-disk.py, then drives the install
verbs against image files (never a real disk).

Coverage:
  - probe: detects Windows (ESP + NTFS), Linux (ESP + ext4 root),
    old SevynOS, free space, model/transport/removable, and a
    raw disk with no partition table (gpt: no)
  - plan: free-space / replace / auto / whole-disk / portable
    modes, refusals (no free space with the shrink-Windows hint,
    boot disk, bad target, portable on a non-removable disk)
  - install --yes: free-space, replace, beside-Linux, whole-disk
    and portable installs; the new ESP + data partitions appear,
    grub.cfg lists SevynOS + every detected OS, the slot layout
    lands on the data partition, and the protected partitions are
    byte-identical before/after
  - install without --yes refuses and writes nothing
  - status: installed / dual-boot reporting

Run: python3 v2/update/test-install.py
"""
import hashlib
import os
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
FIXTURE = ROOT / "v2" / "image" / "make-mock-windows-disk.py"
SEVYN_C = HERE / "sevyn.c"

CHECKS = []


def check(name, ok, detail=""):
    CHECKS.append((name, bool(ok), detail))
    print(f"  {'ok' if ok else 'FAIL'}: {name}" +
          (f" ({detail})" if detail and not ok else ""))


def run(argv, env=None, expect=None):
    e = dict(os.environ)
    e["MTOOLS_SKIP_CHECK"] = "1"
    if env:
        e.update(env)
    r = subprocess.run(argv, env=e, capture_output=True, text=True)
    if expect is not None and r.returncode != expect:
        raise RuntimeError(
            f"command failed (rc={r.returncode}, want {expect}): "
            f"{' '.join(argv)}\n{r.stdout}{r.stderr}")
    return r


def part_range(disk, num):
    """(start_sector, size_sectors) for partition num via sgdisk -i."""
    out = subprocess.run(["sgdisk", "-i", str(num), str(disk)],
                         capture_output=True, text=True).stdout
    first = last = None
    for line in out.splitlines():
        if line.startswith("First sector: "):
            first = int(line.split(":", 1)[1].strip().split()[0])
        if line.startswith("Last sector: "):
            last = int(line.split(":", 1)[1].strip().split()[0])
    return first, last - first + 1


def region_hash(disk, num):
    first, count = part_range(disk, num)
    h = hashlib.sha256()
    with open(disk, "rb") as f:
        f.seek(first * 512)
        left = count * 512
        while left:
            chunk = f.read(min(1 << 20, left))
            if not chunk:
                break
            h.update(chunk)
            left -= len(chunk)
    return h.hexdigest()


def esp_file(disk, num, guest):
    """Read a file out of a FAT partition inside a disk image."""
    first, _ = part_range(disk, num)
    out = subprocess.run(
        ["mcopy", "-i", f"{disk}@@{first * 512}", "-o", f"::{guest}", "-"],
        capture_output=True)
    return out.stdout if out.returncode == 0 else None


def data_file(disk, num, guest):
    """Read a file out of an ext4 partition inside a disk image."""
    first, _ = part_range(disk, num)
    # The slice can be ~1 GiB: keep it next to the disk, not /tmp.
    with tempfile.NamedTemporaryFile(
            delete=False,
            dir=os.path.dirname(os.path.abspath(disk))) as tf:
        tmp = tf.name
    try:
        subprocess.run(["dd", f"if={disk}", f"of={tmp}", "bs=512",
                        f"skip={first}", "status=none"], check=True)
        out = subprocess.run(
            ["debugfs", "-R", f"cat {guest}", tmp],
            capture_output=True)
        return out.stdout if out.returncode == 0 else None
    finally:
        os.unlink(tmp)


def main():
    # Fixture disks are ~2 GiB: /tmp is a 512M tmpfs, so build them
    # under ~/workspace (real disk) and clean up afterwards. The
    # directory may not exist (CI runners have no ~/workspace), so
    # create it first.
    ws = Path.home() / "workspace"
    ws.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=ws) as td:
        td = Path(td)
        sevyn = td / "sevyn"
        r = subprocess.run(["gcc", "-O2", "-Wall", "-Wextra", "-o",
                            str(sevyn), str(SEVYN_C)],
                           capture_output=True, text=True)
        check("sevyn.c compiles warning-clean", r.returncode == 0,
              r.stderr[:400])
        if r.returncode != 0:
            return 1

        # Install-files dir + live-ESP dir (dummy contents).
        files_dir = td / "install-files"
        files_dir.mkdir()
        for name in ("shimx64.efi", "grubx64.efi", "mmx64.efi",
                     "fbx64.efi", "BOOTX64.CSV", "unicode.pf2",
                     "normal.mod", "fat.mod", "part_gpt.mod",
                     "moddep.lst"):
            (files_dir / name).write_bytes(b"dummy-" + name.encode() + b"\n")
        live_esp = td / "live-esp"
        live_esp.mkdir()
        (live_esp / "vmlinuz").write_bytes(b"dummy-kernel\n")
        (live_esp / "initramfs.cpio.gz").write_bytes(b"dummy-initramfs\n")
        mounts = td / "mounts"
        mounts.write_text("proc /proc proc rw 0 0\n")
        env = {
            "SEVYN_INSTALL_FILES_DIR": str(files_dir),
            "SEVYN_INSTALL_LIVE_ESP_DIR": str(live_esp),
            "SEVYN_INSTALL_VERSION": "m11-test-1",
            "SEVYN_INSTALL_PROC_MOUNTS": str(mounts),
        }

        def sevyn_install(*args, expect=None):
            r = run([str(sevyn), "install", *args], env=env)
            if expect is not None:
                check(f"sevyn install {' '.join(args)} -> {expect}",
                      r.returncode == expect,
                      f"rc={r.returncode} out={r.stdout[:200]} "
                      f"err={r.stderr[:200]}")
            return r

        def build_disk(name, layout, extra=None):
            disk = td / name
            cmd = [sys.executable, str(FIXTURE), "--out", str(disk),
                   "--layout", layout, "--windows-esp-mb", "32",
                   "--windows-ntfs-mb", "64", "--free-mb", "2200",
                   "--old-esp-mb", "1152", "--old-data-mb", "864"]
            if extra:
                cmd += extra
            run(cmd, expect=0)
            return disk

        # --- probe ---
        d_free = build_disk("win-free.img", "windows-free")
        d_old = build_disk("win-old.img", "windows-oldsevyn")
        d_nofree = build_disk("win-nofree.img", "windows-nofree")

        r = sevyn_install("probe", "--disk", str(d_free))
        import re as _re
        m = _re.search(r"disk-free-mb: (\d+)", r.stdout)
        free_mb = int(m.group(1)) if m else -1
        check("probe windows-free finds Windows + free space",
              "disk-windows: yes" in r.stdout and
              "disk-sevyn: no" in r.stdout and free_mb >= 2016,
              r.stdout[:300])
        r = sevyn_install("probe", "--disk", str(d_old))
        check("probe windows-oldsevyn finds Windows + old SevynOS",
              "disk-windows: yes" in r.stdout and
              "disk-sevyn: yes" in r.stdout,
              r.stdout[:300])
        r = sevyn_install("probe", "--disk", str(d_nofree))
        check("probe windows-nofree finds Windows, no free space",
              "disk-windows: yes" in r.stdout and
              "disk-free-mb: 0" in r.stdout,
              r.stdout[:300])

        # --- plan ---
        r = sevyn_install("plan", "--disk", str(d_free), expect=0)
        check("plan auto on free disk is free-space mode",
              "mode: free-space" in r.stdout and
              "protected: 1 2" in r.stdout, r.stdout[:300])
        r = sevyn_install("plan", "--disk", str(d_nofree), expect=1)
        check("plan auto on nofree disk refuses with the shrink hint",
              "Shrink Windows 11 by ~10 GB" in r.stderr,
              r.stdout[:200] + r.stderr[:200])
        r = sevyn_install("plan", "--disk", str(d_old), expect=0)
        check("plan auto on old-SevynOS disk is replace mode",
              "mode: replace" in r.stdout and "replaced: 3 4" in r.stdout,
              r.stdout[:300])
        r = sevyn_install("plan", "--disk", str(d_nofree),
                          "--target", "free", expect=1)
        check("plan --target free on nofree disk refuses", True)
        r = sevyn_install("plan", "--disk", str(d_old),
                          "--target", "3", expect=0)
        check("plan --target 3 on old-SevynOS disk is replace mode",
              "mode: replace" in r.stdout, r.stdout[:300])
        r = sevyn_install("plan", "--disk", str(d_free),
                          "--target", "1", expect=1)
        check("plan --target 1 (Windows ESP) refuses",
              r.returncode != 0, r.stdout[:200] + r.stderr[:200])

        # Plain GPT disk with no OS at all: installer v2 installs
        # into its free space (M11 refused Windows-less disks).
        plain = td / "plain.img"
        with open(plain, "wb") as f:
            f.truncate(64 * 1024 * 1024)
        run(["sgdisk", "--zap-all", "--clear", str(plain)])
        r = sevyn_install("plan", "--disk", str(plain), expect=1)
        check("plan on a 64 MiB empty GPT disk refuses (too small)",
              "too small" in r.stderr or "not enough" in r.stderr,
              r.stdout[:200] + r.stderr[:200])
        big_plain = td / "big-plain.img"
        with open(big_plain, "wb") as f:
            f.truncate(6144 * 1024 * 1024)
        run(["sgdisk", "--zap-all", "--clear", str(big_plain)])
        r = sevyn_install("plan", "--disk", str(big_plain), expect=0)
        check("plan on an empty GPT disk is free-space mode",
              "mode: free-space" in r.stdout, r.stdout[:300])

        # Boot-disk protection: /data lives on the target disk.
        mounts_boot = td / "mounts-boot"
        mounts_boot.write_text(
            f"{d_free} /data ext4 rw 0 0\n")
        env_boot = dict(env)
        env_boot["SEVYN_INSTALL_PROC_MOUNTS"] = str(mounts_boot)
        r = run([str(sevyn), "install", "plan", "--disk", str(d_free)],
                env=env_boot)
        check("plan on the boot disk refuses", r.returncode != 0,
              r.stdout[:200] + r.stderr[:200])

        # --- install without --yes writes nothing ---
        before = hashlib.sha256(d_free.read_bytes()).hexdigest()
        r = sevyn_install("install", "--disk", str(d_free), expect=1)
        after = hashlib.sha256(d_free.read_bytes()).hexdigest()
        check("install without --yes refuses and writes nothing",
              before == after, "disk changed without --yes")

        # --- install free-space ---
        win_esp_before = region_hash(d_free, 1)
        win_ntfs_before = region_hash(d_free, 2)
        r = sevyn_install("install", "--disk", str(d_free), "--yes",
                          expect=0)
        check("install free-space succeeds",
              "install: ok" in r.stdout, r.stdout[:300] + r.stderr[:300])
        check("Windows partitions byte-identical after free-space install",
              region_hash(d_free, 1) == win_esp_before and
              region_hash(d_free, 2) == win_ntfs_before)
        r = sevyn_install("probe", "--disk", str(d_free))
        check("probe after install finds Windows + SevynOS",
              "windows: yes" in r.stdout and "sevyn: yes" in r.stdout,
              r.stdout[:300])
        cfg = esp_file(d_free, 3, "/EFI/ubuntu/grub.cfg")
        check("new grub.cfg lists SevynOS + Windows 11",
              cfg is not None and b"SevynOS" in cfg and
              b"Windows 11" in cfg, (cfg or b"")[:200])
        check("new grub.cfg pins the data partition by PARTUUID",
              cfg is not None and b"sevyn.data=PARTUUID=" in cfg,
              (cfg or b"")[:200])
        check("new ESP carries kernel + initramfs",
              esp_file(d_free, 3, "/vmlinuz") is not None and
              esp_file(d_free, 3, "/initramfs.cpio.gz") is not None)
        check("new ESP carries the fallback bootloader",
              esp_file(d_free, 3, "/EFI/BOOT/BOOTX64.EFI") is not None)
        check("new ESP carries the Windows chainload entry",
              cfg is not None and b"bootmgfw.efi" in cfg,
              (cfg or b"")[:200])
        state = data_file(d_free, 4, "/slot-state.json")
        check("data partition carries the slot layout",
              state is not None and b'"active": "A"' in state,
              (state or b"")[:200])
        r = sevyn_install("status", "--disk", str(d_free))
        check("status on a live (non-installed) host reports not "
              "installed", "installed: no" in r.stdout, r.stdout[:200])

        # --- install replace ---
        win_esp_before = region_hash(d_old, 1)
        win_ntfs_before = region_hash(d_old, 2)
        r = sevyn_install("install", "--disk", str(d_old),
                          "--target", "3", "--yes", expect=0)
        check("install replace succeeds",
              "install: ok" in r.stdout, r.stdout[:300] + r.stderr[:300])
        check("Windows partitions byte-identical after replace install",
              region_hash(d_old, 1) == win_esp_before and
              region_hash(d_old, 2) == win_ntfs_before)
        r = sevyn_install("probe", "--disk", str(d_old))
        check("probe after replace finds Windows + SevynOS",
              "windows: yes" in r.stdout and "sevyn: yes" in r.stdout,
              r.stdout[:300])
        out = subprocess.run(["sgdisk", "-p", str(d_old)],
                             capture_output=True, text=True).stdout
        check("old SevynOS partitions are gone after replace",
              "Old SevynOS" not in out and "SevynOS ESP" in out,
              out[:300])
        cfg = esp_file(d_old, 3, "/EFI/ubuntu/grub.cfg")
        check("replace grub.cfg lists SevynOS + Windows 11",
              cfg is not None and b"SevynOS" in cfg and
              b"Windows 11" in cfg, (cfg or b"")[:200])

        # --- installer v2: probe of the new layouts ---
        d_linux = build_disk("linux-free.img", "linux-free")
        d_usb = build_disk("usb-free.img", "usb-free")
        d_empty = build_disk("empty.img", "empty")
        d_whole = build_disk("win-whole.img", "windows-free")

        r = sevyn_install("probe", "--disk", str(d_linux))
        check("probe linux-free finds Linux, no Windows",
              "disk-linux: yes" in r.stdout and
              "disk-windows: no" in r.stdout and
              "disk-os-list: Linux" in r.stdout and
              "os: linux-esp" in r.stdout and
              "os: linux" in r.stdout,
              r.stdout[:400])
        r = sevyn_install("probe", "--disk", str(d_usb))
        check("probe usb-free finds an unknown FAT32 part, file transport",
              "disk-os-list: Other" in r.stdout and
              "disk-windows: no" in r.stdout and
              "disk-transport: file" in r.stdout,
              r.stdout[:400])
        r = sevyn_install("probe", "--disk", str(d_empty))
        check("probe empty disk reports no GPT but a size",
              "disk-gpt: no" in r.stdout and
              "disk-size-mb: 6144" in r.stdout,
              r.stdout[:300])

        # An MBR disk: same non-GPT gate (sgdisk would convert it
        # in memory — the installer must not be fooled).
        d_mbr = build_disk("mbr.img", "mbr")
        r = sevyn_install("probe", "--disk", str(d_mbr))
        check("probe MBR disk reports no GPT but a size",
              "disk-gpt: no" in r.stdout and
              "disk-size-mb: 6144" in r.stdout,
              r.stdout[:300])
        r = sevyn_install("plan", "--disk", str(d_mbr),
                          "--target", "whole", expect=0)
        check("plan --target whole on an MBR disk is whole-disk",
              "mode: whole-disk" in r.stdout and
              "destroyed: none (non-GPT" in r.stdout,
              r.stdout[:400])

        # --- installer v2: plan modes ---
        r = sevyn_install("plan", "--disk", str(d_linux), expect=0)
        check("plan auto beside Linux is free-space with a Linux entry",
              "mode: free-space" in r.stdout and
              "grub: SevynOS + Ubuntu" in r.stdout and
              "linux: yes" in r.stdout, r.stdout[:400])
        r = sevyn_install("plan", "--disk", str(d_empty),
                          "--target", "whole", expect=0)
        check("plan --target whole on an empty disk is whole-disk",
              "mode: whole-disk" in r.stdout and
              "wipe: yes" in r.stdout and
              "destroyed: none" in r.stdout and
              "new-esp: 1" in r.stdout and "new-data: 2" in r.stdout,
              r.stdout[:400])
        r = sevyn_install("plan", "--disk", str(d_empty), expect=1)
        check("plan auto on an empty (non-GPT) disk refuses, names whole",
              "no GPT partition table" in r.stderr and
              "--target whole" in r.stderr,
              r.stdout[:200] + r.stderr[:200])
        env_usb = dict(env)
        env_usb["SEVYN_INSTALL_FORCE_REMOVABLE"] = "1"
        r = run([str(sevyn), "install", "plan", "--disk", str(d_usb),
                 "--target", "portable"], env=env_usb)
        check("plan --target portable on a removable stick is portable",
              r.returncode == 0 and "mode: portable" in r.stdout and
              "boot-entry: none (portable" in r.stdout,
              r.stdout[:400] + r.stderr[:200])
        r = sevyn_install("plan", "--disk", str(d_free),
                          "--target", "portable", expect=1)
        check("plan --target portable on a non-removable disk refuses",
              "not a removable USB drive" in r.stderr,
              r.stdout[:200] + r.stderr[:200])
        r = sevyn_install("plan", "--disk", str(d_whole),
                          "--target", "whole", expect=0)
        check("plan --target whole on a Windows disk names the wipe",
              "mode: whole-disk" in r.stdout and
              "destroyed: 1 2" in r.stdout and
              "protected: none" in r.stdout, r.stdout[:400])

        # --- installer v2: install beside Linux ---
        lin_esp_before = region_hash(d_linux, 1)
        lin_root_before = region_hash(d_linux, 2)
        r = sevyn_install("install", "--disk", str(d_linux), "--yes",
                          expect=0)
        check("install beside Linux succeeds",
              "install: ok" in r.stdout, r.stdout[:300] + r.stderr[:300])
        check("Linux partitions byte-identical after beside-Linux install",
              region_hash(d_linux, 1) == lin_esp_before and
              region_hash(d_linux, 2) == lin_root_before)
        cfg = esp_file(d_linux, 3, "/EFI/ubuntu/grub.cfg")
        check("beside-Linux grub.cfg lists SevynOS + Ubuntu",
              cfg is not None and b"SevynOS" in cfg and
              b'menuentry "Ubuntu"' in cfg and
              b"/EFI/ubuntu/grubx64.efi" in cfg,
              (cfg or b"")[:300])
        check("beside-Linux grub.cfg has no Windows entry",
              cfg is not None and b"Windows 11" not in cfg,
              (cfg or b"")[:300])

        # --- installer v2: whole-disk install on an empty disk ---
        r = sevyn_install("install", "--disk", str(d_empty),
                          "--target", "whole", "--yes", expect=0)
        check("install --target whole on an empty disk succeeds",
              "install: ok" in r.stdout, r.stdout[:300] + r.stderr[:300])
        r = sevyn_install("probe", "--disk", str(d_empty))
        check("probe after whole-disk install finds SevynOS, GPT",
              "disk-gpt: yes" in r.stdout and
              "disk-sevyn: yes" in r.stdout, r.stdout[:300])
        cfg = esp_file(d_empty, 1, "/EFI/ubuntu/grub.cfg")
        check("whole-disk grub.cfg is SevynOS-only",
              cfg is not None and b"SevynOS" in cfg and
              b"Windows 11" not in cfg and b"Ubuntu" not in cfg,
              (cfg or b"")[:300])
        state = data_file(d_empty, 2, "/slot-state.json")
        check("whole-disk data partition carries the slot layout",
              state is not None and b'"active": "A"' in state,
              (state or b"")[:200])

        # --- installer v2: portable install on a USB stick ---
        r = run([str(sevyn), "install", "install", "--disk", str(d_usb),
                 "--target", "portable", "--yes"], env=env_usb)
        check("install --target portable on a USB stick succeeds",
              r.returncode == 0 and "install: ok" in r.stdout,
              r.stdout[:300] + r.stderr[:300])
        cfg = esp_file(d_usb, 2, "/EFI/ubuntu/grub.cfg")
        check("portable grub.cfg is SevynOS-only",
              cfg is not None and b"SevynOS" in cfg and
              b"Windows 11" not in cfg, (cfg or b"")[:300])
        check("portable ESP carries the fallback bootloader",
              esp_file(d_usb, 2, "/EFI/BOOT/BOOTX64.EFI") is not None)
        check("portable install kept the stick's old partition",
              esp_file(d_usb, 1, "/README.txt") is not None)

        # --- installer v2: whole-disk install erases a Windows disk ---
        r = sevyn_install("install", "--disk", str(d_whole),
                          "--target", "whole", "--yes", expect=0)
        check("install --target whole on a Windows disk succeeds",
              "install: ok" in r.stdout, r.stdout[:300] + r.stderr[:300])
        out = subprocess.run(["sgdisk", "-p", str(d_whole)],
                             capture_output=True, text=True).stdout
        check("whole-disk install removed the Windows partitions",
              "Windows" not in out and "SevynOS ESP" in out,
              out[:300])

    failed = [c for c in CHECKS if not c[1]]
    print(f"\n{len(CHECKS) - len(failed)}/{len(CHECKS)} install checks passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
