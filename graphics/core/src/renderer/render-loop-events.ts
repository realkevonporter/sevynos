import type { FrameExecutionResult } from "./frame-execution-result.js";

export interface RenderLoopStartedEvent {
  readonly type: "started";
}

export interface RenderLoopFrameRequestedEvent {
  readonly type: "frame-requested";

  readonly wasAlreadyPending: boolean;
}

export interface RenderLoopFrameStartedEvent {
  readonly type: "frame-started";

  readonly tickNumber: number;
}

export interface RenderLoopFrameCompletedEvent {
  readonly type: "frame-completed";

  readonly tickNumber: number;

  readonly result: FrameExecutionResult;
}

export interface RenderLoopFrameFailedEvent {
  readonly type: "frame-failed";

  readonly tickNumber: number;

  readonly error: unknown;
}

export interface RenderLoopStoppedEvent {
  readonly type: "stopped";

  readonly completedFrameCount: number;

  readonly failedFrameCount: number;
}

export type RenderLoopEvent =
  | RenderLoopStartedEvent
  | RenderLoopFrameRequestedEvent
  | RenderLoopFrameStartedEvent
  | RenderLoopFrameCompletedEvent
  | RenderLoopFrameFailedEvent
  | RenderLoopStoppedEvent;

export type RenderLoopEventListener = (event: RenderLoopEvent) => void;
