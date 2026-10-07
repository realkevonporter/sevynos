/**
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LinuxDisplayService, parseEdidRefreshRates } from "./linux-display-service.js";

/** Build a minimal 128-byte EDID with one 1920x1080@60 detailed timing. */
function makeEdid(): Buffer {
  const edid = Buffer.alloc(128, 0);
  edid[0] = 0x00;
  edid.write("FFFFFFFFFF", 1, "hex");
  edid[7] = 0x00;
  edid[21] = 53; // 530 mm wide
  edid[22] = 30; // 300 mm tall
  const base = 54;
  edid.writeUInt16LE(14850, base); // 148.5 MHz pixel clock (10 kHz units)
  edid[base + 2] = 0x80; // hActive low = 1920 & 0xff
  edid[base + 3] = 0x18; // hBlank low = 280 & 0xff
  edid[base + 4] = 0x71; // hActive high nibble 0x7, hBlank high nibble 0x1
  edid[base + 5] = 0x38; // vActive low = 1080 & 0xff
  edid[base + 6] = 0x2d; // vBlank low = 45
  edid[base + 7] = 0x40; // vActive high nibble 0x4
  // Standard timing + descriptor padding already zeroed.
  let sum = 0;
  for (let i = 0; i < 127; i++) sum += edid[i] ?? 0;
  edid[127] = (256 - (sum % 256)) % 256;
  return edid;
}

const WESTON_INI = `[core]
backend=drm-backend.so
renderer=gl

[shell]
locking=false
`;

describe("parseEdidRefreshRates", () => {
  it("derives refresh rates from detailed timings", () => {
    const rates = parseEdidRefreshRates(makeEdid());
    expect(rates.get("1920x1080")).toBeCloseTo(60, 1);
  });

  it("returns empty for missing or malformed EDID", () => {
    expect(parseEdidRefreshRates(Buffer.alloc(0)).size).toBe(0);
    expect(parseEdidRefreshRates(Buffer.alloc(128, 0xff)).size).toBe(0);
  });
});

describe("LinuxDisplayService", () => {
  let root: string;
  let drm: string;
  let iniPath: string;
  let stateDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sevyn-display-test-"));
    drm = join(root, "drm");
    stateDir = join(root, "state");
    iniPath = join(root, "weston.ini");
    const conn = join(drm, "card0-Virtual-1");
    await mkdir(conn, { recursive: true });
    await writeFile(join(conn, "status"), "connected\n");
    await writeFile(join(conn, "modes"), "1920x1080\n1280x720\n1024x768\n");
    await writeFile(join(conn, "edid"), makeEdid());
    await writeFile(iniPath, WESTON_INI);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const service = () => new LinuxDisplayService(drm, iniPath, stateDir);

  it("enumerates real outputs and modes from DRM sysfs", async () => {
    const outputs = await service().getOutputs();
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toMatchObject({ id: "card0-Virtual-1", connected: true });
    expect(outputs[0]?.modes).toHaveLength(3);
    const fhd = outputs[0]?.modes.find((m) => m.width === 1920);
    expect(fhd?.refreshHz).toBeCloseTo(60, 1);
    expect(outputs[0]?.physicalMm).toMatchObject({ width: 530, height: 300 });
  });

  it("omits refresh rates when no EDID is present", async () => {
    await rm(join(drm, "card0-Virtual-1", "edid"));
    const outputs = await service().getOutputs();
    expect(outputs[0]?.modes[0]?.refreshHz).toBeUndefined();
    expect(outputs[0]?.physicalMm).toBeUndefined();
  });

  it("marks disconnected outputs", async () => {
    await writeFile(join(drm, "card0-Virtual-1", "status"), "disconnected\n");
    const outputs = await service().getOutputs();
    expect(outputs[0]?.connected).toBe(false);
  });

  it("pins a real mode in weston.ini and persists the choice", async () => {
    const change = await service().setMode("card0-Virtual-1", {
      width: 1280,
      height: 720,
    });
    expect(change.restartRequired).toBe(true);
    const ini = await import("node:fs/promises").then((fs) =>
      fs.readFile(iniPath, "utf8"),
    );
    expect(ini).toContain("[core]");
    expect(ini).toContain("backend=drm-backend.so");
    expect(ini).toContain("[output]");
    expect(ini).toContain("name=card0-Virtual-1");
    expect(ini).toContain("mode=1280x720");
    const outputs = await service().getOutputs();
    expect(outputs[0]?.configuredMode).toMatchObject({ width: 1280, height: 720 });
  });

  it("rejects modes the connector does not offer", async () => {
    await expect(
      service().setMode("card0-Virtual-1", { width: 9999, height: 9999 }),
    ).rejects.toThrow(/not offered/);
    await expect(
      service().setMode("card9-Nope-1", { width: 1280, height: 720 }),
    ).rejects.toThrow(/unknown display output/i);
  });

  it("rejects mode changes on disconnected outputs", async () => {
    await writeFile(join(drm, "card0-Virtual-1", "status"), "disconnected\n");
    await expect(
      service().setMode("card0-Virtual-1", { width: 1280, height: 720 }),
    ).rejects.toThrow(/not connected/);
  });

  it("sets rotation via weston transform", async () => {
    const change = await service().setRotation("card0-Virtual-1", 90);
    expect(change.restartRequired).toBe(true);
    expect(change.rotation).toBe(90);
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(iniPath, "utf8")).toContain("transform=90");
    expect(await service().getRotation("card0-Virtual-1")).toBe(90);
  });

  it("reports night light as unavailable with a reason", () => {
    const nightLight = service().getNightLight();
    expect(nightLight.available).toBe(false);
    expect(nightLight.reason).toMatch(/weston/i);
  });
});
