/**
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Rubber-band / marquee select (gap unit 14, audit #23).
 *
 * Pure rectangle math plus the `useMarqueeSelection` hook, shared by
 * the Files list and the desktop: both drag a selection rectangle
 * over empty space and multi-select what it touches. The hook owns
 * only the drag lifecycle (press → move → release); each surface
 * owns its coordinate conversion (pointer coords are window coords —
 * the Files list subtracts its origin and adds its scroll offset,
 * the desktop subtracts the top bar) and its item rectangles.
 *
 * The renderer is the enabling primitive: an `onPress` now carries
 * the press position (`PressEvent.nativeEvent.x/y`), motion arrives
 * through `subscribePointerMove`, and the release — or the pointer
 * leaving the surface — through `subscribePointerUp`. A press that
 * starts on an item never reaches the hook (the item's own onPress
 * wins the hit-test), so a marquee can only start from empty space.
 * A marquee over nothing behaves like a click on empty space.
 */

import * as React from "react";
import {
  subscribePointerMove,
  subscribePointerUp,
  type PressEvent,
} from "./sevyn-renderer";
import {
  applyMarqueeSelection,
  type PressModifiers,
  type SelectionState,
} from "./selection";

export interface MarqueePoint {
  readonly x: number;
  readonly y: number;
}

export interface MarqueeRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A press must move this far (either axis) before it becomes a drag. */
export const MARQUEE_THRESHOLD_PX = 4;

/**
 * The rubber-band fill: violet (the default accent — the accent is
 * the selection signal) at ~15% alpha, as 8-digit hex, the
 * convention the renderer already uses for transparent rects. The
 * renderer has no borderWidth/borderColor, so the band is fill-only.
 */
export const MARQUEE_FILL = "#5B5BD626";

/** The rectangle spanning two pointer points, whatever the drag direction. */
export function normalizeRect(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): MarqueeRect {
  return {
    x: Math.min(x0, x1),
    y: Math.min(y0, y1),
    width: Math.abs(x1 - x0),
    height: Math.abs(y1 - y0),
  };
}

/** True when the two rects overlap by more than an edge touch. */
export function rectsIntersect(a: MarqueeRect, b: MarqueeRect): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

/** The indices of the rects the marquee touches, in array order. */
export function indicesInRect(
  rects: readonly MarqueeRect[],
  rect: MarqueeRect,
): number[] {
  const hit: number[] = [];
  for (let i = 0; i < rects.length; i += 1) {
    if (rectsIntersect(rect, rects[i])) hit.push(i);
  }
  return hit;
}

export interface MarqueeSelectionOptions {
  /** The live selection (read at press time — the snapshot). */
  readonly selection: SelectionState;
  /** Sets the selection (preview during the drag, commit on release). */
  readonly onSelection: (next: SelectionState) => void;
  /** The item names, in listing order. */
  readonly names: readonly string[];
  /**
   * The indices the rect touches, in the surface's own coordinates.
   * Called with the raw pointer-space rect on every move and once
   * on release; read scroll offsets from a ref at call time, never
   * from a captured value.
   */
  readonly indicesForRect: (rect: MarqueeRect) => number[];
  /**
   * The press turned out to be a click (released without dragging).
   * The surface keeps its click behaviour here — Files clears the
   * selection; the desktop does nothing.
   */
  readonly onClick?: (modifiers: PressModifiers) => void;
}

export interface MarqueeDrag {
  /** The live band rect, in pointer (window) coordinates. */
  readonly dragRect: MarqueeRect | null;
  /**
   * Start a marquee from a surface `onPress`. Without a pointer
   * position (keyboard activation) this is a click at once — no drag
   * is possible — so `onClick` runs and nothing subscribes.
   */
  readonly begin: (ev: PressEvent) => void;
}

interface ActiveDrag {
  readonly start: MarqueePoint;
  readonly modifiers: PressModifiers;
  readonly snapshot: SelectionState;
  current: MarqueePoint;
  rect: MarqueeRect | null;
  active: boolean;
  // Filled in right after creation: the subscriptions close over the
  // drag, and the drag must carry the unsubscribers so the up
  // handler (or an unmount) can remove both.
  unsubMove: () => void;
  unsubUp: () => void;
}

/**
 * The marquee drag lifecycle for one surface. The selection
 * live-previews during the drag (computed against the press-time
 * snapshot, so repeated moves never accumulate) and stands on
 * release; a press released without dragging is a click.
 */
export function useMarqueeSelection(options: MarqueeSelectionOptions): MarqueeDrag {
  const dragRef = React.useRef<ActiveDrag | null>(null);
  const [dragRect, setDragRect] = React.useState<MarqueeRect | null>(null);

  // A drag left subscribed by an unmount mid-gesture must not keep
  // firing into a dead component.
  React.useEffect(
    () => () => {
      const drag = dragRef.current;
      if (drag) {
        drag.unsubMove();
        drag.unsubUp();
        dragRef.current = null;
      }
    },
    [],
  );

  const begin = React.useCallback(
    (ev: PressEvent) => {
      const native = ev.nativeEvent;
      const modifiers: PressModifiers = {
        shiftKey: native.shiftKey,
        ctrlKey: native.ctrlKey,
        metaKey: native.metaKey,
      };
      if (typeof native.x !== "number" || typeof native.y !== "number") {
        options.onClick?.(modifiers);
        return;
      }
      if (dragRef.current) return;
      const drag: ActiveDrag = {
        start: { x: native.x, y: native.y },
        modifiers,
        snapshot: options.selection,
        current: { x: native.x, y: native.y },
        rect: null,
        active: false,
        unsubMove: () => {},
        unsubUp: () => {},
      };
      dragRef.current = drag;
      const unsubMove = subscribePointerMove((move) => {
        const live = dragRef.current;
        if (!live) return false;
        // A leave arrives as far-off motion before the up event; it
        // is not a position, so it must not move the band.
        if (move.x < 0 || move.y < 0) return false;
        live.current = { x: move.x, y: move.y };
        const rect = normalizeRect(
          live.start.x,
          live.start.y,
          live.current.x,
          live.current.y,
        );
        if (
          Math.abs(live.current.x - live.start.x) < MARQUEE_THRESHOLD_PX &&
          Math.abs(live.current.y - live.start.y) < MARQUEE_THRESHOLD_PX
        ) {
          return false;
        }
        if (
          live.rect &&
          live.rect.x === rect.x &&
          live.rect.y === rect.y &&
          live.rect.width === rect.width &&
          live.rect.height === rect.height
        ) {
          return false;
        }
        live.active = true;
        live.rect = rect;
        setDragRect(rect);
        options.onSelection(
          applyMarqueeSelection(
            options.names,
            live.snapshot,
            options.indicesForRect(rect),
            live.modifiers,
          ),
        );
        return true;
      });
      const unsubUp = subscribePointerUp(() => {
        const live = dragRef.current;
        if (!live) return false;
        dragRef.current = null;
        live.unsubMove();
        live.unsubUp();
        if (live.active && live.rect) {
          // The live preview already stands; apply it once more
          // against the snapshot for the final rect so the commit
          // is exact, then clear the band.
          setDragRect(null);
          options.onSelection(
            applyMarqueeSelection(
              options.names,
              live.snapshot,
              options.indicesForRect(live.rect),
              live.modifiers,
            ),
          );
        } else {
          options.onClick?.(live.modifiers);
        }
        return true;
      });
      drag.unsubMove = unsubMove;
      drag.unsubUp = unsubUp;
    },
    [options],
  );

  return { dragRect, begin };
}
