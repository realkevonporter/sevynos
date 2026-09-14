import type { PointerInputEvent } from "./pointer-input-event.js";
import type { ActiveWindowDrag } from "./window-drag-state.js";
import type { ActiveWindowResize } from "./window-resize-state.js";

export interface DesktopPointerFocusController {
  handlePointerEvent(event: PointerInputEvent): unknown;
}

export interface DesktopWindowDragRuntime {
  isDragging(pointerId: number): boolean;

  handlePointerEvent(event: PointerInputEvent): void;

  cancelAll(): readonly ActiveWindowDrag[];
}

export interface DesktopWindowResizeRuntime {
  isResizing(pointerId: number): boolean;

  handlePointerEvent(event: PointerInputEvent): void;

  cancelAll(): readonly ActiveWindowResize[];
}
