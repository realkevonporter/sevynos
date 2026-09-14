import { describe, it, expect, vi } from "vitest";
import { KeyboardShortcutRegistry } from "./keyboard-shortcut-registry.js";

describe("KeyboardShortcutRegistry", () => {
  it("registers default shortcuts", () => {
    const registry = new KeyboardShortcutRegistry();
    const shortcuts = registry.listShortcuts();

    expect(shortcuts.length).toBeGreaterThan(0);
    expect(registry.getShortcut("system.copy")).toBeDefined();
    expect(registry.getShortcut("window.close")).toBeDefined();
    expect(registry.getShortcut("system.launcher")).toBeDefined();
  });

  it("can register and unregister a new shortcut", () => {
    const registry = new KeyboardShortcutRegistry();
    const action = vi.fn();

    const unregister = registry.register({
      id: "test.shortcut",
      label: "Test",
      category: "application",
      action,
      keys: { key: "t", ctrl: true },
    });

    expect(registry.getShortcut("test.shortcut")).toBeDefined();

    unregister();

    expect(registry.getShortcut("test.shortcut")).toBeUndefined();
  });

  it("handles a matched key down event", () => {
    const registry = new KeyboardShortcutRegistry();
    const action = vi.fn();

    registry.register({
      id: "test.shortcut",
      label: "Test",
      category: "application",
      action,
      keys: { key: "k", ctrl: true, shift: true },
    });

    const handled = registry.handleKeyDown({
      key: "k",
      ctrlKey: true,
      shiftKey: true,
      altKey: false,
      metaKey: false,
    });

    expect(handled).toBe(true);
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("does not handle events that do not match", () => {
    const registry = new KeyboardShortcutRegistry();
    const action = vi.fn();

    registry.register({
      id: "test.shortcut",
      label: "Test",
      category: "application",
      action,
      keys: { key: "k", ctrl: true, shift: true },
    });

    const handled = registry.handleKeyDown({
      key: "k",
      ctrlKey: true,
      shiftKey: false, // missing shift
      altKey: false,
      metaKey: false,
    });

    expect(handled).toBe(false);
    expect(action).not.toHaveBeenCalled();
  });

  it("formats shortcuts correctly", () => {
    expect(KeyboardShortcutRegistry.formatShortcut({ key: "c", ctrl: true })).toBe(
      "Ctrl+C",
    );
    expect(
      KeyboardShortcutRegistry.formatShortcut({ key: "z", ctrl: true, shift: true }),
    ).toBe("Ctrl+Shift+Z");
    expect(KeyboardShortcutRegistry.formatShortcut({ key: "Tab", alt: true })).toBe(
      "Alt+Tab",
    );
    expect(
      KeyboardShortcutRegistry.formatShortcut({ key: "ArrowLeft", meta: true }),
    ).toBe("Super+ArrowLeft");
    expect(KeyboardShortcutRegistry.formatShortcut({ key: "Meta" })).toBe("Super");
  });
});
