import type { CursorKind } from "./cursor-kind.js";
import type {
  CursorManagerEvent,
  CursorManagerEventListener,
} from "./cursor-manager-events.js";
import { CursorState } from "./cursor-state.js";
import type { HitTestPoint } from "./hit-test-point.js";

export interface CursorManagerDependencies {
  readonly now: () => number;

  readonly initialPosition?: HitTestPoint;

  readonly initialKind?: CursorKind;

  readonly onEvent?: CursorManagerEventListener;
}

export class CursorManager {
  readonly #now: () => number;

  readonly #onEvent: CursorManagerEventListener | undefined;

  #state: CursorState;

  public constructor(dependencies: CursorManagerDependencies) {
    this.#now = dependencies.now;

    this.#onEvent = dependencies.onEvent;

    this.#state = new CursorState({
      kind: dependencies.initialKind ?? "default",

      position: dependencies.initialPosition ?? {
        x: 0,
        y: 0,
      },

      visible: (dependencies.initialKind ?? "default") !== "hidden",

      updatedAt: this.#now(),
    });
  }

  public get state(): CursorState {
    return this.#state;
  }

  public setKind(kind: CursorKind): CursorState {
    return this.#update({
      kind,

      position: this.#state.position,

      visible: kind !== "hidden",
    });
  }

  public moveTo(position: HitTestPoint): CursorState {
    return this.#update({
      kind: this.#state.kind,

      position,

      visible: this.#state.visible,
    });
  }

  public update(options: {
    readonly kind?: CursorKind;

    readonly position?: HitTestPoint;

    readonly visible?: boolean;
  }): CursorState {
    const kind = options.kind ?? this.#state.kind;

    return this.#update({
      kind,

      position: options.position ?? this.#state.position,

      visible: options.visible ?? kind !== "hidden",
    });
  }

  public show(): CursorState {
    if (this.#state.visible) {
      return this.#state;
    }

    return this.#update({
      kind: this.#state.kind === "hidden" ? "default" : this.#state.kind,

      position: this.#state.position,

      visible: true,
    });
  }

  public hide(): CursorState {
    return this.#update({
      kind: "hidden",

      position: this.#state.position,

      visible: false,
    });
  }

  public reset(): CursorState {
    return this.#update({
      kind: "default",

      position: this.#state.position,

      visible: true,
    });
  }

  #update(options: {
    readonly kind: CursorKind;

    readonly position: HitTestPoint;

    readonly visible: boolean;
  }): CursorState {
    const previousState = this.#state;

    if (
      previousState.kind === options.kind &&
      previousState.position.x === options.position.x &&
      previousState.position.y === options.position.y &&
      previousState.visible === options.visible
    ) {
      return previousState;
    }

    const state = new CursorState({
      kind: options.kind,

      position: options.position,

      visible: options.visible,

      updatedAt: this.#now(),
    });

    this.#state = state;

    this.#emit({
      type: "cursor-state-changed",

      previousState,

      state,
    });

    return state;
  }

  #emit(event: CursorManagerEvent): void {
    this.#onEvent?.(event);
  }
}
