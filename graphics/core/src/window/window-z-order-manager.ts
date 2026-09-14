import type { GenesisWindow, GenesisWindowId } from "./genesis-window.js";
import type { WindowRegistry } from "./window-registry.js";
import type {
  WindowZOrderManagerEvent,
  WindowZOrderManagerEventListener,
  WindowZOrderOperation,
} from "./window-z-order-events.js";

export interface WindowZOrderManagerDependencies {
  readonly windows: WindowRegistry;

  readonly now: () => Date;

  readonly onEvent?: WindowZOrderManagerEventListener;
}

export class WindowZOrderManager {
  readonly #windows: WindowRegistry;

  readonly #now: () => Date;

  readonly #onEvent: WindowZOrderManagerEventListener | undefined;

  public constructor(dependencies: WindowZOrderManagerDependencies) {
    this.#windows = dependencies.windows;

    this.#now = dependencies.now;

    this.#onEvent = dependencies.onEvent;
  }

  public bringToFront(windowId: GenesisWindowId): GenesisWindow {
    this.#requireStackableWindow(windowId);

    this.#applyOrder(
      this.#moveToEnd(this.#getOrderedWindows(), windowId),
      "bring-to-front",
      windowId,
      null,
    );

    return this.#requireWindow(windowId);
  }

  public sendToBack(windowId: GenesisWindowId): GenesisWindow {
    this.#requireStackableWindow(windowId);

    this.#applyOrder(
      this.#moveToStart(this.#getOrderedWindows(), windowId),
      "send-to-back",
      windowId,
      null,
    );

    return this.#requireWindow(windowId);
  }

  public raiseAbove(
    windowId: GenesisWindowId,
    relativeWindowId: GenesisWindowId,
  ): GenesisWindow {
    this.#assertDistinctWindows(windowId, relativeWindowId);

    this.#requireStackableWindow(windowId);

    this.#requireStackableWindow(relativeWindowId);

    const ordered = this.#removeWindow(this.#getOrderedWindows(), windowId);

    const relativeIndex = ordered.findIndex((window) => window.id === relativeWindowId);

    ordered.splice(relativeIndex + 1, 0, this.#requireWindow(windowId));

    this.#applyOrder(ordered, "raise-above", windowId, relativeWindowId);

    return this.#requireWindow(windowId);
  }

  public lowerBelow(
    windowId: GenesisWindowId,
    relativeWindowId: GenesisWindowId,
  ): GenesisWindow {
    this.#assertDistinctWindows(windowId, relativeWindowId);

    this.#requireStackableWindow(windowId);

    this.#requireStackableWindow(relativeWindowId);

    const ordered = this.#removeWindow(this.#getOrderedWindows(), windowId);

    const relativeIndex = ordered.findIndex((window) => window.id === relativeWindowId);

    ordered.splice(relativeIndex, 0, this.#requireWindow(windowId));

    this.#applyOrder(ordered, "lower-below", windowId, relativeWindowId);

    return this.#requireWindow(windowId);
  }

  public normalize(): readonly GenesisWindow[] {
    const ordered = this.#getOrderedWindows();

    this.#applyOrder(ordered, "normalize", null, null);

    return Object.freeze(ordered.map((window) => this.#requireWindow(window.id)));
  }

  public list(): readonly GenesisWindow[] {
    return Object.freeze([...this.#getOrderedWindows()]);
  }

  public getTopWindow(): GenesisWindow | undefined {
    return this.#getOrderedWindows().at(-1);
  }

  #getOrderedWindows(): GenesisWindow[] {
    return this.#windows
      .list()
      .filter((window) => this.#isStackable(window))
      .sort((first, second) => {
        if (first.zIndex !== second.zIndex) {
          return first.zIndex - second.zIndex;
        }

        return first.id.localeCompare(second.id);
      });
  }

  #applyOrder(
    ordered: readonly GenesisWindow[],
    operation: WindowZOrderOperation,
    windowId: GenesisWindowId | null,
    relativeWindowId: GenesisWindowId | null,
  ): void {
    ordered.forEach((window, index) => {
      const targetZIndex = index + 1;

      if (window.zIndex === targetZIndex) {
        return;
      }

      this.#windows.update(window.withZIndex(targetZIndex, this.#now()));
    });

    this.#emit({
      type: "window-z-order-changed",

      operation,

      windowId,

      relativeWindowId,

      orderedWindowIds: Object.freeze(ordered.map((window) => window.id)),
    });
  }

  #moveToEnd(
    ordered: readonly GenesisWindow[],
    windowId: GenesisWindowId,
  ): GenesisWindow[] {
    const result = this.#removeWindow(ordered, windowId);

    result.push(this.#requireWindow(windowId));

    return result;
  }

  #moveToStart(
    ordered: readonly GenesisWindow[],
    windowId: GenesisWindowId,
  ): GenesisWindow[] {
    return [this.#requireWindow(windowId), ...this.#removeWindow(ordered, windowId)];
  }

  #removeWindow(
    ordered: readonly GenesisWindow[],
    windowId: GenesisWindowId,
  ): GenesisWindow[] {
    return ordered.filter((window) => window.id !== windowId);
  }

  #requireStackableWindow(windowId: GenesisWindowId): GenesisWindow {
    const window = this.#requireWindow(windowId);

    if (!this.#isStackable(window)) {
      throw new Error(
        `Window "${windowId}" cannot participate in z-order from state "${window.state}".`,
      );
    }

    return window;
  }

  #requireWindow(windowId: GenesisWindowId): GenesisWindow {
    const window = this.#windows.get(windowId);

    if (window === undefined) {
      throw new Error(`Window "${windowId}" was not found.`);
    }

    return window;
  }

  #assertDistinctWindows(
    windowId: GenesisWindowId,
    relativeWindowId: GenesisWindowId,
  ): void {
    if (windowId === relativeWindowId) {
      throw new Error(`Window "${windowId}" cannot be ordered relative to itself.`);
    }
  }

  #isStackable(window: GenesisWindow): boolean {
    return window.state !== "closing" && window.state !== "closed";
  }

  #emit(event: WindowZOrderManagerEvent): void {
    this.#onEvent?.(event);
  }
}
