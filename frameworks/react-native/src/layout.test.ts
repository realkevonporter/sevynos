import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { layoutNativeTree, resetDroppedPropWarnings } from "./layout.js";
import type { NativeHostNode, NativeStyle } from "./native-types.js";

function createHostNode(
  id: string,
  type: NativeHostNode["type"],
  style: NativeStyle,
  props: Record<string, unknown> = {},
): NativeHostNode {
  return {
    kind: "host",
    id,
    type,
    props: {
      id,
      style,
      ...props,
    },
    children: [],
    hidden: false,
    dirty: true,
    revision: 1,
  };
}

describe("layout engine dev warnings for dropped style props", () => {
  const originalEnv = process.env["NODE_ENV"];

  beforeEach(() => {
    resetDroppedPropWarnings();
    process.env["NODE_ENV"] = "development";
  });

  afterEach(() => {
    process.env["NODE_ENV"] = originalEnv;
    vi.restoreAllMocks();
  });

  it("forwards border, shadow, and opacity props to material commands and does not warn", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation((): void => undefined);

    const node = createHostNode("card-1", "view", {
      backgroundColor: "#1E293B",
      borderColor: "#38BDF8",
      borderWidth: 2,
      borderStyle: "dashed",
      borderTopLeftRadius: 8,
      borderTopRightRadius: 12,
      borderBottomLeftRadius: 4,
      borderBottomRightRadius: 16,
      opacity: 0.85,
      shadowColor: "#000000",
      shadowOffset: { width: 2, height: 4 },
      shadowOpacity: 0.3,
      shadowRadius: 6,
    });

    const result = layoutNativeTree({
      roots: [node],
      bounds: { x: 0, y: 0, width: 200, height: 100 },
      appearance: "dark",
      accent: "#D7AC57",
      reducedMotion: false,
      revision: 1,
      changedNodeIds: [node.id],
    });

    const materialCmd = result.snapshot.commands.find(
      (cmd) => cmd.kind === "material" && cmd.id === "card-1.background",
    );
    expect(materialCmd).toBeDefined();
    if (materialCmd?.kind === "material") {
      expect(materialCmd.borderWidth).toBe(2);
      expect(materialCmd.borderStyle).toBe("dashed");
      expect(materialCmd.borderColor).toBe("#38BDF8");
      expect(materialCmd.opacity).toBe(0.85);
      expect(materialCmd.radii).toEqual({
        topLeft: 8,
        topRight: 12,
        bottomLeft: 4,
        bottomRight: 16,
      });
      expect(materialCmd.shadow).toEqual({
        color: "#000000",
        x: 2,
        y: 4,
        blur: 6,
        opacity: 0.3,
      });
    }

    // Must NOT warn for any of these supported props
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("forwards typography and opacity props to text commands and does not warn", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation((): void => undefined);

    const node = createHostNode(
      "title-text",
      "text",
      {
        color: "#F3F4F6",
        lineHeight: 24,
        letterSpacing: 0.5,
        fontFamily: "Inter",
        fontStyle: "italic",
        opacity: 0.9,
      },
      { text: "Hello World" },
    );

    const result = layoutNativeTree({
      roots: [node],
      bounds: { x: 0, y: 0, width: 200, height: 100 },
      appearance: "dark",
      accent: "#D7AC57",
      reducedMotion: false,
      revision: 1,
      changedNodeIds: [node.id],
    });

    const textCmd = result.snapshot.commands.find(
      (cmd) => cmd.kind === "text" && cmd.id === "title-text.text",
    );
    expect(textCmd).toBeDefined();
    if (textCmd?.kind === "text") {
      expect(textCmd.lineHeight).toBe(24);
      expect(textCmd.letterSpacing).toBe(0.5);
      expect(textCmd.fontFamily).toBe("Inter");
      expect(textCmd.fontStyle).toBe("italic");
      expect(textCmd.opacity).toBe(0.9);
    }

    // Must NOT warn for any of these supported props
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("warns only for unforwarded props while accepting aspect ratio and transforms", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation((): void => undefined);

    const node = createHostNode("box-1", "view", {
      zIndex: 10,
      aspectRatio: 16 / 9,
      transform: [{ translateX: 4 }, { scaleX: 1.25 }],
      textDecorationLine: "underline",
    });

    layoutNativeTree({
      roots: [node],
      bounds: { x: 0, y: 0, width: 200, height: 100 },
      appearance: "dark",
      accent: "#D7AC57",
      reducedMotion: false,
      revision: 1,
      changedNodeIds: [node.id],
    });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(
        /Style prop "zIndex" on component <view> \(id: box-1\) was dropped/,
      ),
    );
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringMatching(/Style prop "aspectRatio"/),
    );
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringMatching(/Style prop "transform"/),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(
        /Style prop "textDecorationLine" on component <view> \(id: box-1\) was dropped/,
      ),
    );
  });

  it("includes accessibilityRole and accessibilityLabel in component name when present", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation((): void => undefined);

    const node = createHostNode(
      "action-btn",
      "button",
      { zIndex: 2 },
      { accessibilityRole: "button", accessibilityLabel: "Submit Form" },
    );

    layoutNativeTree({
      roots: [node],
      bounds: { x: 0, y: 0, width: 200, height: 50 },
      appearance: "dark",
      accent: "#D7AC57",
      reducedMotion: false,
      revision: 1,
      changedNodeIds: [node.id],
    });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(
        /Style prop "zIndex" on component <button role="button"> \("Submit Form", id: action-btn\) was dropped/,
      ),
    );
  });

  it("stays completely silent for honored style properties", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation((): void => undefined);

    const node = createHostNode("clean-node", "view", {
      backgroundColor: "#1A1D24",
      borderColor: "#D7AC57",
      borderRadius: 12,
      padding: 16,
      margin: 8,
      width: 150,
      height: 60,
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
      overflow: "hidden",
      translateX: 10,
      translateY: 5,
      scale: 1,
    });

    layoutNativeTree({
      roots: [node],
      bounds: { x: 0, y: 0, width: 200, height: 100 },
      appearance: "dark",
      accent: "#D7AC57",
      reducedMotion: false,
      revision: 1,
      changedNodeIds: [node.id],
    });

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("stays completely silent in production mode even when unforwarded props are present", () => {
    process.env["NODE_ENV"] = "production";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation((): void => undefined);

    const node = createHostNode("prod-node", "view", {
      zIndex: 1,
      aspectRatio: 1.5,
      textDecorationLine: "underline",
    });

    layoutNativeTree({
      roots: [node],
      bounds: { x: 0, y: 0, width: 200, height: 100 },
      appearance: "dark",
      accent: "#D7AC57",
      reducedMotion: false,
      revision: 1,
      changedNodeIds: [node.id],
    });

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("deduplicates warnings per node and prop across multiple layout passes", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation((): void => undefined);

    const node = createHostNode("reused-node", "view", {
      zIndex: 1,
    });

    const layoutOptions = {
      roots: [node],
      bounds: { x: 0, y: 0, width: 200, height: 100 },
      appearance: "dark" as const,
      accent: "#D7AC57",
      reducedMotion: false,
      revision: 1,
      changedNodeIds: [node.id],
    };

    // First layout pass
    layoutNativeTree(layoutOptions);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    // Second layout pass with same node and prop
    layoutNativeTree({ ...layoutOptions, revision: 2 });
    expect(warnSpy).toHaveBeenCalledTimes(1);

    // Resetting warnings allows it to warn again
    resetDroppedPropWarnings();
    layoutNativeTree({ ...layoutOptions, revision: 3 });
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });
});

