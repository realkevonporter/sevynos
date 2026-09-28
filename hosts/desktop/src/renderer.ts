import {
  DisplayRenderPlanner,
  GenesisFrameExecutor,
  GenesisRenderLoop,
  GraphicsRuntimeCoordinator,
  ManualRenderLoopScheduler,
} from "@sevynos/graphics";
import { createWheelInputEvent } from "@sevynos/input";
import { CanvasGenesisRenderer } from "./canvas-genesis-renderer.js";
import {
  DesktopIsolatedApplicationCoordinator,
  DesktopPersistenceController,
  DesktopSceneComposer,
  createDesktopRuntime,
  createDiagnosticsSnapshot,
  createRenderInvalidator,
  hitTestDesktopSceneControl,
  restoreDesktopSession,
  validateDesktopSettings,
  type DesktopPersistenceAdapter,
  type DesktopScene,
  type DesktopViewport,
  type DesktopWindowSceneNode,
} from "@sevynos/desktop-shell";
import type { WindowControlHit } from "@sevynos/desktop-shell/internal";
import type { SevynApplicationPackage } from "@sevynos/react-native";
import { ElectronWorkerApplicationExecutor } from "./electron-worker-application-executor.js";
import {
  createSystemApplicationModuleUrl,
  resolveSystemApplicationModule,
} from "./shell-hot-reload.js";

function requireDesktopCanvas(): HTMLCanvasElement {
  const canvas = document.querySelector<HTMLCanvasElement>("#desktop");

  if (canvas === null) {
    throw new Error("Desktop canvas was not found.");
  }

  return canvas;
}

function requireCanvasContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext("2d");

  if (context === null) {
    throw new Error("A 2D canvas context could not be created.");
  }

  return context;
}

function readViewport(): DesktopViewport {
  return {
    width: window.innerWidth,
    height: window.innerHeight,
    scaleFactor: window.devicePixelRatio || 1,
  };
}

const canvas = requireDesktopCanvas();
const context = requireCanvasContext(canvas);
let viewport = readViewport();
const loadedSettings = validateDesktopSettings(
  await window.genesisHost.loadDesktopSettings(),
);
const runtime = await createDesktopRuntime({
  launchDefaults: false,
  settings: loadedSettings,
});
const isolatedApplications = await DesktopIsolatedApplicationCoordinator.create({
  runtime,
  executor: new ElectronWorkerApplicationExecutor(
    new URL("./application-worker.js", import.meta.url),
  ),
  services: {
    request: (applicationId, service, argumentsValue) => {
      if (service === "clipboard.read") {
        return window.genesisHost.readClipboardText();
      }
      if (service === "clipboard.write") {
        return window.genesisHost
          .writeClipboardText(typeof argumentsValue === "string" ? argumentsValue : "")
          .then(() => null);
      }
      if (service !== "notifications.show")
        return Promise.reject(new Error(`Service ${service} has no desktop provider.`));
      runtime.diagnostics.record({
        severity: "info",
        subsystem: "application-worker",
        event: "notification.requested",
        message: `A sandboxed application requested a notification (${applicationId}).`,
      });
      return Promise.resolve(null);
    },
  },
});
async function launchDesktopApplication(applicationId: string): Promise<void> {
  await isolatedApplications.launch(applicationId);
}
function configureDesktopDisplay(): void {
  runtime.layout.configureHostDisplays([
    {
      id: "display-primary",
      name: "Primary Display",
      bounds: { x: 0, y: 0, width: viewport.width, height: viewport.height },
      pixelWidth: Math.round(viewport.width * viewport.scaleFactor),
      pixelHeight: Math.round(viewport.height * viewport.scaleFactor),
      scaleFactor: viewport.scaleFactor,
      refreshRate: 60,
      primary: true,
    },
  ]);
}
configureDesktopDisplay();
const persistenceAdapter: DesktopPersistenceAdapter = {
  load: () => window.genesisHost.loadDesktopSession(),
  save: (session) => window.genesisHost.saveDesktopSession(session),
  clear: () => window.genesisHost.clearDesktopSession(),
};
if (loadedSettings.restorePreviousSession) {
  await restoreDesktopSession(runtime, await persistenceAdapter.load(), viewport);
}
// Fresh boot starts with a clean desktop (no auto-launched apps).
// resetToDefaults() is reserved for explicit user-initiated reset
// via persistence.reset().
await isolatedApplications.attachRunningApplications();
const persistence = new DesktopPersistenceController({
  runtime,
  adapter: persistenceAdapter,
});
persistence.connect();
runtime.settings.subscribe((settings) => {
  void window.genesisHost.saveDesktopSettings(settings).catch(() => {
    runtime.diagnostics.record({
      severity: "error",
      subsystem: "persistence",
      event: "settings.save.failed",
      message: "Desktop settings could not be saved.",
    });
  });
});
window.addEventListener("error", (event) => {
  runtime.diagnostics.record({
    severity: "error",
    subsystem: "renderer",
    event: "renderer.error",
    message: event.message || "Unhandled renderer error.",
  });
  runtime.recovery.enter(event.message || "The desktop renderer encountered an error.");
});
window.addEventListener("unhandledrejection", () => {
  runtime.diagnostics.record({
    severity: "error",
    subsystem: "renderer",
    event: "promise.unhandled",
    message: "An unhandled promise rejection occurred.",
  });
  runtime.recovery.enter("An asynchronous desktop operation failed.");
});
let frameExecutionCount = 0;
let invalidate = (): void => undefined;
const sceneComposer = new DesktopSceneComposer(
  runtime,
  () => frameExecutionCount,
  () => {
    invalidate();
  },
);
const canvasRenderer = new CanvasGenesisRenderer(canvas, context);
let latestScene: DesktopScene | undefined;

