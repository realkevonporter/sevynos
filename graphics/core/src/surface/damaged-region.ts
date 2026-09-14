import type { SurfaceSize } from "./surface-size.js";

export interface DamagedRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export function validateDamagedRegion(
  region: DamagedRegion,
  surfaceSize: SurfaceSize,
): void {
  if (!Number.isInteger(region.x) || region.x < 0) {
    throw new RangeError("Damaged region x must be a non-negative integer.");
  }

  if (!Number.isInteger(region.y) || region.y < 0) {
    throw new RangeError("Damaged region y must be a non-negative integer.");
  }

  if (!Number.isInteger(region.width) || region.width <= 0) {
    throw new RangeError("Damaged region width must be a positive integer.");
  }

  if (!Number.isInteger(region.height) || region.height <= 0) {
    throw new RangeError("Damaged region height must be a positive integer.");
  }

  if (region.x + region.width > surfaceSize.width) {
    throw new RangeError("Damaged region exceeds the surface width.");
  }

  if (region.y + region.height > surfaceSize.height) {
    throw new RangeError("Damaged region exceeds the surface height.");
  }
}
