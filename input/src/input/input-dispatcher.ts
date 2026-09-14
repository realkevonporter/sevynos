import type { InputDeviceRegistry } from "./input-device-registry.js";
import {
  InputDispatchDeviceKindMismatchError,
  InputDispatchDisconnectedDeviceError,
  InputDispatchListenerError,
  InputDispatchUnknownDeviceError,
  InputListenerAlreadyRegisteredError,
  InputListenerNotFoundError,
} from "../errors/input-dispatcher-errors.js";
import type {
  InputDispatcherEvent,
  InputDispatcherEventListener,
} from "./input-dispatcher-events.js";
import type { SevynInputEvent } from "./input-event.js";

export type InputEventListener = (event: SevynInputEvent) => void;

export interface InputListenerRegistration {
  readonly id: string;

  readonly listener: InputEventListener;
}

export interface InputDispatchResult {
  readonly event: SevynInputEvent;

  readonly deliveredTo: readonly string[];
}

export interface InputDispatcherDependencies {
  readonly deviceRegistry: InputDeviceRegistry;

  readonly onEvent?: InputDispatcherEventListener;
}

export class InputDispatcher {
  readonly #deviceRegistry: InputDeviceRegistry;

  readonly #listeners = new Map<string, InputEventListener>();

  readonly #onEvent: InputDispatcherEventListener | undefined;

  public constructor(dependencies: InputDispatcherDependencies) {
    this.#deviceRegistry = dependencies.deviceRegistry;

    this.#onEvent = dependencies.onEvent;
  }

  public get listenerCount(): number {
    return this.#listeners.size;
  }

  public addListener(registration: InputListenerRegistration): void {
    if (this.#listeners.has(registration.id)) {
      throw new InputListenerAlreadyRegisteredError(registration.id);
    }

    this.#listeners.set(registration.id, registration.listener);

    this.#emit({
      type: "input-listener-registered",

      listenerId: registration.id,
    });
  }

  public removeListener(listenerId: string): void {
    if (!this.#listeners.delete(listenerId)) {
      throw new InputListenerNotFoundError(listenerId);
    }

    this.#emit({
      type: "input-listener-removed",

      listenerId,
    });
  }

  public hasListener(listenerId: string): boolean {
    return this.#listeners.has(listenerId);
  }

  public listListenerIds(): readonly string[] {
    return Object.freeze([...this.#listeners.keys()]);
  }

  public dispatch(event: SevynInputEvent): InputDispatchResult {
    try {
      this.#validateEvent(event);
    } catch (error: unknown) {
      const dispatchError = this.#normalizeError(error);

      this.#emit({
        type: "input-dispatch-rejected",

        event,

        error: dispatchError,
      });

      throw dispatchError;
    }

    /*
     * Snapshot the listeners before dispatch.
     *
     * A listener may add or remove listeners while
     * handling an event. Those changes must apply to
     * the next event, not the current dispatch cycle.
     */
    const listeners = [...this.#listeners.entries()] as const;

    this.#emit({
      type: "input-dispatch-started",

      event,

      listenerCount: listeners.length,
    });

    const deliveredTo: string[] = [];

    for (const [listenerId, listener] of listeners) {
      try {
        listener(event);

        deliveredTo.push(listenerId);
      } catch (cause: unknown) {
        const error = new InputDispatchListenerError(listenerId, cause);

        this.#emit({
          type: "input-dispatch-failed",

          event,

          listenerId,

          error,
        });

        throw error;
      }
    }

    const immutableDeliveredTo = Object.freeze([...deliveredTo]);

    const result: InputDispatchResult = Object.freeze({
      event,

      deliveredTo: immutableDeliveredTo,
    });

    this.#emit({
      type: "input-dispatch-completed",

      event,

      deliveredTo: immutableDeliveredTo,
    });

    return result;
  }

  public clearListeners(): readonly string[] {
    const listenerIds = this.listListenerIds();

    this.#listeners.clear();

    for (const listenerId of listenerIds) {
      this.#emit({
        type: "input-listener-removed",

        listenerId,
      });
    }

    return listenerIds;
  }

  #validateEvent(event: SevynInputEvent): void {
    const device = this.#deviceRegistry.get(event.deviceId);

    if (device === undefined) {
      throw new InputDispatchUnknownDeviceError(event.deviceId);
    }

    if (device.state !== "connected") {
      throw new InputDispatchDisconnectedDeviceError(event.deviceId);
    }

    if (device.descriptor.kind !== event.deviceKind) {
      throw new InputDispatchDeviceKindMismatchError(
        event.deviceId,
        device.descriptor.kind,
        event.deviceKind,
      );
    }
  }

  #normalizeError(error: unknown): Error {
    if (error instanceof Error) {
      return error;
    }

    return new Error(String(error));
  }

  #emit(event: InputDispatcherEvent): void {
    this.#onEvent?.(event);
  }
}