describe("button chrome and control command emission", () => {
  it("emits a control command with button chrome for a button with no action prop", () => {
    const buttonNode = createHostNode(
      "custom-btn",
      "button",
      {
        backgroundColor: "#1E293B",
        borderColor: "#38BDF8",
        borderWidth: 1,
        borderRadius: 8,
        color: "#F8FAFC",
      },
      { label: "Submit" },
    );

    const result = layoutNativeTree({
      roots: [buttonNode],
      bounds: { x: 0, y: 0, width: 300, height: 200 },
      appearance: "dark",
      accent: "#D7AC57",
      reducedMotion: false,
      revision: 1,
      changedNodeIds: [buttonNode.id],
    });

    // Must emit a control command
    const controlCmd = result.snapshot.commands.find(
      (cmd) => cmd.kind === "control" && cmd.id === "custom-btn.control",
    );
    expect(controlCmd).toBeDefined();
    if (controlCmd?.kind === "control") {
      expect(controlCmd.action).toBe("custom");
      expect(controlCmd.label).toBe("Submit");
      expect(controlCmd.state).toBe("idle");
      expect(controlCmd.background).toBe("#1E293B");
      expect(controlCmd.accent).toBe("#38BDF8");
      expect(controlCmd.foreground).toBe("#F8FAFC");
      expect(controlCmd.radius).toBe(8);
      expect(controlCmd.borderWidth).toBe(1);
      expect(controlCmd.borderColor).toBe("#38BDF8");
    }

    // Must NOT emit duplicate material background
    const materialBackgroundCmd = result.snapshot.commands.find(
      (cmd) => cmd.kind === "material" && cmd.id === "custom-btn.background",
    );
    expect(materialBackgroundCmd).toBeUndefined();
  });

  it("handles pressed, hovered, focused, and disabled interaction states", () => {
    const buttonNode = createHostNode("interactive-btn", "button", {
      backgroundColor: "#222738",
      borderRadius: 6,
    });

    const baseOptions = {
      roots: [buttonNode],
      bounds: { x: 0, y: 0, width: 300, height: 200 },
      appearance: "dark" as const,
      accent: "#D7AC57",
      reducedMotion: false,
      revision: 1,
      changedNodeIds: [buttonNode.id],
    };

    // Idle
    const idleResult = layoutNativeTree(baseOptions);
    const idleCmd = idleResult.snapshot.commands.find((c) => c.kind === "control");
    expect(idleCmd).toMatchObject({
      kind: "control",
      state: "idle",
      background: "#222738",
    });

    // Pressed
    const pressedResult = layoutNativeTree({
      ...baseOptions,
      pressedId: buttonNode.id,
    });
    const pressedCmd = pressedResult.snapshot.commands.find((c) => c.kind === "control");
    expect(pressedCmd).toMatchObject({
      kind: "control",
      state: "pressed",
      background: "#222738",
      accent: "#D7AC57",
    });

    // Hovered
    const hoveredResult = layoutNativeTree({
      ...baseOptions,
      hoveredId: buttonNode.id,
    });
    const hoveredCmd = hoveredResult.snapshot.commands.find((c) => c.kind === "control");
    expect(hoveredCmd).toMatchObject({
      kind: "control",
      state: "hovered",
      background: "#222738",
    });

    // Focused
    const focusedResult = layoutNativeTree({
      ...baseOptions,
      focusId: buttonNode.id,
    });
    const focusedCmd = focusedResult.snapshot.commands.find((c) => c.kind === "control");
    expect(focusedCmd).toMatchObject({
      kind: "control",
      state: "focused",
      background: "#222738",
      accent: "#D7AC57",
    });

    // Disabled
    const disabledNode = createHostNode(
      "disabled-btn",
      "button",
      { backgroundColor: "#222738" },
      { disabled: true },
    );
    const disabledResult = layoutNativeTree({
      roots: [disabledNode],
      bounds: { x: 0, y: 0, width: 300, height: 200 },
      appearance: "dark",
      accent: "#D7AC57",
      reducedMotion: false,
      revision: 1,
      changedNodeIds: [disabledNode.id],
    });
    const disabledCmd = disabledResult.snapshot.commands.find(
      (c) => c.kind === "control",
    );
    expect(disabledCmd).toMatchObject({
      kind: "control",
      state: "disabled",
    });
  });

  it("supports arbitrary action strings for custom controls without colliding with settings", () => {
    const customActionNode = createHostNode(
      "custom-action-btn",
      "button",
      {},
      { action: "application.custom-action", label: "Trigger Action" },
    );

    const result = layoutNativeTree({
      roots: [customActionNode],
      bounds: { x: 0, y: 0, width: 300, height: 200 },
      appearance: "dark",
      accent: "#D7AC57",
      reducedMotion: false,
      revision: 1,
      changedNodeIds: [customActionNode.id],
    });

    const controlCmd = result.snapshot.commands.find((c) => c.kind === "control");
    expect(controlCmd).toBeDefined();
    if (controlCmd?.kind === "control") {
      expect(controlCmd.action).toBe("application.custom-action");
      expect(controlCmd.label).toBe("Trigger Action");
    }
  });
});
