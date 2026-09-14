export interface HitTestPoint {
  readonly x: number;
  readonly y: number;
}

export function createHitTestPoint(point: HitTestPoint): HitTestPoint {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new RangeError("Hit-test coordinates must be finite numbers.");
  }

  return Object.freeze({
    x: point.x,
    y: point.y,
  });
}
