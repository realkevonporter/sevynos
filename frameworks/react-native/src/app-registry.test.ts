import { describe, expect, it } from "vitest";
import { AppRegistry, Platform, Text, View } from "./public.js";

describe("SevynOS React Native application registration", () => {
  it("registers and creates a normal React Native application root", () => {
    AppRegistry.clear();
    const Application = () =>
      View({ children: Text({ children: `Platform: ${Platform.OS}` }) });

    expect(AppRegistry.registerComponent("Example", () => Application)).toBe("Example");
    expect(AppRegistry.getAppKeys()).toEqual(["Example"]);
    expect(AppRegistry.getRunnable("Example")?.run().type).toBe(Application);
    expect(() => AppRegistry.registerComponent("Example", () => Application)).toThrow(
      /already contains/,
    );
    AppRegistry.unregisterComponent("Example");
    expect(AppRegistry.getRunnable("Example")).toBeUndefined();
  });
});
