export interface DisplayBounds {
  readonly x: number;
  readonly y: number;

  readonly width: number;
  readonly height: number;
}

export function validateDisplayBounds(bounds: DisplayBounds): void {
  if (!Number.isInteger(bounds.x)) {
    throw new TypeError("Display bounds x must be an integer.");
  }

  if (!Number.isInteger(bounds.y)) {
    throw new TypeError("Display bounds y must be an integer.");
  }

  if (!Number.isInteger(bounds.width) || bounds.width <= 0) {
    throw new RangeError("Display bounds width must be a positive integer.");
  }

  if (!Number.isInteger(bounds.height) || bounds.height <= 0) {
    throw new RangeError("Display bounds height must be a positive integer.");
  }
}
