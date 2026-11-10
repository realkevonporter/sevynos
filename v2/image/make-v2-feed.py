#!/usr/bin/env python3
"""Generate the nightly v2 update feed (updates-v2.json).

Usage:
  make-v2-feed.py --build-dir <v2/image/build> --out <updates-v2.json>
                  [--key-file <signing-key.json>]
                  [--anchor <v2/update/trusted-update-keys.json>]
                  [--channel nightly]

Writes the feed for the built v2 image: version from the build's
os-version file, artifacts vmlinuz + initramfs.cpio.gz with sha256 +
size, URLs pointing at the nightly release assets. The feed uses the
same protocol as the old tree's updates.json (tools/update-signing/):
the signature covers the canonical body, and the updater verifies it
against the trust anchor baked into the image.

Signing (only when --key-file is given — the SEVYN_NIGHTLY_UPDATE_SIGNING_KEY
secret, the private-key JSON from generate-key.mjs):
  - the key's keyId must be in the committed anchor (--anchor) when
    one exists; a mismatch fails loudly (a feed signed with a key no
    image trusts is worse than an unsigned feed).
  - when no anchor is committed yet, the feed ships UNSIGNED with a
    loud warning and the updater refuses it (fail-closed) — the same
    behaviour as the old tree's build.mjs. Provision the anchor first
    (see v2/README.md), then the next nightly signs.
"""
import argparse
import hashlib
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
SIGN_FEED = ROOT / "tools" / "update-signing" / "sign-feed.mjs"
RELEASE_BASE = ("https://github.com/realkevonporter/sevynos/releases"
                "/download/nightly")


def sha256_file(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--build-dir", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--key-file", default=None)
    ap.add_argument("--anchor", default=None)
    ap.add_argument("--channel", default="nightly")
    args = ap.parse_args()

    build = Path(args.build_dir)
    version_file = build / "os-version"
    kernel = build / "vmlinuz"
    initramfs = build / "initramfs.cpio.gz"
    for p in (version_file, kernel, initramfs):
        if not p.is_file():
            print(f"missing: {p}", file=sys.stderr)
            return 1
    version = version_file.read_text().strip()
    if not version:
        print("empty os-version", file=sys.stderr)
        return 1

    feed = {
        "version": version,
        "channel": args.channel,
        "publishedAt": datetime.now(timezone.utc).strftime(
            "%Y-%m-%dT%H:%M:%S.000Z"),
        "releaseNotes": f"SevynOS nightly {version}.",
        "artifacts": [
            {"kind": "vmlinuz",
             "url": f"{RELEASE_BASE}/vmlinuz",
             "sha256": sha256_file(kernel),
             "sizeBytes": kernel.stat().st_size},
            {"kind": "initramfs",
             "url": f"{RELEASE_BASE}/initramfs.cpio.gz",
             "sha256": sha256_file(initramfs),
             "sizeBytes": initramfs.stat().st_size},
        ],
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(feed, indent=2) + "\n")
    print(f"feed written: {out} (version {version}, "
          f"channel {args.channel})")

    key_file = args.key_file
    if not key_file:
        print("WARNING: no signing key — updates-v2.json is UNSIGNED "
              "and devices will refuse it (fail-closed). Set "
              "SEVYN_NIGHTLY_UPDATE_SIGNING_KEY to sign.", file=sys.stderr)
        return 0
    key = json.loads(Path(key_file).read_text())
    key_id = key.get("keyId")
    if not key_id:
        print("signing key has no keyId", file=sys.stderr)
        return 1
    if args.anchor and Path(args.anchor).is_file():
        anchor = json.loads(Path(args.anchor).read_text())
        trusted = {e.get("keyId") for e in anchor.get("keys", [])}
        if key_id not in trusted:
            print(f"ERROR: signing keyId {key_id!r} is not in the "
                  f"committed trust anchor {args.anchor} (trusted: "
                  f"{sorted(trusted)}). Refusing to sign a feed no "
                  f"image trusts.", file=sys.stderr)
            return 1
    else:
        print(f"WARNING: no committed trust anchor ({args.anchor}) — "
              f"the signed feed would be refused by every image. "
              f"Shipping UNSIGNED instead; provision the anchor first "
              f"(see v2/README.md).", file=sys.stderr)
        return 0
    r = subprocess.run(["node", str(SIGN_FEED), "--feed", str(out),
                        "--key-file", str(key_file)],
                       capture_output=True, text=True)
    if r.returncode != 0:
        print(f"sign-feed failed: {r.stderr}", file=sys.stderr)
        return 1
    print(f"feed signed with key {key_id!r}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
