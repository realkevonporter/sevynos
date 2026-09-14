import type { RenderLoopSchedulerState } from "./render-loop-scheduler-state.js";

export interface RenderLoopScheduler {
  readonly state: RenderLoopSchedulerState;

  start(): void;

  stop(): void;
}
