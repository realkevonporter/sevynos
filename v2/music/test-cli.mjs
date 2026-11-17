// SevynOS Music — CLI smoke test for `sevyn music` (v2/update/sevyn.c).
//
// The in-guest music check trusts the CLI's exit code as the verb's
// success signal. This proves that contract on the host, before
// QEMU: a successful verb exits 0 and prints its JSON; a failed verb
// (missing file, bad seek, unreachable daemon) exits 1. The daemon
// answers bare JSON — print_reply prints it verbatim, and the
// roundtrip maps {"ok":false,...} to exit 1.
//
// Run: node test-cli.mjs   (needs gcc for sevyn.c)
// Exit 0 = full pass.
import { spawn, execFile } from "node:child_process";
import fs from "node:fs/promises";
import { existsSync, openSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const TMP = "/tmp/sevyn-music-cli-test";
const SOCK = path.join(TMP, "music.sock");
const BIN = path.join(TMP, "sevyn");

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

async function waitForSocket(sockPath, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(sockPath)) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await fs.rm(TMP, { recursive: true, force: true });
  await fs.mkdir(TMP, { recursive: true });
  const wav = path.join(TMP, "tone.wav");
  // Reuse the fixture writer from test-musicd via a minimal inline
  // copy: 1 s of silence is enough — the CLI test only needs a file
  // the daemon accepts (duration comes from the header).
  const sampleRate = 44100;
  const data = Buffer.alloc(sampleRate * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  await fs.writeFile(wav, Buffer.concat([header, data]));

  const build = await new Promise((resolve) => {
    execFile(
      "gcc",
      ["-O2", "-Wall", "-Wextra", "-o", BIN, path.join(ROOT, "update", "sevyn.c")],
      { env: { ...process.env, TMPDIR: TMP } },
      (err, _out, stderr) => resolve({ code: err ? 1 : 0, err: stderr }),
    );
  });
  check("sevyn.c compiles clean (gcc -O2 -Wall -Wextra)", build.code === 0, build.err);

  const env = { SEVYN_MUSIC_SOCK: SOCK };
  const daemonErr = openSync(path.join(TMP, "musicd.err"), "w");
  const daemon = spawn(
    "node",
    [
      path.join(HERE, "musicd.mjs"),
      "--socket",
      SOCK,
      "--data",
      path.join(TMP, "data"),
      "--bridge",
      "null",
    ],
    { stdio: ["ignore", "ignore", daemonErr] },
  );
  if (!(await waitForSocket(SOCK))) {
    let errTail = "";
    try {
      errTail = readFileSync(path.join(TMP, "musicd.err"), "utf8").slice(-500);
    } catch {}
    check("musicd listens on its socket", false, errTail.trim());
    daemon.kill();
    process.exit(1);
  }
  check("musicd listens on its socket", true);

  let r = await run(BIN, ["music", "status"], env);
  check(
    "status exits 0 with idle JSON",
    r.code === 0 && r.out.includes('"state":"idle"'),
    `code=${r.code} out=${r.out.trim().slice(0, 80)}`,
  );

  r = await run(BIN, ["music", "play", "/no/such/file.wav"], env);
  check(
    "play missing file exits 1 with ok:false",
    r.code === 1 && r.out.includes('"ok":false'),
    `code=${r.code} out=${r.out.trim().slice(0, 80)}`,
  );

  r = await run(BIN, ["music", "play", wav], env);
  check(
    "play wav exits 0, playing",
    r.code === 0 && r.out.includes('"state":"playing"'),
    `code=${r.code} out=${r.out.trim().slice(0, 100)}`,
  );

  r = await run(BIN, ["music", "seek", "abc"], env);
  check("seek abc exits 1", r.code === 1, `code=${r.code}`);

  r = await run(BIN, ["music", "seek", "99"], env);
  check(
    "seek past end exits 0 (clamped)",
    r.code === 0 && r.out.includes('"ok":true'),
    `code=${r.code} out=${r.out.trim().slice(0, 80)}`,
  );

  r = await run(BIN, ["music", "volume", "150"], env);
  check(
    "volume 150 exits 0, clamped to 100",
    r.code === 0 && r.out.includes('"volume":100'),
    `code=${r.code} out=${r.out.trim().slice(0, 80)}`,
  );

  r = await run(BIN, ["music", "volume", "abc"], env);
  check("volume abc exits 1", r.code === 1, `code=${r.code}`);

  r = await run(BIN, ["music", "pause"], env);
  check(
    "pause exits 0, paused",
    r.code === 0 && r.out.includes('"state":"paused"'),
    `code=${r.code} out=${r.out.trim().slice(0, 80)}`,
  );

  r = await run(BIN, ["music", "resume"], env);
  check(
    "resume exits 0, playing",
    r.code === 0 && r.out.includes('"state":"playing"'),
    `code=${r.code} out=${r.out.trim().slice(0, 80)}`,
  );

  r = await run(BIN, ["music", "stop"], env);
  check(
    "stop exits 0, stopped",
    r.code === 0 && r.out.includes('"state":"stopped"'),
    `code=${r.code} out=${r.out.trim().slice(0, 80)}`,
  );

  r = await run(BIN, ["music", "--socket", "/nonexistent.sock", "status"], {});
  check("unreachable daemon exits 1", r.code === 1, `code=${r.code}`);

  r = await run(BIN, ["music", "--socket"], {});
  check("--socket with no path is a usage error", r.code !== 0, `code=${r.code}`);

  r = await run(BIN, ["music", "bogus"], env);
  check("unknown verb is a usage error", r.code !== 0, `code=${r.code}`);

  daemon.kill();
  await sleep(500);
  await fs.rm(TMP, { recursive: true, force: true });
  console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("test-cli crashed:", e);
  process.exit(1);
});
