#!/usr/bin/env python3
"""Copy binaries plus their shared-library closure into a rootfs stage dir.

Usage:
  copy-closure.py <sysroot> <stage> <src:dst> [<src:dst> ...]

Each <src:dst> pair names a binary on the build host (src) and where it
belongs in the stage (dst, absolute, e.g. /usr/local/bin/sevyn-statusd).
Libraries are resolved with the sysroot's dynamic loader
(<sysroot>/lib64/ld-linux-x86-64.so.2 --list) against the sysroot's lib
dirs, then copied into the stage at their sysroot-relative paths, so the
stage ends up with the same layout the loader expects.

Symlinks are preserved (and their targets copied too). The loader itself
is copied as well. Run `ldconfig -r <stage>` afterwards to build the
ld.so.cache (see build-m1-image.sh).
"""
import os
import shutil
import subprocess
import sys


def lib_dirs(sysroot):
    dirs = [
        os.path.join(sysroot, "lib", "x86_64-linux-gnu"),
        os.path.join(sysroot, "usr", "lib", "x86_64-linux-gnu"),
        os.path.join(sysroot, "lib"),
        os.path.join(sysroot, "usr", "lib"),
        # Plugin dirs some binaries carry as absolute RUNPATHs (Weston's
        # RUNPATH is /usr/lib/x86_64-linux-gnu/weston, which does not exist
        # on the build host when the sysroot is elsewhere).
        os.path.join(sysroot, "usr", "lib", "x86_64-linux-gnu", "weston"),
        os.path.join(sysroot, "usr", "lib", "x86_64-linux-gnu", "dri"),
    ]
    return [d for d in dirs if os.path.isdir(d)]


def find_loader(sysroot):
    candidates = [
        os.path.join(sysroot, "lib64", "ld-linux-x86-64.so.2"),
        os.path.join(sysroot, "usr", "lib", "x86_64-linux-gnu", "ld-linux-x86-64.so.2"),
        os.path.join(sysroot, "usr", "lib64", "ld-linux-x86-64.so.2"),
        "/lib64/ld-linux-x86-64.so.2",
    ]
    for c in candidates:
        if os.path.exists(c):
            return c
    return None


def loader_list(sysroot, binary):
    loader = find_loader(sysroot)
    if loader is None:
        print("error: no dynamic loader found for sysroot", sysroot, file=sys.stderr)
        sys.exit(1)
    cmd = [
        loader,
        "--list",
        "--library-path",
        ":".join(lib_dirs(sysroot)),
        binary,
    ]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        print(f"loader --list failed for {binary}:\n{r.stdout}\n{r.stderr}", file=sys.stderr)
        sys.exit(1)
    libs = []
    for line in r.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        # "libfoo.so.0 => /path/to/libfoo.so.0 (0x...)" or "/path (0x...)"
        if "=>" in line:
            line = line.split("=>", 1)[1].strip()
        path = line.split(" (")[0].strip()
        if path.startswith("/"):
            libs.append(path)
    return libs


def copy_into(sysroot, stage, host_path):
    """Copy host_path (absolute, under sysroot or '/') into the stage at
    the same relative path, preserving symlinks and copying their targets."""
    rel = host_path
    if sysroot != "/" and host_path.startswith(sysroot):
        rel = host_path[len(sysroot):]
    dest = os.path.join(stage, rel.lstrip("/"))
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    if os.path.islink(host_path):
        target = os.readlink(host_path)
        if os.path.lexists(dest):
            os.unlink(dest)
        os.symlink(target, dest)
        # Also copy the real file the link points to (same dir, same name
        # the loader will resolve to).
        real = os.path.realpath(host_path)
        if real != host_path:
            copy_into(sysroot, stage, real)
    else:
        shutil.copy2(host_path, dest)


def main():
    if len(sys.argv) < 4:
        print(__doc__, file=sys.stderr)
        return 2
    sysroot = os.path.abspath(sys.argv[1])
    stage = os.path.abspath(sys.argv[2])
    pairs = []
    for arg in sys.argv[3:]:
        src, _, dst = arg.partition(":")
        if not src or not dst:
            print(f"bad pair {arg!r}, expected src:dst", file=sys.stderr)
            return 2
        pairs.append((src, dst))

    for src, dst in pairs:
        libs = loader_list(sysroot, src)
        # The binary itself goes to its stage path (not its host path).
        dest = os.path.join(stage, dst.lstrip("/"))
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        shutil.copy2(src, dest)
        os.chmod(dest, 0o755)
        for lib in libs:
            copy_into(sysroot, stage, lib)
        # The loader, explicitly (it may not appear in --list output).
        # Copy it to its sysroot-relative path AND to the canonical
        # PT_INTERP path /lib64/ld-linux-x86-64.so.2, which is what the
        # binaries' interpreter headers point at.
        loader = find_loader(sysroot)
        if loader is not None:
            copy_into(sysroot, stage, loader)
            dest = os.path.join(stage, "lib64", "ld-linux-x86-64.so.2")
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            if not os.path.lexists(dest):
                shutil.copy2(os.path.realpath(loader), dest)
                os.chmod(dest, 0o755)
    print(f"closure copied into {stage}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
