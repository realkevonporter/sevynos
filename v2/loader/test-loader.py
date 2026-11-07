#!/usr/bin/env python3
"""Host-side unit tests for sevyn-loader (v2/loader/sevyn-loader.c).

Builds the loader with the host gcc, then drives the CLI against a
scratch tree (SEVYN_APPS_DIR / SEVYN_PRISTINE_DIR /
SEVYN_TRUSTED_KEYS_DIR / SEVYN_RUN_DIR all under a temp dir). Bundles
are built with the stdlib zipfile module; Ed25519 keys come from
openssl. No QEMU, no Hermes — the CI harness (m3-check) covers the
guest end to end.

Run: python3 v2/loader/test-loader.py
Exit 0 = all checks pass.
"""
import base64
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
LOADER_C = HERE / "sevyn-loader.c"
JSON_C = HERE / "json.c"

FAILURES = []


def check(name, cond, detail=""):
    if cond:
        print(f"  ok: {name}")
    else:
        print(f"FAIL: {name} {detail}")
        FAILURES.append(name)


def run_loader(env, *args):
    p = subprocess.run(
        [str(LOADER_BIN), *args],
        env={**os.environ, **env},
        capture_output=True,
        text=True,
        timeout=30,
    )
    return p.returncode, p.stdout + p.stderr


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


def make_bundle(out_path, *, app_id="files", name="Files",
                version="1.0.0", system=False, protected=False,
                permissions=None, entry=b"FAKE-HBC", color="#3b82f6",
                glyph="F", sign_key=None, sign_key_id=None,
                tamper_hash=False, bad_signature=False,
                bundle_hash=None, extra_manifest=None):
    """Build a .sevyn zip. sign_key is a dict with 'pub' (32 bytes raw)
    and 'priv' (path to the PEM private key)."""
    if permissions is None:
        permissions = []
    if bundle_hash is None:
        bundle_hash = sha256_hex(entry)
        if tamper_hash:
            bundle_hash = "0" * 64
    manifest = {
        "id": app_id,
        "name": name,
        "version": version,
        "entry": "app.hbc",
        "color": color,
        "glyph": glyph,
        "system": system,
        "protected": protected,
        "permissions": permissions,
        "bundleHash": bundle_hash,
    }
    if sign_key is not None:
        key_id = sign_key_id or sha256_hex(sign_key["pub"])[:16]
        signed = f"sevyn-bundle-v1\n{app_id}\n{version}\n{bundle_hash}\n".encode()
        # openssl pkeyutl cannot sign Ed25519 in one shot, so use the
        # loader's own sign helper (same libcrypto calls as the verifier).
        sig = subprocess.run(
            [str(SIGN_BIN), sign_key["priv"]],
            input=signed, capture_output=True, check=True,
        ).stdout
        if bad_signature:
            sig = bytes([sig[0] ^ 0xFF]) + sig[1:]
        manifest["signature"] = {
            "algorithm": "ed25519",
            "keyId": key_id,
            "publicKey": b64(sign_key["pub"]),
            "value": b64(sig),
        }
    if extra_manifest:
        manifest.update(extra_manifest)
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("manifest.json", json.dumps(manifest))
        z.writestr("app.hbc", entry)
        z.writestr("assets/icon.txt", "icon")
    return manifest


def gen_keypair(d, name):
    priv = d / f"{name}.pem"
    pub_der = d / f"{name}.der"
    subprocess.run(
        ["openssl", "genpkey", "-algorithm", "ed25519", "-out", str(priv)],
        check=True, capture_output=True)
    subprocess.run(
        ["openssl", "pkey", "-in", str(priv), "-pubout", "-outform", "DER",
         "-out", str(pub_der)],
        check=True, capture_output=True)
    # Last 32 bytes of the DER SubjectPublicKeyInfo are the raw key.
    pub = pub_der.read_bytes()[-32:]
    return {"priv": str(priv), "pub": pub}


