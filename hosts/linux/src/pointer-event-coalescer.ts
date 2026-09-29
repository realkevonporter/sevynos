import type { PointerInputEvent } from "@sevynos/input";

export interface PointerEventCoalescerOptions {
  readonly dispatch: (event: PointerInputEvent) => void;
  readonly schedule?: (callback: () => void) => unknown;
  readonly cancel?: (handle: unknown) => void;
  /**
   * Minimum milliseconds between dispatched pointer-move events.
   * Hover effects (like dock magnification) don't need 60fps updates;
   * throttling reduces full-frame software rasterization load.
   * Defaults to 0 (no throttling). Button events are never throttled.
   */
  readonly hoverThrottleMs?: number;
  readonly now?: () => number;
}

export class PointerEventCoalescer {
  readonly #dispatch: (event: PointerInputEvent) => void;
  readonly #schedule: (callback: () => void) => unknown;
  readonly #cancel: (handle: unknown) => void;
  readonly #hoverThrottleMs: number;
  readonly #now: () => number;
  #pendingMotion: PointerInputEvent | undefined;
  #handle: unknown;
  #scheduled = false;
  #lastMoveDispatch = 0;

  public constructor(options: PointerEventCoalescerOptions) {
    this.#dispatch = options.dispatch;
    this.#hoverThrottleMs = options.hoverThrottleMs ?? 0;
    this.#now = options.now ?? (() => Date.now());
    this.#schedule =
      options.schedule ??
      ((callback) => {
        let active = true;
        queueMicrotask(() => {
          if (active) callback();
        });
        return {
          cancel: () => {
            active = false;
          },
        };
      });
    this.#cancel =
      options.cancel ??
      ((handle) => {
        if (typeof handle === "object" && handle !== null && "cancel" in handle) {
          (handle as { cancel: () => void }).cancel();
        } else {
          globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>);
        }
      });
  }

  public push(event: PointerInputEvent): void {
    if (event.type !== "pointer-move") {
      this.flush();
      this.#dispatch(event);
      return;
    }
    this.#pendingMotion = event;
    if (this.#scheduled) return;
    const now = this.#now();
    const elapsed = now - this.#lastMoveDispatch;
    // Throttle hover moves: if we dispatched recently, schedule the flush
    // for when the throttle window expires instead of dropping the event.
    // The pending motion always holds the latest position.
    if (this.#hoverThrottleMs > 0 && elapsed < this.#hoverThrottleMs) {
      const delayMs = this.#hoverThrottleMs - elapsed;
      this.#scheduled = true;
      this.#handle = setTimeout(() => {
        this.#scheduled = false;
        this.#handle = undefined;
        this.flush();
      }, delayMs);
      return;
    }
    this.#scheduled = true;
    this.#handle = this.#schedule(() => {
      this.#scheduled = false;
      this.#handle = undefined;
      this.flush();
    });
  }

  public flush(): void {
    this.#scheduled = false;
    if (this.#handle !== undefined) this.#cancel(this.#handle);
    this.#handle = undefined;
    const motion = this.#pendingMotion;
    this.#pendingMotion = undefined;
    if (motion !== undefined) {
      this.#lastMoveDispatch = this.#now();
      this.#dispatch(motion);
    }
  }

  public close(): void {
    this.#scheduled = false;
    if (this.#handle !== undefined) this.#cancel(this.#handle);
    this.#handle = undefined;
    this.#pendingMotion = undefined;
  }

  public get pendingMotion(): boolean {
    return this.#pendingMotion !== undefined;
  }
}
