#!/usr/bin/env python3
"""Build the M8 harness fixtures from a built image.

Usage:
  make-update-fixtures.py --build-dir <v2/image/build>
                          --out-dir <fixtures dir>
                          [--version-v1 <v>] [--version-v2 <v>]
                          [--version-bad <v>]

Produces (in --out-dir):
  vmlinuz-v2, initramfs-v2.cpio.gz
      The built image repacked with os-version = --version-v2
      (the "next nightly" the updater installs).
  vmlinuz-bad, initramfs-bad.cpio.gz
      The built image repacked with a corrupt shell bundle (the host
      cannot mount it, so the shell never reaches READY — init runs,
      the updater records the boot attempt, and the bootloader must
      fall back to the good slot) and os-version = --version-bad.
      It verifies fine (it is signed): the fallback is about boot
      health, not signature rejection.
  updates-v2.json, updates-bad.json, updates-badsig.json,
  updates-badhash.json
      UNSIGNED manifest templates for the four feed cases. Artifact
      URLs carry a __PORT__ placeholder: the harness substitutes its
      HTTP server port and signs each manifest with sign-feed.mjs
      before serving (the signature covers the artifact URLs, so the
      manifests can only be signed once the port is known).
      - updates-v2.json: the v2 image, correctly signed by the harness.
      - updates-bad.json: the bad image, correctly signed by the
        harness (proves the fallback is about boot health, not
        signature rejection).
      - updates-badsig.json: the v2 image with a corrupted signature
        (the harness signs, then flips one base64 character).
      - updates-badhash.json: a NEWER version (m8-test-3) with a wrong
        initramfs sha256, correctly signed over the wrong hash (the
        signature verifies; the download hash check refuses it).

The harness copies one manifest at a time to updates.json (the URL
the daemon fetches) per phase.
"""
import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


def run(cmd, cwd=None, **kw):
    r = subprocess.run(cmd, capture_output=True, text=True, cwd=cwd, **kw)
    if r.returncode != 0:
        print(f"command failed: {' '.join(map(str, cmd))}", file=sys.stderr)
        print(r.stdout, file=sys.stderr)
        print(r.stderr, file=sys.stderr)
        raise SystemExit(1)
    return r


