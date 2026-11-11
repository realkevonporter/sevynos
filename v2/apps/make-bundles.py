#!/usr/bin/env python3
"""SevynOS v2 M3 — package the stock apps into .sevyn bundles.

Reads the stock app list from v2/shell/src/apps.ts (the single source
of truth for id/name/color/glyph — the shell's fallback list must match
it), then for each app writes <id>.sevyn (zip: manifest.json + app.hbc
+ assets/) with:
  - bundleHash = sha256(app.hbc),
  - terminal: system + protected, signed with a fresh Ed25519 keypair
    generated for this image build; the public key lands in the
    trusted-keys dir as <keyId>.pub so the loader trusts it. The
    private key is kept in the build temp dir and never shipped.
  - terminal, settings, files, browser: permission cli.exec (they run
    the `sevyn` CLI through the host's Sevyn.exec bridge) and each
    ships its OWN bundle (M4: terminal.hbc, settings.hbc, files.hbc;
    M5: browser.hbc).
  - every other stock app: unsigned, no permissions, the template hbc.

Also writes the harness fixtures to the test-bundles dir:
  - crash.sevyn: the crash bundle (unsigned; throws at startup),
  - tampered.sevyn: files' manifest with a zeroed bundleHash, so the
    loader must refuse it,
  - badsystem.sevyn: terminal's manifest shape (system:true) signed
    with a DIFFERENT fresh keypair — not the image's trusted one — so
    the loader must refuse it (a system app needs a trusted signature).

Usage:
  python3 make-bundles.py --hbc <app.hbc> --crash-hbc <crash.hbc>
      [--terminal-hbc <terminal.hbc>] [--settings-hbc <settings.hbc>]
      [--files-hbc <files.hbc>] [--browser-hbc <browser.hbc>]
      --out <bundles-dir> --trusted-keys-dir <dir>
      [--test-bundles-dir <dir>]

Exit 0 on success. Prints one line per bundle + the trusted keyId.
"""
import argparse
import base64
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
APPS_TS = REPO / "v2" / "shell" / "src" / "apps.ts"
SIGN_HELPER = REPO / "v2" / "loader" / "ed25519-sign.c"

# Per-app overrides beyond apps.ts (id -> manifest fields). Terminal
# is the protected system app (the recovery path); terminal, settings,
# files, browser, and the three M10 comms apps run the `sevyn` CLI,
# so they hold cli.exec. Files keeps status.read too: the M3 template
# still shows a live status line in its window (m3-check step 5), and
# the real M4 Files app simply never subscribes — it has no status line.
OVERRIDES = {
    "terminal": {
        "system": True,
        "protected": True,
        "sign": True,
        "permissions": ["cli.exec"],
        "singleInstance": False,
    },
    "settings": {"permissions": ["cli.exec"]},
    "files": {"permissions": ["status.read", "cli.exec"],
              "singleInstance": False},
    "browser": {"permissions": ["cli.exec"], "singleInstance": False},
    # Notes is a template app (no own hbc) — multi-instance like
    # Files/Terminal/Browser, so it gets the flag here.
    "notes": {"singleInstance": False},
    # M10: one comms.hbc serves all three (identity from Sevyn.appId).
    "messages": {"permissions": ["cli.exec"]},
    "video-calls": {"permissions": ["cli.exec"]},
    "voice-calls": {"permissions": ["cli.exec"]},
}


def parse_apps_ts():
    """Parse the APPS entries out of apps.ts.

    Entries are one logical object each (they may span lines after
    prettier); fields are id, name, color, glyph, in that order, with
    an optional trailing `singleInstance: true|false` after glyph.
    """
    text = APPS_TS.read_text()
    apps = []
    pat = re.compile(
        r'\{\s*id:\s*"([^"]+)",\s*name:\s*"([^"]+)",\s*'
        r'color:\s*"([^"]+)",\s*glyph:\s*"([^"]+)"'
        r'(?:,\s*singleInstance:\s*(true|false))?,?\s*\}')
    for m in pat.finditer(text):
        apps.append({"id": m.group(1), "name": m.group(2),
                     "color": m.group(3), "glyph": m.group(4),
                     "singleInstance": m.group(5) != "false"})
    if not apps:
        raise SystemExit(f"no apps parsed from {APPS_TS}")
    return apps


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


