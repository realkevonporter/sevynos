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
"""
import argparse
import json
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
    args = ap.parse_args()

    kernel = Path(args.kernel)
    initramfs = Path(args.initramfs)
    out = Path(args.out)
    for p in (kernel, initramfs):
        if not p.is_file():
            print(f"missing: {p}", file=sys.stderr)
            return 1

    # Two slots x (~15 MB kernel + ~50 MB initramfs) + ext4 overhead.
    need_mb = (kernel.stat().st_size + initramfs.stat().st_size) * 2 \
        // (1024 * 1024) + 32
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

    cmds = "\n".join([
        "mkdir /slots",
        "mkdir /slots/A",
        "mkdir /slots/B",
        f"write {kernel} /slots/A/vmlinuz",
        f"write {initramfs} /slots/A/initramfs.cpio.gz",
        f"write {state_path} /slot-state.json",
        "",
    ])
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
    print(f"data disk ready: {out} ({size_mb} MB, slot A = {args.version})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
