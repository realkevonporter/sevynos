import { describe, expect, it } from "vitest";

import type { ApplicationPackage } from "../application/application-package.js";
import {
  ApplicationSession,
  type ApplicationSessionId,
} from "../application/application-session.js";
import type { ApplicationLifecycleController } from "../application/application-lifecycle-controller.js";
import {
  GenesisWindowManager,
  WindowRegistry,
  WindowZOrderManager,
} from "@sevynos/graphics";
import {
  FocusManager,
  InputDeviceRegistry,
  InputDispatcher,
  PointerFocusController,
  WindowHitTester,
  createPointerInputEvent,
} from "@sevynos/input";

const CREATED_AT = new Date("2026-07-31T17:00:00.000Z");

const TEST_APPLICATION_PACKAGE: ApplicationPackage = {
  manifest: {
    manifestVersion: 1,

    id: "org.sevynos.pointer-focus-test",

    name: "Pointer Focus Test",

    version: "0.1.0",

    hostId: "sevyn.host.test",

    entrypoint: "index.js",
  },

  files: {
    "index.js": "",
  },
};

function createPointerDownEvent(x: number, y: number) {
  return createPointerInputEvent({
    type: "pointer-down",

    eventId: `pointer-down-${String(x)}-${String(y)}`,

    deviceId: "mouse-1",

    deviceKind: "mouse",

    timestamp: 1,

    pointerId: 1,

    position: {
      x,
      y,
    },

    button: "primary",

    buttons: ["primary"],

    pressure: 0,
  });
}

function createApplicationLifecycleController(): ApplicationLifecycleController {
  const sessions = new Map<ApplicationSessionId, ApplicationSession>();

  const getSession = (sessionId: ApplicationSessionId): ApplicationSession => {
    const existing = sessions.get(sessionId);

    if (existing !== undefined) {
      return existing;
    }

    const created = new ApplicationSession({
      id: sessionId,

      application: TEST_APPLICATION_PACKAGE,

      createdAt: CREATED_AT,

      state: "background",
    });

    sessions.set(sessionId, created);

    return created;
  };

  return {
    foregroundApplication: (sessionId: ApplicationSessionId): ApplicationSession => {
      const session = getSession(sessionId);

      const foreground = new ApplicationSession({
        id: session.id,

        application: session.application,

        createdAt: session.createdAt,

        state: "foreground",
      });

      sessions.set(sessionId, foreground);

      return foreground;
    },

    backgroundApplication: (sessionId: ApplicationSessionId): ApplicationSession => {
      const session = getSession(sessionId);

      const background = new ApplicationSession({
        id: session.id,

        application: session.application,

        createdAt: session.createdAt,

        state: "background",
      });

      sessions.set(sessionId, background);

      return background;
    },
  };
}

function createWindowManager(): GenesisWindowManager {
  let nextWindowNumber = 0;

  const windowRegistry = new WindowRegistry();

  const now = (): Date => new Date(CREATED_AT);

  const zOrder = new WindowZOrderManager({
    windows: windowRegistry,

    now,
  });

  return new GenesisWindowManager({
    windows: windowRegistry,

    applications: createApplicationLifecycleController(),

    zOrder,

    createWindowId: () => {
      nextWindowNumber += 1;

      return `window-${String(nextWindowNumber)}`;
    },

    now,
  });
}

function createInputDispatcher(): InputDispatcher {
  const deviceRegistry = new InputDeviceRegistry();

  deviceRegistry.register(
    {
      id: "mouse-1",

      name: "Test Mouse",

      kind: "mouse",

      capabilities: ["pointer"],

      virtual: true,
    },
    1,
  );

  return new InputDispatcher({
    deviceRegistry,
  });
}

