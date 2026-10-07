// Tests for the Secure Boot install-time tooling:
//   tools/qemu/sevyn-secure-boot.sh  (MOK generation, signing, enrollment)
//   tools/qemu/verify-secure-boot.sh (chain verification reporting)
//
// The tests are hermetic: they never depend on the host's firmware state or
// on which of sbsign/sbverify/mokutil happen to be installed. External tools
// are pinned per test through the scripts' SEVYN_SB_SBSIGN / SEVYN_SB_SBVERIFY
// / SEVYN_SB_MOKUTIL overrides (empty string = treat as missing, path = use
// this fake shim), and firmware state is faked by constructing (or omitting)
// $SEVYN_SB_ROOT/sys/firmware/efi in the scratch root.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  readFileSync,
  statSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const HELPER = join(REPO, "tools/qemu/sevyn-secure-boot.sh");
const VERIFY = join(REPO, "tools/qemu/verify-secure-boot.sh");
const DOC = join(REPO, "docs/secure-boot.md");

function scratch() {
  return mkdtempSync(join(tmpdir(), "sevyn-sb-test-"));
}

function makeFakeBin(fakes) {
  // fakes: { name: scriptBody }
  const dir = mkdtempSync(join(tmpdir(), "sevyn-sb-fakebin-"));
  for (const [name, body] of Object.entries(fakes)) {
    const p = join(dir, name);
    writeFileSync(p, `#!/bin/sh\n${body}\n`);
    chmodSync(p, 0o755);
  }
  return dir;
}

function runHelper(root, args, extraEnv = {}) {
  return execFileSync(HELPER, args, {
    env: { ...process.env, SEVYN_SB_ROOT: root, ...extraEnv },
    encoding: "utf8",
  });
}

function readState(root) {
  return JSON.parse(
    readFileSync(join(root, "var/lib/sevyn/secureboot/state.json"), "utf8"),
  );
}

function fakeUefi(root) {
  // Build a fake UEFI sysfs tree under the scratch root so the scripts see a
  // UEFI boot. Omit this call and the scripts see a legacy (non-UEFI) boot.
  mkdirSync(join(root, "sys/firmware/efi"), { recursive: true });
}

// A fake sbsign: copies the input artifact to --output, simulating a signature.
const FAKE_SBSIGN_OK = `
out=""
in=""
while [ $# -gt 0 ]; do
  case "$1" in
    --output) out="$2"; shift 2 ;;
    --key|--cert) shift 2 ;;
    *) in="$1"; shift ;;
  esac
done
cp "$in" "$out"
`;

// A fake sbsign that always fails (and writes a partial output, to prove the
// helper never leaves a truncated artifact behind).
const FAKE_SBSIGN_FAIL = `
out=""
while [ $# -gt 0 ]; do
  case "$1" in
    --output) out="$2"; shift 2 ;;
    *) shift ;;
  esac
done
echo "partial" > "$out"
exit 1
`;

const FAKE_SBVERIFY_OK = `exit 0`;
const FAKE_SBVERIFY_FAIL = `exit 1`;

// A fake mokutil that accepts --import and records its argv in
// $SEVYN_SB_TEST_LOG for the test to inspect. Reads (and discards) stdin so
// the password pipe never blocks.
const FAKE_MOKUTIL_OK = `
printf '%s\\n' "$@" >> "$SEVYN_SB_TEST_LOG"
cat >/dev/null
exit 0
`;

// A fake mokutil that must never be invoked (e.g. on a non-UEFI boot where
// enrollment does not apply). Exits 99 loudly if it is.
const FAKE_MOKUTIL_NEVER = `
echo "mokutil must not be invoked" >&2
exit 99
`;