const renderPlanner = new DisplayRenderPlanner({
  displays: runtime.environment.displays,
  now: () => new Date(),
});

const frameExecutor = new GenesisFrameExecutor<DesktopScene>({
  createRenderPlans: () => {
    latestScene = sceneComposer.compose(viewport);
    console.log(
      `[Renderer] Composed scene with ${String(latestScene.nodes.length)} nodes (frame ${String(frameExecutionCount)})`,
    );
    return renderPlanner.createRenderPlans(latestScene);
  },
  renderer: canvasRenderer,
  now: () => new Date(),
});

const renderLoop = new GenesisRenderLoop({
  executeFrame: () => {
    const startedAt = performance.now();
    const result = frameExecutor.executeFrame();
    frameExecutionCount += 1;
    runtime.diagnostics.recordFrame(
      performance.now() - startedAt,
      result.failures.length > 0,
    );
    if (result.failures.length > 0)
      runtime.diagnostics.record({
        severity: "error",
        subsystem: "renderer",
        event: "frame.failed",
        message: "One or more display render plans failed.",
        metadata: { failures: result.failures.length },
      });
    return result;
  },
});

const scheduler = new ManualRenderLoopScheduler({ frameDriver: renderLoop });
const graphicsRuntime = new GraphicsRuntimeCoordinator({
  renderer: canvasRenderer,
  renderLoop,
  scheduler,
});

graphicsRuntime.start();

const renderInvalidator = createRenderInvalidator(
  () => {
    renderLoop.requestFrame();
    scheduler.step();
  },
  (render) => {
    window.requestAnimationFrame(render);
  },
);
invalidate = () => {
  renderInvalidator.invalidate();
};

const unsubscribeShellHotReload = window.genesisHost.onShellApplicationChanged(
  (applicationId, revision) => {
    const moduleUrl = createSystemApplicationModuleUrl(
      import.meta.url,
      applicationId,
      revision,
    );
    void import(moduleUrl)
      .then((moduleNamespace: unknown) =>
        runtime.shell.hotReload(
          resolveSystemApplicationModule(applicationId, moduleNamespace),
        ),
      )
      .then(() => {
        runtime.diagnostics.record({
          severity: "info",
          subsystem: "shell",
          event: "system-application.reloaded",
          message: `${applicationId} reloaded without restarting Runtime or Genesis.`,
        });
        renderInvalidator.invalidate();
      })
      .catch((error: unknown) => {
        runtime.diagnostics.record({
          severity: "error",
          subsystem: "shell",
          event: "system-application.reload-failed",
          message: error instanceof Error ? error.message : String(error),
        });
      });
  },
);
const unsubscribeApplicationHotReload =
  window.genesisHost.onDevelopmentApplicationChanged((packageJson) => {
    void Promise.resolve()
      .then(() => JSON.parse(packageJson) as SevynApplicationPackage)
      .then((applicationPackage) =>
        isolatedApplications.installDevelopmentPackage(applicationPackage),
      )
      .then(() => window.genesisHost.saveInstalledApplicationPackage(packageJson))
      .then(() => {
        runtime.diagnostics.record({
          severity: "info",
          subsystem: "application-worker",
          event: "development-application.reloaded",
          message: "Development application bundle reloaded in place.",
        });
        renderInvalidator.invalidate();
      })
      .catch((error: unknown) => {
        runtime.diagnostics.record({
          severity: "error",
          subsystem: "application-worker",
          event: "development-application.reload-failed",
          message: error instanceof Error ? error.message : "Reload failed.",
        });
      });
  });
