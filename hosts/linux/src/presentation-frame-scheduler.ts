export interface PresentationFrameSchedulerSnapshot {
  readonly dirty: boolean;
  readonly scheduled: boolean;
  readonly rendering: boolean;
  readonly frameInFlight: boolean;
  readonly invalidationCount: number;
  readonly submittedFrameCount: number;
  readonly maximumScheduledCallbacks: number;
}

export interface PresentationFrameSchedulerOptions {
  readonly executeFrame: (traceId: string | undefined) => boolean;
  readonly schedule?: (callback: () => void) => void;
}

/**
 * Coalesces synchronous state changes and applies presentation backpressure.
 * There can be one submitted frame and one dirty latest-state replacement.
 */
export class PresentationFrameScheduler {
  readonly #executeFrame: (traceId: string | undefined) => boolean;
  readonly #scheduleCallback: (callback: () => void) => void;
  #dirty = false;
  #scheduled = false;
  #rendering = false;
  #frameInFlight = false;
  #pendingTraceId: string | undefined;
  #invalidationCount = 0;
  #submittedFrameCount = 0;
  #scheduledCallbacks = 0;
  #maximumScheduledCallbacks = 0;
  #stopped = false;

  public constructor(options: PresentationFrameSchedulerOptions) {
    this.#executeFrame = options.executeFrame;
    this.#scheduleCallback = options.schedule ?? queueMicrotask;
  }

  public invalidate(traceId?: string): void {
    if (this.#stopped) return;
    this.#dirty = true;
    this.#invalidationCount += 1;
    if (traceId !== undefined) this.#pendingTraceId = traceId;
    this.#schedule();
  }

  public framePresented(): void {
    if (this.#stopped) return;
    this.#frameInFlight = false;
    this.#schedule();
  }

  public stop(): void {
    this.#stopped = true;
    this.#dirty = false;
    this.#pendingTraceId = undefined;
  }

  public get snapshot(): PresentationFrameSchedulerSnapshot {
    return Object.freeze({
      dirty: this.#dirty,
      scheduled: this.#scheduled,
      rendering: this.#rendering,
      frameInFlight: this.#frameInFlight,
      invalidationCount: this.#invalidationCount,
      submittedFrameCount: this.#submittedFrameCount,
      maximumScheduledCallbacks: this.#maximumScheduledCallbacks,
    });
  }

  #schedule(): void {
    if (
      this.#stopped ||
      !this.#dirty ||
      this.#scheduled ||
      this.#rendering ||
      this.#frameInFlight
    )
      return;
    this.#scheduled = true;
    this.#scheduledCallbacks += 1;
    this.#maximumScheduledCallbacks = Math.max(
      this.#maximumScheduledCallbacks,
      this.#scheduledCallbacks,
    );
    this.#scheduleCallback(() => {
      this.#scheduledCallbacks -= 1;
      this.#scheduled = false;
      this.#run();
    });
  }

  #run(): void {
    if (this.#stopped || !this.#dirty || this.#rendering || this.#frameInFlight) return;
    this.#dirty = false;
    this.#rendering = true;
    this.#frameInFlight = true;
    const traceId = this.#pendingTraceId;
    this.#pendingTraceId = undefined;
    let submitted = false;
    try {
      submitted = this.#executeFrame(traceId);
      if (submitted) this.#submittedFrameCount += 1;
    } finally {
      this.#rendering = false;
      if (!submitted) this.#frameInFlight = false;
      this.#schedule();
    }
  }
}
