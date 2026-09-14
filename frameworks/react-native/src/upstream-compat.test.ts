import { describe, expect, it, vi } from "vitest";
import {
  DeviceEventEmitter,
  InteractionManager,
  Settings,
  TurboModuleRegistry,
  processColor,
  LayoutAnimation,
  ActionSheetIOS,
  PushNotificationIOS,
  Systrace,
  LogBox,
} from "./upstream-compat.js";

describe("upstream React Native compatibility surface", () => {
  it("dispatches device events and schedules interaction work", async () => {
    const listener = vi.fn();
    const subscription = DeviceEventEmitter.addListener("change", listener);
    DeviceEventEmitter.emit("change", { value: 1 });
    subscription.remove();
    expect(listener).toHaveBeenCalledWith({ value: 1 });
    await expect(InteractionManager.runAfterInteractions(() => 7)).resolves.toBe(7);
  });

  it("exposes settings and registered TurboModules", () => {
    Settings.set({ theme: "dark" });
    expect(Settings.get("theme")).toBe("dark");
    expect(TurboModuleRegistry.get("DeviceInfo")).toBeDefined();
    expect(() => TurboModuleRegistry.getEnforcing("MissingModule")).toThrow();
  });

  it("registers host TurboModules with enforcing lookup and safe invalidation", () => {
    const module = { getConstants: () => ({ platform: "sevynos" }) };
    const remove = TurboModuleRegistry.register("SevynTestModule", module);
    expect(TurboModuleRegistry.get("SevynTestModule")).toBe(module);
    expect(TurboModuleRegistry.getEnforcing("SevynTestModule")).toBe(module);
    remove();
    expect(TurboModuleRegistry.get("SevynTestModule")).toBeNull();
    expect(() => TurboModuleRegistry.getEnforcing("SevynTestModule")).toThrow();
  });

  it("exports functional processColor normalizer", () => {
    expect(processColor("#FFFFFF")).toBe(0xffffffff);
    expect(processColor("red")).toBe(0xffff0000);
    expect(processColor("rgba(0, 0, 0, 0.5)")).toBe(0x80000000);
  });

  it("exports functional LayoutAnimation with configureNext and Presets", () => {
    expect(LayoutAnimation.Presets.easeInEaseOut).toBeDefined();
    expect(typeof LayoutAnimation.configureNext).toBe("function");
    const onEnd = vi.fn();
    LayoutAnimation.configureNext(LayoutAnimation.Presets.spring, onEnd);
  });

  it("exports functional ActionSheetIOS", () => {
    expect(typeof ActionSheetIOS.showActionSheetWithOptions).toBe("function");
    const callback = vi.fn();
    ActionSheetIOS.showActionSheetWithOptions(
      {
        options: ["One", "Cancel"],
        cancelButtonIndex: 1,
      },
      callback,
    );
    expect(ActionSheetIOS.getActiveActionSheet()).toBeDefined();
    ActionSheetIOS.dismissActionSheet();
    expect(callback).toHaveBeenCalledWith(1);
  });

  it("exports PushNotificationIOS granting permissions by default", async () => {
    const permissions = await PushNotificationIOS.requestPermissions();
    expect(permissions["alert"]).toBe(true);
    expect(permissions["badge"]).toBe(true);
    expect(permissions["sound"]).toBe(true);

    const cb = vi.fn();
    PushNotificationIOS.checkPermissions(cb);
    expect(cb).toHaveBeenCalledWith(permissions);
  });

  it("documents and stubs Systrace and LogBox cleanly", () => {
    expect(() => {
      Systrace.beginEvent("test");
      Systrace.endEvent();
      Systrace.counterEvent("test", 1);
      LogBox.ignoreLogs(["warning"]);
      LogBox.ignoreAllLogs(true);
      LogBox.install();
      LogBox.uninstall();
    }).not.toThrow();
  });
});
