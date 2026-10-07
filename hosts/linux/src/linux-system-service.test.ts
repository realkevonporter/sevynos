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

  it("reports per-core CPU percentages from the second sample onward", async () => {
    await writeFile(
      procStat,
      "cpu  100 0 100 800 0 0 0 0 0 0\n" +
        "cpu0 50 0 50 400 0 0 0 0 0 0\n" +
        "cpu1 50 0 50 400 0 0 0 0 0 0\n",
    );
    const service = new LinuxSystemService({
      procStatPath: procStat,
      procMeminfoPath: procMeminfo,
      procUptimePath: procUptime,
    });

    const firstSnapshot = await service.snapshot();
    expect(firstSnapshot.cpuCorePercents).toBeUndefined();

    await writeFile(
      procStat,
      "cpu  150 0 125 825 0 0 0 0 0 0\n" +
        "cpu0 60 0 60 420 0 0 0 0 0 0\n" +
        "cpu1 90 0 65 405 0 0 0 0 0 0\n",
    );
    const secondSnapshot = await service.snapshot();
    // cpu0: 40 ticks added, 20 idle => 50%. cpu1: 60 ticks added, 5 idle => 92%.
    expect(secondSnapshot.cpuCorePercents).toEqual([50, 92]);
    service.close();
  });

  it("reports real disk usage via statfs for the configured path", async () => {
    const service = new LinuxSystemService({ diskPath: tempDir });
    const snapshot = await service.snapshot();
    expect(snapshot.disks).toHaveLength(1);
    const [disk] = snapshot.disks ?? [];
    expect(disk?.mountPoint).toBe(tempDir);
    expect(disk?.totalBytes).toBeGreaterThan(0);
    expect(disk?.freeBytes).toBeGreaterThanOrEqual(0);
    expect((disk?.usedBytes ?? 0) + (disk?.freeBytes ?? 0)).toBe(disk?.totalBytes);
    service.close();
  });

  it("omits disk usage when the path cannot be stat'ed", async () => {
    const service = new LinuxSystemService({
      diskPath: join(tempDir, "missing-volume"),
    });
    const snapshot = await service.snapshot();
    expect(snapshot.disks).toBeUndefined();
    service.close();
  });

  it("reports per-interface network throughput, excluding loopback", async () => {
    const netDev = join(tempDir, "net-dev");
    const header =
      "Inter-|   Receive                                                |  Transmit\n" +
      " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n";
    const sample = (loRx: number, ethRx: number, ethTx: number): string =>
      header +
      `    lo: ${String(loRx)}    10    0    0    0     0          0         0        2000    20    0    0    0     0       0          0\n` +
      `  eth0: ${String(ethRx)}  100   0    0    0     0          0         0        ${String(ethTx)}   50    0    0    0     0       0          0\n`;
    await writeFile(netDev, sample(1000, 100000, 50000));

    let nowMs = 1_000_000;
    const service = new LinuxSystemService({
      procNetDevPath: netDev,
      now: () => nowMs,
    });

    const first = await service.snapshot();
    expect(first.networkInterfaces?.some((i) => i.name === "lo")).toBe(false);
    const firstEth = first.networkInterfaces?.find((i) => i.name === "eth0");
    expect(firstEth?.rxBytesPerSecond).toBe(0);
    expect(firstEth?.txBytesPerSecond).toBe(0);
    expect(firstEth?.rxBytesTotal).toBe(100000);
    expect(firstEth?.txBytesTotal).toBe(50000);

    // 4000 rx bytes and 1000 tx bytes over 2 seconds.
    nowMs += 2000;
    await writeFile(netDev, sample(1500, 104000, 51000));
    const second = await service.snapshot();
    const secondEth = second.networkInterfaces?.find((i) => i.name === "eth0");
    expect(secondEth?.rxBytesPerSecond).toBe(2000);
    expect(secondEth?.txBytesPerSecond).toBe(500);
    service.close();
  });

  it("re-baselines network rates when counters reset", async () => {
    const netDev = join(tempDir, "net-dev-reset");
    const row = (rx: number, tx: number): string =>
      `  eth0: ${String(rx)}  100   0    0    0     0          0         0        ${String(tx)}   50    0    0    0     0       0          0\n`;
    await writeFile(netDev, row(100000, 50000));

    let nowMs = 2_000_000;
    const service = new LinuxSystemService({
      procNetDevPath: netDev,
      now: () => nowMs,
    });
    await service.snapshot();

    // Counter wrapped below the previous value: rate must not go negative.
    nowMs += 1000;
    await writeFile(netDev, row(1000, 500));
    const snapshot = await service.snapshot();
    const eth = snapshot.networkInterfaces?.find((i) => i.name === "eth0");
    expect(eth?.rxBytesPerSecond).toBe(0);
    expect(eth?.txBytesPerSecond).toBe(0);
    service.close();
  });
});
