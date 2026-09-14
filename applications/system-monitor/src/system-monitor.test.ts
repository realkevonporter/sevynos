import { describe, expect, it } from "vitest";
import { systemMonitorManifest } from "./index.js";

describe("SystemMonitorApplication", () => {
  it("exports a valid SevynApplicationManifest", () => {
    expect(systemMonitorManifest.id).toBe("org.sevynos.system-monitor");
    expect(systemMonitorManifest.name).toBe("System Monitor");
    expect(systemMonitorManifest.runtime).toBe("react-native");
  });
});