def sha256_file(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()


def unpack(initramfs, dest):
    dest.mkdir(parents=True, exist_ok=True)
    with open(initramfs, "rb") as f:
        gz = subprocess.Popen(["gzip", "-dc"], stdin=f,
                              stdout=subprocess.PIPE)
        run(["cpio", "-id", "--quiet"], cwd=dest,
            stdin=gz.stdout)
        gz.wait()
        if gz.returncode != 0:
            print("gzip -dc failed", file=sys.stderr)
            raise SystemExit(1)


def repack(src_dir, out_path):
    """Repack a directory as a gzip'd newc cpio archive.

    The file list goes through a temp file, not a pipe: cpio reads names
    from a regular file, so stdin reaches EOF cleanly and there is no
    pipe deadlock between the writer and the compressor. (cpio with no
    stdin redirect inherits the caller's stdin and blocks forever.)
    """
    names = run(["find", ".", "-printf", "%P\n"], cwd=src_dir).stdout.splitlines()
    names = [n for n in names if n]
    names_path = Path(tempfile.mktemp(prefix="sevyn-cpio-names-"))
    err_path = Path(tempfile.mktemp(prefix="sevyn-cpio-err-"))
    names_path.write_text("\n".join(names) + "\n")
    try:
        with open(out_path, "wb") as out, open(names_path, "rb") as names_f, \
                open(err_path, "wb") as err_f:
            cpio = subprocess.Popen(
                ["cpio", "-o", "-H", "newc", "--quiet"],
                cwd=src_dir, stdin=names_f, stdout=subprocess.PIPE,
                stderr=err_f)
            gz = subprocess.Popen(["gzip", "-9"], stdin=cpio.stdout,
                                  stdout=out)
            # Parent must not read cpio's stdout (gzip owns it) — wait()
            # only; stderr went to a file so it can never block cpio.
            cpio.stdout.close()
            cpio.wait()
            gz.wait()
            if cpio.returncode != 0 or gz.returncode != 0:
                print(f"repack failed: {err_path.read_text()!r}",
                      file=sys.stderr)
                raise SystemExit(1)
    finally:
        names_path.unlink(missing_ok=True)
        err_path.unlink(missing_ok=True)


BAD_INIT = None  # (unused: the bad fixture breaks the shell, not init)


def corrupt_shell_hbc(shell_hbc_path):
    """A broken nightly usually breaks the shell/app layer, not init:
    init runs, the updater records the boot attempt, but the shell
    never becomes READY. Corrupt the shell bytecode so the host
    cannot mount it."""
    shell_hbc_path.write_bytes(b"NOT A HERMES BYTECODE FILE\n" * 64)


def manifest(version, channel, artifacts):
    return {
        "version": version,
        "channel": channel,
        "publishedAt": "2026-11-07T05:00:00.000Z",
        "releaseNotes": f"SevynOS nightly {version}.",
        "artifacts": artifacts,
    }


def artifact(kind, name, path):
    return {
        "kind": kind,
        "url": f"http://10.0.2.2:__PORT__/{name}",
        "sha256": sha256_file(path),
        "sizeBytes": Path(path).stat().st_size,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--build-dir", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--version-v1", default="m8-test-1")
    ap.add_argument("--version-v2", default="m8-test-2")
    ap.add_argument("--version-bad", default="m8-test-bad")
    ap.add_argument("--version-v3", default="m8-test-3")
    args = ap.parse_args()

    build = Path(args.build_dir)
    out = Path(args.out_dir)
    kernel = build / "vmlinuz"
    initramfs = build / "initramfs.cpio.gz"
    for p in (kernel, initramfs):
        if not p.is_file():
            print(f"missing: {p}", file=sys.stderr)
            return 1
    out.mkdir(parents=True, exist_ok=True)

    # Unpack work lives next to the output, not in /tmp: a real image
    # unpacks to ~150 MB per copy and /tmp is a small tmpfs on some hosts.
    tmp = Path(tempfile.mkdtemp(prefix="sevyn-update-fixtures-",
                                dir=str(out)))
    try:
        # v2: same image, new version stamp.
        v2_dir = tmp / "v2"
        unpack(initramfs, v2_dir)
        version_path = v2_dir / "usr" / "share" / "sevyn" / "os-version"
        version_path.parent.mkdir(parents=True, exist_ok=True)
        version_path.write_text(args.version_v2 + "\n")
        init_v2 = out / "initramfs-v2.cpio.gz"
        repack(v2_dir, init_v2)
        kern_v2 = out / "vmlinuz-v2"
        shutil.copy2(kernel, kern_v2)

        # bad: corrupt shell bundle + bad version stamp. init runs
        # (the updater records the boot attempt), the host cannot
        # mount the shell, READY never arrives, init powers off.
        bad_dir = tmp / "bad"
        unpack(initramfs, bad_dir)
        bad_hbc = bad_dir / "usr" / "share" / "sevyn" / "shell" / "shell.hbc"
        if not bad_hbc.is_file():
            print(f"bad fixture needs a shell bundle: {bad_hbc} missing "
                  f"(is this an M8 image?)", file=sys.stderr)
            return 1
        corrupt_shell_hbc(bad_hbc)
        version_path = bad_dir / "usr" / "share" / "sevyn" / "os-version"
        version_path.parent.mkdir(parents=True, exist_ok=True)
        version_path.write_text(args.version_bad + "\n")
        init_bad = out / "initramfs-bad.cpio.gz"
        repack(bad_dir, init_bad)
        kern_bad = out / "vmlinuz-bad"
        shutil.copy2(kernel, kern_bad)

        arts_v2 = [artifact("vmlinuz", "vmlinuz-v2", kern_v2),
                   artifact("initramfs", "initramfs-v2.cpio.gz", init_v2)]
        arts_bad = [artifact("vmlinuz", "vmlinuz-bad", kern_bad),
                    artifact("initramfs", "initramfs-bad.cpio.gz",
                             init_bad)]
        arts_badhash = [dict(arts_v2[0]),
                        dict(arts_v2[1], sha256="0" * 64)]

        (out / "updates-v2.json").write_text(
            json.dumps(manifest(args.version_v2, "nightly", arts_v2),
                       indent=2) + "\n")
        (out / "updates-bad.json").write_text(
            json.dumps(manifest(args.version_bad, "nightly", arts_bad),
                       indent=2) + "\n")
        # badsig: same body as v2; the harness signs then corrupts.
        (out / "updates-badsig.json").write_text(
            json.dumps(manifest(args.version_v2, "nightly", arts_v2),
                       indent=2) + "\n")
        (out / "updates-badhash.json").write_text(
            json.dumps(manifest(args.version_v3, "nightly", arts_badhash),
                       indent=2) + "\n")
        print(f"fixtures ready in {out}:")
        for name in ("vmlinuz-v2", "initramfs-v2.cpio.gz",
                     "vmlinuz-bad", "initramfs-bad.cpio.gz",
                     "updates-v2.json", "updates-bad.json",
                     "updates-badsig.json", "updates-badhash.json"):
            p = out / name
            print(f"  {name} ({p.stat().st_size} bytes)")
        return 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
