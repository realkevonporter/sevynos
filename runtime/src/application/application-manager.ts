import { ApplicationHostNotFoundError } from "../errors/application-host-not-found-error.js";
import { ApplicationSessionNotFoundError } from "../errors/application-session-not-found-error.js";
import { InvalidApplicationSessionStateError } from "../errors/invalid-application-session-state-error.js";

import type { ApplicationHostStartResult } from "./application-host.js";
import type { ApplicationHostRegistry } from "./application-host-registry.js";
import type { ApplicationId } from "./application-manifest.js";
import type { ApplicationPackageRegistry } from "./application-package-registry.js";
import { ApplicationSession, type ApplicationSessionId } from "./application-session.js";
import type { SessionRegistry } from "./session-registry.js";

export interface ApplicationManagerDependencies {
  readonly applications: ApplicationPackageRegistry;
  readonly hosts: ApplicationHostRegistry;
  readonly sessions: SessionRegistry;
  readonly createSessionId: () => ApplicationSessionId;
  readonly now: () => Date;
}

export interface StartApplicationResult {
  readonly session: ApplicationSession;
  readonly host: ApplicationHostStartResult;
}

export class ApplicationManager {
  readonly #applications: ApplicationPackageRegistry;
  readonly #hosts: ApplicationHostRegistry;
  readonly #sessions: SessionRegistry;
  readonly #createSessionId: () => ApplicationSessionId;
  readonly #now: () => Date;

  public constructor(dependencies: ApplicationManagerDependencies) {
    this.#applications = dependencies.applications;
    this.#hosts = dependencies.hosts;
    this.#sessions = dependencies.sessions;
    this.#createSessionId = dependencies.createSessionId;
    this.#now = dependencies.now;
  }

  public async start(applicationId: ApplicationId): Promise<StartApplicationResult> {
    const applicationPackage = this.#applications.get(applicationId);

    const hostId = applicationPackage.manifest.hostId;

    const host = this.#hosts.get(hostId);

    if (!host) {
      throw new ApplicationHostNotFoundError(hostId);
    }

    const createdSession = new ApplicationSession({
      id: this.#createSessionId(),
      application: applicationPackage,
      createdAt: this.#now(),
    });

    this.#sessions.add(createdSession);

    const startingSession = createdSession.transitionTo("starting");

    this.#sessions.update(startingSession);

    try {
      const hostResult = await host.start(startingSession);

      const runningSession = startingSession.transitionTo("running");

      this.#sessions.update(runningSession);

      return {
        session: runningSession,
        host: hostResult,
      };
    } catch (error: unknown) {
      const failedSession = startingSession.transitionTo("failed");

      this.#sessions.update(failedSession);

      throw error;
    }
  }

  public async stop(sessionId: ApplicationSessionId): Promise<ApplicationSession> {
    const session = this.#sessions.get(sessionId);

    if (!session) {
      throw new ApplicationSessionNotFoundError(sessionId);
    }

    if (session.state !== "running") {
      throw new InvalidApplicationSessionStateError(sessionId, session.state);
    }

    const hostId = session.application.manifest.hostId;

    const host = this.#hosts.get(hostId);

    if (!host) {
      throw new ApplicationHostNotFoundError(hostId);
    }

    const stoppingSession = session.transitionTo("stopping");

    this.#sessions.update(stoppingSession);

    try {
      await host.stop(stoppingSession);

      const stoppedSession = stoppingSession.transitionTo("stopped");

      this.#sessions.update(stoppedSession);

      return stoppedSession;
    } catch (error: unknown) {
      const failedSession = stoppingSession.transitionTo("failed");

      this.#sessions.update(failedSession);

      throw error;
    }
  }
}
