import { describe, expect, it } from "vitest";
import {
  composeComponentGallery,
  composeSettingsApplication,
  motionDuration,
  resolveSevynColors,
  sevynTokens,
} from "./internal.js";

const settings = Object.freeze({
  theme: "dark" as const,
  accentColor: "#D7AC57",
  taskbarPosition: "bottom" as const,
  taskbarBehavior: "always-visible" as const,
  displayLayout: "side-by-side" as const,
  workspaceCount: 4,
  cursorSize: 1,
  reducedMotion: false,
  restorePreviousSession: true,
});
describe("Sevyn React Native system framework", () => {
  it("defines complete centralized design foundations", () => {
    expect(sevynTokens.spacing.xxl).toBe(48);
    expect(sevynTokens.material.regular.blur).toBe(22);
    expect(resolveSevynColors("dark").accent).toBe("#D7AC57");
  });
  it("composes deterministic responsive Settings surfaces", () => {
    const first = composeSettingsApplication({
      bounds: { x: 0, y: 0, width: 720, height: 680 },
      settings,
      focused: true,
    });
    const second = composeSettingsApplication({
      bounds: { x: 0, y: 0, width: 720, height: 680 },
      settings,
      focused: true,
    });
    expect(first).toEqual(second);
    expect(
      first.commands.some(
        (command) => command.kind === "control" && command.action === "theme",
      ),
    ).toBe(true);
  });
  it("renders light, dark, interaction, and reduced-motion gallery states", () => {
    const light = composeComponentGallery({
      bounds: { x: 0, y: 0, width: 500, height: 400 },
      appearance: "light",
      reducedMotion: false,
    });
    const dark = composeComponentGallery({
      bounds: { x: 0, y: 0, width: 500, height: 400 },
      appearance: "dark",
      reducedMotion: true,
    });
    expect(light.colors.canvas).not.toBe(dark.colors.canvas);
    expect(
      dark.commands
        .filter((command) => command.kind === "control")
        .map((command) => command.state),
    ).toEqual(["idle", "hovered", "focused", "pressed", "disabled"]);
    expect(motionDuration(190, dark.reducedMotion)).toBe(0);
  });
  it("provides 100% standard React Native component aliases, StyleSheet, and Platform", async () => {
    const {
      View,
      Text,
      TextInput,
      ScrollView,
      Image,
      Pressable,
      TouchableOpacity,
      Switch,
      Modal,
      StyleSheet,
      Platform,
      Dimensions,
      Alert,
      FlatList,
      SevynApplicationRuntime,
    } = await import("./internal.js");

    expect(View).toBeDefined();
    expect(Text).toBeDefined();
    expect(TextInput).toBeDefined();
    expect(ScrollView).toBeDefined();
    expect(Image).toBeDefined();
    expect(Pressable).toBeDefined();
    expect(TouchableOpacity).toBeDefined();
    expect(Switch).toBeDefined();
    expect(Modal).toBeDefined();
    expect(FlatList).toBeDefined();

    expect(Platform.OS).toBe("sevynos");
    expect(Platform.select({ sevynos: "ok", default: "no" })).toBe("ok");
    expect(Dimensions.get("window").width).toBeGreaterThan(0);

    let alerted = false;
    Alert.alert("Test", "Message", [
      {
        text: "OK",
        onPress: () => {
          alerted = true;
        },
      },
    ]);
    expect(alerted).toBe(true);

    const styles = StyleSheet.create({
      card: {
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderRadius: 10,
        flex: 1,
      },
    });
    expect(styles.card.flexDirection).toBe("row");
    expect(styles.card.borderRadius).toBe(10);

    const runtime = new SevynApplicationRuntime({
      bounds: { x: 0, y: 0, width: 400, height: 300 },
    });
    runtime.mount(
      View({
        id: "root",
        style: styles.card,
        children: [
          Text({
            key: "t1",
            id: "t1",
            text: "Hello Standard React Native",
            style: { fontWeight: "bold" },
          }),
          TouchableOpacity({
            key: "btn",
            id: "btn",
            children: Text({ id: "t2", text: "Click" }),
          }),
        ],
      }),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(runtime.snapshot.commands.length).toBeGreaterThan(0);
    const bgCommand = runtime.snapshot.commands.find((c) => c.kind === "material");
    expect(bgCommand).toBeDefined();
    expect(bgCommand?.radius).toBe(10);
  });
});
