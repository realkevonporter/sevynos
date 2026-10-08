// Tests for tools/qemu/weston-liveness.sh.
//
// The library is exercised hermetically: real Unix sockets are created in a
// temp dir (live listener vs. stale file with no listener), and PIDs are a
// live `sleep` child vs. a reaped one. The shell functions are invoked via
// `sh -c` sourcing the library; assertions are on exit codes only.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const LIB = new URL("./weston-liveness.sh", import.meta.url).pathname;

async function shBody(script) {
  const { stdout } = await execFileAsync("sh", ["-c", `. "${LIB}"\n${script}`]);
  return stdout.trim();
}

async function exitCode(script) {
  // Runs the snippet, prints the exit code of the last function call.
  const out = await shBody(`${script}\necho "rc=$?"`);
  const m = out.match(/rc=(\d+)/);
  assert.ok(m, `expected rc marker, got: ${out}`);
  return Number(m[1]);
}

test("weston_is_alive: live process + accepting socket => 0", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wl-"));
  try {
    const sock = join(dir, "wayland-0");
    const server = net.createServer();
    await new Promise((resolve) => server.listen(sock, resolve));
    try {
      const rc = await exitCode(`weston_is_alive $$ "${sock}"`);
      assert.equal(rc, 0);
    } finally {
      server.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("weston_is_alive: dead pid => 1", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wl-"));
  try {
    const sock = join(dir, "wayland-0");
    const server = net.createServer();
    await new Promise((resolve) => server.listen(sock, resolve));
    // A pid that cannot exist (also covers the kill -0 failure path).
    const deadPid = 2147483647;
    try {
      const rc = await exitCode(`weston_is_alive ${deadPid} "${sock}"`);
      assert.equal(rc, 1);
    } finally {
      server.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("weston_is_alive: stale socket file with no listener => 1 (ECONNREFUSED)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wl-"));
  try {
    const sock = join(dir, "wayland-0");
    // Bind then close without unlinking: leaves a stale socket file behind,
    // exactly like a crashed Weston.
    const server = net.createServer();
    await new Promise((resolve) => server.listen(sock, resolve));
    await new Promise((resolve) => server.close(resolve));
    const rc = await exitCode(`weston_is_alive $$ "${sock}"`);
    assert.equal(rc, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("weston_is_alive: missing socket => 1", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wl-"));
  try {
    const rc = await exitCode(`weston_is_alive $$ "${join(dir, "nope")}"`);
    assert.equal(rc, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("wait_for_weston_liveness: succeeds once the socket becomes live", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wl-"));
  try {
    const sock = join(dir, "wayland-0");
    // Listener appears 0.4s in; the poller must pick it up.
    const server = net.createServer();
    setTimeout(() => server.listen(sock), 400).unref();
    try {
      const rc = await exitCode(`wait_for_weston_liveness $$ "${sock}" 50`);
      assert.equal(rc, 0);
    } finally {
      server.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("wait_for_weston_liveness: times out when nothing ever listens", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wl-"));
  try {
    const rc = await exitCode(`wait_for_weston_liveness $$ "${join(dir, "void")}" 5`);
    assert.equal(rc, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("wait_for_weston_liveness: returns fast when the process is dead", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wl-"));
  try {
    const start = Date.now();
    const rc = await exitCode(
      `wait_for_weston_liveness 2147483647 "${join(dir, "void")}" 100`,
    );
    const elapsed = Date.now() - start;
    assert.equal(rc, 1);
    // Must not burn the full 10s timeout on a dead process.
    assert.ok(elapsed < 5000, `took ${elapsed}ms`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