def build_sign_helper(tmp: Path) -> Path:
    sign_bin = tmp / "ed25519-sign"
    build = subprocess.run(
        ["gcc", "-O2", "-Wall", "-Wextra", "-o", str(sign_bin),
         str(SIGN_HELPER), "-lcrypto"],
        capture_output=True, text=True)
    if build.returncode != 0:
        print("sign helper build failed", file=sys.stderr)
        print(build.stderr, file=sys.stderr)
        raise SystemExit(1)
    return sign_bin


def gen_keypair(tmp: Path):
    priv = tmp / "trusted.pem"
    pub_der = tmp / "trusted.der"
    subprocess.run(["openssl", "genpkey", "-algorithm", "ed25519",
                    "-out", str(priv)], check=True, capture_output=True)
    subprocess.run(["openssl", "pkey", "-in", str(priv), "-pubout",
                    "-outform", "DER", "-out", str(pub_der)],
                   check=True, capture_output=True)
    pub = pub_der.read_bytes()[-32:]
    return priv, pub


def sign_bundle(sign_bin: Path, priv: Path, pub: bytes, manifest: dict) -> dict:
    key_id = sha256_hex(pub)[:16]
    signed = (f"sevyn-bundle-v1\n{manifest['id']}\n{manifest['version']}\n"
              f"{manifest['bundleHash']}\n").encode()
    sig = subprocess.run([str(sign_bin), str(priv)], input=signed,
                         capture_output=True, check=True).stdout
    assert len(sig) == 64, f"bad signature length {len(sig)}"
    return {"algorithm": "ed25519", "keyId": key_id,
            "publicKey": b64(pub), "value": b64(sig)}


