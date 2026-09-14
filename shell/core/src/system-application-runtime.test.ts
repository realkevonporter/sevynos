import { describe, expect, it, vi } from "vitest";
import { defineDeviceProfile, type DeviceDescriptor } from "./device-profile.js";
import { defineSystemApplication } from "./system-application.js";
import { SystemApplicationRuntime } from "./system-application-runtime.js";

const device: DeviceDescriptor = {
  deviceClass: "desktop",
  width: 1440,
  height: 900,
  pointer: "fine",
  keyboard: true,
  touch: false,
};
const profile = defineDeviceProfile({
  id: "desktop",
  name: "Desktop",
  priority: 1,
  match: { deviceClasses: ["desktop"] },
  applications: [
    { applicationId: "org.sevynos.dock", slot: "dock", layer: 20 },
    { applicationId: "org.sevynos.launcher", slot: "overlay", layer: 30 },
  ],
});

function application(id: string, version: string, events: string[], initialValue = 0) {
  return defineSystemApplication<number>({
    manifest: {
      id,
      name: id,
      version,
      roles: [id.split(".").at(-1) ?? "system"],
      supportedDeviceClasses: ["desktop"],
    },
    create: (_context, preservedState) => {
      const value = preservedState ?? initialValue;
      return {
        start: () => {
          events.push(`start:${id}:${version}`);
        },
        stop: (reason) => {
          events.push(`stop:${id}:${version}:${reason}`);
        },
        captureState: () => value,
        render: () => ({ id, version, value }),
      };
    },
  });
}

describe("SystemApplicationRuntime", () => {
  it("starts the applications selected by a device profile", async () => {
    const events: string[] = [];
    const runtime = new SystemApplicationRuntime();
    runtime.register(application("org.sevynos.dock", "1", events));
    runtime.register(application("org.sevynos.launcher", "1", events));
    await runtime.activate(profile, device);
    expect(runtime.listRunning().map((entry) => entry.applicationId)).toEqual([
      "org.sevynos.dock",
      "org.sevynos.launcher",
    ]);
    expect(events).toEqual(["start:org.sevynos.dock:1", "start:org.sevynos.launcher:1"]);
  });

  it("hot reloads one application and preserves sibling instances and state", async () => {
    const events: string[] = [];
    const runtime = new SystemApplicationRuntime();
    runtime.register(application("org.sevynos.dock", "1", events, 7));
    runtime.register(application("org.sevynos.launcher", "1", events));
    await runtime.activate(profile, device);
    events.length = 0;
    await runtime.hotReload(application("org.sevynos.dock", "2", events));
    expect(events).toEqual([
      "start:org.sevynos.dock:2",
      "stop:org.sevynos.dock:1:hot-reload",
    ]);
    expect(runtime.render("org.sevynos.dock", undefined)).toEqual({
      id: "org.sevynos.dock",
      version: "2",
      value: 7,
    });
  });

  it("invalidates the shell without coupling applications to one another", async () => {
    const invalidate = vi.fn();
    const runtime = new SystemApplicationRuntime();
    runtime.subscribe(invalidate);
    runtime.register(
      defineSystemApplication({
        manifest: {
          id: "org.sevynos.dock",
          name: "Dock",
          version: "1",
          roles: ["dock"],
          supportedDeviceClasses: ["desktop"],
        },
        create: (context) => ({
          start: context.invalidate,
          render: () => [],
        }),
      }),
    );
    runtime.register(application("org.sevynos.launcher", "1", []));
    await runtime.activate(profile, device);
    expect(invalidate).toHaveBeenCalled();
  });

  it("keeps the active application when a replacement cannot start", async () => {
    const runtime = new SystemApplicationRuntime();
    runtime.register(application("org.sevynos.dock", "1", [], 9));
    runtime.register(application("org.sevynos.launcher", "1", []));
    await runtime.activate(profile, device);
    const replacement = defineSystemApplication({
      manifest: {
        id: "org.sevynos.dock",
        name: "Dock",
        version: "2",
        roles: ["dock"],
        supportedDeviceClasses: ["desktop"],
      },
      create: () => ({
        start: () => {
          throw new Error("invalid replacement");
        },
        render: () => ({ version: "2" }),
      }),
    });

    await expect(runtime.hotReload(replacement)).rejects.toThrow("invalid replacement");
    expect(runtime.render("org.sevynos.dock", undefined)).toEqual({
      id: "org.sevynos.dock",
      version: "1",
      value: 9,
    });
  });
});