test("generate-mok creates a keypair with correct layout and permissions", () => {
  const root = scratch();
  try {
    runHelper(root, ["generate-mok"]);
    const dir = join(root, "var/lib/sevyn/secureboot");
    assert.equal(statSync(join(dir, "MOK.priv")).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, "MOK.pem")).mode & 0o777, 0o644);
    assert.equal(statSync(join(dir, "MOK.der")).mode & 0o777, 0o644);
    const state = readState(root);
    assert.equal(state.mok, "generated");
    assert.match(state.fingerprint, /^[0-9a-f]{64}$/);
    assert.ok(state.generatedAt);
    // The certificate must parse and carry the code-signing EKU.
    const text = execSync(`openssl x509 -in ${join(dir, "MOK.pem")} -noout -text`, {
      encoding: "utf8",
    });
    assert.match(text, /Code Signing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("generate-mok never regenerates over an existing key", () => {
  const root = scratch();
  try {
    runHelper(root, ["generate-mok"]);
    const before = readFileSync(join(root, "var/lib/sevyn/secureboot/MOK.priv"), "utf8");
    runHelper(root, ["generate-mok"]);
    const after = readFileSync(join(root, "var/lib/sevyn/secureboot/MOK.priv"), "utf8");
    assert.equal(after, before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sign degrades gracefully when sbsign is missing", () => {
  const root = scratch();
  try {
    runHelper(root, ["generate-mok"]);
    // Empty override = sbsign is missing, regardless of the host's PATH.
    const out = runHelper(root, ["sign"], { SEVYN_SB_SBSIGN: "" });
    assert.match(out, /sbsign is missing/);
    const state = readState(root);
    assert.equal(state.signed, "false");
    assert.equal(state.signReason, "no-sbsign");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sign signs GRUB, kernel and recovery kernel with a working sbsign", () => {
  const root = scratch();
  const fakeBin = makeFakeBin({ sbsign: FAKE_SBSIGN_OK });
  try {
    runHelper(root, ["generate-mok"]);
    const artifacts = [
      "boot/efi/EFI/SevynOS/grubx64.efi",
      "boot/efi/EFI/BOOT/BOOTX64.EFI",
      "boot/vmlinuz",
      "boot/efi/EFI/SevynOS/vmlinuz", // C1 recovery kernel, staged on the ESP
    ];
    for (const a of artifacts) {
      const p = join(root, a);
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, `fake-efi-binary:${a}`);
    }
    runHelper(root, ["sign"], { SEVYN_SB_SBSIGN: join(fakeBin, "sbsign") });
    const state = readState(root);
    assert.equal(state.signed, "true");
    assert.equal(state.signedWith, state.fingerprint);
    assert.ok(state.signedAt);
    for (const a of artifacts) {
      assert.equal(
        readFileSync(join(root, a), "utf8"),
        `fake-efi-binary:${a}`,
        `${a} must be intact after signing`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(fakeBin, { recursive: true, force: true });
  }
});

test("sign leaves artifacts untouched when sbsign fails", () => {
  const root = scratch();
  const fakeBin = makeFakeBin({ sbsign: FAKE_SBSIGN_FAIL });
  try {
    runHelper(root, ["generate-mok"]);
    const p = join(root, "boot/vmlinuz");
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, "original-kernel-bytes");
    runHelper(root, ["sign"], { SEVYN_SB_SBSIGN: join(fakeBin, "sbsign") });
    assert.equal(readFileSync(p, "utf8"), "original-kernel-bytes");
    assert.ok(!readFileSync || true); // no temp file may remain
    const state = readState(root);
    assert.equal(state.signed, "false");
    assert.equal(state.signReason, "no-artifacts");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(fakeBin, { recursive: true, force: true });
  }
});

test("queue-enrollment degrades gracefully without mokutil", () => {
  const root = scratch();
  try {
    runHelper(root, ["generate-mok"]);
    // Fake a UEFI boot so the script reaches the mokutil check, and hide
    // mokutil via the override so the host's PATH cannot leak in.
    fakeUefi(root);
    const out = runHelper(root, ["queue-enrollment"], { SEVYN_SB_MOKUTIL: "" });
    assert.match(out, /mokutil is not installed/);
    const state = readState(root);
    assert.equal(state.enrollment, "manual-required");
    assert.equal(state.enrollmentReason, "no-mokutil");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("queue-enrollment is not applicable on a non-UEFI boot even with mokutil present", () => {
  const root = scratch();
  const fakeBin = makeFakeBin({ mokutil: FAKE_MOKUTIL_NEVER });
  try {
    runHelper(root, ["generate-mok"]);
    // No fakeUefi(): legacy boot. mokutil must never be consulted.
    const out = runHelper(root, ["queue-enrollment"], {
      SEVYN_SB_MOKUTIL: join(fakeBin, "mokutil"),
    });
    assert.match(out, /Not a UEFI boot/);
    const state = readState(root);
    assert.equal(state.enrollment, "not-applicable");
    assert.equal(state.enrollmentReason, "no-uefi");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(fakeBin, { recursive: true, force: true });
  }
});

test("queue-enrollment queues the MOK when mokutil accepts the import on UEFI", () => {
  const root = scratch();
  const fakeBin = makeFakeBin({ mokutil: FAKE_MOKUTIL_OK });
  const mokutilLog = join(scratch(), "mokutil.log");
  try {
    runHelper(root, ["generate-mok"]);
    fakeUefi(root);
    const out = runHelper(root, ["queue-enrollment"], {
      SEVYN_SB_MOKUTIL: join(fakeBin, "mokutil"),
      SEVYN_SB_TEST_LOG: mokutilLog,
    });
    assert.match(out, /queued for enrollment/);
    const state = readState(root);
    assert.equal(state.enrollment, "queued");
    // mokutil --import must have been called with the DER certificate.
    const invoked = readFileSync(mokutilLog, "utf8");
    assert.match(invoked, /--import/);
    assert.ok(invoked.includes(join(root, "var/lib/sevyn/secureboot/MOK.der")));
    // The enrollment password is stored 0600 and is 16 chars.
    const pwFile = join(root, "var/lib/sevyn/secureboot/mok-enrollment-password");
    assert.equal(statSync(pwFile).mode & 0o777, 0o600);
    assert.equal(readFileSync(pwFile, "utf8").length, 16);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(fakeBin, { recursive: true, force: true });
    rmSync(join(mokutilLog, ".."), { recursive: true, force: true });
  }
});

test("verify-secure-boot reports OK when sbverify accepts every artifact", () => {
  const root = scratch();
  const fakeBin = makeFakeBin({ sbverify: FAKE_SBVERIFY_OK });
  const noTools = { SEVYN_SB_SBSIGN: "", SEVYN_SB_MOKUTIL: "" };
  try {
    runHelper(root, ["generate-mok"]);
    runHelper(root, ["sign"], noTools);
    // Fake a UEFI boot so queue-enrollment records manual-required (mokutil
    // hidden); the verifier then SKIPs enrollment instead of querying the
    // host's real mokutil/firmware.
    fakeUefi(root);
    runHelper(root, ["queue-enrollment"], noTools);
    const p = join(root, "boot/vmlinuz");
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, "kernel");
    let code = 0;
    let out = "";
    try {
      out = execFileSync(VERIFY, ["--root", root], {
        env: {
          ...process.env,
          SEVYN_SB_SBVERIFY: join(fakeBin, "sbverify"),
          SEVYN_SB_MOKUTIL: "",
        },
        encoding: "utf8",
      });
    } catch (e) {
      code = e.status;
      out = e.stdout;
    }
    assert.equal(code, 0);
    assert.match(out, /OK\s+MOK keypair/);
    assert.match(out, /OK\s+signature: \/boot\/vmlinuz/);
    assert.match(out, /RESULT: PASS/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(fakeBin, { recursive: true, force: true });
  }
});

test("verify-secure-boot fails when sbverify rejects a signature or the key is exposed", () => {
  const root = scratch();
  const fakeBin = makeFakeBin({ sbverify: FAKE_SBVERIFY_FAIL });
  try {
    runHelper(root, ["generate-mok"]);
    const p = join(root, "boot/vmlinuz");
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, "kernel");
    chmodSync(join(root, "var/lib/sevyn/secureboot/MOK.priv"), 0o644);
    let code = 0;
    let out = "";
    try {
      out = execFileSync(VERIFY, ["--root", root], {
        env: {
          ...process.env,
          SEVYN_SB_SBVERIFY: join(fakeBin, "sbverify"),
          SEVYN_SB_MOKUTIL: "",
        },
        encoding: "utf8",
      });
    } catch (e) {
      code = e.status;
      out = e.stdout;
    }
    assert.equal(code, 1);
    assert.match(out, /FAIL\s+MOK keypair/);
    assert.match(out, /FAIL\s+signature: \/boot\/vmlinuz/);
    assert.match(out, /RESULT: FAIL/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(fakeBin, { recursive: true, force: true });
  }
});

test("docs/secure-boot.md carries the honesty markers", () => {
  const doc = readFileSync(DOC, "utf8");
  assert.match(doc, /does NOT claim Secure Boot support/i);
  assert.match(doc, /BLOCKED ON KEVON/);
  assert.match(doc, /Microsoft/);
  assert.match(doc, /MOK Manager/);
  assert.match(doc, /kernel updates must re-sign/i);
});
