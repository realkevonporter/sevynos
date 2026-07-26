import { randomUUID } from "node:crypto";

import type { ApplicationManifest } from "./application-manifest.js";
import {
  assertApplicationSessionTransition,
  type ApplicationSessionState,
} from "./application-session-state.js";

export type ApplicationSessionId = string;

export interface CreateApplicationSessionOptions {
  readonly id?: ApplicationSessionId;
  readonly application: ApplicationManifest;
  readonly state?: ApplicationSessionState;
  readonly createdAt?: Date;
}

export class ApplicationSession {
  public readonly id: ApplicationSessionId;
  public readonly application: ApplicationManifest;
  public readonly state: ApplicationSessionState;
  public readonly createdAt: Date;

  public constructor(options: CreateApplicationSessionOptions) {
    this.id = options.id ?? randomUUID();
    this.application = options.application;
    this.state = options.state ?? "created";
    this.createdAt = options.createdAt ?? new Date();
  }

  public transitionTo(requestedState: ApplicationSessionState): ApplicationSession {
    assertApplicationSessionTransition(this.state, requestedState);

    return new ApplicationSession({
      id: this.id,
      application: this.application,
      state: requestedState,
      createdAt: this.createdAt,
    });
  }
}
