import type { GenesisWindow, GenesisWindowId } from "@sevynos/graphics";

export type WindowControlKind = "minimize" | "maximize" | "restore" | "close";

export interface WindowControlRect {
  readonly kind: WindowControlKind;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface DesktopPoint {
  readonly x: number;
  readonly y: number;
}

export interface WindowControlHit {
  readonly windowId: GenesisWindowId;
  readonly control: WindowControlKind;
}

const CONTROL_SIZE = 28;
const CONTROL_GAP = 6;
const CONTROL_RIGHT_INSET = 10;
const CONTROL_TOP_INSET = 9;

const CONTROL_ORDER: readonly WindowControlKind[] = [
  "close",
  "restore",
  "maximize",
  "minimize",
];

export function getWindowControlRects(
  window: GenesisWindow,
): readonly WindowControlRect[] {
  return CONTROL_ORDER.map((kind, index) => ({
    kind,
    x:
      window.bounds.x +
      window.bounds.width -
      CONTROL_RIGHT_INSET -
      CONTROL_SIZE -
      index * (CONTROL_SIZE + CONTROL_GAP),
    y: window.bounds.y + CONTROL_TOP_INSET,
    width: CONTROL_SIZE,
    height: CONTROL_SIZE,
  }));
}

export function hitTestWindowControl(
  windows: readonly GenesisWindow[],
  point: DesktopPoint,
): WindowControlHit | undefined {
  const ordered = [...windows].sort((first, second) => second.zIndex - first.zIndex);

  for (const window of ordered) {
    for (const control of getWindowControlRects(window)) {
      if (containsPoint(control, point)) {
        return { windowId: window.id, control: control.kind };
      }
    }
  }

  return undefined;
}

export function isPointInWindowControlRegion(
  window: GenesisWindow,
  localPoint: DesktopPoint,
): boolean {
  const desktopPoint = {
    x: window.bounds.x + localPoint.x,
    y: window.bounds.y + localPoint.y,
  };

  return getWindowControlRects(window).some((control) =>
    containsPoint(control, desktopPoint),
  );
}

function containsPoint(rect: WindowControlRect, point: DesktopPoint): boolean {
  return (
    point.x >= rect.x &&
    point.x < rect.x + rect.width &&
    point.y >= rect.y &&
    point.y < rect.y + rect.height
  );
}
