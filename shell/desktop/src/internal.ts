export {
  ApplicationSurfaceRegistry,
  type DesktopApplicationSurface,
  type SystemMonitorSnapshot,
} from "./application-surfaces.js";
export type {
  DesktopCursorSceneNode,
  DesktopScene,
  DesktopSceneNode,
  DesktopStatusBarSceneNode,
  DesktopViewport,
  DesktopWindowSceneNode,
} from "./desktop-scene.js";
export { getWindowControlRects } from "./window-controls.js";
export type {
  WindowControlHit,
  WindowControlKind,
  WindowControlRect,
} from "./window-controls.js";
export { decodeWorkerSurface } from "./worker-surface-decoder.js";
export {
  DESKTOP_VISUAL_METRICS,
  resolveDesktopAppearance,
  type DesktopAppearance,
  type DesktopShadowAppearance,
  type DesktopWindowAppearance,
} from "./desktop-appearance.js";
