import type { ApplicationId } from "./application-descriptor.js";
import type { ApplicationHostStartResult } from "./application-host.js";
import type { ApplicationHostRegistry } from "./application-host-registry.js";
import type { ApplicationSession, ApplicationSessionId } from "./application-session.js";
import { ApplicationSession as Session } from "./application-session.js";
import type { ApplicationRegistry } from "./application-registry.js";
import type { SessionRegistry } from "./session-registry.js";

export interface ApplicationManagerDependencies {
  readonly applications: ApplicationRegistry;
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
  readonly #applications: ApplicationRegistry;
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
    const application = this.#applications.get(applicationId);

    if (!application) {
      throw new Error(`Application "${applicationId}" is not registered.`);
    }

    const host = this.#hosts.get(application.hostId);

    if (!host) {
      throw new Error(`Application host "${application.hostId}" is not registered.`);
    }

    const createdSession = new Session({
      id: this.#createSessionId(),
      application,
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
      throw new Error(`Application session "${sessionId}" is not registered.`);
    }

    if (session.state !== "running") {
      throw new Error(
        `Application session "${sessionId}" cannot be stopped from state "${session.state}".`,
      );
    }

    const host = this.#hosts.get(session.application.hostId);

    if (!host) {
      throw new Error(
        `Application host "${session.application.hostId}" is not registered.`,
      );
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
