import type { ApplicationPackage } from "./application-package.js";
import {
  assertApplicationSessionTransition,
  type ApplicationSessionState,
} from "./application-session-state.js";

export type ApplicationSessionId = string;

export interface CreateApplicationSessionOptions {
  readonly id: ApplicationSessionId;
  readonly application: ApplicationPackage;
  readonly createdAt: Date;
  readonly state?: ApplicationSessionState;
}

export class ApplicationSession {
  public readonly id: ApplicationSessionId;

  public readonly application: ApplicationPackage;

  public readonly createdAt: Date;

  public readonly state: ApplicationSessionState;

  public constructor(options: CreateApplicationSessionOptions) {
    this.id = options.id;
    this.application = options.application;
    this.createdAt = options.createdAt;
    this.state = options.state ?? "created";
  }

  public transitionTo(state: ApplicationSessionState): ApplicationSession {
    if (state === this.state) {
      return this;
    }

    assertApplicationSessionTransition(this.state, state);

    return new ApplicationSession({
      id: this.id,
      application: this.application,
      createdAt: this.createdAt,
      state,
    });
  }

  public markLaunching(): ApplicationSession {
    return this.transitionTo("starting");
  }

  public markForeground(): ApplicationSession {
    return this.transitionTo("foreground");
  }

  public markBackground(): ApplicationSession {
    return this.transitionTo("background");
  }

  public markSuspended(): ApplicationSession {
    return this.transitionTo("suspended");
  }

  public markTerminating(): ApplicationSession {
    return this.transitionTo("stopping");
  }

  public markStopped(): ApplicationSession {
    return this.transitionTo("stopped");
  }

  public markFailed(): ApplicationSession {
    return this.transitionTo("failed");
  }

  public isForeground(): boolean {
    return this.state === "foreground";
  }

  public isBackground(): boolean {
    return this.state === "background";
  }

  public isSuspended(): boolean {
    return this.state === "suspended";
  }

  public isStopped(): boolean {
    return this.state === "stopped";
  }

  public isTerminal(): boolean {
    return this.state === "stopped" || this.state === "failed";
  }
}
