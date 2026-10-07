/**
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import { describe, expect, it, vi } from "vitest";
import {
  bluetoothClassIconName,
  classifyPairLine,
  LinuxBluetoothService,
  type BluetoothCommandResult,
  type BluetoothCtlSession,
} from "./linux-bluetooth-service.js";

const SHOW_ON = `Controller AA:BB:CC:DD:EE:FF sevyn [default]
	Name: sevyn
	Alias: sevyn
	Class: 0x00000000 (0)
	Powered: yes
	Discoverable: no
	Pairable: yes
	Discovering: no
`;
const SHOW_OFF = SHOW_ON.replace("Powered: yes", "Powered: no");
const NO_CONTROLLER = "No default controller available\n";

function runnerFor(
  handlers: Record<string, BluetoothCommandResult>,
): (args: readonly string[]) => Promise<BluetoothCommandResult> {
  return (args: readonly string[]) => {
    const key = args.join(" ");
    const exact = handlers[key];
    if (exact !== undefined) return Promise.resolve(exact);
    const prefix = Object.keys(handlers).find((k) => key.startsWith(k));
    const matched = prefix === undefined ? undefined : handlers[prefix];
    if (matched === undefined)
      return Promise.resolve({ code: 1, stdout: "", stderr: `unexpected: ${key}` });
    return Promise.resolve(matched);
  };
}

const ok = (stdout: string): BluetoothCommandResult => ({ code: 0, stdout, stderr: "" });

function showRunner(powered: boolean, available = true) {
  return runnerFor({
    show: ok(available ? (powered ? SHOW_ON : SHOW_OFF) : NO_CONTROLLER),
  });
}

function scriptedSession(lines: readonly string[]): {
  factory: (
    onLine: (line: string) => void,
    onClose: (code: number | null) => void,
  ) => BluetoothCtlSession;
  written: string[];
} {
  const written: string[] = [];
  const factory = (onLine: (line: string) => void) => {
    queueMicrotask(() => {
      for (const line of lines) onLine(line);
    });
    return {
      writeLine: (line: string) => {
        written.push(line);
      },
      close: () => undefined,
    };
  };
  return { factory, written };
}

describe("classifyPairLine", () => {
  it("detects successful pairing", () => {
    expect(classifyPairLine("[NEW] Device AA:BB:CC:DD:EE:FF")).toBeUndefined();
    expect(classifyPairLine("Pairing successful")?.status).toBe("paired");
  });

  it("extracts passkey confirmation prompts", () => {
    const outcome = classifyPairLine("Confirm passkey 482913 (yes/no)?");
    expect(outcome?.status).toBe("confirm-passkey");
    expect(outcome?.prompt).toContain("482913");
  });

  it("detects PIN requests and failures", () => {
    expect(classifyPairLine("[agent] Enter PIN code:")?.status).toBe("pin-request");
    const failed = classifyPairLine(
      "Failed to pair: org.bluez.Error.AuthenticationFailed",
    );
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toContain("AuthenticationFailed");
  });

  it("ignores informational lines", () => {
    expect(classifyPairLine("[bluetooth]# ")).toBeUndefined();
    expect(classifyPairLine("Attempting to pair with AA:BB:CC:DD:EE:FF")).toBeUndefined();
  });
});

describe("bluetoothClassIconName", () => {
  it("maps major classes to Sevyn icon names without emoji", () => {
    expect(bluetoothClassIconName(0x000100)).toBe("monitor"); // computer
    expect(bluetoothClassIconName(0x000200)).toBe("bluetooth"); // phone
    expect(bluetoothClassIconName(0x000300)).toBe("wifi"); // LAN
    expect(bluetoothClassIconName(0x00240404)).toBe("music-note"); // headphones
    expect(bluetoothClassIconName(0x000540)).toBe("keyboard"); // keyboard peripheral
    expect(bluetoothClassIconName(0x000580)).toBe("pointer"); // mouse peripheral
    expect(bluetoothClassIconName(0x000600)).toBe("image"); // imaging
    expect(bluetoothClassIconName(0x000700)).toBe("clock"); // wearable
    expect(bluetoothClassIconName(0x000900)).toBe("heart"); // health
    expect(bluetoothClassIconName(0x000000)).toBe("bluetooth"); // unknown
  });
});

describe("LinuxBluetoothService adapter state", () => {
  it("reports powered adapter state from bluetoothctl show", async () => {
    const service = new LinuxBluetoothService(showRunner(true));
    const state = await service.getState();
    expect(state).toMatchObject({
      available: true,
      powered: true,
      pairable: true,
      discovering: false,
      name: "sevyn",
      address: "AA:BB:CC:DD:EE:FF",
    });
    service.close();
  });

  it("reports unavailable when no controller exists", async () => {
    const service = new LinuxBluetoothService(showRunner(true, false));
    expect((await service.getState()).available).toBe(false);
    await expect(service.listDevices()).rejects.toThrow(/unavailable/i);
    service.close();
  });

  it("reports unavailable when bluetoothctl is missing", async () => {
    const service = new LinuxBluetoothService(() =>
      Promise.resolve({ code: null, stdout: "", stderr: "spawn ENOENT" }),
    );
    expect((await service.getState()).available).toBe(false);
    service.close();
  });

  it("toggles power via bluetoothctl", async () => {
    const run = vi.fn(
      runnerFor({
        show: ok(SHOW_ON),
        "power on": ok("Changing power on succeeded\n"),
        "power off": ok("Changing power off succeeded\n"),
      }),
    );
    const service = new LinuxBluetoothService(run);
    await service.setPowered(false);
    expect(run).toHaveBeenCalledWith(["power", "off"]);
    await service.setPowered(true);
    expect(run).toHaveBeenCalledWith(["power", "on"]);
    service.close();
  });
});

describe("LinuxBluetoothService devices", () => {
  const DEVICES = `Device AA:BB:CC:DD:EE:01 WH-1000XM4
Device AA:BB:CC:DD:EE:02 Logitech K380
`;
  const INFO_HEADPHONES = `Device AA:BB:CC:DD:EE:01 (public)
	Name: WH-1000XM4
	Alias: WH-1000XM4
	Class: 0x00240404 (2360324)
	Paired: yes
	Trusted: yes
	Connected: no
	LegacyPairing: no
	RSSI: -58
`;
  const INFO_KEYBOARD = `Device AA:BB:CC:DD:EE:02 (public)
	Name: Logitech K380
	Class: 0x000540 (1344)
	Paired: no
	Trusted: no
	Connected: no
	LegacyPairing: no
`;

  it("lists enriched devices sorted connected > paired > name", async () => {
    const service = new LinuxBluetoothService(
      runnerFor({
        show: ok(SHOW_ON),
        devices: ok(DEVICES),
        "info AA:BB:CC:DD:EE:01": ok(INFO_HEADPHONES),
        "info AA:BB:CC:DD:EE:02": ok(INFO_KEYBOARD),
      }),
    );
    const devices = await service.listDevices();
    expect(devices).toHaveLength(2);
    expect(devices[0]).toMatchObject({
      address: "AA:BB:CC:DD:EE:01",
      name: "WH-1000XM4",
      paired: true,
      trusted: true,
      connected: false,
      rssi: -58,
      icon: "music-note",
    });
    expect(devices[1]).toMatchObject({
      address: "AA:BB:CC:DD:EE:02",
      paired: false,
      icon: "keyboard",
    });
    service.close();
  });

  it("falls back to the scan name when info is unavailable", async () => {
    const service = new LinuxBluetoothService(
      runnerFor({
        show: ok(SHOW_ON),
        devices: ok("Device AA:BB:CC:DD:EE:03 Mystery\n"),
        "info AA:BB:CC:DD:EE:03": { code: 1, stdout: "", stderr: "not found" },
      }),
    );
    const devices = await service.listDevices();
    expect(devices[0]).toMatchObject({
      name: "Mystery",
      paired: false,
      icon: "bluetooth",
    });
    service.close();
  });
});

describe("LinuxBluetoothService pairing", () => {
  it("pairs Just Works devices and trusts them", async () => {
    const run = vi.fn(
      runnerFor({
        show: ok(SHOW_ON),
        "trust AA:BB:CC:DD:EE:01": ok("trust succeeded\n"),
      }),
    );
    const { factory, written } = scriptedSession(["Pairing successful"]);
    const service = new LinuxBluetoothService(run, factory);
    const outcome = await service.pair("AA:BB:CC:DD:EE:01");
    expect(outcome.status).toBe("paired");
    expect(written).toEqual([
      "agent DisplayYesNo",
      "default-agent",
      "pair AA:BB:CC:DD:EE:01",
    ]);
    expect(run).toHaveBeenCalledWith(["trust", "AA:BB:CC:DD:EE:01"]);
    service.close();
  });

  it("surfaces passkey confirmation and completes on accept", async () => {
    const run = runnerFor({ show: ok(SHOW_ON), "trust AA:BB:CC:DD:EE:01": ok("") });
    const written: string[] = [];
    const factory = (onLine: (line: string) => void) => {
      queueMicrotask(() => {
        onLine("Confirm passkey 482913 (yes/no)?");
      });
      return {
        writeLine: (line: string) => {
          written.push(line);
          if (line === "yes")
            queueMicrotask(() => {
              onLine("Pairing successful");
            });
        },
        close: () => undefined,
      };
    };
    const service = new LinuxBluetoothService(run, factory);
    const pending = await service.pair("AA:BB:CC:DD:EE:01");
    expect(pending.status).toBe("confirm-passkey");
    expect(pending.prompt).toContain("482913");
    const final = await service.respondToPairing(true);
    expect(final.status).toBe("paired");
    expect(written).toContain("yes");
    service.close();
  });

  it("reports pairing failures with the BlueZ reason", async () => {
    const { factory } = scriptedSession([
      "Failed to pair: org.bluez.Error.AuthenticationCanceled",
    ]);
    const service = new LinuxBluetoothService(showRunner(true), factory);
    const outcome = await service.pair("AA:BB:CC:DD:EE:01");
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("AuthenticationCanceled");
    service.close();
  });

  it("rejects invalid addresses and concurrent attempts", async () => {
    const service = new LinuxBluetoothService(
      showRunner(true),
      scriptedSession([]).factory,
    );
    await expect(service.pair("not-a-mac")).rejects.toThrow(/invalid bluetooth address/i);
    await expect(service.connect("zz")).rejects.toThrow(/invalid bluetooth address/i);
    service.close();
  });
});

describe("LinuxBluetoothService connect/disconnect/remove/trust", () => {
  const run = () =>
    vi.fn(
      runnerFor({
        show: ok(SHOW_ON),
        "connect AA:BB:CC:DD:EE:01": ok("Connection successful\n"),
        "disconnect AA:BB:CC:DD:EE:01": ok("Successful disconnected\n"),
        "remove AA:BB:CC:DD:EE:01": ok("Device has been removed\n"),
        "trust AA:BB:CC:DD:EE:01": ok("trust succeeded\n"),
        "untrust AA:BB:CC:DD:EE:01": ok("untrust succeeded\n"),
      }),
    );

  it("connects, disconnects, forgets, and (un)trusts", async () => {
    const runner = run();
    const service = new LinuxBluetoothService(runner);
    await service.connect("AA:BB:CC:DD:EE:01");
    await service.disconnect("AA:BB:CC:DD:EE:01");
    await service.remove("AA:BB:CC:DD:EE:01");
    await service.setTrusted("AA:BB:CC:DD:EE:01", true);
    await service.setTrusted("AA:BB:CC:DD:EE:01", false);
    expect(runner).toHaveBeenCalledWith(["connect", "AA:BB:CC:DD:EE:01"]);
    expect(runner).toHaveBeenCalledWith(["remove", "AA:BB:CC:DD:EE:01"]);
    service.close();
  });

  it("throws a clear error when connect fails", async () => {
    const service = new LinuxBluetoothService(
      runnerFor({
        show: ok(SHOW_ON),
        "connect AA:BB:CC:DD:EE:01": {
          code: 1,
          stdout: "",
          stderr: "Failed to connect: Device unreachable",
        },
      }),
    );
    await expect(service.connect("AA:BB:CC:DD:EE:01")).rejects.toThrow(/unreachable/);
    service.close();
  });
});
