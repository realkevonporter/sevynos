import {
  ApplicationState,
  type ApplicationState as ApplicationStateValue,
} from "./application-state";

export interface ApplicationLifecycleSnapshot {
  readonly state: ApplicationStateValue;
  readonly previousState: ApplicationStateValue | null;
  readonly version: number;
}

export type ApplicationLifecycleListener = (
  snapshot: ApplicationLifecycleSnapshot,
) => void;

const allowedTransitions: Readonly<
  Record<ApplicationStateValue, readonly ApplicationStateValue[]>
> = {
  [ApplicationState.Launching]: [
    ApplicationState.Foreground,
    ApplicationState.Terminating,
    ApplicationState.Failed,
  ],

  [ApplicationState.Foreground]: [
    ApplicationState.Background,
    ApplicationState.Terminating,
    ApplicationState.Failed,
  ],

  [ApplicationState.Background]: [
    ApplicationState.Foreground,
    ApplicationState.Suspended,
    ApplicationState.Terminating,
    ApplicationState.Failed,
  ],

  [ApplicationState.Suspended]: [
    ApplicationState.Foreground,
    ApplicationState.Background,
    ApplicationState.Terminating,
    ApplicationState.Failed,
  ],

  [ApplicationState.Terminating]: [ApplicationState.Stopped, ApplicationState.Failed],

  [ApplicationState.Stopped]: [],

  [ApplicationState.Failed]: [ApplicationState.Terminating, ApplicationState.Stopped],
};

export class ApplicationLifecycle {
  private state: ApplicationStateValue;

  private previousState: ApplicationStateValue | null = null;

  private version = 0;

  private readonly listeners = new Set<ApplicationLifecycleListener>();

  public constructor(initialState: ApplicationStateValue = ApplicationState.Launching) {
    this.state = initialState;
  }

  public getState(): ApplicationStateValue {
    return this.state;
  }

  public getPreviousState(): ApplicationStateValue | null {
    return this.previousState;
  }

  public getSnapshot(): ApplicationLifecycleSnapshot {
    return {
      state: this.state,
      previousState: this.previousState,
      version: this.version,
    };
  }

  public canTransitionTo(nextState: ApplicationStateValue): boolean {
    if (nextState === this.state) {
      return false;
    }

    return allowedTransitions[this.state].includes(nextState);
  }

  public transitionTo(nextState: ApplicationStateValue): ApplicationLifecycleSnapshot {
    if (nextState === this.state) {
      return this.getSnapshot();
    }

    if (!this.canTransitionTo(nextState)) {
      throw new Error(
        `Invalid application lifecycle transition: ` +
          `"${this.state}" → "${nextState}".`,
      );
    }

    this.previousState = this.state;
    this.state = nextState;
    this.version += 1;

    const snapshot = this.getSnapshot();

    this.notify(snapshot);

    return snapshot;
  }

  public subscribe(listener: ApplicationLifecycleListener): () => void {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  public isForeground(): boolean {
    return this.state === ApplicationState.Foreground;
  }

  public isBackground(): boolean {
    return this.state === ApplicationState.Background;
  }

  public isSuspended(): boolean {
    return this.state === ApplicationState.Suspended;
  }

  public isStopped(): boolean {
    return this.state === ApplicationState.Stopped;
  }

  public isTerminal(): boolean {
    return (
      this.state === ApplicationState.Stopped || this.state === ApplicationState.Failed
    );
  }

  private notify(snapshot: ApplicationLifecycleSnapshot): void {
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}