describe("PointerFocusController and GenesisWindowManager", () => {
  it("raises and focuses a clicked background window", () => {
    const windowManager = createWindowManager();

    const first = windowManager.createWindow({
      sessionId: "session-1",

      title: "First",

      bounds: {
        x: 0,
        y: 0,
        width: 400,
        height: 300,
      },
    });

    const second = windowManager.createWindow({
      sessionId: "session-2",

      title: "Second",

      bounds: {
        x: 500,
        y: 0,
        width: 400,
        height: 300,
      },
    });

    expect(windowManager.getWindow(first.id)?.state).toBe("visible");

    expect(windowManager.getWindow(second.id)?.state).toBe("focused");

    const dispatcher = createInputDispatcher();

    const focusManager = new FocusManager();

    focusManager.registerTarget(first.id);

    focusManager.registerTarget(second.id);

    focusManager.focusKeyboard(second.id);

    focusManager.focusPointer(second.id);

    const hitTester = new WindowHitTester({
      listWindows: () => windowManager.listWindows(),
    });

    const controller = new PointerFocusController({
      dispatcher,

      focusManager,

      hitTester,

      windowController: windowManager,
    });

    const result = controller.handlePointerEvent(createPointerDownEvent(100, 100));

    const updatedFirst = windowManager.getWindow(first.id);

    const updatedSecond = windowManager.getWindow(second.id);

    expect(result.hit).toBe(true);

    expect(result.activated).toBe(true);

    expect(result.targetId).toBe(first.id);

    expect(updatedFirst?.state).toBe("focused");

    expect(updatedSecond?.state).toBe("visible");

    expect(updatedFirst?.zIndex).toBeGreaterThan(updatedSecond?.zIndex ?? -1);

    expect(focusManager.state).toEqual({
      pointerFocus: first.id,

      keyboardFocus: first.id,

      activeWindow: first.id,
    });
  });

  it("keeps window and logical focus synchronized across repeated clicks", () => {
    const windowManager = createWindowManager();

    const first = windowManager.createWindow({
      sessionId: "session-1",

      title: "First",

      bounds: {
        x: 0,
        y: 0,
        width: 400,
        height: 300,
      },
    });

    const second = windowManager.createWindow({
      sessionId: "session-2",

      title: "Second",

      bounds: {
        x: 500,
        y: 0,
        width: 400,
        height: 300,
      },
    });

    const dispatcher = createInputDispatcher();

    const focusManager = new FocusManager();

    focusManager.registerTarget(first.id);

    focusManager.registerTarget(second.id);

    const controller = new PointerFocusController({
      dispatcher,

      focusManager,

      hitTester: new WindowHitTester({
        listWindows: () => windowManager.listWindows(),
      }),

      windowController: windowManager,
    });

    controller.handlePointerEvent(createPointerDownEvent(100, 100));

    expect(windowManager.getWindow(first.id)?.state).toBe("focused");

    expect(windowManager.getWindow(second.id)?.state).toBe("visible");

    expect(focusManager.state.keyboardFocus).toBe(first.id);

    expect(focusManager.state.activeWindow).toBe(first.id);

    controller.handlePointerEvent(createPointerDownEvent(550, 100));

    expect(windowManager.getWindow(first.id)?.state).toBe("visible");

    expect(windowManager.getWindow(second.id)?.state).toBe("focused");

    expect(windowManager.getWindow(second.id)?.zIndex).toBeGreaterThan(
      windowManager.getWindow(first.id)?.zIndex ?? -1,
    );

    expect(focusManager.state).toEqual({
      pointerFocus: second.id,

      keyboardFocus: second.id,

      activeWindow: second.id,
    });
  });

  it("does not alter active window focus when clicking outside all windows", () => {
    const windowManager = createWindowManager();

    const window = windowManager.createWindow({
      sessionId: "session-1",

      title: "First",

      bounds: {
        x: 0,
        y: 0,
        width: 400,
        height: 300,
      },
    });

    const dispatcher = createInputDispatcher();

    const focusManager = new FocusManager();

    focusManager.registerTarget(window.id);

    focusManager.focusKeyboard(window.id);

    focusManager.focusPointer(window.id);

    const controller = new PointerFocusController({
      dispatcher,

      focusManager,

      hitTester: new WindowHitTester({
        listWindows: () => windowManager.listWindows(),
      }),

      windowController: windowManager,
    });

    const result = controller.handlePointerEvent(createPointerDownEvent(1000, 1000));

    expect(result.hit).toBe(false);

    expect(result.activated).toBe(false);

    expect(result.targetId).toBeNull();

    expect(windowManager.getWindow(window.id)?.state).toBe("focused");

    expect(focusManager.state).toEqual({
      pointerFocus: null,

      keyboardFocus: window.id,

      activeWindow: window.id,
    });
  });
});
