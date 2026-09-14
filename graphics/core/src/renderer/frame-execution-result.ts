import type { DisplayId } from "../display/display-id.js";
import type { RenderResult } from "./render-result.js";

export interface FrameRenderFailureOptions {
  readonly displayId: DisplayId;

  readonly error: unknown;
}

export class FrameRenderFailure {
  public readonly displayId: DisplayId;

  public readonly error: unknown;

  public constructor(options: FrameRenderFailureOptions) {
    this.displayId = options.displayId;

    this.error = options.error;
  }
}

export interface FrameExecutionResultOptions {
  readonly executionNumber: number;

  readonly startedAt: Date;

  readonly completedAt: Date;

  readonly renderResults: readonly RenderResult[];

  readonly failures: readonly FrameRenderFailure[];
}

export class FrameExecutionResult {
  public readonly executionNumber: number;

  public readonly startedAt: Date;

  public readonly completedAt: Date;

  public readonly renderResults: readonly RenderResult[];

  public readonly failures: readonly FrameRenderFailure[];

  public constructor(options: FrameExecutionResultOptions) {
    if (!Number.isSafeInteger(options.executionNumber) || options.executionNumber < 1) {
      throw new RangeError("Frame execution number must be a positive safe integer.");
    }

    if (options.completedAt.getTime() < options.startedAt.getTime()) {
      throw new RangeError(
        "Frame execution completion time cannot be earlier than its start time.",
      );
    }

    this.executionNumber = options.executionNumber;

    this.startedAt = new Date(options.startedAt);

    this.completedAt = new Date(options.completedAt);

    this.renderResults = [...options.renderResults];

    this.failures = [...options.failures];
  }

  public get durationMilliseconds(): number {
    return this.completedAt.getTime() - this.startedAt.getTime();
  }

  public get displayCount(): number {
    return this.renderResults.length + this.failures.length;
  }

  public get renderedDisplayCount(): number {
    return this.renderResults.length;
  }

  public get failedDisplayCount(): number {
    return this.failures.length;
  }

  public get succeeded(): boolean {
    return this.failures.length === 0;
  }

  public get partiallySucceeded(): boolean {
    return this.renderResults.length > 0 && this.failures.length > 0;
  }

  public get completelyFailed(): boolean {
    return this.renderResults.length === 0 && this.failures.length > 0;
  }

  public get hadWork(): boolean {
    return this.displayCount > 0;
  }
}
