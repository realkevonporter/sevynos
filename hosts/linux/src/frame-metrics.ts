/**
 * Rolling frame-pipeline instrumentation for the bare-metal Linux host.
 *
 * Collects per-frame samples (raster duration, damage, pipe latency,
 * present intervals) into small ring buffers and summarizes them on
 * demand. Collection is cheap (a few numbers per frame); reporting is
 * gated by the caller (SEVYN_FRAME_METRICS=1 in wayland.ts).
 *
 * Terminology for the summary:
 * - frame interval: time between consecutive frame-presented acks; the
 *   closest thing to "what the user sees" on vsync-driven hardware.
 * - pipe latency: time from the frame packet hitting the pipe
 *   (WaylandFramePresenter.render -> connection.sendFrame) to the
 *   compositor's frame-presented ack for the same frameId.
 * - coalesced: scheduler invalidations that never became submitted
 *   frames (invalidationCount - submittedFrameCount); high values mean
 *   the UI is dirtying faster than the pipeline can present.
 */

export interface FrameRasterSample {
  readonly frameId: number;
  readonly displayId: string;
  readonly rasterMs: number;
  readonly damageRectCount: number;
  readonly damagePixelCount: number;
}

export interface PercentileSummary {
  readonly count: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

export interface FrameMetricsSummary {
  /** Estimated from mean frame interval; 0 until two frames presented. */
  readonly fps: number;
  readonly frameIntervalMs: PercentileSummary;
  readonly rasterMs: PercentileSummary;
  /** submit(frameId) -> presented(frameId). */
  readonly pipeLatencyMs: PercentileSummary;
  readonly damageRectsPerFrame: number;
  readonly damagePixelsPerFrame: number;
  /** Frames rasterized but not submitted (zero damage). */
  readonly emptyFrames: number;
  readonly invalidations: number;
  readonly submittedFrames: number;
  readonly coalescedInvalidations: number;
}

export interface SchedulerCounts {
  readonly invalidationCount: number;
  readonly submittedFrameCount: number;
}

const MAX_SAMPLES = 240;

function pushCapped(buffer: number[], value: number): void {
  buffer.push(value);
  if (buffer.length > MAX_SAMPLES) buffer.shift();
}

function summarizeSamples(buffer: readonly number[]): PercentileSummary {
  if (buffer.length === 0) {
    return { count: 0, p50: 0, p95: 0, max: 0 };
  }
  const sorted = [...buffer].sort((a, b) => a - b);
  const at = (quantile: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(quantile * (sorted.length - 1)))] ?? 0;
  const round = (value: number): number => Math.round(value * 1000) / 1000;
  return {
    count: sorted.length,
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    max: round(sorted[sorted.length - 1] ?? 0),
  };
}

function mean(buffer: readonly number[]): number {
  if (buffer.length === 0) return 0;
  let total = 0;
  for (const value of buffer) total += value;
  return Math.round((total / buffer.length) * 1000) / 1000;
}

export class FrameMetrics {
  readonly #rasterMs: number[] = [];
  readonly #frameIntervalsMs: number[] = [];
  readonly #pipeLatencyMs: number[] = [];
  readonly #damageRects: number[] = [];
  readonly #damagePixels: number[] = [];
  readonly #submitTimes = new Map<number, number>();
  #lastPresentedAtMs: number | undefined;
  #emptyFrames = 0;

  public recordRaster(sample: FrameRasterSample): void {
    pushCapped(this.#rasterMs, sample.rasterMs);
    pushCapped(this.#damageRects, sample.damageRectCount);
    pushCapped(this.#damagePixels, sample.damagePixelCount);
    if (sample.damageRectCount === 0) this.#emptyFrames += 1;
  }

  public recordSubmitted(frameId: number, atMs: number): void {
    this.#submitTimes.set(frameId, atMs);
    if (this.#submitTimes.size > MAX_SAMPLES) {
      const oldest = this.#submitTimes.keys().next();
      if (!oldest.done) this.#submitTimes.delete(oldest.value);
    }
  }

  public recordPresented(frameId: number, atMs: number): void {
    if (this.#lastPresentedAtMs !== undefined) {
      pushCapped(this.#frameIntervalsMs, atMs - this.#lastPresentedAtMs);
    }
    this.#lastPresentedAtMs = atMs;
    const submittedAtMs = this.#submitTimes.get(frameId);
    if (submittedAtMs !== undefined) {
      pushCapped(this.#pipeLatencyMs, atMs - submittedAtMs);
      this.#submitTimes.delete(frameId);
    }
  }

  public summarize(counts: SchedulerCounts): FrameMetricsSummary {
    const intervals = summarizeSamples(this.#frameIntervalsMs);
    const meanInterval = mean(this.#frameIntervalsMs);
    return {
      fps: meanInterval > 0 ? Math.round((1000 / meanInterval) * 10) / 10 : 0,
      frameIntervalMs: intervals,
      rasterMs: summarizeSamples(this.#rasterMs),
      pipeLatencyMs: summarizeSamples(this.#pipeLatencyMs),
      damageRectsPerFrame: mean(this.#damageRects),
      damagePixelsPerFrame: mean(this.#damagePixels),
      emptyFrames: this.#emptyFrames,
      invalidations: counts.invalidationCount,
      submittedFrames: counts.submittedFrameCount,
      coalescedInvalidations: Math.max(
        0,
        counts.invalidationCount - counts.submittedFrameCount,
      ),
    };
  }
}