def write_bundle(out_path: Path, manifest: dict, hbc: bytes):
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("manifest.json", json.dumps(manifest, indent=2) + "\n")
        z.writestr("app.hbc", hbc)
        z.writestr("assets/icon.txt", manifest["name"] + "\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--hbc", required=True, help="template app.hbc")
    ap.add_argument("--crash-hbc", required=True, help="crash app.hbc")
    ap.add_argument("--terminal-hbc", default=None,
                    help="terminal app.hbc (defaults to the template)")
    ap.add_argument("--settings-hbc", default=None,
                    help="settings app.hbc (defaults to the template)")
    ap.add_argument("--files-hbc", default=None,
                    help="files app.hbc (defaults to the template)")
    ap.add_argument("--browser-hbc", default=None,
                    help="browser app.hbc (defaults to the template)")
    ap.add_argument("--comms-hbc", default=None,
                    help="comms app.hbc (defaults to the template)")
    ap.add_argument("--out", required=True, help="stock bundles dir")
    ap.add_argument("--trusted-keys-dir", required=True)
    ap.add_argument("--test-bundles-dir", default=None)
    args = ap.parse_args()

    hbc = Path(args.hbc).read_bytes()
    crash_hbc = Path(args.crash_hbc).read_bytes()
    # M4 real apps ship their own bundles; M10's three comms apps
    # share one comms.hbc; anything without one falls back to the
    # template (the other eight stock apps).
    hbc_for = {
        "terminal": (Path(args.terminal_hbc).read_bytes()
                     if args.terminal_hbc else hbc),
        "settings": (Path(args.settings_hbc).read_bytes()
                     if args.settings_hbc else hbc),
        "files": (Path(args.files_hbc).read_bytes()
                  if args.files_hbc else hbc),
        "browser": (Path(args.browser_hbc).read_bytes()
                    if args.browser_hbc else hbc),
        "messages": (Path(args.comms_hbc).read_bytes()
                     if args.comms_hbc else hbc),
        "video-calls": (Path(args.comms_hbc).read_bytes()
                        if args.comms_hbc else hbc),
        "voice-calls": (Path(args.comms_hbc).read_bytes()
                        if args.comms_hbc else hbc),
    }
    out_dir = Path(args.out)
    trusted_dir = Path(args.trusted_keys_dir)
    test_dir = Path(args.test_bundles_dir) if args.test_bundles_dir else None
    out_dir.mkdir(parents=True, exist_ok=True)
    trusted_dir.mkdir(parents=True, exist_ok=True)
    if test_dir:
        test_dir.mkdir(parents=True, exist_ok=True)

    apps = parse_apps_ts()
    tmp = Path(tempfile.mkdtemp(prefix="sevyn-bundles-"))
    try:
        sign_bin = build_sign_helper(tmp)
        priv, pub = gen_keypair(tmp)
        key_id = sha256_hex(pub)[:16]
        (trusted_dir / (key_id + ".pub")).write_bytes(pub)
        print(f"trusted key: {key_id}")

        for app in apps:
            ov = OVERRIDES.get(app["id"], {})
            app_hbc = hbc_for.get(app["id"], hbc)
            manifest = {
                "id": app["id"],
                "name": app["name"],
                "version": "1.0.0",
                "entry": "app.hbc",
                "color": app["color"],
                "glyph": app["glyph"],
                "system": ov.get("system", False),
                "protected": ov.get("protected", False),
                "singleInstance": ov.get(
                    "singleInstance", app.get("singleInstance", True)),
                "permissions": ov.get("permissions", []),
                "bundleHash": sha256_hex(app_hbc),
            }
            if ov.get("sign"):
                manifest["signature"] = sign_bundle(
                    sign_bin, priv, pub, manifest)
            write_bundle(out_dir / f"{app['id']}.sevyn", manifest, app_hbc)
            signed = "signed" if ov.get("sign") else "unsigned"
            print(f"  {app['id']}.sevyn ({signed}, "
                  f"system={manifest['system']}, "
                  f"perms={manifest['permissions']})")

        if test_dir:
            # Crash fixture: the crash bytecode under its own manifest.
            crash_manifest = {
                "id": "crash", "name": "Crash", "version": "1.0.0",
                "entry": "app.hbc", "color": "#ef4444", "glyph": "!",
                "system": False, "protected": False, "permissions": [],
                "bundleHash": sha256_hex(crash_hbc),
            }
            write_bundle(test_dir / "crash.sevyn", crash_manifest, crash_hbc)
            print("  crash.sevyn (test fixture)")
            # Tampered fixture: files' manifest, zeroed hash.
            files = next(a for a in apps if a["id"] == "files")
            tampered = {
                "id": "files", "name": files["name"], "version": "1.0.0",
                "entry": "app.hbc", "color": files["color"],
                "glyph": files["glyph"], "system": False,
                "protected": False, "permissions": ["cli.exec"],
                "bundleHash": "0" * 64,
            }
            write_bundle(test_dir / "tampered.sevyn", tampered, hbc)
            print("  tampered.sevyn (test fixture, bad bundleHash)")
            # Bad-system fixture: system:true, signed with a key the
            # image does NOT trust. The loader must refuse it.
            bad_priv, bad_pub = gen_keypair(tmp)
            badsystem = {
                "id": "terminal", "name": "Terminal", "version": "9.9.9",
                "entry": "app.hbc", "color": "#111827", "glyph": ">",
                "system": True, "protected": True,
                "permissions": ["cli.exec"],
                "bundleHash": sha256_hex(hbc),
            }
            badsystem["signature"] = sign_bundle(
                sign_bin, bad_priv, bad_pub, badsystem)
            write_bundle(test_dir / "badsystem.sevyn", badsystem, hbc)
            print("  badsystem.sevyn (test fixture, untrusted system)")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print(f"wrote {len(apps)} stock bundles to {out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
