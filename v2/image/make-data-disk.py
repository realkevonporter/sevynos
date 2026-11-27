#!/usr/bin/env python3
"""Create the M8 persistent data disk (ext4) for the A/B slots.

Usage:
  make-data-disk.py --kernel <vmlinuz> --initramfs <initramfs.cpio.gz>
                    --version <version> --out <disk.img> [--size-mb N]
                    [--label LABEL]

Layout (ext4, no partition table — the guest mounts /dev/vda directly):
  /slots/A/vmlinuz
  /slots/A/initramfs.cpio.gz     the built image, in slot A
  /slots/B/                      empty (the updater fills it)
  /slot-state.json               {"active": "A", "good": "A",
                                  "attempts": 0, "version": <version>}

Writes go through debugfs (no loop mount, no root needed beyond
mkfs.ext4). The guest's init mounts the disk at /data; the updater
reads/writes the slot state there.

--label sets the filesystem label (M7: SEVYN_DATA). The M7 init mounts
the data disk by label (/dev/disk/by-label/SEVYN_DATA) because on bare
metal the device name varies by bus; the M6 data disk has no label and
mounts by /dev/vda instead.

--seed-dir copies a host directory tree onto the data partition,
preserving relative paths (files at the seed root land at the /data
root, subdirectories become /data subdirectories). The M13 image seeds
the sample media this way: the 7 test WAVs at the /data root (audiod's
SCAN is flat and the Music app scans /data) and the 7 sample JPEGs in
/photos (the Camera gallery's PHOTOS_DIR). The seed is written at
image-build time, so only a fresh flash gets it — the updater never
touches user files in /data, so an existing install keeps whatever
is already there.
"""
import argparse
import json
import os
import subprocess
import sys
from pathlib import Path


def run(cmd, **kw):
    r = subprocess.run(cmd, capture_output=True, text=True, **kw)
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
    ap.add_argument("--size-mb", type=int, default=256)
    ap.add_argument("--label", default=None)
    ap.add_argument("--seed-dir", default=None,
                    help="host directory tree to copy onto the data "
                         "partition, preserving relative paths")
    args = ap.parse_args()

    kernel = Path(args.kernel)
    initramfs = Path(args.initramfs)
    out = Path(args.out)
    for p in (kernel, initramfs):
        if not p.is_file():
            print(f"missing: {p}", file=sys.stderr)
            return 1

    # Seed entries: (host path, guest path), sorted for a deterministic
    # disk. Symlinks are refused (a link could escape the seed dir);
    # names with whitespace are refused (debugfs splits its commands
    # on whitespace, so such a name could never be written faithfully).
    seed_dirs = []
    seed_files = []
    seed_bytes = 0
    if args.seed_dir is not None:
        seed_dir = Path(args.seed_dir)
        if not seed_dir.is_dir():
            print(f"missing seed dir: {seed_dir}", file=sys.stderr)
            return 1
        for root, dirs, files in os.walk(seed_dir):
            dirs.sort()
            for d in sorted(dirs):
                rel = (Path(root) / d).relative_to(seed_dir)
                seed_dirs.append("/" + rel.as_posix())
            for name in sorted(files):
                host = Path(root) / name
                if host.is_symlink() or not host.is_file():
                    print(f"seed entry not a regular file: {host}",
                          file=sys.stderr)
                    return 1
                rel = host.relative_to(seed_dir)
                if any(c.isspace() for c in rel.as_posix()):
                    print(f"seed name has whitespace: {rel}", file=sys.stderr)
                    return 1
                seed_files.append((host, "/" + rel.as_posix()))
                seed_bytes += host.stat().st_size
        seed_dirs.sort(key=lambda p: (p.count("/"), p))
        print(f"seed: {len(seed_files)} files, "
              f"{seed_bytes // (1024 * 1024)} MB from {seed_dir}")

    # Two slots x (~15 MB kernel + ~50 MB initramfs) + ext4 overhead.
    need_mb = (kernel.stat().st_size + initramfs.stat().st_size) * 2 \
        // (1024 * 1024) + 32 + seed_bytes // (1024 * 1024) + 1
    size_mb = max(args.size_mb, need_mb)
    print(f"data disk: {size_mb} MB (slots need ~{need_mb} MB)")

    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "wb") as f:
        f.truncate(size_mb * 1024 * 1024)
    mkfs = ["mkfs.ext4", "-q", "-F"]
    if args.label:
        mkfs += ["-L", args.label]
    run(mkfs + [str(out)])

    state = {"active": "A", "good": "A", "attempts": 0,
             "version": args.version}
    state_path = out.with_suffix(".slot-state.json")
    state_path.write_text(json.dumps(state, indent=2) + "\n")

    cmds = [
        "mkdir /slots",
        "mkdir /slots/A",
        "mkdir /slots/B",
        f"write {kernel} /slots/A/vmlinuz",
        f"write {initramfs} /slots/A/initramfs.cpio.gz",
        f"write {state_path} /slot-state.json",
    ]
    for d in seed_dirs:
        cmds.append(f"mkdir {d}")
    for host, guest in seed_files:
        cmds.append(f"write {host} {guest}")
    cmds.append("")
    cmds = "\n".join(cmds)
    cmds_path = out.with_suffix(".debugfs-cmds")
    cmds_path.write_text(cmds)
    run(["debugfs", "-w", "-f", str(cmds_path), str(out)])
    cmds_path.unlink()
    state_path.unlink()

    # Verify the layout reads back.
    r = run(["debugfs", "-R", "ls -l /slots/A", str(out)])
    assert "vmlinuz" in r.stdout and "initramfs.cpio.gz" in r.stdout, \
        f"slot A incomplete:\n{r.stdout}"
    r = run(["debugfs", "-R", "cat /slot-state.json", str(out)])
    assert json.loads(r.stdout)["version"] == args.version, \
        f"state mismatch:\n{r.stdout}"
    # Verify the seed reads back: every seeded file's basename must
    # appear in its parent directory's listing.
    by_dir = {}
    for _, guest in seed_files:
        by_dir.setdefault(str(Path(guest).parent),
                          []).append(Path(guest).name)
    for parent, names in sorted(by_dir.items()):
        r = run(["debugfs", "-R", f"ls {parent}", str(out)])
        missing = [n for n in names if n not in r.stdout.split()]
        assert not missing, \
            f"seed missing in {parent}: {missing}\n{r.stdout}"
    print(f"data disk ready: {out} ({size_mb} MB, slot A = {args.version})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
