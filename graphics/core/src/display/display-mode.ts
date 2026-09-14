export interface DisplayMode {
  readonly width: number;

  readonly height: number;

  readonly refreshRate: number;
}

export function validateDisplayMode(mode: DisplayMode): void {
  if (!Number.isInteger(mode.width) || mode.width <= 0) {
    throw new RangeError("Display mode width must be a positive integer.");
  }

  if (!Number.isInteger(mode.height) || mode.height <= 0) {
    throw new RangeError("Display mode height must be a positive integer.");
  }

  if (!Number.isFinite(mode.refreshRate) || mode.refreshRate <= 0) {
    throw new RangeError("Display mode refresh rate must be a positive finite number.");
  }
}
