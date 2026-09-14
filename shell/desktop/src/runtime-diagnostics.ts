export type DiagnosticSeverity = "debug" | "info" | "warning" | "error";
export interface DiagnosticEntry {
  readonly timestamp: string;
  readonly severity: DiagnosticSeverity;
  readonly subsystem: string;
  readonly event: string;
  readonly message: string;
  readonly metadata?: Readonly<Record<string, string | number | boolean | null>>;
}
export interface FrameDiagnostics {
  readonly count: number;
  readonly latestDuration: number;
  readonly averageDuration: number;
  readonly failedFrames: number;
}

export class RuntimeDiagnosticsService {
  readonly #capacity: number;
  readonly #entries: DiagnosticEntry[] = [];
  #frameCount = 0;
  #frameTotal = 0;
  #latest = 0;
  #failed = 0;
  public constructor(capacity = 200) {
    if (!Number.isSafeInteger(capacity) || capacity < 1)
      throw new RangeError("Diagnostics capacity must be positive.");
    this.#capacity = capacity;
  }
  public record(input: Omit<DiagnosticEntry, "timestamp">): DiagnosticEntry {
    const entry = Object.freeze({
      ...input,
      timestamp: new Date().toISOString(),
      ...(input.metadata === undefined
        ? {}
        : { metadata: Object.freeze({ ...input.metadata }) }),
    });
    this.#entries.push(entry);
    while (this.#entries.length > this.#capacity) this.#entries.shift();
    return entry;
  }
  public list(): readonly DiagnosticEntry[] {
    return Object.freeze([...this.#entries]);
  }
  public clear(): void {
    this.#entries.length = 0;
  }
  public recordFrame(duration: number, failed = false): void {
    this.#frameCount += 1;
    this.#latest = Math.max(0, duration);
    this.#frameTotal += this.#latest;
    if (failed) this.#failed += 1;
  }
  public get frames(): FrameDiagnostics {
    return Object.freeze({
      count: this.#frameCount,
      latestDuration: this.#latest,
      averageDuration: this.#frameCount === 0 ? 0 : this.#frameTotal / this.#frameCount,
      failedFrames: this.#failed,
    });
  }
}

export function createDiagnosticsSnapshot(input: {
  readonly settings: unknown;
  readonly displays: unknown;
  readonly workspaces: unknown;
  readonly sessions: number;
  readonly windows: number;
  readonly diagnostics: RuntimeDiagnosticsService;
}): Readonly<Record<string, unknown>> {
  return Object.freeze({
    generatedAt: new Date().toISOString(),
    runtime: Object.freeze({ sessions: input.sessions, windows: input.windows }),
    settings: input.settings,
    displays: input.displays,
    workspaces: input.workspaces,
    frameMetrics: input.diagnostics.frames,
    diagnostics: input.diagnostics.list(),
  });
}
