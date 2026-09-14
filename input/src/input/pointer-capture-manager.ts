import {
  PointerAlreadyCapturedError,
  PointerCaptureNotFoundError,
  PointerCaptureTargetMismatchError,
} from "../errors/pointer-capture-errors.js";
import type { FocusTargetId } from "./focus-state.js";
import {
  PointerCapture,
  type PointerCaptureId,
  type PointerCaptureReleaseReason,
} from "./pointer-capture.js";
import type {
  PointerCaptureManagerEvent,
  PointerCaptureManagerEventListener,
} from "./pointer-capture-events.js";
import type { PointerInputEvent } from "./pointer-input-event.js";

export interface PointerCaptureManagerDependencies {
  readonly now: () => number;

  readonly onEvent?: PointerCaptureManagerEventListener;
}

export class PointerCaptureManager {
  readonly #captures = new Map<PointerCaptureId, PointerCapture>();

  readonly #now: () => number;

  readonly #onEvent: PointerCaptureManagerEventListener | undefined;

  public constructor(dependencies: PointerCaptureManagerDependencies) {
    this.#now = dependencies.now;

    this.#onEvent = dependencies.onEvent;
  }

  public get size(): number {
    return this.#captures.size;
  }

  public capture(pointerId: PointerCaptureId, targetId: FocusTargetId): PointerCapture {
    const existing = this.#captures.get(pointerId);

    if (existing !== undefined) {
      throw new PointerAlreadyCapturedError(pointerId, existing.targetId);
    }

    const capture = new PointerCapture({
      pointerId,

      targetId,

      capturedAt: this.#now(),
    });

    this.#captures.set(pointerId, capture);

    this.#emit({
      type: "pointer-captured",

      capture,
    });

    return capture;
  }

  public get(pointerId: PointerCaptureId): PointerCapture | undefined {
    return this.#captures.get(pointerId);
  }

  public require(pointerId: PointerCaptureId): PointerCapture {
    const capture = this.get(pointerId);

    if (capture === undefined) {
      throw new PointerCaptureNotFoundError(pointerId);
    }

    return capture;
  }

  public has(pointerId: PointerCaptureId): boolean {
    return this.#captures.has(pointerId);
  }

  public isCapturedBy(pointerId: PointerCaptureId, targetId: FocusTargetId): boolean {
    return this.#captures.get(pointerId)?.targetId === targetId;
  }

  public list(): readonly PointerCapture[] {
    return Object.freeze([...this.#captures.values()]);
  }

  public release(
    pointerId: PointerCaptureId,
    reason: PointerCaptureReleaseReason = "explicit",
  ): PointerCapture {
    const capture = this.require(pointerId);

    this.#captures.delete(pointerId);

    this.#emit({
      type: "pointer-capture-released",

      capture,

      reason,
    });

    return capture;
  }

  public releaseForTarget(targetId: FocusTargetId): readonly PointerCapture[] {
    const released: PointerCapture[] = [];

    for (const capture of this.#captures.values()) {
      if (capture.targetId !== targetId) {
        continue;
      }

      this.#captures.delete(capture.pointerId);

      released.push(capture);

      this.#emit({
        type: "pointer-capture-released",

        capture,

        reason: "target-removed",
      });
    }

    const immutableReleased = Object.freeze([...released]);

    if (immutableReleased.length > 0) {
      this.#emit({
        type: "pointer-capture-target-released",

        targetId,

        pointerIds: Object.freeze(immutableReleased.map((capture) => capture.pointerId)),

        reason: "target-removed",
      });
    }

    return immutableReleased;
  }

  public clear(): readonly PointerCapture[] {
    const captures = this.list();

    this.#captures.clear();

    for (const capture of captures) {
      this.#emit({
        type: "pointer-capture-released",

        capture,

        reason: "clear",
      });
    }

    return captures;
  }

  public assertCapturedBy(
    pointerId: PointerCaptureId,
    targetId: FocusTargetId,
  ): PointerCapture {
    const capture = this.require(pointerId);

    if (capture.targetId !== targetId) {
      throw new PointerCaptureTargetMismatchError(pointerId, capture.targetId, targetId);
    }

    return capture;
  }

  public handlePointerEvent(event: PointerInputEvent): PointerCapture | undefined {
    const capture = this.#captures.get(event.pointerId);

    this.#emit({
      type: "pointer-capture-event-observed",

      event,

      capture,
    });

    if (capture === undefined) {
      return undefined;
    }

    if (event.type === "pointer-up") {
      this.release(event.pointerId, "pointer-up");
    } else if (event.type === "pointer-cancel") {
      this.release(event.pointerId, "pointer-cancel");
    }

    return capture;
  }

  #emit(event: PointerCaptureManagerEvent): void {
    this.#onEvent?.(event);
  }
}
