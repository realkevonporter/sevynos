import type { PointerInputEvent } from "@sevynos/input";

export interface PointerEventCoalescerOptions {
  readonly dispatch: (event: PointerInputEvent) => void;
  readonly schedule?: (callback: () => void) => unknown;
  readonly cancel?: (handle: unknown) => void;
}

export class PointerEventCoalescer {
  readonly #dispatch: (event: PointerInputEvent) => void;
  readonly #schedule: (callback: () => void) => unknown;
  readonly #cancel: (handle: unknown) => void;
  #pendingMotion: PointerInputEvent | undefined;
  #handle: unknown;
  #scheduled = false;

  public constructor(options: PointerEventCoalescerOptions) {
    this.#dispatch = options.dispatch;
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
    if (motion !== undefined) this.#dispatch(motion);
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
