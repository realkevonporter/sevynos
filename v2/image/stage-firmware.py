#!/usr/bin/env python3
"""Stage firmware into the SevynOS v2 rootfs stage dir.

Usage:
  stage-firmware.py <sysroot> <stage>

Copies the firmware the M7 real-hardware drivers need from the
sysroot's /lib/firmware into the stage at /lib/firmware, decompressing
the sysroot's .zst files with `zstd` so the guest never depends on the
kernel's zstd firmware support.

Required (the build FAILS if any of these is missing — wifi does not
work without its firmware):
  iwlwifi-9000-pu-b0-jf-b0-34.ucode, -38, -46 (Intel Wireless-AC 9560,
  the GF65 Thin 9SD's wifi; the driver tries the highest API version
  first and falls back, so all three are staged).

Optional (warn, do not fail — modesetting works without them, only
GuC submission / HuC media offload / DMC power management are lost):
  i915/kbl_guc_70.1.1.bin, i915/kbl_huc_4.0.0.bin,
  i915/kbl_dmc_ver1_04.bin (Intel UHD 630, Coffee Lake).

Why this exists: the M6 image ships zero firmware (QEMU's virtio
devices need none). On bare metal the drivers are dead weight without
their firmware — iwlwifi in particular refuses to start the radio.
"""
import os
import subprocess
import sys

REQUIRED = [
    "iwlwifi-9000-pu-b0-jf-b0-34.ucode",
    "iwlwifi-9000-pu-b0-jf-b0-38.ucode",
    "iwlwifi-9000-pu-b0-jf-b0-46.ucode",
]

OPTIONAL = [
    "i915/kbl_guc_70.1.1.bin",
    "i915/kbl_huc_4.0.0.bin",
    "i915/kbl_dmc_ver1_04.bin",
]


def find_firmware(fwroot, rel):
    """Locate <rel> under fwroot, preferring the plain file, else .zst."""
    plain = os.path.join(fwroot, rel)
    if os.path.isfile(plain):
        return plain, False
    zst = plain + ".zst"
    if os.path.isfile(zst):
        return zst, True
    return None, False


def stage_one(fwroot, stage, rel):
    src, compressed = find_firmware(fwroot, rel)
    if src is None:
        return False
    dest = os.path.join(stage, "lib", "firmware", rel)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    if compressed:
        r = subprocess.run(["zstd", "-d", "-f", "-q", src, "-o", dest])
        if r.returncode != 0:
            print(f"error: zstd failed for {src}", file=sys.stderr)
            sys.exit(1)
    else:
        import shutil
        shutil.copy2(src, dest)
    print(f"  staged {rel}")
    return True


def main():
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    sysroot = os.path.abspath(sys.argv[1])
    stage = os.path.abspath(sys.argv[2])
    fwroot = os.path.join(sysroot, "lib", "firmware")
    if not os.path.isdir(fwroot):
        print(f"error: no firmware tree at {fwroot}", file=sys.stderr)
        return 1

    missing = []
    print("staging required firmware:")
    for rel in REQUIRED:
        if not stage_one(fwroot, stage, rel):
            missing.append(rel)
    if missing:
        for rel in missing:
            print(f"error: required firmware {rel} not found under {fwroot}",
                  file=sys.stderr)
        return 1

    print("staging optional firmware:")
    for rel in OPTIONAL:
        if not stage_one(fwroot, stage, rel):
            print(f"warning: optional firmware {rel} not found, skipping",
                  file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
