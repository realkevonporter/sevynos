import { describe, expect, it, vi } from "vitest";

import {
  ApplicationSession,
  type ApplicationPackage,
  type RuntimeLogger,
} from "@sevynos/runtime";
import { JavaScriptApplicationHost } from "./javascript-application-host.js";
import type {
  JavaScriptApplicationContext,
  JavaScriptApplicationInstance,
  JavaScriptApplicationModule,
} from "./javascript-application-module.js";
import type { JavaScriptModuleLoader } from "./javascript-module-loader.js";

const application: ApplicationPackage = {
  manifest: {
    manifestVersion: 1,
    id: "org.sevynos.test",
    name: "Test Application",
    version: "1.0.0",
    hostId: "sevyn.host.javascript",
    entrypoint: "index.js",
  },

  files: {
    "index.js": "export function start() { return {}; }",
  },
};

function createSession(
  applicationPackage: ApplicationPackage = application,
): ApplicationSession {
  return new ApplicationSession({
    id: "session-1",
    application: applicationPackage,
    createdAt: new Date("2026-07-27T00:00:00.000Z"),
  });
}

function createLogger(): RuntimeLogger {
  return {
    log(level, event, context): void {
      void level;
      void event;
      void context;
    },
  };
}

function createModuleLoader(
  applicationModule: JavaScriptApplicationModule,
): JavaScriptModuleLoader {
  return {
    load(_source: string): Promise<JavaScriptApplicationModule> {
      void _source;

      return Promise.resolve(applicationModule);
    },
  };
}

