import { ApplicationHostNotFoundError } from "../errors/application-host-not-found-error.js";
import { ApplicationSessionNotFoundError } from "../errors/application-session-not-found-error.js";
import { InvalidApplicationSessionStateError } from "../errors/invalid-application-session-state-error.js";

import type { ApplicationHostStartResult } from "./application-host.js";
import type { ApplicationHostRegistry } from "./application-host-registry.js";
import type { ApplicationId } from "./application-manifest.js";
import type { ApplicationPackageRegistry } from "./application-package-registry.js";
import { ApplicationSession, type ApplicationSessionId } from "./application-session.js";
import type { ApplicationSessionState } from "./application-session-state.js";
import type { SessionRegistry } from "./session-registry.js";

import {
  ApplicationInstaller,
  type InstalledApplicationRecord,
} from "./application-installer.js";

export interface ApplicationManagerDependencies {
  readonly applications: ApplicationPackageRegistry;
  readonly hosts: ApplicationHostRegistry;
  readonly sessions: SessionRegistry;
  readonly createSessionId: () => ApplicationSessionId;
  readonly now: () => Date;
  readonly installer?: ApplicationInstaller | undefined;
  readonly appsDirectory?: string | undefined;
  readonly pristineDirectory?: string | undefined;
}

export interface StartApplicationResult {
  readonly session: ApplicationSession;
  readonly host: ApplicationHostStartResult;
}

const STOPPABLE_SESSION_STATES: ReadonlySet<ApplicationSessionState> =
  new Set<ApplicationSessionState>(["foreground", "background", "suspended"]);

export class ApplicationManager {
  readonly #applications: ApplicationPackageRegistry;
  readonly #hosts: ApplicationHostRegistry;
  readonly #sessions: SessionRegistry;
  readonly #createSessionId: () => ApplicationSessionId;
  readonly #now: () => Date;
  readonly #installer: ApplicationInstaller;

  public constructor(dependencies: ApplicationManagerDependencies) {
    this.#applications = dependencies.applications;
    this.#hosts = dependencies.hosts;
    this.#sessions = dependencies.sessions;
    this.#createSessionId = dependencies.createSessionId;
    this.#now = dependencies.now;
    this.#installer =
      dependencies.installer ??
      new ApplicationInstaller({
        packages: this.#applications,
        appsDirectory: dependencies.appsDirectory,
        pristineDirectory: dependencies.pristineDirectory,
        onBeforeUninstall: async (appId) => {
          await this.stopAllForApplication(appId);
        },
      });
  }

  public get installer(): ApplicationInstaller {
    return this.#installer;
  }

  public async install(
    bundleData: Uint8Array | string,
    options?: { source?: "pristine" | "bundle" | "sideload" },
  ): Promise<InstalledApplicationRecord> {
    return this.#installer.install(bundleData, options);
  }

  public async uninstall(applicationId: ApplicationId): Promise<void> {
    await this.#installer.uninstall(applicationId);
  }

  public async listInstalled(): Promise<readonly InstalledApplicationRecord[]> {
    return this.#installer.listInstalled();
  }

  public async getInstalled(
    id: ApplicationId,
  ): Promise<InstalledApplicationRecord | undefined> {
    return this.#installer.getInstalled(id);
  }

  public async installFromPristine(
    applicationId: ApplicationId,
  ): Promise<InstalledApplicationRecord> {
    return this.#installer.installFromPristine(applicationId);
  }

  public async stopAllForApplication(applicationId: ApplicationId): Promise<void> {
    const activeSessions = this.#sessions
      .list()
      .filter(
        (s) =>
          s.application.manifest.id === applicationId &&
          STOPPABLE_SESSION_STATES.has(s.state),
      );

    for (const session of activeSessions) {
      await this.stop(session.id);
    }
  }

  public getSession(sessionId: ApplicationSessionId): ApplicationSession | undefined {
    return this.#sessions.get(sessionId);
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

    const startingSession = this.#sessions.transition(createdSession.id, "starting");

    try {
      const hostResult = await host.start(startingSession);

      const foregroundSession = this.#sessions.transition(
        startingSession.id,
        "foreground",
      );

      return {
        session: foregroundSession,
        host: hostResult,
      };
    } catch (error: unknown) {
      this.#sessions.transition(startingSession.id, "failed");

      throw error;
    }
  }

  public async stop(sessionId: ApplicationSessionId): Promise<ApplicationSession> {
    const session = this.#sessions.get(sessionId);

    if (!session) {
      throw new ApplicationSessionNotFoundError(sessionId);
    }

    if (!STOPPABLE_SESSION_STATES.has(session.state)) {
      throw new InvalidApplicationSessionStateError(
        sessionId,
        session.state,
        "be stopped",
      );
    }

    const hostId = session.application.manifest.hostId;

    const host = this.#hosts.get(hostId);

    if (!host) {
      throw new ApplicationHostNotFoundError(hostId);
    }

    const stoppingSession = this.#sessions.transition(session.id, "stopping");

    try {
      await host.stop(stoppingSession);

      return this.#sessions.transition(stoppingSession.id, "stopped");
    } catch (error: unknown) {
      this.#sessions.transition(stoppingSession.id, "failed");

      throw error;
    }
  }

  public foreground(sessionId: ApplicationSessionId): ApplicationSession {
    return this.#transitionSession(
      sessionId,
      "foreground",
      ["background", "suspended"],
      "enter the foreground",
    );
  }

  public background(sessionId: ApplicationSessionId): ApplicationSession {
    return this.#transitionSession(
      sessionId,
      "background",
      ["foreground", "suspended"],
      "enter the background",
    );
  }

  public suspend(sessionId: ApplicationSessionId): ApplicationSession {
    return this.#transitionSession(
      sessionId,
      "suspended",
      ["background"],
      "be suspended",
    );
  }

  #transitionSession(
    sessionId: ApplicationSessionId,
    targetState: ApplicationSessionState,
    allowedStates: readonly ApplicationSessionState[],
    operation: string,
  ): ApplicationSession {
    const session = this.#sessions.get(sessionId);

    if (!session) {
      throw new ApplicationSessionNotFoundError(sessionId);
    }

    if (!allowedStates.includes(session.state)) {
      throw new InvalidApplicationSessionStateError(sessionId, session.state, operation);
    }

    return this.#sessions.transition(sessionId, targetState);
  }
}
