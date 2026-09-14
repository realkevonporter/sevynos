import { describe, expect, it, vi } from "vitest";
import { CapabilityDeniedError } from "../errors/capability-denied-error.js";
import { CapabilityPolicyManager } from "./capability-policy-manager.js";

describe("CapabilityPolicyManager", () => {
  it("auto-grants capabilities to system applications with org.sevynos prefix", () => {
    const manager = new CapabilityPolicyManager();
    const appId = "org.sevynos.notes";

    expect(manager.isSystemApplication(appId)).toBe(true);
    expect(manager.evaluate(appId, "filesystem.read")).toBe("granted");
    expect(manager.hasCapability(appId, "filesystem.read")).toBe(true);
    expect(() => {
      manager.checkCapability(appId, "filesystem.read");
    }).not.toThrow();
  });

  it("denies undeclared capabilities for third-party applications", () => {
    const manager = new CapabilityPolicyManager();
    const appId = "com.thirdparty.editor";

    manager.registerApplication({
      id: appId,
      permissions: ["filesystem.read"],
    });

    expect(manager.isSystemApplication(appId)).toBe(false);
    expect(manager.evaluate(appId, "camera")).toBe("denied");
    expect(manager.hasCapability(appId, "camera")).toBe(false);
    expect(() => {
      manager.checkCapability(appId, "camera");
    }).toThrow(CapabilityDeniedError);
  });

  it("grants standard declared manifest permissions for third-party applications", () => {
    const manager = new CapabilityPolicyManager();
    const appId = "com.thirdparty.editor";

    manager.registerApplication({
      id: appId,
      permissions: ["filesystem.read", "notifications"],
    });

    expect(manager.evaluate(appId, "notifications")).toBe("granted");
    expect(manager.hasCapability(appId, "notifications")).toBe(true);
  });

  it("marks sensitive declared permissions as 'ask'", () => {
    const manager = new CapabilityPolicyManager();
    const appId = "com.thirdparty.cameraapp";

    manager.registerApplication({
      id: appId,
      permissions: ["camera", "microphone", "filesystem.write"],
    });

    expect(manager.evaluate(appId, "camera")).toBe("ask");
    expect(manager.evaluate(appId, "filesystem.write")).toBe("ask");
  });

  it("respects explicit policy overrides (grant, deny, restrict)", () => {
    const manager = new CapabilityPolicyManager();
    const appId = "com.thirdparty.app";

    manager.grant(appId, "network");
    expect(manager.evaluate(appId, "network")).toBe("granted");

    manager.deny(appId, "network");
    expect(manager.evaluate(appId, "network")).toBe("denied");

    manager.restrict(appId, "network");
    expect(manager.evaluate(appId, "network")).toBe("restricted");

    manager.revoke(appId, "network");
    expect(manager.evaluate(appId, "network")).toBe("denied");
  });

  it("requests capability through prompt handler when in 'ask' state", async () => {
    const promptHandler = vi.fn().mockResolvedValue(true);
    const manager = new CapabilityPolicyManager({ promptHandler });
    const appId = "com.thirdparty.photos";

    manager.registerApplication({
      id: appId,
      permissions: ["camera"],
    });

    expect(manager.evaluate(appId, "camera")).toBe("ask");

    const granted = await manager.requestCapability(appId, "camera");
    expect(granted).toBe(true);
    expect(promptHandler).toHaveBeenCalledWith(appId, "camera");
    expect(manager.evaluate(appId, "camera")).toBe("granted");
  });

  it("rejects capability when prompt handler denies permission", async () => {
    const promptHandler = vi.fn().mockResolvedValue(false);
    const manager = new CapabilityPolicyManager({ promptHandler });
    const appId = "com.thirdparty.recorder";

    manager.registerApplication({
      id: appId,
      permissions: ["microphone"],
    });

    const granted = await manager.requestCapability(appId, "microphone");
    expect(granted).toBe(false);
    expect(manager.evaluate(appId, "microphone")).toBe("denied");
  });
});
