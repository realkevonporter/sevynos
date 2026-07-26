import { randomUUID } from "node:crypto";

import type { ApplicationDescriptor } from "./application/application-descriptor.js";
import type { ApplicationHost } from "./application/application-host.js";
import { ApplicationHostRegistry } from "./application/application-host-registry.js";
import {
  ApplicationManager,
  type StartApplicationResult,
} from "./application/application-manager.js";
import { ApplicationRegistry } from "./application/application-registry.js";
import type {
  ApplicationSession,
  ApplicationSessionId,
} from "./application/application-session.js";
import { SessionRegistry } from "./application/session-registry.js";
import type { RuntimeLogger } from "./logger.js";
import { RUNTIME_IDENTITY } from "./runtime-identity.js";
import { assertRuntimeTransition } from "./runtime-state.js";
import type { RuntimeState } from "./runtime-state.js";
import { InvalidRuntimeStateError } from "./errors/invalid-runtime-state-error.js";

export interface RuntimeOptions {
  readonly logger: RuntimeLogger;
  readonly createSessionId?: () => ApplicationSessionId;
  readonly now?: () => Date;
}

export class SevynRuntime {
  readonly #logger: RuntimeLogger;

  readonly #applications: ApplicationRegistry;
  readonly #hosts: ApplicationHostRegistry;
  readonly #sessions: SessionRegistry;
  readonly #applicationManager: ApplicationManager;

  #state: RuntimeState = "created";
  #shutdownPromise: Promise<void> | undefined;

  public constructor(options: RuntimeOptions) {
    this.#logger = options.logger;

    this.#applications = new ApplicationRegistry();
    this.#hosts = new ApplicationHostRegistry();
    this.#sessions = new SessionRegistry();

    this.#applicationManager = new ApplicationManager({
      applications: this.#applications,
      hosts: this.#hosts,
      sessions: this.#sessions,
      createSessionId:
        options.createSessionId ?? ((): ApplicationSessionId => randomUUID()),
      now: options.now ?? ((): Date => new Date()),
    });
  }

  public get state(): RuntimeState {
    return this.#state;
  }

  public registerApplication(application: ApplicationDescriptor): void {
    this.#applications.register(application);

    this.#logger.log("info", "application.registered", {
      applicationId: application.id,
      applicationName: application.name,
      applicationVersion: application.version,
      hostId: application.hostId,
    });
  }

  public unregisterApplication(applicationId: ApplicationDescriptor["id"]): boolean {
    const removed = this.#applications.unregister(applicationId);

    if (removed) {
      this.#logger.log("info", "application.unregistered", {
        applicationId,
      });
    }

    return removed;
  }

  public registerApplicationHost(host: ApplicationHost): void {
    this.#hosts.register(host);

    this.#logger.log("info", "application.host.registered", {
      hostId: host.id,
    });
  }

  public unregisterApplicationHost(hostId: ApplicationHost["id"]): boolean {
    const removed = this.#hosts.unregister(hostId);

    if (removed) {
      this.#logger.log("info", "application.host.unregistered", {
        hostId,
      });
    }

    return removed;
  }

  public async startApplication(
    applicationId: ApplicationDescriptor["id"],
  ): Promise<StartApplicationResult> {
    this.#assertStateForOperation("start application", ["running"]);

    const result = await this.#applicationManager.start(applicationId);

    this.#logger.log("info", "application.started", {
      applicationId,
      sessionId: result.session.id,
      hostId: result.session.application.hostId,
      hostInstanceId: result.host.instanceId,
    });

    return result;
  }

  public async stopApplication(
    sessionId: ApplicationSessionId,
  ): Promise<ApplicationSession> {
    this.#assertStateForOperation("stop application", ["running", "stopping"]);

    const session = await this.#applicationManager.stop(sessionId);

    this.#logger.log("info", "application.stopped", {
      applicationId: session.application.id,
      sessionId: session.id,
      hostId: session.application.hostId,
    });

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

  public async start(): Promise<void> {
    this.#transitionTo("starting", "runtime.start.requested");

    try {
      await this.#initialize();

      this.#transitionTo("running", "runtime.start.completed");

      this.#logger.log("info", "runtime.ready", {
        runtimeId: RUNTIME_IDENTITY.id,
        architectureVersion: RUNTIME_IDENTITY.architectureVersion,
        processId: process.pid,
      });
    } catch (error: unknown) {
      this.#transitionTo("failed", "runtime.start.failed");

      this.#logger.log("error", "runtime.failure", {
        error: this.#serializeError(error),
      });

      throw error;
    }
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
      processId: process.pid,
    });

    await Promise.resolve();
  }

  async #dispose(): Promise<void> {
    this.#logger.log("info", "runtime.disposing");

    const sessions = this.#sessions.list();

    for (const session of sessions) {
      if (session.state !== "running") {
        continue;
      }

      await this.stopApplication(session.id);
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