for (const packageJson of await window.genesisHost.loadInstalledApplicationPackages()) {
  try {
    await isolatedApplications.installDevelopmentPackage(
      JSON.parse(packageJson) as SevynApplicationPackage,
    );
  } catch (error) {
    runtime.diagnostics.record({
      severity: "error",
      subsystem: "application-worker",
      event: "installed-application.load-failed",
      message:
        error instanceof Error ? error.message : "Installed package failed to load.",
    });
  }
}
const initialDevelopmentPackage =
  await window.genesisHost.loadDevelopmentApplicationPackage();
if (initialDevelopmentPackage !== undefined) {
  try {
    const parsedPackage = JSON.parse(
      initialDevelopmentPackage,
    ) as SevynApplicationPackage;
    await isolatedApplications.installDevelopmentPackage(parsedPackage);
    await window.genesisHost.saveInstalledApplicationPackage(initialDevelopmentPackage);
    await launchDesktopApplication(parsedPackage.manifest.id);
  } catch (error) {
    runtime.diagnostics.record({
      severity: "error",
      subsystem: "application-worker",
      event: "development-application.load-failed",
      message: error instanceof Error ? error.message : "Load failed.",
    });
  }
}

const unsubscribeRendering = runtime.subscribe(renderInvalidator.invalidate);

function dispatchPointerEvent(event: PointerEvent): void {
  runtime.dispatchPointerEvent(event);
}

function hitTestControl(x: number, y: number): WindowControlHit | undefined {
  const windowNodes =
    latestScene?.nodes.filter(
      (node): node is DesktopWindowSceneNode => node.kind === "desktop-window",
    ) ?? [];

  const ordered = [...windowNodes].sort((first, second) => second.order - first.order);

  for (const node of ordered) {
    for (const control of node.controls) {
      if (
        x >= control.x &&
        x < control.x + control.width &&
        y >= control.y &&
        y < control.y + control.height
      ) {
        return { windowId: node.windowId, control: control.kind };
      }
    }
  }

  return undefined;
}

function dispatchNativePointerAt(
  type: "enter" | "leave" | "down" | "up",
  event: PointerEvent,
): void {
  const target = latestScene?.nodes
    .filter(
      (node): node is DesktopWindowSceneNode =>
        node.kind === "desktop-window" && node.nativeSurface !== undefined,
    )
    .sort((first, second) => second.order - first.order)
    .find(
      (node) =>
        event.clientX >= node.base.bounds.x &&
        event.clientX < node.base.bounds.x + node.base.bounds.width &&
        event.clientY >= node.base.bounds.y + 46 &&
        event.clientY < node.base.bounds.y + node.base.bounds.height,
    );
  if (target === undefined) return;
  runtime.surfaces.dispatchNativePointer(target.windowId, type, {
    x: event.clientX,
    y: event.clientY,
    pointerId: event.pointerId,
    button: event.button,
  });
}

