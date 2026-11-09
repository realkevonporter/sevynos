#!/usr/bin/env python3
"""SevynOS v2 M6 — package Tokrah into a .sevyn bundle.

Writes tokrah.sevyn (zip: manifest.json + app.hbc) for the image build:
  - manifest id "tokrah", name "Tokrah", color "#E52B42", glyph "T",
  - version from Tokrah's package.json (or --version),
  - permissions ["cli.exec"] — Tokrah's fetch/XHR go through the
    `sevyn net fetch` CLI via the host's Sevyn.exec bridge,
  - bundleHash = sha256(app.hbc),
  - UNSIGNED: Tokrah is a third-party app. Per the M3 loader rules an
    unsigned bundle installs with a user note (self-signed); only a
    trusted signature may make it a system app, and Tokrah is not one.
    Nothing in this script signs it.

The bundle is built by the image build from a pinned Tokrah source
(TOKRAH_SRC locally, or a TOKRAH_READ_TOKEN clone in CI) and is NEVER
committed to this repo: it contains Tokrah's proprietary JS (Hermes
bytecode is decompilable) and this repo is public.

Usage:
  python3 make-tokrah-bundle.py --hbc <tokrah.hbc> --version <x.y.z>
      --out <pristine-dir> [--staged-hbc <path>]

Exit 0 on success. Prints the bundle path + hash.
"""
import argparse
import hashlib
import json
import zipfile
from pathlib import Path


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--hbc", required=True, help="compiled tokrah.hbc")
    ap.add_argument("--version", required=True,
                    help="Tokrah version (from its package.json)")
    ap.add_argument("--out", required=True,
                    help="pristine bundles dir (tokrah.sevyn lands here)")
    ap.add_argument("--staged-hbc", default=None,
                    help="also copy the raw hbc here "
                         "(/usr/share/sevyn/tokrah/tokrah.hbc — "
                         "what `sevyn tokrah run` falls back to)")
    args = ap.parse_args()

    hbc = Path(args.hbc).read_bytes()
    manifest = {
        "id": "tokrah",
        "name": "Tokrah",
        "version": args.version,
        "entry": "app.hbc",
        "color": "#E52B42",
        "glyph": "T",
        "system": False,
        "protected": False,
        "permissions": ["cli.exec"],
        "bundleHash": sha256_hex(hbc),
    }
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "tokrah.sevyn"
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("manifest.json", json.dumps(manifest, indent=2) + "\n")
        z.writestr("app.hbc", hbc)
        z.writestr("assets/icon.txt", "Tokrah\n")
    if args.staged_hbc:
        staged = Path(args.staged_hbc)
        staged.parent.mkdir(parents=True, exist_ok=True)
        staged.write_bytes(hbc)
    print(f"tokrah.sevyn: {out_path} ({len(hbc)} bytes hbc, "
          f"sha256 {manifest['bundleHash'][:16]}…)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
