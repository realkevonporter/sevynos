import type { ApplicationHost } from "./application/application-host.js";
import { ApplicationHostRegistry } from "./application/application-host-registry.js";
import {
  ApplicationManager,
  type StartApplicationResult,
} from "./application/application-manager.js";
import type { ApplicationId } from "./application/application-manifest.js";
import { isApplicationPackage } from "./application/application-package.js";
import { ApplicationPackageRegistry } from "./application/application-package-registry.js";
import type {
  ApplicationSession,
  ApplicationSessionId,
} from "./application/application-session.js";
import type { ApplicationSessionState } from "./application/application-session-state.js";
import type { InstalledApplicationRecord } from "./application/application-installer.js";
import { SessionRegistry } from "./application/session-registry.js";
import { InvalidApplicationPackageError } from "./errors/invalid-application-package-error.js";
import { InvalidRuntimeStateError } from "./errors/invalid-runtime-state-error.js";
import {
  RuntimeShutdownError,
  type RuntimeShutdownFailure,
} from "./errors/runtime-shutdown-error.js";
import type { RuntimeLogger } from "./logger.js";
import { RUNTIME_IDENTITY } from "./runtime-identity.js";
import { assertRuntimeTransition, type RuntimeState } from "./runtime-state.js";

const STOPPABLE_APPLICATION_SESSION_STATES: ReadonlySet<ApplicationSessionState> =
  new Set<ApplicationSessionState>(["foreground", "background", "suspended"]);

function createDefaultSessionId(): ApplicationSessionId {
  const cryptoObject = (
    globalThis as {
      crypto?: {
        randomUUID?: () => string;
      };
    }
  ).crypto;

  if (typeof cryptoObject?.randomUUID === "function") {
    return cryptoObject.randomUUID();
  }

  return createFallbackSessionId();
}

function createFallbackSessionId(): ApplicationSessionId {
  return [
    Date.now().toString(36),
    Math.random().toString(36).slice(2),
    Math.random().toString(36).slice(2),
  ].join("-");
}

function getProcessId(): number | undefined {
  const processValue = (
    globalThis as {
      process?: {
        pid?: number;
      };
    }
  ).process;

  return processValue?.pid;
}

export interface RuntimeOptions {
  readonly logger: RuntimeLogger;
  readonly createSessionId?: () => ApplicationSessionId;
  readonly now?: () => Date;
  readonly appsDirectory?: string | undefined;
  readonly pristineDirectory?: string | undefined;
}

export class SevynRuntime {
  readonly #logger: RuntimeLogger;

  readonly #applications: ApplicationPackageRegistry;
  readonly #hosts: ApplicationHostRegistry;
  readonly #sessions: SessionRegistry;
  readonly #applicationManager: ApplicationManager;
  readonly #listeners = new Set<() => void>();

  #state: RuntimeState = "created";
  #shutdownPromise: Promise<void> | undefined;
  #version = 0;

