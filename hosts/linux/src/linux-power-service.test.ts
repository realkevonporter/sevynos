/**
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LinuxPowerService } from "./linux-power-service.js";

describe("LinuxPowerService lid handling", () => {
  let root: string;
  let lidRoot: string;
  let stateDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sevyn-power-test-"));
    lidRoot = join(root, "lid");
    stateDir = join(root, "state");
    await mkdir(join(lidRoot, "LID0"), { recursive: true });
    await writeFile(join(lidRoot, "LID0", "state"), "state:      open\n");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const service = (pollMs = 25) =>
    new LinuxPowerService(lidRoot, join(root, "power_supply"), stateDir, pollMs);

  it("reads the lid state from the ACPI button interface", async () => {
    const svc = service();
    expect(await svc.getLidState()).toBe("open");
    await writeFile(join(lidRoot, "LID0", "state"), "state:      closed\n");
    expect(await svc.getLidState()).toBe("closed");
    svc.close();
  });

  it("reports unknown when no lid switch exists", async () => {
    const svc = new LinuxPowerService(
      join(root, "no-lid"),
      join(root, "ps"),
      stateDir,
      25,
    );
    expect(await svc.getLidState()).toBe("unknown");
    svc.close();
  });

  it("fires onLidClose once per open->closed transition", async () => {
    const svc = service(20);
    const onLidClose = vi.fn();
    const stop = svc.startLidWatch(onLidClose);
    await new Promise((r) => setTimeout(r, 50));
    await writeFile(join(lidRoot, "LID0", "state"), "state:      closed\n");
    await new Promise((r) => setTimeout(r, 80));
    expect(onLidClose).toHaveBeenCalledTimes(1);
    // Still closed: no repeat firing.
    await new Promise((r) => setTimeout(r, 80));
    expect(onLidClose).toHaveBeenCalledTimes(1);
    // Reopen, then close again: fires a second time.
    await writeFile(join(lidRoot, "LID0", "state"), "state:      open\n");
    await new Promise((r) => setTimeout(r, 80));
    await writeFile(join(lidRoot, "LID0", "state"), "state:      closed\n");
    await new Promise((r) => setTimeout(r, 80));
    expect(onLidClose).toHaveBeenCalledTimes(2);
    stop();
    svc.close();
  });

  it("does not fire when the lid action is 'nothing'", async () => {
    const svc = service(20);
    await svc.setLidAction("nothing");
    expect(await svc.getLidAction()).toBe("nothing");
    const onLidClose = vi.fn();
    const stop = svc.startLidWatch(onLidClose);
    await new Promise((r) => setTimeout(r, 50));
    await writeFile(join(lidRoot, "LID0", "state"), "state:      closed\n");
    await new Promise((r) => setTimeout(r, 80));
    expect(onLidClose).not.toHaveBeenCalled();
    stop();
    svc.close();
  });

  it("does not fire when the first observed state is already closed", async () => {
    await writeFile(join(lidRoot, "LID0", "state"), "state:      closed\n");
    const svc = service(20);
    const onLidClose = vi.fn();
    const stop = svc.startLidWatch(onLidClose);
    await new Promise((r) => setTimeout(r, 80));
    expect(onLidClose).not.toHaveBeenCalled();
    stop();
    svc.close();
  });

  it("persists the lid action across instances", async () => {
    const svc = service();
    expect(await svc.getLidAction()).toBe("sleep");
    await svc.setLidAction("nothing");
    const svc2 = service();
    expect(await svc2.getLidAction()).toBe("nothing");
    svc.close();
    svc2.close();
  });
});

describe("LinuxPowerService charge limits", () => {
  let root: string;
  let psRoot: string;
  let stateDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sevyn-charge-test-"));
    psRoot = join(root, "power_supply");
    stateDir = join(root, "state");
    await mkdir(join(psRoot, "BAT0"), { recursive: true });
    await writeFile(join(psRoot, "BAT0", "type"), "Battery\n");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const service = () => new LinuxPowerService(join(root, "lid"), psRoot, stateDir, 1000);

  it("reports unsupported when the hardware exposes no threshold knobs", async () => {
    const svc = service();
    expect(await svc.getChargeLimit()).toMatchObject({ supported: false });
    await expect(svc.setChargeLimit({ endPct: 80 })).rejects.toThrow(/not supported/i);
    svc.close();
  });

  it("reads and writes charge thresholds when exposed", async () => {
    await writeFile(join(psRoot, "BAT0", "charge_control_start_threshold"), "75\n");
    await writeFile(join(psRoot, "BAT0", "charge_control_end_threshold"), "80\n");
    const svc = service();
    expect(await svc.getChargeLimit()).toMatchObject({
      supported: true,
      battery: "BAT0",
      startPct: 75,
      endPct: 80,
    });
    const updated = await svc.setChargeLimit({ endPct: 90 });
    expect(updated.endPct).toBe(90);
    svc.close();
  });

  it("validates threshold ranges and ordering", async () => {
    await writeFile(join(psRoot, "BAT0", "charge_control_start_threshold"), "75\n");
    await writeFile(join(psRoot, "BAT0", "charge_control_end_threshold"), "80\n");
    const svc = service();
    await expect(svc.setChargeLimit({ endPct: 0 })).rejects.toThrow(/between 1 and 100/);
    await expect(svc.setChargeLimit({ endPct: 101 })).rejects.toThrow(
      /between 1 and 100/,
    );
    await expect(svc.setChargeLimit({ endPct: 70 })).rejects.toThrow(/must be below/);
    svc.close();
  });

  it("ignores non-battery power supplies", async () => {
    await mkdir(join(psRoot, "AC0"), { recursive: true });
    await writeFile(join(psRoot, "AC0", "type"), "Mains\n");
    await writeFile(join(psRoot, "AC0", "charge_control_end_threshold"), "80\n");
    const svc = service();
    expect(await svc.getChargeLimit()).toMatchObject({ supported: false });
    svc.close();
  });
});
