import type { CursorKind } from "./cursor-kind.js";
import type { CursorManager } from "./cursor-manager.js";
import type { PointerInputEvent } from "./pointer-input-event.js";
import type { WindowHitTester } from "./window-hit-tester.js";
import type { WindowResizeEdge } from "./window-resize-edge.js";
import type { WindowResizeEdgeDetector } from "./window-resize-edge-detector.js";

export interface CursorWindowDragRuntime {
  isDragging(pointerId: number): boolean;
}

export interface CursorWindowResizeRuntime {
  isResizing(pointerId: number): boolean;

  getResizeEdge(pointerId: number): WindowResizeEdge | undefined;
}

export interface DesktopCursorRuntimeDependencies {
  readonly cursorManager: CursorManager;

  readonly hitTester: WindowHitTester;

  readonly edgeDetector: WindowResizeEdgeDetector;

  readonly dragRuntime: CursorWindowDragRuntime;

  readonly resizeRuntime: CursorWindowResizeRuntime;
}

export class DesktopCursorRuntime {
  readonly #cursorManager: CursorManager;

  readonly #hitTester: WindowHitTester;

  readonly #edgeDetector: WindowResizeEdgeDetector;

  readonly #dragRuntime: CursorWindowDragRuntime;

  readonly #resizeRuntime: CursorWindowResizeRuntime;

  public constructor(dependencies: DesktopCursorRuntimeDependencies) {
    this.#cursorManager = dependencies.cursorManager;

    this.#hitTester = dependencies.hitTester;

    this.#edgeDetector = dependencies.edgeDetector;

    this.#dragRuntime = dependencies.dragRuntime;

    this.#resizeRuntime = dependencies.resizeRuntime;
  }

  public handlePointerEvent(event: PointerInputEvent): CursorKind {
    const kind = this.#resolveCursorKind(event);

    this.#cursorManager.update({
      kind,

      position: event.position,
    });

    return kind;
  }

  #resolveCursorKind(event: PointerInputEvent): CursorKind {
    if (this.#resizeRuntime.isResizing(event.pointerId)) {
      return this.#resolveActiveResizeCursor(event.pointerId);
    }

    if (this.#dragRuntime.isDragging(event.pointerId)) {
      return "move";
    }

    const hit = this.#hitTester.hitTest(event.position);

    if (hit === undefined) {
      return "default";
    }

    const edge = this.#edgeDetector.detect(event.position, hit.window.bounds);

    if (edge === undefined) {
      return "default";
    }

    return this.#cursorForEdge(edge);
  }

  #resolveActiveResizeCursor(pointerId: number): CursorKind {
    const edge = this.#resizeRuntime.getResizeEdge(pointerId);

    if (edge === undefined) {
      return "default";
    }

    return this.#cursorForEdge(edge);
  }

  #cursorForEdge(edge: WindowResizeEdge): CursorKind {
    switch (edge) {
      case "left":
      case "right":
        return "resize-ew";

      case "top":
      case "bottom":
        return "resize-ns";

      case "top-left":
      case "bottom-right":
        return "resize-nwse";

      case "top-right":
      case "bottom-left":
        return "resize-nesw";
    }
  }
}
