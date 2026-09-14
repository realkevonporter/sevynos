import type { DisplayId } from "../display/display-id.js";

export type RenderResultStatus = "rendered" | "skipped";

export interface RenderResultOptions {
  readonly frameNumber: number;

  readonly displayId: DisplayId;

  readonly status: RenderResultStatus;

  readonly startedAt: Date;

  readonly completedAt: Date;

  readonly commandCount: number;
}

export class RenderResult {
  public readonly frameNumber: number;

  public readonly displayId: DisplayId;

  public readonly status: RenderResultStatus;

  public readonly startedAt: Date;

  public readonly completedAt: Date;

  public readonly commandCount: number;

  public constructor(options: RenderResultOptions) {
    if (!Number.isSafeInteger(options.commandCount) || options.commandCount < 0) {
      throw new RangeError("Render command count must be a non-negative safe integer.");
    }

    if (options.completedAt.getTime() < options.startedAt.getTime()) {
      throw new RangeError(
        "Render completion time cannot be earlier than its start time.",
      );
    }

    this.frameNumber = options.frameNumber;

    this.displayId = options.displayId;

    this.status = options.status;

    this.startedAt = new Date(options.startedAt);

    this.completedAt = new Date(options.completedAt);

    this.commandCount = options.commandCount;
  }

  public get durationMilliseconds(): number {
    return this.completedAt.getTime() - this.startedAt.getTime();
  }
}
