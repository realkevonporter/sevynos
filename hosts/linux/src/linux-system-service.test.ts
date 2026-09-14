import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LinuxSystemService } from "./linux-system-service.js";

describe("LinuxSystemService", () => {
  let tempDir: string;
  let procStat: string;
  let procMeminfo: string;
  let procUptime: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "sevyn-system-test-"));
    procStat = join(tempDir, "stat");
    procMeminfo = join(tempDir, "meminfo");
    procUptime = join(tempDir, "uptime");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("provides safe fallback defaults when proc files are missing", async () => {
    const service = new LinuxSystemService({
      procStatPath: join(tempDir, "missing-stat"),
      procMeminfoPath: join(tempDir, "missing-meminfo"),
      procUptimePath: join(tempDir, "missing-uptime"),
    });
    const snapshot = await service.snapshot();
    expect(snapshot.cpuCores).toBeGreaterThan(0);
    expect(snapshot.memoryTotalBytes).toBe(0);
    expect(snapshot.uptimeSeconds).toBe(0);
    service.close();
  });

  it("parses meminfo, uptime, and calculates CPU load percentage", async () => {
    // Initial CPU tick: total = 1000, idle = 800
    await writeFile(procStat, "cpu  100 0 100 800 0 0 0 0 0 0\n");
    await writeFile(
      procMeminfo,
      "MemTotal:       16384000 kB\nMemFree:         4000000 kB\nMemAvailable:    8192000 kB\n",
    );
    await writeFile(procUptime, "3600.50 7200.00\n");

    const service = new LinuxSystemService({
      procStatPath: procStat,
      procMeminfoPath: procMeminfo,
      procUptimePath: procUptime,
    });

    // First sample establishes baseline
    const firstSnapshot = await service.snapshot();
    expect(firstSnapshot.memoryTotalBytes).toBe(16384000 * 1024);
    expect(firstSnapshot.memoryAvailableBytes).toBe(8192000 * 1024);
    expect(firstSnapshot.memoryUsedBytes).toBe((16384000 - 8192000) * 1024);
    expect(firstSnapshot.uptimeSeconds).toBe(3601);

    // Second sample: 100 total ticks added, 25 of them idle => 75% load
    await writeFile(procStat, "cpu  150 0 125 825 0 0 0 0 0 0\n");
    const secondSnapshot = await service.snapshot();
    expect(secondSnapshot.cpuPercent).toBe(75);
    service.close();
  });
});
