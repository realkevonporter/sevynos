import type { SevynInputEvent } from "./input-event.js";

export interface InputListenerRegisteredEvent {
  readonly type: "input-listener-registered";

  readonly listenerId: string;
}

export interface InputListenerRemovedEvent {
  readonly type: "input-listener-removed";

  readonly listenerId: string;
}

export interface InputDispatchStartedEvent {
  readonly type: "input-dispatch-started";

  readonly event: SevynInputEvent;

  readonly listenerCount: number;
}

export interface InputDispatchCompletedEvent {
  readonly type: "input-dispatch-completed";

  readonly event: SevynInputEvent;

  readonly deliveredTo: readonly string[];
}

export interface InputDispatchRejectedEvent {
  readonly type: "input-dispatch-rejected";

  readonly event: SevynInputEvent;

  readonly error: Error;
}

export interface InputDispatchFailedEvent {
  readonly type: "input-dispatch-failed";

  readonly event: SevynInputEvent;

  readonly listenerId: string;

  readonly error: Error;
}

export type InputDispatcherEvent =
  | InputListenerRegisteredEvent
  | InputListenerRemovedEvent
  | InputDispatchStartedEvent
  | InputDispatchCompletedEvent
  | InputDispatchRejectedEvent
  | InputDispatchFailedEvent;

export type InputDispatcherEventListener = (event: InputDispatcherEvent) => void;
