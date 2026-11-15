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

After all pairs are copied, duplicate libraries are deduped: the sysroot
carries the same library in both /lib and /usr/lib, and the closure
copies both. Byte-identical duplicates are replaced with relative
symlinks to one kept copy (preferring /usr/lib), which saves ~16 MB
gzipped in the initramfs — the M12 image was over GitHub's 2 GiB
release-asset cap without it. Scoped to the stage lib dirs only;
the canonical /lib64 loader copy stays a real file, and
/usr/share/sevyn/* (Chromium's $ORIGIN libs) is untouched.
`--dedupe-only <stage>` runs just that pass over an already-assembled
stage: the image build's explicit Mesa/Weston staging copies
libraries to /usr/lib/... after the closure runs, so those duplicates
only exist once all staging is done — the build calls it right
before ldconfig.
"""
import hashlib
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
        # the loader will resolve to). Resolve the target INSIDE the
        # sysroot tree: a relative target lives next to the link, an
        # absolute target is rooted at the sysroot. os.path.realpath
        # would follow a host symlink that points outside the sysroot
        # (e.g. /usr/lib/.../weston symlinked into another tree) and
        # stage the real file at a wrong path, leaving the staged link
        # dangling — the M6 weston failure (libexec_weston.so.0).
        if os.path.isabs(target):
            real = os.path.join(sysroot, target.lstrip("/"))
        else:
            real = os.path.join(os.path.dirname(host_path), target)
        if real != host_path:
            copy_into(sysroot, stage, real)
    else:
        shutil.copy2(host_path, dest)


def dedupe_stage_libs(stage):
    """Replace byte-identical duplicate libraries in the stage lib dirs
    with relative symlinks to a single kept copy.

    Returns (freed_bytes, replaced_count). Safe to run after every
    invocation (idempotent: symlinks are skipped, and a later copy
    writing identical bytes through a symlink changes nothing).
    Byte-identical files have identical SONAMEs, so the loader treats
    the kept copy and the symlink exactly the same; ldconfig runs
    afterwards and records the deduped layout.
    """
    # Walk /usr/lib first (preferred home), then /lib; shallow paths
    # before nested ones so a canonical copy is kept and a nested
    # copy (e.g. libweston-13/libweston-13/) becomes the symlink.
    lib_roots = [
        os.path.join(stage, "usr", "lib"),
        os.path.join(stage, "lib"),
    ]
    # The canonical loader copy must stay a real file (see main()).
    protected = {os.path.join(stage, "lib64", "ld-linux-x86-64.so.2")}
    candidates = []
    for root_idx, root in enumerate(lib_roots):
        if not os.path.isdir(root):
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames.sort()
            for name in sorted(filenames):
                p = os.path.join(dirpath, name)
                if os.path.islink(p) or not os.path.isfile(p):
                    continue
                if p in protected:
                    continue
                candidates.append(
                    (root_idx, p.count(os.sep), p))
    candidates.sort()
    by_hash = {}
    freed = 0
    replaced = 0
    for _, _, p in candidates:
        st = os.stat(p)
        if st.st_size == 0:
            continue
        h = hashlib.sha256()
        with open(p, "rb") as f:
            for chunk in iter(lambda: f.read(1024 * 1024), b""):
                h.update(chunk)
        digest = h.hexdigest()
        keep = by_hash.get(digest)
        if keep is not None:
            # Same inode already (hardlinked): already one copy.
            if os.stat(keep).st_ino == st.st_ino:
                continue
            rel = os.path.relpath(keep, os.path.dirname(p))
            os.unlink(p)
            os.symlink(rel, p)
            freed += st.st_size
            replaced += 1
        else:
            by_hash[digest] = p
    return freed, replaced


def main():
    # --dedupe-only <stage>: dedupe a stage dir that was assembled by
    # other steps too (the image build's explicit Mesa/Weston staging
    # copies libraries to /usr/lib/... after the closure runs, so the
    # duplicates only exist once all staging is done — run this right
    # before ldconfig in the image build).
    if len(sys.argv) == 3 and sys.argv[1] == "--dedupe-only":
        stage = os.path.abspath(sys.argv[2])
        freed, replaced = dedupe_stage_libs(stage)
        if replaced:
            print(f"deduped {replaced} duplicate libraries, "
                  f"freed {freed / (1024 * 1024):.1f} MiB")
        else:
            print("dedupe: no duplicate libraries")
        return 0
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
        # Always install a REAL copy at the canonical path: copy_into
        # above may have left a symlink there (on a SYSROOT=/ host,
        # /lib64/ld-linux is a symlink to ../lib/.../ld-linux, and
        # nothing copies that target into the stage, so the link
        # dangles and every dynamic binary fails with "not found" —
        # the CI failure on the M1 PR). A dangling link must be
        # replaced, not kept, so test islink/exists, not lexists.
        loader = find_loader(sysroot)
        if loader is not None:
            copy_into(sysroot, stage, loader)
            dest = os.path.join(stage, "lib64", "ld-linux-x86-64.so.2")
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            if os.path.islink(dest) or not os.path.exists(dest):
                if os.path.lexists(dest):
                    os.unlink(dest)
                shutil.copy2(os.path.realpath(loader), dest)
                os.chmod(dest, 0o755)
    # Dedupe after all pairs (and the loader copy): the same library
    # lands in both /lib and /usr/lib, and a second invocation must
    # re-dedupe whatever it added. Runs before ldconfig in the image
    # build, so the cache reflects the deduped layout.
    freed, replaced = dedupe_stage_libs(stage)
    if replaced:
        print(f"deduped {replaced} duplicate libraries, "
              f"freed {freed / (1024 * 1024):.1f} MiB")
    print(f"closure copied into {stage}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