def main():
    global LOADER_BIN, SIGN_BIN
    tmp = Path(tempfile.mkdtemp(prefix="sevyn-loader-test-"))
    LOADER_BIN = tmp / "sevyn-loader"
    SIGN_BIN = tmp / "ed25519-sign"
    print(f"work dir: {tmp}")
    build = subprocess.run(
        ["gcc", "-O2", "-Wall", "-Wextra", "-o", str(LOADER_BIN),
         str(LOADER_C), str(JSON_C), str(HERE / "verify.c"), "-lcrypto"],
        capture_output=True, text=True)
    if build.returncode != 0:
        print("FAIL: loader build failed")
        print(build.stdout)
        print(build.stderr)
        return 1
    print("  ok: loader builds clean (-Wall -Wextra)")
    build = subprocess.run(
        ["gcc", "-O2", "-Wall", "-Wextra", "-o", str(SIGN_BIN),
         str(HERE / "ed25519-sign.c"), "-lcrypto"],
        capture_output=True, text=True)
    if build.returncode != 0:
        print("FAIL: sign helper build failed")
        print(build.stdout)
        print(build.stderr)
        return 1
    print("  ok: sign helper builds clean (-Wall -Wextra)")

    apps = tmp / "apps"
    pristine = tmp / "pristine"
    trusted = tmp / "trusted"
    run = tmp / "run"
    for d in (apps, pristine, trusted, run):
        d.mkdir()
    env = {
        "SEVYN_APPS_DIR": str(apps),
        "SEVYN_PRISTINE_DIR": str(pristine),
        "SEVYN_TRUSTED_KEYS_DIR": str(trusted),
        "SEVYN_RUN_DIR": str(run),
    }

    trusted_key = gen_keypair(tmp, "trusted")
    other_key = gen_keypair(tmp, "other")
    (trusted / (sha256_hex(trusted_key["pub"])[:16] + ".pub")).write_bytes(
        trusted_key["pub"])

    # 1. verify: a plain unsigned bundle verifies.
    b1 = tmp / "files.sevyn"
    make_bundle(b1)
    rc, out = run_loader(env, "verify", str(b1))
    check("verify unsigned bundle", rc == 0 and "LOADER verified files" in out, out)

    # 2. install: unsigned normal app installs; registry + dir appear.
    rc, out = run_loader(env, "install", str(b1))
    check("install unsigned app", rc == 0 and "LOADER installed files 1.0.0" in out, out)
    check("app dir exists", (apps / "files" / "app.hbc").exists())
    reg = json.loads((apps / "registry.json").read_text())
    check("registry has files", len(reg["apps"]) == 1 and reg["apps"][0]["id"] == "files")
    check("registry protected=false for normal app",
          reg["apps"][0]["protected"] is False)

    # 3. list shows it, with colour + glyph for the dock.
    rc, out = run_loader(env, "list")
    check("list shows files", rc == 0 and out.startswith("files|Files|1.0.0"), out)
    check("list carries color + glyph",
          "files|Files|1.0.0|#3b82f6|F|" in out, out)

    # 4. install with a tampered bundleHash is refused.
    b2 = tmp / "bad.sevyn"
    make_bundle(b2, app_id="bad", tamper_hash=True)
    rc, out = run_loader(env, "install", str(b2))
    check("tampered bundleHash refused", rc == 2 and "bundleHash mismatch" in out, out)
    check("tampered app not in registry",
          not (apps / "bad").exists())

    # 5. self-signed app installs with a note.
    b3 = tmp / "self.sevyn"
    make_bundle(b3, app_id="self", sign_key=other_key)
    rc, out = run_loader(env, "install", str(b3))
    check("self-signed installs", rc == 0 and "LOADER note: self is self-signed" in out, out)

    # 6. bad signature is refused.
    b4 = tmp / "badsig.sevyn"
    make_bundle(b4, app_id="badsig", sign_key=other_key, bad_signature=True)
    rc, out = run_loader(env, "install", str(b4))
    check("bad signature refused", rc == 2 and "signature verification failed" in out, out)

    # 7. system app without a trusted signature is refused.
    b5 = tmp / "sys.sevyn"
    make_bundle(b5, app_id="sys", system=True, sign_key=other_key)
    rc, out = run_loader(env, "install", str(b5))
    check("unsigned system app refused", rc == 3 and "no valid trusted signature" in out, out)

    # 8. system app with a trusted signature installs; protected honoured.
    b6 = tmp / "terminal.sevyn"
    make_bundle(b6, app_id="terminal", name="Terminal", system=True,
                protected=True, sign_key=trusted_key)
    rc, out = run_loader(env, "install", str(b6))
    check("trusted system app installs", rc == 0, out)
    reg = json.loads((apps / "registry.json").read_text())
    term = [a for a in reg["apps"] if a["id"] == "terminal"][0]
    check("terminal is protected in registry", term["protected"] is True)
    check("terminal signatureKeyId recorded",
          term["signatureKeyId"] == sha256_hex(trusted_key["pub"])[:16])

    # 9. replacing a system app with an untrusted bundle is refused
    # (here the new bundle claims system:false — a downgrade attempt —
    # so the replacement check, not the system-claim check, fires).
    b7 = tmp / "terminal2.sevyn"
    make_bundle(b7, app_id="terminal", name="Terminal", version="1.0.1",
                system=False, protected=True, sign_key=other_key)
    rc, out = run_loader(env, "install", str(b7))
    check("replace system app with untrusted refused",
          rc == 3 and "requires a trusted signature" in out, out)

    # 10. replacing a system app with a trusted bundle works.
    b8 = tmp / "terminal3.sevyn"
    make_bundle(b8, app_id="terminal", name="Terminal", version="1.0.1",
                system=True, protected=True, sign_key=trusted_key)
    rc, out = run_loader(env, "install", str(b8))
    check("replace system app with trusted works", rc == 0, out)
    reg = json.loads((apps / "registry.json").read_text())
    term = [a for a in reg["apps"] if a["id"] == "terminal"][0]
    check("terminal now 1.0.1", term["version"] == "1.0.1")

    # 11. protected app cannot be uninstalled.
    rc, out = run_loader(env, "uninstall", "terminal")
    check("protected uninstall refused", rc == 3 and "is protected" in out, out)

    # 12. a normal app CAN be uninstalled, then reinstall from pristine.
    shutil.copyfile(b1, pristine / "files.sevyn")
    rc, out = run_loader(env, "uninstall", "files")
    check("uninstall normal app", rc == 0 and "LOADER uninstalled files" in out, out)
    check("app dir removed", not (apps / "files").exists())
    rc, out = run_loader(env, "list")
    check("files gone from list", "files|" not in out, out)
    rc, out = run_loader(env, "reinstall", "files")
    check("reinstall from pristine", rc == 0 and "LOADER reinstalled files from pristine" in out, out)
    check("files back after reinstall", (apps / "files" / "app.hbc").exists())

    # 13. reinstall of a non-pristine app fails.
    rc, out = run_loader(env, "reinstall", "self")
    check("reinstall non-pristine fails", rc == 2 and "not in pristine" in out, out)

    # 14. running app cannot be uninstalled (live pid file).
    (run / "self.pid").write_text(str(os.getpid()))
    rc, out = run_loader(env, "uninstall", "self")
    check("running app uninstall refused", rc == 3 and "is running" in out, out)
    (run / "self.pid").unlink()

    # 15. unknown permission is refused.
    b9 = tmp / "perm.sevyn"
    make_bundle(b9, app_id="perm", permissions=["camera.record"])
    rc, out = run_loader(env, "install", str(b9))
    check("unknown permission refused", rc == 2 and "unknown permission" in out, out)

    # 16. known permission installs and is recorded.
    b10 = tmp / "perm2.sevyn"
    make_bundle(b10, app_id="perm2", permissions=["status.read"])
    rc, out = run_loader(env, "install", str(b10))
    check("status.read installs", rc == 0, out)
    reg = json.loads((apps / "registry.json").read_text())
    p2 = [a for a in reg["apps"] if a["id"] == "perm2"][0]
    check("permission recorded", p2["permissions"] == ["status.read"])

    # 17. reserved id "shell" is refused.
    b11 = tmp / "shell.sevyn"
    make_bundle(b11, app_id="shell")
    rc, out = run_loader(env, "install", str(b11))
    check("reserved id shell refused", rc == 2 and "invalid id" in out, out)

    # 18. a bundle with no app.hbc is refused.
    b12 = tmp / "nohbc.sevyn"
    with zipfile.ZipFile(b12, "w") as z:
        z.writestr("manifest.json", json.dumps({
            "id": "nohbc", "name": "NoHbc", "version": "1.0.0",
            "entry": "app.hbc", "color": "#000000", "glyph": "N",
            "bundleHash": "0" * 64}))
    rc, out = run_loader(env, "install", str(b12))
    check("missing app.hbc refused", rc == 2 and "no app.hbc" in out, out)

    # 19. uninstall of an unknown app fails cleanly.
    rc, out = run_loader(env, "uninstall", "nope")
    check("uninstall unknown fails", rc == 2 and "not installed" in out, out)

    # 20. registry survives a reload: list after a fresh process.
    rc, out = run_loader(env, "list")
    ids = {line.split("|")[0] for line in out.strip().splitlines()}
    check("registry persists", ids == {"files", "self", "terminal", "perm2"}, out)

    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILURES: {FAILURES}")
        print(f"work dir kept at {tmp}")
        return 1
    print("ALL LOADER TESTS PASS")
    shutil.rmtree(tmp, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
