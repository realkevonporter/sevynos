import { describe, expect, it } from "vitest";

import {
  FocusTargetAlreadyRegisteredError,
  FocusTargetNotRegisteredError,
} from "../errors/focus-errors.js";
import type { FocusManagerEvent } from "./focus-events.js";
import { FocusManager } from "./focus-manager.js";
import { EMPTY_FOCUS_STATE } from "./focus-state.js";

describe("FocusManager", () => {
  it("starts without focus", () => {
    const manager = new FocusManager();

    expect(manager.state).toEqual(EMPTY_FOCUS_STATE);

    expect(manager.targetCount).toBe(0);
  });

  it("registers focus targets", () => {
    const manager = new FocusManager();

    manager.registerTarget("window-1");

    expect(manager.hasTarget("window-1")).toBe(true);

    expect(manager.listTargets()).toEqual(["window-1"]);
  });

  it("rejects duplicate targets", () => {
    const manager = new FocusManager();

    manager.registerTarget("window-1");

    expect(() => {
      manager.registerTarget("window-1");
    }).toThrow(FocusTargetAlreadyRegisteredError);
  });

  it("gives a target keyboard focus and activates it", () => {
    const manager = new FocusManager();

    manager.registerTarget("window-1");

    manager.focusKeyboard("window-1");

    expect(manager.state).toEqual({
      keyboardFocus: "window-1",

      pointerFocus: null,

      activeWindow: "window-1",
    });
  });

  it("tracks pointer focus independently", () => {
    const manager = new FocusManager();

    manager.registerTarget("window-1");

    manager.registerTarget("window-2");

    manager.focusKeyboard("window-1");

    manager.focusPointer("window-2");

    expect(manager.state).toEqual({
      keyboardFocus: "window-1",

      pointerFocus: "window-2",

      activeWindow: "window-1",
    });
  });

  it("rejects focusing an unknown target", () => {
    const manager = new FocusManager();

    expect(() => {
      manager.focusKeyboard("missing-window");
    }).toThrow(FocusTargetNotRegisteredError);

    expect(() => {
      manager.focusPointer("missing-window");
    }).toThrow(FocusTargetNotRegisteredError);
  });

  it("activates a target without changing keyboard focus", () => {
    const manager = new FocusManager();

    manager.registerTarget("window-1");

    manager.registerTarget("window-2");

    manager.focusKeyboard("window-1");

    manager.activate("window-2");

    expect(manager.state.keyboardFocus).toBe("window-1");

    expect(manager.state.activeWindow).toBe("window-2");
  });

  it("clears keyboard focus", () => {
    const manager = new FocusManager();

    manager.registerTarget("window-1");

    manager.focusKeyboard("window-1");

    manager.clearKeyboardFocus();

    expect(manager.state.keyboardFocus).toBeNull();

    expect(manager.state.activeWindow).toBe("window-1");
  });

  it("clears pointer focus", () => {
    const manager = new FocusManager();

    manager.registerTarget("window-1");

    manager.focusPointer("window-1");

    manager.clearPointerFocus();

    expect(manager.state.pointerFocus).toBeNull();
  });

  it("clears all focus", () => {
    const manager = new FocusManager();

    manager.registerTarget("window-1");

    manager.focusKeyboard("window-1");

    manager.focusPointer("window-1");

    manager.clearAll();

    expect(manager.state).toEqual(EMPTY_FOCUS_STATE);
  });

  it("tracks focus history", () => {
    const manager = new FocusManager();

    manager.registerTarget("window-1");

    manager.registerTarget("window-2");

    manager.focusKeyboard("window-1");

    manager.focusKeyboard("window-2");

    expect(manager.getHistory()).toEqual(["window-1", "window-2"]);
  });

  it("moves refocused targets to the end of history", () => {
    const manager = new FocusManager();

    manager.registerTarget("window-1");

    manager.registerTarget("window-2");

    manager.focusKeyboard("window-1");

    manager.focusKeyboard("window-2");

    manager.focusKeyboard("window-1");

    expect(manager.getHistory()).toEqual(["window-2", "window-1"]);
  });

  it("restores the previously focused target", () => {
    const manager = new FocusManager();

    manager.registerTarget("window-1");

    manager.registerTarget("window-2");

    manager.focusKeyboard("window-1");

    manager.focusKeyboard("window-2");

    const restored = manager.restorePreviousFocus();

    expect(restored).toBe("window-1");

    expect(manager.state.keyboardFocus).toBe("window-1");
  });

  it("restores focus when the focused target is removed", () => {
    const manager = new FocusManager();

    manager.registerTarget("window-1");

    manager.registerTarget("window-2");

    manager.focusKeyboard("window-1");

    manager.focusKeyboard("window-2");

    manager.removeTarget("window-2");

    expect(manager.state.keyboardFocus).toBe("window-1");

    expect(manager.state.activeWindow).toBe("window-1");
  });

  it("clears pointer focus when its target is removed", () => {
    const manager = new FocusManager();

    manager.registerTarget("window-1");

    manager.focusPointer("window-1");

    manager.removeTarget("window-1");

    expect(manager.state.pointerFocus).toBeNull();
  });

  it("rejects removing an unknown target", () => {
    const manager = new FocusManager();

    expect(() => {
      manager.removeTarget("missing-window");
    }).toThrow(FocusTargetNotRegisteredError);
  });

  it("returns immutable snapshots", () => {
    const manager = new FocusManager();

    manager.registerTarget("window-1");

    manager.focusKeyboard("window-1");

    expect(Object.isFrozen(manager.state)).toBe(true);

    expect(Object.isFrozen(manager.listTargets())).toBe(true);

    expect(Object.isFrozen(manager.getHistory())).toBe(true);
  });

  it("does not emit events for unchanged state", () => {
    const events: FocusManagerEvent[] = [];

    const manager = new FocusManager({
      onEvent: (event) => {
        events.push(event);
      },
    });

    manager.registerTarget("window-1");

    manager.focusKeyboard("window-1");

    events.length = 0;

    manager.focusKeyboard("window-1");

    expect(events).toEqual([]);
  });

  it("emits deterministic focus transition events", () => {
    const events: FocusManagerEvent[] = [];

    const manager = new FocusManager({
      onEvent: (event) => {
        events.push(event);
      },
    });

    manager.registerTarget("window-1");

    events.length = 0;

    manager.focusKeyboard("window-1", "keyboard");

    expect(events.map((event) => event.type)).toEqual([
      "keyboard-focus-changed",
      "active-window-changed",
      "focus-state-changed",
    ]);
  });

  it("emits pointer focus transitions", () => {
    const events: FocusManagerEvent[] = [];

    const manager = new FocusManager({
      onEvent: (event) => {
        events.push(event);
      },
    });

    manager.registerTarget("window-1");

    events.length = 0;

    manager.focusPointer("window-1");

    expect(events.map((event) => event.type)).toEqual([
      "pointer-focus-changed",
      "focus-state-changed",
    ]);
  });

  it("emits target lifecycle events", () => {
    const events: FocusManagerEvent[] = [];

    const manager = new FocusManager({
      onEvent: (event) => {
        events.push(event);
      },
    });

    manager.registerTarget("window-1");

    manager.removeTarget("window-1");

    expect(events.map((event) => event.type)).toEqual([
      "focus-target-registered",
      "focus-target-removed",
    ]);
  });
});
