#!/usr/bin/env python3
"""Host-side tests for the File Explorer port's `sevyn` CLI verbs
(v2/update/sevyn.c, the #122 port): `files copy`, `files move`,
`files delete`, `files volumes`, `files eject`, `files clipboard`.

Builds the CLI with the host gcc, then drives it against a temp
directory. The clipboard path is overridden with
SEVYN_FILES_CLIPBOARD so the tests never touch /data. No QEMU — the
CI harness (m4-check) covers the guest end to end.

Run: python3 v2/update/test-files-port.py
Exit 0 = all checks pass.
"""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
SEVYN_C = HERE / "sevyn.c"

FAILURES = []


def check(name, cond, detail=""):
    if cond:
        print(f"  ok: {name}")
    else:
        print(f"FAIL: {name} {detail}")
        FAILURES.append(name)


def run_cli(binary, args, env_extra=None):
    env = dict(os.environ)
    if env_extra:
        env.update(env_extra)
    return subprocess.run([str(binary)] + args, capture_output=True,
                          text=True, timeout=60, env=env)


def main():
    tmp = Path(tempfile.mkdtemp(prefix="sevyn-files-port-test-"))
    binary = tmp / "sevyn"
    # gcc writes its temp files under TMPDIR; point it at the test's
    # own temp dir so the build works even where /tmp is small/full
    # (the sandbox's /tmp is a 512 MB tmpfs).
    build_env = dict(os.environ)
    build_env["TMPDIR"] = str(tmp)
    build = subprocess.run(
        ["gcc", "-O2", "-Wall", "-Wextra", "-o", str(binary),
         str(SEVYN_C), "-lcrypto"],
        capture_output=True, text=True, env=build_env)
    check("sevyn.c compiles clean", build.returncode == 0, build.stderr)
    if build.returncode != 0:
        print("FAILURES:", FAILURES)
        return 1

    root = tmp / "tree"
    (root / "docs").mkdir(parents=True)
    (root / "docs" / "photo.png").write_text("PNGDATA")
    (root / "docs" / "sub").mkdir()
    (root / "docs" / "sub" / "note.txt").write_text("hello")
    (root / "top.txt").write_text("top")

    clipboard_env = {"SEVYN_FILES_CLIPBOARD": str(tmp / "clipboard.json")}

    # --- help lists the new verbs --------------------------------------
    r = run_cli(binary, ["help"])
    for verb in ("sevyn files copy", "sevyn files move", "sevyn files delete",
                 "sevyn files volumes", "sevyn files eject",
                 "sevyn files clipboard"):
        check(f"help lists {verb}", verb in r.stdout, r.stdout)

    # --- copy: file, directory (recursive), missing source ------------
    r = run_cli(binary, ["files", "copy", str(root / "top.txt"),
                         str(root / "top-copy.txt")])
    check("copy file: exit 0", r.returncode == 0, r.stderr)
    check("copy file: contents copied",
          (root / "top-copy.txt").read_text() == "top")
    r = run_cli(binary, ["files", "copy", str(root / "docs"),
                         str(root / "docs-copy")])
    check("copy directory: exit 0", r.returncode == 0, r.stderr)
    check("copy directory: nested file copied",
          (root / "docs-copy" / "sub" / "note.txt").read_text() == "hello")
    check("copy directory: file copied",
          (root / "docs-copy" / "photo.png").read_text() == "PNGDATA")
    r = run_cli(binary, ["files", "copy", str(root / "nope"),
                         str(root / "nope-copy")])
    check("copy missing source: exit 1", r.returncode == 1, r.stderr)

    # --- move: rename within one filesystem ----------------------------
    r = run_cli(binary, ["files", "move", str(root / "top-copy.txt"),
                         str(root / "moved.txt")])
    check("move file: exit 0", r.returncode == 0, r.stderr)
    check("move file: source gone", not (root / "top-copy.txt").exists())
    check("move file: destination has the contents",
          (root / "moved.txt").read_text() == "top")
    r = run_cli(binary, ["files", "move", str(root / "nope"),
                         str(root / "moved-nope")])
    check("move missing source: exit 1", r.returncode == 1, r.stderr)
    # NOTE: the EXDEV copy+delete fallback cannot be forced on one
    # host filesystem; it is the same rename() error branch the guest
    # hits when moving between / and a USB volume.

    # --- delete: file, directory (recursive), protected paths ---------
    r = run_cli(binary, ["files", "delete", str(root / "moved.txt")])
    check("delete file: exit 0", r.returncode == 0, r.stderr)
    check("delete file: gone", not (root / "moved.txt").exists())
    r = run_cli(binary, ["files", "delete", str(root / "docs-copy")])
    check("delete directory: exit 0", r.returncode == 0, r.stderr)
    check("delete directory: gone", not (root / "docs-copy").exists())
    for protected in ("/", "/data", "/data/"):
        r = run_cli(binary, ["files", "delete", protected])
        check(f"delete {protected}: refused", r.returncode == 1, r.stderr)
        check(f"delete {protected}: says refusing",
              "refusing to delete" in r.stderr, r.stderr)
    r = run_cli(binary, ["files", "delete", str(root / "nope")])
    check("delete missing path: exit 1", r.returncode == 1, r.stderr)

    # --- clipboard: empty, set, get, clear -----------------------------
    r = run_cli(binary, ["files", "clipboard"], clipboard_env)
    check("clipboard: empty at first", r.returncode == 0 and
          r.stdout.strip() == "empty", r.stdout)
    r = run_cli(binary, ["files", "clipboard", "set", "copy",
                         str(root / "docs" / "photo.png"), "photo.png",
                         "file"], clipboard_env)
    check("clipboard set copy: exit 0", r.returncode == 0, r.stderr)
    r = run_cli(binary, ["files", "clipboard"], clipboard_env)
    check("clipboard get: returns the stored JSON", r.returncode == 0, r.stdout)
    stored = json.loads(r.stdout)
    check("clipboard get: kind/source round-trip",
          stored == {"kind": "copy",
                     "sourcePath": str(root / "docs" / "photo.png"),
                     "sourceName": "photo.png",
                     "sourceKind": "file"}, r.stdout)
    r = run_cli(binary, ["files", "clipboard", "set", "cut",
                         str(root / "docs"), "docs",
                         "directory"], clipboard_env)
    check("clipboard set cut: exit 0", r.returncode == 0, r.stderr)
    stored = json.loads(
        run_cli(binary, ["files", "clipboard"], clipboard_env).stdout)
    check("clipboard set cut: kind is cut", stored["kind"] == "cut", str(stored))
    r = run_cli(binary, ["files", "clipboard", "set", "explode",
                         str(root / "docs"), "docs",
                         "directory"], clipboard_env)
    check("clipboard set bad kind: exit 1", r.returncode == 1, r.stderr)
    r = run_cli(binary, ["files", "clipboard", "set", "copy",
                         str(root / "docs"), "docs",
                         "thing"], clipboard_env)
    check("clipboard set bad source kind: exit 1", r.returncode == 1, r.stderr)
    r = run_cli(binary, ["files", "clipboard", "clear"], clipboard_env)
    check("clipboard clear: exit 0", r.returncode == 0, r.stderr)
    r = run_cli(binary, ["files", "clipboard"], clipboard_env)
    check("clipboard: empty after clear", r.stdout.strip() == "empty", r.stdout)
    r = run_cli(binary, ["files", "clipboard", "clear"], clipboard_env)
    check("clipboard clear twice: still exit 0", r.returncode == 0, r.stderr)

    # --- volumes: real mounts, tab-separated, / first ------------------
    r = run_cli(binary, ["files", "volumes"])
    check("volumes: exit 0", r.returncode == 0, r.stderr)
    lines = [line for line in r.stdout.splitlines() if line]
    check("volumes: at least one volume", len(lines) >= 1, r.stdout)
    first = lines[0].split("\t")
    check("volumes: / is first", first[0] == "/", r.stdout)
    check("volumes: / is the Internal Drive", first[1] == "Internal Drive",
          r.stdout)
    check("volumes: / is not removable", first[2] == "0", r.stdout)
    ok_shape = True
    for line in lines:
        fields = line.split("\t")
        if len(fields) != 5:
            ok_shape = False
        elif not fields[3].isdigit() or not fields[4].isdigit():
            ok_shape = False
        elif fields[2] not in ("0", "1"):
            ok_shape = False
    check("volumes: every line is mount/label/removable/size/avail",
          ok_shape, r.stdout)

    # --- eject: refuses non-removable and unknown volumes -------------
    r = run_cli(binary, ["files", "eject", "/"])
    check("eject /: refused (not removable)", r.returncode == 1, r.stderr)
    check("eject /: says not removable", "not removable" in r.stderr, r.stderr)
    r = run_cli(binary, ["files", "eject", "/media/no-such-stick"])
    check("eject unknown mount: exit 1", r.returncode == 1, r.stderr)
    check("eject unknown mount: says no such volume",
          "no such volume" in r.stderr, r.stderr)

    if FAILURES:
        print("FAILURES:", FAILURES)
        return 1
    print("test-files-port: all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
