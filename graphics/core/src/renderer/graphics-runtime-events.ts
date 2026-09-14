import type { GraphicsRuntimeShutdownFailure } from "../errors/graphics-runtime-errors.js";
import type { GraphicsRuntimeState } from "./graphics-runtime-state.js";

export interface GraphicsRuntimeStartingEvent {
  readonly type: "starting";
}

export interface GraphicsRuntimeRendererInitializedEvent {
  readonly type: "renderer-initialized";
}

export interface GraphicsRuntimeRenderLoopStartedEvent {
  readonly type: "render-loop-started";
}

export interface GraphicsRuntimeSchedulerStartedEvent {
  readonly type: "scheduler-started";
}

export interface GraphicsRuntimeStartedEvent {
  readonly type: "started";
}

export interface GraphicsRuntimeStartupFailedEvent {
  readonly type: "startup-failed";

  readonly error: unknown;

  readonly rollbackErrors: readonly unknown[];
}

export interface GraphicsRuntimeStoppingEvent {
  readonly type: "stopping";
}

export interface GraphicsRuntimeSchedulerStoppedEvent {
  readonly type: "scheduler-stopped";
}

export interface GraphicsRuntimeRenderLoopStoppedEvent {
  readonly type: "render-loop-stopped";
}

export interface GraphicsRuntimeRendererShutdownEvent {
  readonly type: "renderer-shutdown";
}

export interface GraphicsRuntimeStoppedEvent {
  readonly type: "stopped";
}

export interface GraphicsRuntimeShutdownFailedEvent {
  readonly type: "shutdown-failed";

  readonly failures: readonly GraphicsRuntimeShutdownFailure[];
}

export interface GraphicsRuntimeStateChangedEvent {
  readonly type: "state-changed";

  readonly previousState: GraphicsRuntimeState;

  readonly state: GraphicsRuntimeState;
}

export type GraphicsRuntimeEvent =
  | GraphicsRuntimeStartingEvent
  | GraphicsRuntimeRendererInitializedEvent
  | GraphicsRuntimeRenderLoopStartedEvent
  | GraphicsRuntimeSchedulerStartedEvent
  | GraphicsRuntimeStartedEvent
  | GraphicsRuntimeStartupFailedEvent
  | GraphicsRuntimeStoppingEvent
  | GraphicsRuntimeSchedulerStoppedEvent
  | GraphicsRuntimeRenderLoopStoppedEvent
  | GraphicsRuntimeRendererShutdownEvent
  | GraphicsRuntimeStoppedEvent
  | GraphicsRuntimeShutdownFailedEvent
  | GraphicsRuntimeStateChangedEvent;

export type GraphicsRuntimeEventListener = (event: GraphicsRuntimeEvent) => void;
