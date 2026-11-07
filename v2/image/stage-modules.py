#!/usr/bin/env python3
"""Stage kernel modules into the SevynOS v2 rootfs stage dir.

Usage:
  stage-modules.py <sysroot> <kernel-version> <stage> <module> [<module> ...]

Resolves each module's dependency closure with `modinfo` against the
sysroot's /lib/modules/<kernel-version> tree, decompresses the .ko.zst
files with `zstd` (Ubuntu kernels ship zstd-compressed modules), and
writes plain .ko files into the stage at their canonical relative paths
(/lib/modules/<kernel-version>/...), plus an ordered load manifest at
/lib/modules/<kernel-version>/sevyn-modules.txt (dependencies first).
The guest init insmod's the manifest in order before starting Weston.

Why this exists: the Ubuntu generic kernel builds virtio-gpu, the USB HID
stack, and the xHCI PCI driver as modules, and the initramfs carries no
modules by default. Without them there is no DRM device for the
compositor and no USB tablet pointer for input. Built-in drivers
(virtio-pci, atkbd, xhci core, DRM core) need nothing.
"""
import os
import subprocess
import sys


def main():
    if len(sys.argv) < 5:
        print(__doc__, file=sys.stderr)
        return 2
    sysroot = os.path.abspath(sys.argv[1])
    kver = sys.argv[2]
    stage = os.path.abspath(sys.argv[3])
    wanted = sys.argv[4:]

    modroot = os.path.join(sysroot, "lib", "modules", kver)
    if not os.path.isdir(modroot):
        print(f"error: no modules tree at {modroot}", file=sys.stderr)
        return 1

    idx = {}
    for root, _, files in os.walk(modroot):
        for f in files:
            if f.endswith(".ko.zst"):
                idx[f[:-7]] = os.path.join(root, f)
            elif f.endswith(".ko"):
                idx[f[:-3]] = os.path.join(root, f)

    # Modules built into the kernel (=y) have no .ko file; they are
    # already present at boot and need no staging. modules.builtin
    # lists them by path (kernel/.../<name>.ko).
    builtin = set()
    try:
        with open(os.path.join(modroot, "modules.builtin")) as f:
            for line in f:
                base = os.path.basename(line.strip())
                if base.endswith(".ko"):
                    builtin.add(base[:-3])
    except OSError:
        pass

    order = []
    seen = set()

    def visit(name):
        if name in seen:
            return
        seen.add(name)
        # Kernel module files use underscores (virtio_blk.ko.zst) but
        # the conventional spelling uses hyphens (virtio-blk); modprobe
        # accepts both. Try the name as given, then the underscored form.
        path = idx.get(name) or idx.get(name.replace("-", "_"))
        if path is None:
            # Built-in: nothing to stage (and nothing to insmod — the
            # manifest only lists staged modules). A built-in module
            # cannot depend on a loadable one, so no dep walk is needed.
            uname = name.replace("-", "_")
            if uname in builtin:
                print(f"note: {name} is built into the kernel, not staged")
                return
            print(f"error: module {name} not found under {modroot}", file=sys.stderr)
            sys.exit(1)
        r = subprocess.run(["modinfo", "-F", "depends", path],
                           capture_output=True, text=True)
        if r.returncode != 0:
            print(f"error: modinfo failed for {name}: {r.stderr}", file=sys.stderr)
            sys.exit(1)
        for dep in [d for d in r.stdout.strip().split(",") if d]:
            visit(dep)
        order.append((name, path))

    for name in wanted:
        visit(name)

    staged = []
    for name, path in order:
        rel = os.path.relpath(path, modroot)
        if rel.endswith(".ko.zst"):
            rel = rel[:-4]  # .ko.zst -> .ko
        dest = os.path.join(stage, "lib", "modules", kver, rel)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        if path.endswith(".ko.zst"):
            r = subprocess.run(["zstd", "-d", "-f", "-q", path, "-o", dest])
            if r.returncode != 0:
                print(f"error: zstd failed for {path}", file=sys.stderr)
                return 1
        else:
            import shutil
            shutil.copy2(path, dest)
        staged.append(f"/lib/modules/{kver}/{rel}")

    manifest = os.path.join(stage, "lib", "modules", kver, "sevyn-modules.txt")
    with open(manifest, "w") as f:
        f.write("\n".join(staged) + "\n")
    print(f"staged {len(staged)} modules for {kver}:")
    for s in staged:
        print(f"  {s}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
