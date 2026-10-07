import { describe, expect, it } from "vitest";
import {
  Ionicons,
  MaterialIcons,
  Feather,
  FontAwesome,
  createIconSet,
} from "./vector-icons.js";

describe("@sevynos/react-native vector icons", () => {
  it("creates Ionicons element with name, size and color", () => {
    const el = Ionicons({ name: "compass", size: 32, color: "#0EA5E9" });
    expect(el).toBeDefined();
    expect((el.props as { readonly icon: string }).icon).toBe("compass");
  });

  it("creates MaterialIcons element with name, size and color", () => {
    const el = MaterialIcons({ name: "folder", size: 24, color: "#06B6D4" });
    expect(el).toBeDefined();
    expect((el.props as { readonly icon: string }).icon).toBe("folder");
  });

  it("creates Feather and FontAwesome elements", () => {
    const el1 = Feather({ name: "code", size: 20, color: "#6366F1" });
    const el2 = FontAwesome({ name: "gear", size: 18, color: "#64748B" });
    expect((el1.props as { readonly icon: string }).icon).toBe("code");
    expect((el2.props as { readonly icon: string }).icon).toBe("gear");
  });

  it("supports createIconSet factory", () => {
    const Custom = createIconSet({ custom: 1 }, "CustomFont");
    const el = Custom({ name: "custom", size: 28 });
    expect((el.props as { readonly icon: string }).icon).toBe("custom");
  });
});

describe("SevynIcon", () => {
  it("creates a NativeIcon element for a SevynIconName", async () => {
    const { SevynIcon } = await import("./vector-icons.js");
    const el = SevynIcon({ name: "app-browser", size: 32, color: "#FFFFFF" });
    expect(el).toBeDefined();
    expect((el.props as { readonly icon: string }).icon).toBe("app-browser");
    const style = (el.props as { readonly style: readonly unknown[] }).style;
    expect(style[0]).toMatchObject({ width: 32, height: 32, color: "#FFFFFF" });
  });

  it("covers every application icon glyph name", async () => {
    const { SevynIcon } = await import("./vector-icons.js");
    const names = [
      "app-browser",
      "app-calculator",
      "app-camera",
      "app-files",
      "app-music",
      "app-notes",
      "app-settings",
      "app-sevyn-code",
      "app-system-monitor",
      "app-terminal",
      "app-text-editor",
      "app-welcome",
    ] as const;
    for (const name of names) {
      const el = SevynIcon({ name });
      expect((el.props as { readonly icon: string }).icon).toBe(name);
    }
  });
});
