export { createDesktopRuntime, type DesktopRuntime } from "./desktop-runtime.js";
export { DesktopSceneComposer } from "./desktop-scene-composer.js";
export {
  DesktopSessionManager,
  GUEST_USERNAME,
  type DesktopSessionCallbacks,
  type SessionUser,
  type UnlockAttemptResult,
} from "./desktop-session.js";
export { UserScopedFileSystem } from "./user-scoped-file-system.js";
export type {
  DesktopScene,
  DesktopViewport,
  DesktopWindowSceneNode,
} from "./desktop-scene.js";
export { hitTestDesktopSceneControl } from "./desktop-scene-hit-testing.js";
export { RuntimeDiagnosticsService } from "./runtime-diagnostics.js";
export {
  DesktopIsolatedApplicationCoordinator,
  type IsolatedApplicationServiceProvider,
} from "./isolated-application-coordinator.js";
export {
  DEFAULT_DESKTOP_SETTINGS,
  DesktopSettingsService,
  validateDesktopSettings,
  type DesktopSettings,
  type DesktopSettingsAdapter,
} from "./desktop-settings.js";
export {
  DesktopPersistenceController,
  restoreDesktopSession,
  validateDesktopSession,
  type DesktopPersistenceAdapter,
  type PersistedDesktopSessionV1,
} from "./desktop-persistence.js";
export {
  createRenderInvalidator,
  type RenderInvalidator,
  type RenderScheduler,
} from "./render-invalidator.js";
export { createDiagnosticsSnapshot } from "./runtime-diagnostics.js";
export {
  WindowAnimationController,
  type WindowAnimationTransform,
  type WindowAnimationKind,
} from "./window-animation-controller.js";
