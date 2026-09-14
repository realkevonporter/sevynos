import { describe, expect, it, vi } from "vitest";
import React from "react";
import {
  ActionSheetIOS,
  getActiveActionSheet,
  dismissActionSheet,
} from "./action-sheet.js";
import { SevynApplicationRuntime } from "./application-runtime.js";
import { View } from "./primitives.js";

describe("ActionSheetIOS", () => {
  it("registers an active action sheet and notifies listeners", () => {
    const callback = vi.fn();
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: "Photo Options",
        message: "Choose an action",
        options: ["Camera", "Gallery", "Cancel"],
        cancelButtonIndex: 2,
        destructiveButtonIndex: 0,
      },
      callback,
    );

    const sheet = getActiveActionSheet();
    expect(sheet).toBeDefined();
    expect(sheet?.options.title).toBe("Photo Options");
    expect(sheet?.options.options).toEqual(["Camera", "Gallery", "Cancel"]);

    sheet?.select(1);
    expect(callback).toHaveBeenCalledWith(1);
    expect(getActiveActionSheet()).toBeNull();
  });

  it("renders modal backdrop, panel, and buttons in SevynApplicationRuntime", () => {
    const runtime = new SevynApplicationRuntime({
      bounds: { x: 0, y: 0, width: 600, height: 800 },
    });

    runtime.mount(
      React.createElement(View, {
        style: { width: 600, height: 800, backgroundColor: "#111111" },
      }),
    );

    const callback = vi.fn();
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: "Options",
        options: ["Delete Item", "Save", "Cancel"],
        cancelButtonIndex: 2,
        destructiveButtonIndex: 0,
        disabledButtonIndices: [1],
      },
      callback,
    );

    const commands = runtime.snapshot.commands;
    const backdrop = commands.find((c) => c.id.endsWith(".backdrop"));
    const panel = commands.find((c) => c.id.endsWith(".panel"));
    const title = commands.find((c) => c.id.endsWith(".title"));
    const deleteBtn = commands.find((c) => c.id.endsWith(".button.0.bg"));
    const saveBtn = commands.find((c) => c.id.endsWith(".button.1.bg"));
    const cancelBtn = commands.find((c) => c.id.endsWith(".button.2.bg"));

    expect(backdrop).toBeDefined();
    expect(panel).toBeDefined();
    expect(title).toBeDefined();
    expect(deleteBtn).toBeDefined();
    expect(saveBtn).toBeDefined();
    expect(cancelBtn).toBeDefined();

    // Verify button 1 is disabled (opacity 0.4)
    expect(saveBtn?.opacity).toBe(0.4);

    // Verify button 0 is destructive red
    const deleteLabel = commands.find((c) => c.id.endsWith(".button.0.label"));
    expect(deleteLabel && "color" in deleteLabel ? deleteLabel.color : "").toBe(
      "#ED7780",
    );

    // Click button 0 (Delete)
    if (deleteBtn) {
      const btnBounds = deleteBtn.bounds;
      const clickX = btnBounds.x + btnBounds.width / 2;
      const clickY = btnBounds.y + btnBounds.height / 2;

      runtime.dispatchPointer("down", {
        pointerId: 1,
        x: clickX,
        y: clickY,
        button: 0,
      });

      runtime.dispatchPointer("up", {
        pointerId: 1,
        x: clickX,
        y: clickY,
        button: 0,
      });

      expect(callback).toHaveBeenCalledWith(0);
      expect(getActiveActionSheet()).toBeNull();
      // Overlay commands removed
      expect(
        runtime.snapshot.commands.find((c) => c.id.endsWith(".panel")),
      ).toBeUndefined();
    }

    runtime.unmount();
  });

  it("cancels when clicking outside the panel or pressing Escape", () => {
    const runtime = new SevynApplicationRuntime({
      bounds: { x: 0, y: 0, width: 600, height: 800 },
    });

    runtime.mount(
      React.createElement(View, {
        style: { width: 600, height: 800, backgroundColor: "#111111" },
      }),
    );

    const callback1 = vi.fn();
    ActionSheetIOS.showActionSheetWithOptions(
      {
        options: ["One", "Cancel"],
        cancelButtonIndex: 1,
      },
      callback1,
    );

    // Click at (10, 10), which is outside the bottom panel
    runtime.dispatchPointer("up", {
      pointerId: 1,
      x: 10,
      y: 10,
      button: 0,
    });

    expect(callback1).toHaveBeenCalledWith(1);
    expect(getActiveActionSheet()).toBeNull();

    // Now test Escape key
    const callback2 = vi.fn();
    ActionSheetIOS.showActionSheetWithOptions(
      {
        options: ["Item", "Cancel"],
        cancelButtonIndex: 1,
      },
      callback2,
    );

    runtime.dispatchKeyboard("down", {
      key: "Escape",
      code: "Escape",
      shift: false,
      alt: false,
      control: false,
      meta: false,
    });

    expect(callback2).toHaveBeenCalledWith(1);
    expect(getActiveActionSheet()).toBeNull();

    runtime.unmount();
  });

  it("supports dismissActionSheet programmatic dismissal", () => {
    const callback = vi.fn();
    ActionSheetIOS.showActionSheetWithOptions(
      {
        options: ["Choice", "Cancel"],
        cancelButtonIndex: 1,
      },
      callback,
    );

    expect(getActiveActionSheet()).toBeDefined();
    dismissActionSheet();
    expect(callback).toHaveBeenCalledWith(1);
    expect(getActiveActionSheet()).toBeNull();
  });
});
