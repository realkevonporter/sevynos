import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LinuxBatteryService } from "./linux-battery-service.js";

describe("LinuxBatteryService", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "sevyn-battery-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("reports available: false when no battery device exists in sysfs", async () => {
    const service = new LinuxBatteryService(tempDir);
    const snapshot = await service.snapshot();
    expect(snapshot.available).toBe(false);
    expect(snapshot.percent).toBe(0);
    expect(snapshot.charging).toBe(false);
    service.close();
  });

  it("reports discharging battery state accurately from sysfs", async () => {
    const bat0 = join(tempDir, "BAT0");
    await mkdir(bat0, { recursive: true });
    await writeFile(join(bat0, "type"), "Battery\n");
    await writeFile(join(bat0, "capacity"), "77\n");
    await writeFile(join(bat0, "status"), "Discharging\n");

    const service = new LinuxBatteryService(tempDir);
    const snapshot = await service.snapshot();
    expect(snapshot.available).toBe(true);
    expect(snapshot.percent).toBe(77);
    expect(snapshot.charging).toBe(false);
    expect(snapshot.state).toBe("discharging");
    service.close();
  });

  it("reports charging battery state accurately from sysfs", async () => {
    const bat1 = join(tempDir, "BAT1");
    await mkdir(bat1, { recursive: true });
    await writeFile(join(bat1, "type"), "Battery\n");
    await writeFile(join(bat1, "capacity"), "42\n");
    await writeFile(join(bat1, "status"), "Charging\n");

    const service = new LinuxBatteryService(tempDir);
    const snapshot = await service.snapshot();
    expect(snapshot.available).toBe(true);
    expect(snapshot.percent).toBe(42);
    expect(snapshot.charging).toBe(true);
    expect(snapshot.state).toBe("charging");
    service.close();
  });
  it("detects non-BAT names by type and preserves zero percent", async () => {
    const battery = join(tempDir, "power-device");
    await mkdir(battery);
    await writeFile(join(battery, "type"), "Battery\n");
    await writeFile(join(battery, "capacity"), "0\n");
    await writeFile(join(battery, "status"), "Discharging\n");
    const service = new LinuxBatteryService(tempDir);
    expect(await service.snapshot()).toMatchObject({
      available: true,
      percent: 0,
      state: "discharging",
    });
    await writeFile(join(battery, "capacity"), "broken");
    expect(await service.snapshot()).toMatchObject({
      available: false,
      state: "unknown",
    });
    await rm(join(battery, "capacity"));
    expect((await service.snapshot()).available).toBe(false);
    service.close();
  });

  it("does not label a full battery as actively charging", async () => {
    const battery = join(tempDir, "BAT0");
    await mkdir(battery);
    await writeFile(join(battery, "type"), "Battery\n");
    await writeFile(join(battery, "capacity"), "100\n");
    await writeFile(join(battery, "status"), "Full\n");
    const service = new LinuxBatteryService(tempDir);
    expect(await service.snapshot()).toMatchObject({
      available: true,
      percent: 100,
      charging: false,
      state: "full",
    });
    service.close();
  });
});