  public constructor(options: RuntimeOptions) {
    this.#logger = options.logger;

    this.#applications = new ApplicationPackageRegistry();

    this.#hosts = new ApplicationHostRegistry();

    this.#sessions = new SessionRegistry();

    this.#applicationManager = new ApplicationManager({
      applications: this.#applications,
      hosts: this.#hosts,
      sessions: this.#sessions,
      createSessionId: options.createSessionId ?? createDefaultSessionId,
      now: options.now ?? ((): Date => new Date()),
      appsDirectory: options.appsDirectory,
      pristineDirectory: options.pristineDirectory,
    });
  }

  public get state(): RuntimeState {
    return this.#state;
  }

  public subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);

    return (): void => {
      this.#listeners.delete(listener);
    };
  }

  public getSnapshot(): number {
    return this.#version;
  }

  public registerApplication(input: unknown): void {
    if (!isApplicationPackage(input)) {
      throw new InvalidApplicationPackageError(
        "expected an object containing a manifest.",
      );
    }

    this.#applications.register(input);

    this.#logger.log("info", "application.registered", {
      applicationId: input.manifest.id,
      version: input.manifest.version,
      hostId: input.manifest.hostId,
    });

    this.#notify();
  }

  public unregisterApplication(applicationId: ApplicationId): boolean {
    const removed = this.#applications.unregister(applicationId);

    if (removed) {
      this.#logger.log("info", "application.unregistered", {
        applicationId,
      });

      this.#notify();
    }

    return removed;
  }

  public registerApplicationHost(host: ApplicationHost): void {
    this.#hosts.register(host);

    this.#logger.log("info", "application.host.registered", {
      hostId: host.id,
    });

    this.#notify();
  }

  public unregisterApplicationHost(hostId: ApplicationHost["id"]): boolean {
    const removed = this.#hosts.unregister(hostId);

    if (removed) {
      this.#logger.log("info", "application.host.unregistered", {
        hostId,
      });

      this.#notify();
    }

    return removed;
  }

  public async startApplication(
    applicationId: ApplicationId,
  ): Promise<StartApplicationResult> {
    this.#assertStateForOperation("start application", ["running"]);

    const result = await this.#applicationManager.start(applicationId);

    this.#logger.log("info", "application.started", {
      applicationId,
      sessionId: result.session.id,
      hostId: result.session.application.manifest.hostId,
      hostInstanceId: result.host.instanceId,
      sessionState: result.session.state,
    });

    this.#notify();

    return result;
  }

  public async stopApplication(
    sessionId: ApplicationSessionId,
  ): Promise<ApplicationSession> {
    this.#assertStateForOperation("stop application", ["running", "stopping"]);

    const session = await this.#applicationManager.stop(sessionId);

    this.#logger.log("info", "application.stopped", {
      applicationId: session.application.manifest.id,
      sessionId: session.id,
      hostId: session.application.manifest.hostId,
      sessionState: session.state,
    });

    this.#notify();

    return session;
  }

  public getApplicationSession(
    sessionId: ApplicationSessionId,
  ): ApplicationSession | undefined {
    return this.#sessions.get(sessionId);
  }

  public listApplicationSessions(): readonly ApplicationSession[] {
    return this.#sessions.list();
  }

  public async installApplication(
    bundleData: Uint8Array | string,
    options?: { source?: "pristine" | "bundle" | "sideload" },
  ): Promise<InstalledApplicationRecord> {
    const record = await this.#applicationManager.install(bundleData, options);
    this.#logger.log("info", "application.installed", {
      applicationId: record.id,
      version: record.version,
      system: record.system,
      installSource: record.installSource,
    });
    this.#notify();
    return record;
  }

  public async uninstallApplication(applicationId: ApplicationId): Promise<void> {
    await this.#applicationManager.uninstall(applicationId);
    this.#logger.log("info", "application.uninstalled", {
      applicationId,
    });
    this.#notify();
  }

  public async listInstalledApplications(): Promise<
    readonly InstalledApplicationRecord[]
  > {
    return this.#applicationManager.listInstalled();
  }

  public async getInstalledApplication(
    id: ApplicationId,
  ): Promise<InstalledApplicationRecord | undefined> {
    return this.#applicationManager.getInstalled(id);
  }

  public async installApplicationFromPristine(
    applicationId: ApplicationId,
  ): Promise<InstalledApplicationRecord> {
    const record = await this.#applicationManager.installFromPristine(applicationId);
    this.#logger.log("info", "application.installed.pristine", {
      applicationId: record.id,
      version: record.version,
    });
    this.#notify();
    return record;
  }

  public async start(): Promise<void> {
    this.#transitionTo("starting", "runtime.start.requested");

    try {
      await this.#initialize();

      this.#transitionTo("running", "runtime.start.completed");

      this.#logger.log("info", "runtime.ready", {
        runtimeId: RUNTIME_IDENTITY.id,
        architectureVersion: RUNTIME_IDENTITY.architectureVersion,
        processId: getProcessId(),
      });
    } catch (error: unknown) {
      this.#transitionTo("failed", "runtime.start.failed");

      this.#logger.log("error", "runtime.failure", {
        error: this.#serializeError(error),
      });

      throw error;
    }
  }

  public foregroundApplication(sessionId: ApplicationSessionId): ApplicationSession {
    this.#assertStateForOperation("foreground application", ["running"]);

    const session = this.#applicationManager.foreground(sessionId);

    this.#logger.log("info", "application.foregrounded", {
      applicationId: session.application.manifest.id,
      sessionId: session.id,
      state: session.state,
    });

    this.#notify();

    return session;
  }

  public backgroundApplication(sessionId: ApplicationSessionId): ApplicationSession {
    this.#assertStateForOperation("background application", ["running"]);

    const session = this.#applicationManager.background(sessionId);

    this.#logger.log("info", "application.backgrounded", {
      applicationId: session.application.manifest.id,
      sessionId: session.id,
      state: session.state,
    });

    this.#notify();

    return session;
  }

  public suspendApplication(sessionId: ApplicationSessionId): ApplicationSession {
    this.#assertStateForOperation("suspend application", ["running"]);

    const session = this.#applicationManager.suspend(sessionId);

    this.#logger.log("info", "application.suspended", {
      applicationId: session.application.manifest.id,
      sessionId: session.id,
      state: session.state,
    });

    this.#notify();

    return session;
  }

  public stop(reason: string): Promise<void> {
    if (this.#shutdownPromise !== undefined) {
      return this.#shutdownPromise;
    }

    this.#shutdownPromise = this.#performStop(reason);

    return this.#shutdownPromise;
  }

  async #performStop(reason: string): Promise<void> {
    if (this.#state === "stopped") {
      return;
    }

    if (this.#state === "failed") {
      this.#logger.log("warn", "runtime.stop.skipped", {
        reason,
        state: this.#state,
      });

      return;
    }

    this.#transitionTo("stopping", "runtime.stop.requested", {
      reason,
    });

    try {
      await this.#dispose();

      this.#transitionTo("stopped", "runtime.stop.completed", {
        reason,
      });
    } catch (error: unknown) {
      this.#transitionTo("failed", "runtime.stop.failed", {
        reason,
      });

      this.#logger.log("error", "runtime.failure", {
        reason,
        error: this.#serializeError(error),
      });

      throw error;
    }
  }

  async #initialize(): Promise<void> {
    this.#logger.log("info", "runtime.initializing", {
      processId: getProcessId(),
    });

    await Promise.resolve();
  }

  async #dispose(): Promise<void> {
    this.#logger.log("info", "runtime.disposing");

    const failures: RuntimeShutdownFailure[] = [];

    const sessions = this.#sessions.list();

    for (const session of sessions) {
      if (!STOPPABLE_APPLICATION_SESSION_STATES.has(session.state)) {
        continue;
      }

      try {
        await this.stopApplication(session.id);
      } catch (error: unknown) {
        failures.push({
          sessionId: session.id,
          error,
        });

        this.#logger.log("error", "application.stop.failed.during-runtime-shutdown", {
          sessionId: session.id,
          applicationId: session.application.manifest.id,
          sessionState: session.state,
          error: this.#serializeError(error),
        });
      }
    }

    if (failures.length > 0) {
      throw new RuntimeShutdownError(failures);
    }
  }

  #transitionTo(
    requestedState: RuntimeState,
    event: string,
    context: Readonly<Record<string, unknown>> = {},
  ): void {
    const previousState = this.#state;

    assertRuntimeTransition(previousState, requestedState);

    this.#state = requestedState;

    this.#logger.log("info", event, {
      previousState,
      currentState: requestedState,
      ...context,
    });

    this.#notify();
  }

  #assertStateForOperation(
    operation: string,
    allowedStates: readonly RuntimeState[],
  ): void {
    if (allowedStates.includes(this.#state)) {
      return;
    }

    throw new InvalidRuntimeStateError(operation, this.#state, allowedStates);
  }

  #notify(): void {
    this.#version += 1;

    for (const listener of this.#listeners) {
      listener();
    }
  }

  #serializeError(error: unknown): Readonly<Record<string, unknown>> {
    if (error instanceof Error) {
      return {
        name: error.name,
        message: error.message,
        stack: error.stack,
      };
    }

    return {
      message: String(error),
    };
  }
}
