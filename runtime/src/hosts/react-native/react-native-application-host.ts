import type {
  ApplicationHost,
  ApplicationHostStartResult,
} from "../../application/application-host.js";
import type {
  ApplicationSession,
  ApplicationSessionId,
} from "../../application/application-session.js";
import type { RuntimeLogger } from "../../logger.js";
import type { ReactNativeApplicationSurface } from "./react-native-application-surface.js";
import type { ReactNativeComponentRegistry } from "./react-native-component-registry.js";

export interface ReactNativeApplicationHostOptions {
  readonly logger: RuntimeLogger;
  readonly componentRegistry: ReactNativeComponentRegistry;
  readonly surface: ReactNativeApplicationSurface;
}

export class ReactNativeApplicationHost implements ApplicationHost {
  public readonly id = "sevyn.host.react-native";

  readonly #logger: RuntimeLogger;
  readonly #componentRegistry: ReactNativeComponentRegistry;
  readonly #surface: ReactNativeApplicationSurface;

  readonly #running = new Set<ApplicationSessionId>();

  public constructor(options: ReactNativeApplicationHostOptions) {
    this.#logger = options.logger;
    this.#componentRegistry = options.componentRegistry;
    this.#surface = options.surface;
  }

  public async start(session: ApplicationSession): Promise<ApplicationHostStartResult> {
    const { manifest } = session.application;

    if (this.#running.has(session.id)) {
      throw new Error(
        `React Native application session "${session.id}" is already running.`,
      );
    }

    const component = this.#componentRegistry.get(manifest.entrypoint);

    if (component === undefined) {
      throw new Error(
        `React Native entrypoint "${manifest.entrypoint}" is not registered for application "${manifest.id}".`,
      );
    }

    await this.#surface.mount({
      sessionId: session.id,
      component,
      props: {
        applicationId: manifest.id,
        sessionId: session.id,
      },
    });

    this.#running.add(session.id);

    this.#logger.log("info", "react-native.application.started", {
      applicationId: manifest.id,
      sessionId: session.id,
      entrypoint: manifest.entrypoint,
    });

    return {
      instanceId: `react-native:${session.id}`,
    };
  }

  public async stop(session: ApplicationSession): Promise<void> {
    if (!this.#running.has(session.id)) {
      return;
    }

    try {
      await this.#surface.unmount(session.id);
    } finally {
      this.#running.delete(session.id);
    }

    this.#logger.log("info", "react-native.application.stopped", {
      applicationId: session.application.manifest.id,
      sessionId: session.id,
    });
  }
}
