export interface SurfaceSize {
  readonly width: number;
  readonly height: number;
}

export function validateSurfaceSize(size: SurfaceSize): void {
  if (!Number.isInteger(size.width) || size.width <= 0) {
    throw new RangeError("Surface width must be a positive integer.");
  }

  if (!Number.isInteger(size.height) || size.height <= 0) {
    throw new RangeError("Surface height must be a positive integer.");
  }
}
