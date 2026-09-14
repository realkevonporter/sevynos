import type { RenderLoopTickResult } from "./genesis-render-loop.js";

export interface RenderLoopSchedulerStartedEvent {
  readonly type: "started";
}

export interface RenderLoopSchedulerStepStartedEvent {
  readonly type: "step-started";

  readonly stepNumber: number;
}

export interface RenderLoopSchedulerStepCompletedEvent {
  readonly type: "step-completed";

  readonly stepNumber: number;

  readonly tickResult: RenderLoopTickResult;
}

export interface RenderLoopSchedulerStepFailedEvent {
  readonly type: "step-failed";

  readonly stepNumber: number;

  readonly error: unknown;
}

export interface RenderLoopSchedulerStoppedEvent {
  readonly type: "stopped";

  readonly stepCount: number;

  readonly successfulStepCount: number;

  readonly failedStepCount: number;
}

export type RenderLoopSchedulerEvent =
  | RenderLoopSchedulerStartedEvent
  | RenderLoopSchedulerStepStartedEvent
  | RenderLoopSchedulerStepCompletedEvent
  | RenderLoopSchedulerStepFailedEvent
  | RenderLoopSchedulerStoppedEvent;

export type RenderLoopSchedulerEventListener = (event: RenderLoopSchedulerEvent) => void;