canvas.addEventListener("pointerdown", (event) => {
  const desktopControl = hitTestDesktopSceneControl(
    latestScene,
    event.clientX,
    event.clientY,
  );
  if (desktopControl !== undefined) {
    switch (desktopControl.kind) {
      case "desktop-launcher-button":
        runtime.applications.toggleLauncher();
        return;
      case "desktop-launcher-entry":
        void launchDesktopApplication(desktopControl.applicationId);
        return;
      case "desktop-taskbar-application":
        runtime.applications.activateTaskbarApplication(desktopControl.applicationId);
        return;
      case "desktop-window-switcher-entry":
        runtime.applications.selectSwitcherApplication(desktopControl.applicationId);
        return;
      case "desktop-lock-screen-unlock":
        runtime.applications.unlock();
        return;
      case "desktop-reset-action":
        void persistence.reset();
        return;
      case "desktop-workspace-control":
        runtime.environment.switchWorkspace(desktopControl.workspaceId);
        runtime.applications.synchronizeKeyboardFocus();
        return;
      case "desktop-workspace-action":
        void (
          desktopControl.action === "new-folder"
            ? runtime.createDesktopFolder()
            : runtime.createDesktopFile()
        ).catch((error: unknown) => {
          runtime.diagnostics.record({
            severity: "error",
            subsystem: "desktop",
            event: "desktop-item.create-failed",
            message: String(error),
          });
        });
        return;
      case "desktop-workspace-item":
        void runtime.applications.launch("org.sevynos.files");
        return;
      case "desktop-settings-control":
        if (desktopControl.action === "installer-launch") {
          runtime.diagnostics.record({
            severity: "info",
            subsystem: "installer",
            event: "installer.unavailable",
            message: "The SevynOS installer is available from Linux live media.",
          });
          return;
        }
        applySettingsAction(desktopControl.action);
        return;
      case "desktop-diagnostics-control": {
        if (desktopControl.action === "clear") runtime.diagnostics.clear();
        else if (desktopControl.action === "test")
          runtime.diagnostics.record({
            severity: "info",
            subsystem: "diagnostics",
            event: "diagnostics.test",
            message: "Safe diagnostic test event.",
          });
        else
          void window.genesisHost.exportDiagnostics(
            createDiagnosticsSnapshot({
              settings: runtime.settings.snapshot,
              displays: runtime.environment.listDisplays(),
              workspaces: {
                active: runtime.environment.activeWorkspace,
                count: runtime.environment.workspaceCount,
              },
              sessions: runtime.platformRuntime
                .listApplicationSessions()
                .filter((session) => !session.isTerminal()).length,
              windows: runtime.windows
                .listWindows()
                .filter((candidate) => candidate.state !== "closed").length,
              diagnostics: runtime.diagnostics,
            }),
          );
        renderInvalidator.invalidate();
        return;
      }
      case "desktop-recovery-control":
        if (desktopControl.action === "reset") {
          void persistence.reset().then(() => {
            runtime.recovery.clear();
          });
        } else void window.genesisHost.quitDesktop();
        return;
    }
  }
  const controlHit = hitTestControl(event.clientX, event.clientY);

  if (controlHit !== undefined) {
    void runtime.activateWindowControl(controlHit.windowId, controlHit.control, {
      x: 0,
      y: 0,
      width: viewport.width,
      height: Math.max(200, viewport.height - 88),
    });
    return;
  }

  canvas.setPointerCapture(event.pointerId);
  dispatchPointerEvent(event);
  dispatchNativePointerAt("down", event);
});

function applySettingsAction(
  action:
    | "theme"
    | "accent"
    | "taskbar-position"
    | "taskbar-behavior"
    | "display-layout"
    | "workspace-count"
    | "cursor-size"
    | "reduced-motion"
    | "restore-session",
): void {
  const settings = runtime.settings.snapshot;
  const next = <T>(values: readonly T[], current: T): T =>
    values[(values.indexOf(current) + 1) % values.length] ?? current;
  switch (action) {
    case "theme":
      runtime.settings.update({
        theme: next(["dark", "light", "system"] as const, settings.theme),
      });
      return;
    case "accent":
      runtime.settings.update({
        accentColor: next(
          ["#d5aa4e", "#6ea8fe", "#77d6a3", "#e879a9"] as const,
          settings.accentColor,
        ),
      });
      return;
    case "taskbar-position":
      runtime.settings.update({
        taskbarPosition: next(
          ["bottom", "top", "left", "right"] as const,
          settings.taskbarPosition,
        ),
      });
      return;
    case "taskbar-behavior":
      runtime.settings.update({
        taskbarBehavior:
          settings.taskbarBehavior === "always-visible" ? "auto-hide" : "always-visible",
      });
      return;
    case "display-layout":
      runtime.settings.update({
        displayLayout: next(
          ["side-by-side", "vertical", "offset"] as const,
          settings.displayLayout,
        ),
      });
      return;
    case "workspace-count":
      runtime.settings.update({
        workspaceCount: settings.workspaceCount === 8 ? 1 : settings.workspaceCount + 1,
      });
      return;
    case "cursor-size":
      runtime.settings.update({
        cursorSize: next([0.75, 1, 1.5, 2] as const, settings.cursorSize),
      });
      return;
    case "reduced-motion":
      runtime.settings.update({ reducedMotion: !settings.reducedMotion });
      return;
    case "restore-session":
      runtime.settings.update({
        restorePreviousSession: !settings.restorePreviousSession,
      });
  }
}

