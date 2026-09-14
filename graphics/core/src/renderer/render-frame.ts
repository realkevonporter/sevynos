import type { DisplayId } from "../display/display-id.js";
import type { DisplayRenderPlan } from "../display/display-render-plan.js";
import { RenderTarget } from "./render-target.js";

export interface RenderFrameOptions<TScene> {
  readonly frameNumber: number;

  readonly plan: DisplayRenderPlan<TScene>;

  readonly target: RenderTarget;

  readonly startedAt: Date;
}

export class RenderFrame<TScene> {
  public readonly frameNumber: number;

  public readonly displayId: DisplayId;

  public readonly plan: DisplayRenderPlan<TScene>;

  public readonly target: RenderTarget;

  public readonly startedAt: Date;

  public constructor(options: RenderFrameOptions<TScene>) {
    if (!Number.isSafeInteger(options.frameNumber) || options.frameNumber < 1) {
      throw new RangeError("Frame number must be a positive safe integer.");
    }

    if (options.plan.displayId !== options.target.displayId) {
      throw new Error(
        `Render plan display "${options.plan.displayId}" does not match render target display "${options.target.displayId}".`,
      );
    }

    this.frameNumber = options.frameNumber;

    this.displayId = options.plan.displayId;

    this.plan = options.plan;

    this.target = options.target;

    this.startedAt = new Date(options.startedAt);
  }
}
