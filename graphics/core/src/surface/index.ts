export { GenesisSurface } from "./genesis-surface.js";

export type { GenesisSurfaceProperties } from "./genesis-surface.js";

export type { DamagedRegion } from "./damaged-region.js";

export { validateDamagedRegion } from "./damaged-region.js";

export type { PixelFormat } from "./pixel-format.js";

export type { SurfaceId } from "./surface-id.js";

export type { SurfaceSize } from "./surface-size.js";

export { validateSurfaceSize } from "./surface-size.js";

export type { SurfaceState } from "./surface-state.js";

export { SurfaceRegistry } from "./surface-registry.js";

export { SurfaceAlreadyExistsError } from "../errors/surface-already-exists-error.js";

export { SurfaceNotFoundError } from "../errors/surface-not-found-error.js";

export { GenesisSurfaceManager } from "./genesis-surface-manager.js";

export type {
  CreateSurfaceRequest,
  GenesisSurfaceManagerDependencies,
} from "./genesis-surface-manager.js";