canvas.addEventListener("pointermove", (event) => {
  dispatchPointerEvent(event);
  dispatchNativePointerAt("enter", event);
});

canvas.addEventListener("pointerup", (event) => {
  dispatchPointerEvent(event);
  dispatchNativePointerAt("up", event);

  if (canvas.hasPointerCapture(event.pointerId)) {
    canvas.releasePointerCapture(event.pointerId);
  }
});

canvas.addEventListener("pointercancel", (event) => {
  dispatchPointerEvent(event);
  dispatchNativePointerAt("leave", event);

  if (canvas.hasPointerCapture(event.pointerId)) {
    canvas.releasePointerCapture(event.pointerId);
  }
});

canvas.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    runtime.dispatcher.dispatch(
      createWheelInputEvent({
        eventId: `desktop-wheel-${String(event.timeStamp)}`,
        deviceId: "desktop-mouse",
        deviceKind: "mouse",
        timestamp: event.timeStamp,
        position: { x: event.clientX, y: event.clientY },
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        deltaMode:
          event.deltaMode === 1 ? "line" : event.deltaMode === 2 ? "page" : "pixel",
      }),
    );
  },
  { passive: false },
);

window.addEventListener("keydown", (event) => {
  if (event.ctrlKey && event.altKey && event.code === "KeyL") {
    const modes = ["side-by-side", "vertical", "offset"] as const;
    const current = modes.indexOf(runtime.environment.layoutMode);
    const next = modes[(current + 1) % modes.length];
    if (next !== undefined)
      runtime.layout.configureViewport(
        viewport.width,
        viewport.height,
        viewport.scaleFactor,
        next,
      );
    event.preventDefault();
    return;
  }
  if (
    event.ctrlKey &&
    event.altKey &&
    (event.code === "ArrowLeft" || event.code === "ArrowRight")
  ) {
    const focused = runtime.windows
      .listWindows()
      .find((candidate) => candidate.state === "focused");
    if (focused !== undefined) {
      const displays = runtime.environment.listDisplays();
      const current = runtime.environment.getDisplayForBounds(focused.bounds);
      const currentIndex = displays.findIndex((display) => display.id === current.id);
      const direction = event.code === "ArrowRight" ? 1 : -1;
      const destination =
        displays[(currentIndex + direction + displays.length) % displays.length];
      if (destination !== undefined)
        runtime.environment.moveWindowToDisplay(focused.id, destination.id);
    }
    event.preventDefault();
    return;
  }
  if (event.ctrlKey && event.shiftKey && /^Digit[1-4]$/.test(event.code)) {
    const workspaceId = `workspace-${event.code.slice(-1)}` as
      "workspace-1" | "workspace-2" | "workspace-3" | "workspace-4";
    const focused = runtime.windows
      .listWindows()
      .find((candidate) => candidate.state === "focused");
    if (focused !== undefined)
      runtime.environment.moveWindowToWorkspace(focused.id, workspaceId);
    event.preventDefault();
    return;
  }
  runtime.dispatchKeyboardEvent(event);

  if (event.key === "Backspace" || event.key === "Enter" || event.key === "Escape") {
    event.preventDefault();
  }
});

window.addEventListener("keyup", (event) => {
  runtime.dispatchKeyboardEvent(event);
});

window.addEventListener("resize", () => {
  viewport = readViewport();
  configureDesktopDisplay();
  renderInvalidator.invalidate();
});

let shuttingDown = false;
const removeShutdownListener = window.genesisHost.onShutdownRequested(() => {
  if (shuttingDown) return;
  shuttingDown = true;
  void (async (): Promise<void> => {
    runtime.beginShutdown();
    await persistence.flush();
    await isolatedApplications.shutdown();
    persistence.disconnect();
    await runtime.closeForShutdown();
    graphicsRuntime.stop();
    unsubscribeShellHotReload();
    unsubscribeApplicationHotReload();
    unsubscribeRendering();
    removeShutdownListener();
    await window.genesisHost.completeShutdown();
  })();
});

renderInvalidator.invalidate();
