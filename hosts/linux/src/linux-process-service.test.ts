// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LinuxProcessService } from "./linux-process-service.js";

function makeStat(name: string, state: string, rssPages: number): string {
  // pid (comm) state ppid ... fields; rss is the 24th field (index 21 after comm).
  const tail = ["S", "1", "1", "1", "0", "-1", "0", "0", "0", "0", "0", "0"];
  tail[0] = state;
  const padding = new Array<string>(21 - tail.length).fill("0");
  return `1 (${name}) ${[...tail, ...padding, String(rssPages)].join(" ")}\n`;
}

describe("LinuxProcessService", () => {
  let tempDir: string;
  let procPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "sevyn-proc-test-"));
    procPath = join(tempDir, "proc");
    await mkdir(procPath);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns an empty list when the proc directory is missing", async () => {
    const service = new LinuxProcessService({
      procPath: join(tempDir, "missing"),
    });
    const snapshot = await service.snapshot();
    expect(snapshot.processes).toEqual([]);
    service.close();
  });

  it("parses pid, name, state, and memory from /proc/<pid>/stat", async () => {
    await mkdir(join(procPath, "42"));
    await writeFile(join(procPath, "42", "stat"), makeStat("genesis", "S", 1024));
    const service = new LinuxProcessService({ procPath, pageSizeBytes: 4096 });
    const snapshot = await service.snapshot();
    expect(snapshot.processes).toHaveLength(1);
    const [entry] = snapshot.processes;
    expect(entry?.pid).toBe(42);
    expect(entry?.name).toBe("genesis");
    expect(entry?.state).toBe("S");
    expect(entry?.memoryBytes).toBe(1024 * 4096);
    service.close();
  });

  it("handles process names containing spaces and parentheses", async () => {
    await mkdir(join(procPath, "7"));
    await writeFile(join(procPath, "7", "stat"), makeStat("my (weird) app", "R", 10));
    const service = new LinuxProcessService({ procPath });
    const snapshot = await service.snapshot();
    expect(snapshot.processes[0]?.name).toBe("my (weird) app");
    expect(snapshot.processes[0]?.state).toBe("R");
    service.close();
  });

  it("sorts by memory descending and skips non-numeric or unreadable entries", async () => {
    await mkdir(join(procPath, "100"));
    await writeFile(join(procPath, "100", "stat"), makeStat("small", "S", 5));
    await mkdir(join(procPath, "200"));
    await writeFile(join(procPath, "200", "stat"), makeStat("big", "S", 500));
    await mkdir(join(procPath, "self")); // non-pid directory
    await mkdir(join(procPath, "300")); // missing stat file (exited process)
    await mkdir(join(procPath, "400"));
    await writeFile(join(procPath, "400", "stat"), "garbage without parens");
    const service = new LinuxProcessService({ procPath });
    const snapshot = await service.snapshot();
    expect(snapshot.processes.map((p) => p.pid)).toEqual([200, 100]);
    service.close();
  });

  it("notifies subscribers on refresh and stops after unsubscribe", async () => {
    const service = new LinuxProcessService({
      procPath,
      refreshIntervalMs: 20,
    });
    let calls = 0;
    const unsubscribe = service.subscribe(() => {
      calls += 1;
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(calls).toBeGreaterThan(0);
    const before = calls;
    unsubscribe();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(calls).toBe(before);
    service.close();
  });
});