describe("JavaScriptApplicationHost", () => {
  it("has the JavaScript host identifier", () => {
    const moduleLoader = createModuleLoader({
      start(): JavaScriptApplicationInstance {
        return {};
      },
    });

    const host = new JavaScriptApplicationHost({
      logger: createLogger(),
      moduleLoader,
    });

    expect(host.id).toBe("sevyn.host.javascript");
  });

  it("loads and starts the application entrypoint", async () => {
    const session = createSession();

    const start = vi.fn(
      (context: JavaScriptApplicationContext): JavaScriptApplicationInstance => ({
        title: context.applicationId,
      }),
    );

    const load = vi.fn((_source: string): Promise<JavaScriptApplicationModule> => {
      void _source;

      return Promise.resolve({
        start,
      });
    });

    const moduleLoader: JavaScriptModuleLoader = {
      load,
    };

    const host = new JavaScriptApplicationHost({
      logger: createLogger(),
      moduleLoader,
    });

    const result = await host.start(session);

    expect(load).toHaveBeenCalledOnce();

    expect(load).toHaveBeenCalledWith(application.files["index.js"]);

    expect(start).toHaveBeenCalledOnce();

    const firstCall = start.mock.calls[0];

    expect(firstCall).toBeDefined();

    const context = firstCall?.[0];

    expect(context).toBeDefined();

    if (context === undefined) {
      throw new Error("Expected the application context to be provided.");
    }

    expect(context.applicationId).toBe(application.manifest.id);
    expect(context.sessionId).toBe(session.id);
    expect(typeof context.log).toBe("function");

    expect(result).toEqual({
      instanceId: "javascript:session-1",
    });
  });

  it("forwards application logging to the runtime logger", async () => {
    const session = createSession();

    const log = vi.fn<RuntimeLogger["log"]>();

    const logger: RuntimeLogger = {
      log,
    };

    const applicationModule: JavaScriptApplicationModule = {
      start(context: JavaScriptApplicationContext): JavaScriptApplicationInstance {
        context.log("Hello from the application.");

        return {};
      },
    };

    const host = new JavaScriptApplicationHost({
      logger,
      moduleLoader: createModuleLoader(applicationModule),
    });

    await host.start(session);

    expect(log).toHaveBeenCalledWith("info", "application.log", {
      applicationId: application.manifest.id,
      sessionId: session.id,
      message: "Hello from the application.",
    });
  });

  it("stops a running application", async () => {
    const session = createSession();

    const stop = vi.fn((context: JavaScriptApplicationContext): Promise<void> => {
      void context;

      return Promise.resolve();
    });

    const applicationModule: JavaScriptApplicationModule = {
      start(): JavaScriptApplicationInstance {
        return {
          title: "Test Application",
        };
      },

      stop,
    };

    const host = new JavaScriptApplicationHost({
      logger: createLogger(),
      moduleLoader: createModuleLoader(applicationModule),
    });

    await host.start(session);
    await host.stop(session);

    expect(stop).toHaveBeenCalledOnce();

    expect(stop).toHaveBeenCalledOnce();

    const stopCall = stop.mock.calls[0];

    expect(stopCall).toBeDefined();

    if (stopCall === undefined) {
      throw new Error("Expected the application stop function to be called.");
    }

    const stopContext = stopCall[0];

    expect(stopContext.applicationId).toBe(application.manifest.id);
    expect(stopContext.sessionId).toBe(session.id);
    expect(typeof stopContext.log).toBe("function");
  });

  it("does not stop an application twice", async () => {
    const session = createSession();

    const stop = vi.fn((context: JavaScriptApplicationContext): Promise<void> => {
      void context;

      return Promise.resolve();
    });

    const applicationModule: JavaScriptApplicationModule = {
      start(): JavaScriptApplicationInstance {
        return {};
      },

      stop,
    };

    const host = new JavaScriptApplicationHost({
      logger: createLogger(),
      moduleLoader: createModuleLoader(applicationModule),
    });

    await host.start(session);
    await host.stop(session);
    await host.stop(session);

    expect(stop).toHaveBeenCalledOnce();
  });

  it("allows an application without a stop function", async () => {
    const session = createSession();

    const applicationModule: JavaScriptApplicationModule = {
      start(): JavaScriptApplicationInstance {
        return {};
      },
    };

    const host = new JavaScriptApplicationHost({
      logger: createLogger(),
      moduleLoader: createModuleLoader(applicationModule),
    });

    await host.start(session);

    await expect(host.stop(session)).resolves.toBeUndefined();
  });

  it("does nothing when stopping an unknown session", async () => {
    const session = createSession();

    const stop = vi.fn((context: JavaScriptApplicationContext): Promise<void> => {
      void context;

      return Promise.resolve();
    });

    const applicationModule: JavaScriptApplicationModule = {
      start(): JavaScriptApplicationInstance {
        return {};
      },

      stop,
    };

    const host = new JavaScriptApplicationHost({
      logger: createLogger(),
      moduleLoader: createModuleLoader(applicationModule),
    });

    await expect(host.stop(session)).resolves.toBeUndefined();

    expect(stop).not.toHaveBeenCalled();
  });

  it("rejects a missing application entrypoint", async () => {
    const missingEntrypointApplication: ApplicationPackage = {
      manifest: {
        ...application.manifest,
        entrypoint: "missing.js",
      },

      files: application.files,
    };

    const session = createSession(missingEntrypointApplication);

    const applicationModule: JavaScriptApplicationModule = {
      start(): JavaScriptApplicationInstance {
        return {};
      },
    };

    const load = vi.fn((source: string): Promise<JavaScriptApplicationModule> => {
      void source;

      return Promise.resolve(applicationModule);
    });

    const host = new JavaScriptApplicationHost({
      logger: createLogger(),
      moduleLoader: {
        load,
      },
    });

    await expect(host.start(session)).rejects.toThrow(
      'Application entrypoint "missing.js" was not found in package "org.sevynos.test".',
    );

    expect(load).not.toHaveBeenCalled();
  });

  it("rejects a module without a start function", async () => {
    const session = createSession();

    const invalidModule = {} as unknown as JavaScriptApplicationModule;

    const host = new JavaScriptApplicationHost({
      logger: createLogger(),
      moduleLoader: createModuleLoader(invalidModule),
    });

    await expect(host.start(session)).rejects.toThrow(
      'Application "org.sevynos.test" does not export a start function.',
    );
  });

  it("propagates module loading failures", async () => {
    const session = createSession();

    const loadError = new Error("Unable to load JavaScript module.");

    const moduleLoader: JavaScriptModuleLoader = {
      load(source: string): Promise<JavaScriptApplicationModule> {
        void source;

        return Promise.reject(loadError);
      },
    };

    const host = new JavaScriptApplicationHost({
      logger: createLogger(),
      moduleLoader,
    });

    await expect(host.start(session)).rejects.toBe(loadError);
  });

  it("propagates application startup failures", async () => {
    const session = createSession();

    const startupError = new Error("Application startup failed.");

    const applicationModule: JavaScriptApplicationModule = {
      start(): Promise<JavaScriptApplicationInstance> {
        return Promise.reject(startupError);
      },
    };

    const host = new JavaScriptApplicationHost({
      logger: createLogger(),
      moduleLoader: createModuleLoader(applicationModule),
    });

    await expect(host.start(session)).rejects.toBe(startupError);

    await expect(host.stop(session)).resolves.toBeUndefined();
  });

  it("propagates application shutdown failures", async () => {
    const session = createSession();

    const shutdownError = new Error("Application shutdown failed.");

    const applicationModule: JavaScriptApplicationModule = {
      start(): JavaScriptApplicationInstance {
        return {};
      },

      stop(context: JavaScriptApplicationContext): Promise<void> {
        void context;

        return Promise.reject(shutdownError);
      },
    };

    const host = new JavaScriptApplicationHost({
      logger: createLogger(),
      moduleLoader: createModuleLoader(applicationModule),
    });

    await host.start(session);

    await expect(host.stop(session)).rejects.toBe(shutdownError);
  });
});
