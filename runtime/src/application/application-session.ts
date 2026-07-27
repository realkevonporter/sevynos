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
    assertApplicationSessionTransition(this.state, state);

    return new ApplicationSession({
      id: this.id,
      application: this.application,
      createdAt: this.createdAt,
      state,
    });
  }
}
