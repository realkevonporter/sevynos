// SevynOS v2 M10 — CLI smoke test for `sevyn comms` (sevyn.c).
//
// The in-guest m10-check trusts the CLI's exit code as the verb's
// success signal (termCmd waits for `EXEC ... -> 0`). This proves
// that contract on the host, before QEMU: a successful verb exits 0
// and prints its JSON; a failed verb (bad login, failed RCS probe,
// unreachable daemon) exits 1. The daemon answers bare JSON, not
// the "OK "/"ERR " lines the other daemons speak — print_reply
// prints it verbatim, and comms_roundtrip maps {"ok":false,...}
// to exit 1.
//
// Run: node v2/comms/test-cli.mjs   (needs gcc for sevyn.c)
// Exit 0 = full pass.
import { spawn, execFile } from "node:child_process";
import { mkdtempSync, rmSync, openSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const TMP = mkdtempSync(join(tmpdir(), "m10-cli-"));
const SOCK = join(TMP, "comms.sock");
const BIN = join(TMP, "sevyn");
const ACS_PORT = 5060;

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

function run(cmd, args, env = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { env: { ...process.env, ...env } }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, out: stdout, err: stderr });
    });
  });
}

function spawnQuiet(cmd, args, env = {}) {
  const p = spawn(cmd, args, { stdio: "ignore", env: { ...process.env, ...env } });
  return p;
}

// Wait for a TCP port to accept connections (a fixed sleep is a
// flake: under load Node takes longer than 1 s to bind — the
// 2026-11-10 failure mode where the mock ACS was still starting
// when the probe ran and the probe got ECONNREFUSED).
async function waitForPort(port, timeoutMs = 15000) {
  const net = await import("node:net");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await new Promise((resolve, reject) => {
        const s = net.createConnection(port, "127.0.0.1");
        s.on("connect", () => {
          s.end();
          resolve();
        });
        s.on("error", reject);
      });
      return true;
    } catch {
      await sleep(200);
    }
  }
  return false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForSocket(path, timeoutMs = 10000) {
  const { createConnection } = await import("node:net");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await new Promise((resolve, reject) => {
        const s = createConnection(path);
        s.on("connect", () => {
          s.end();
          resolve();
        });
        s.on("error", reject);
      });
      return true;
    } catch {
      await sleep(200);
    }
  }
  return false;
}

async function main() {
  // Compile sevyn.c (the same flags the image build uses).
  await new Promise((resolve, reject) => {
    execFile(
      "gcc",
      ["-O2", "-Wall", "-Wextra", "-o", BIN, join(ROOT, "update", "sevyn.c")],
      (err, _out, stderr) => (err ? reject(new Error(stderr || String(err))) : resolve()),
    );
  });
  check("sevyn.c compiles clean (gcc -O2 -Wall -Wextra)", true);

  const env = { SEVYN_COMMS_SOCK: SOCK };
  // Daemon up, no mocks yet: status works, the RCS probe must fail
  // (no ACS listening) and exit 1 — not silently succeed.
  // The daemon's stderr goes to a file: if it never listens, the
  // failure is diagnosable instead of a silent timeout (the
  // 2026-11-10 failure mode — stdio "ignore" hid the cause).
  const daemonErr = openSync(join(TMP, "commsd.err"), "w");
  const daemon = spawn(
    "node",
    [
      join(HERE, "commsd.mjs"),
      "--socket",
      SOCK,
      "--data",
      join(TMP, "data"),
      "--bridge",
      "null",
    ],
    { stdio: ["ignore", "ignore", daemonErr] },
  );
  if (!(await waitForSocket(SOCK))) {
    let errTail = "";
    try {
      errTail = readFileSync(join(TMP, "commsd.err"), "utf8").slice(-500);
    } catch {}
    check("commsd listens on its socket", false, errTail.trim());
    daemon.kill();
    rmSync(TMP, { recursive: true, force: true });
    process.exit(1);
  }
  check("commsd listens on its socket", true);

  let r = await run(BIN, ["comms", "status"], env);
  check(
    "status exits 0 with JSON",
    r.code === 0 && r.out.includes('"loggedIn":false'),
    `code=${r.code} out=${r.out.trim().slice(0, 80)}`,
  );

  r = await run(BIN, ["comms", "rcs", "probe"], env);
  check(
    "rcs probe vs dead ACS exits 1",
    r.code === 1 && r.out.includes('"ok":false'),
    `code=${r.code} out=${r.out.trim().slice(0, 80)}`,
  );

  // Mock ACS up: the probe must now pass and exit 0. Wait for both
  // ports, not a fixed sleep — under load the mock takes longer
  // than 1 s to bind, and a too-early probe fails ECONNREFUSED.
  const acs = spawnQuiet("node", [join(HERE, "harness", "mock-acs.js")]);
  const acsUp = (await waitForPort(ACS_PORT)) && (await waitForPort(5061));
  check("mock ACS listens on 5060 + 5061", acsUp);
  r = await run(BIN, ["comms", "rcs", "probe"], env);
  check(
    "rcs probe vs mock ACS exits 0",
    r.code === 0 && r.out.includes('"ok":true'),
    `code=${r.code} out=${r.out.trim().slice(0, 120)}`,
  );

  // Bad login (no mock homeserver on 7071): the daemon answers
  // {ok:false}, so the CLI must exit 1.
  r = await run(
    BIN,
    ["comms", "login", "@nobody:test.local", "wrongpass", "http://127.0.0.1:7071"],
    env,
  );
  check(
    "bad login exits 1",
    r.code === 1,
    `code=${r.code} out=${r.out.trim().slice(0, 80)}`,
  );

  // Unreachable daemon (bad socket): exit 1.
  r = await run(BIN, ["comms", "--socket", "/nonexistent.sock", "status"], {});
  check("unreachable daemon exits 1", r.code === 1, `code=${r.code}`);

  // --socket with no path: usage, exit 1 (nonzero).
  r = await run(BIN, ["comms", "--socket"], {});
  check("--socket with no path is a usage error", r.code !== 0, `code=${r.code}`);

  daemon.kill();
  acs.kill();
  await sleep(500);
  try {
    execFile("fuser", ["-k", `${ACS_PORT}/tcp`], () => {});
  } catch {}
  rmSync(TMP, { recursive: true, force: true });
  console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("test-cli crashed:", e);
  process.exit(1);
});
