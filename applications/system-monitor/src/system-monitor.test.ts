// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import {
  describeProcessState,
  filterProcesses,
  formatBytes,
  formatThroughput,
  formatUptime,
  percentWidth,
  systemMonitorManifest,
} from "./index.js";

describe("SystemMonitorApplication", () => {
  it("exports a valid SevynApplicationManifest", () => {
    expect(systemMonitorManifest.id).toBe("org.sevynos.system-monitor");
    expect(systemMonitorManifest.name).toBe("System Monitor");
    expect(systemMonitorManifest.runtime).toBe("react-native");
    expect(systemMonitorManifest.icon).toBe("icons/system-monitor.svg");
    expect(systemMonitorManifest.permissions).toContain("hardware:query");
    expect(systemMonitorManifest.permissions).toContain("process:inspect");
  });
});

describe("formatBytes", () => {
  it("formats byte counts with the right unit", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(8 * 1024 ** 3)).toBe("8.0 GB");
    expect(formatBytes(1536 * 1024 ** 2)).toBe("1.5 GB");
  });

  it("handles non-finite input without throwing", () => {
    expect(formatBytes(Number.NaN)).toBe("0 B");
    expect(formatBytes(-100)).toBe("0 B");
  });
});

describe("formatUptime", () => {
  it("formats seconds into a human uptime string", () => {
    expect(formatUptime(45)).toBe("45s");
    expect(formatUptime(90)).toBe("1m 30s");
    expect(formatUptime(3661)).toBe("1h 1m 1s");
    expect(formatUptime(90061)).toBe("1d 1h 1m 1s");
  });

  it("handles invalid input without throwing", () => {
    expect(formatUptime(Number.NaN)).toBe("0s");
    expect(formatUptime(-5)).toBe("0s");
  });
});

describe("formatThroughput", () => {
  it("formats per-second byte rates", () => {
    expect(formatThroughput(0)).toBe("0 B/s");
    expect(formatThroughput(512)).toBe("512 B/s");
    expect(formatThroughput(2048)).toBe("2.0 KB/s");
    expect(formatThroughput(Number.NaN)).toBe("0 B/s");
  });
});

describe("percentWidth", () => {
  it("builds a clamped percent dimension string", () => {
    expect(percentWidth(42)).toBe("42%");
    expect(percentWidth(42.7)).toBe("43%");
    expect(percentWidth(-5)).toBe("0%");
    expect(percentWidth(150)).toBe("100%");
  });
});

describe("describeProcessState", () => {
  it("maps single-letter /proc states to labels", () => {
    expect(describeProcessState("R")).toBe("Running");
    expect(describeProcessState("S")).toBe("Sleeping");
    expect(describeProcessState("D")).toBe("Disk wait");
    expect(describeProcessState("Z")).toBe("Zombie");
    expect(describeProcessState("T")).toBe("Stopped");
    expect(describeProcessState("I")).toBe("Idle");
  });

  it("passes unknown states through unchanged", () => {
    expect(describeProcessState("Q")).toBe("Q");
    expect(describeProcessState("")).toBe("Unknown");
  });
});

describe("filterProcesses", () => {
  const processes = [
    { pid: 1, name: "genesis", state: "S", memoryBytes: 100 },
    { pid: 42, name: "browser", state: "R", memoryBytes: 200 },
    { pid: 7, name: "browser-helper", state: "S", memoryBytes: 50 },
  ];

  it("returns everything for an empty query", () => {
    expect(filterProcesses(processes, "")).toHaveLength(3);
    expect(filterProcesses(processes, "   ")).toHaveLength(3);
  });

  it("matches by name case-insensitively", () => {
    const result = filterProcesses(processes, "BROWSER");
    expect(result.map((p) => p.pid)).toEqual([42, 7]);
  });

  it("matches by pid substring", () => {
    expect(filterProcesses(processes, "42").map((p) => p.pid)).toEqual([42]);
  });

  it("returns an empty list when nothing matches", () => {
    expect(filterProcesses(processes, "nope")).toEqual([]);
  });
});
