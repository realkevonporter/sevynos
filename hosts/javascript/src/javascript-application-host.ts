import type {
  ApplicationHost,
  ApplicationHostStartResult,
  ApplicationModule,
  ApplicationModuleContext,
  ApplicationModuleInstance,
  ApplicationSession,
  ApplicationSessionId,
  RuntimeLogger,
} from "@sevynos/runtime";
import type { JavaScriptModuleLoader } from "./javascript-module-loader.js";

interface RunningApplication {
  readonly module: ApplicationModule;
  readonly context: ApplicationModuleContext;
  readonly instance: ApplicationModuleInstance;
}

export interface JavaScriptApplicationHostOptions {
  readonly logger: RuntimeLogger;
  readonly moduleLoader: JavaScriptModuleLoader;
}

export class JavaScriptApplicationHost implements ApplicationHost {
  public readonly id = "sevyn.host.javascript";

  readonly #logger: RuntimeLogger;
  readonly #moduleLoader: JavaScriptModuleLoader;

  readonly #running = new Map<ApplicationSessionId, RunningApplication>();

  public constructor(options: JavaScriptApplicationHostOptions) {
    this.#logger = options.logger;
    this.#moduleLoader = options.moduleLoader;
  }

  public async start(session: ApplicationSession): Promise<ApplicationHostStartResult> {
    const { manifest, files } = session.application;

    const source = files[manifest.entrypoint];

    if (source === undefined) {
      throw new Error(
        `Application entrypoint "${manifest.entrypoint}" was not found in package "${manifest.id}".`,
      );
    }

    const module = await this.#moduleLoader.load(source);

    if (typeof module.start !== "function") {
      throw new Error(`Application "${manifest.id}" does not export a start function.`);
    }

    const context: ApplicationModuleContext = {
      applicationId: manifest.id,
      sessionId: session.id,

      log: (message): void => {
        this.#logger.log("info", "application.log", {
          applicationId: manifest.id,
          sessionId: session.id,
          message,
        });
      },
    };

    const instance = await module.start(context);

    this.#running.set(session.id, {
      module,
      context,
      instance,
    });

    return {
      instanceId: `javascript:${session.id}`,
    };
  }

  public async stop(session: ApplicationSession): Promise<void> {
    const running = this.#running.get(session.id);

    if (running === undefined) {
      return;
    }

    await running.module.stop?.(running.context);

    this.#running.delete(session.id);
  }
}
