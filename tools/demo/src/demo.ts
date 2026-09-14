import {
  DataUrlJavaScriptModuleLoader,
  JavaScriptApplicationHost,
} from "@sevynos/javascript-host";

import { SevynRuntime, SevynRuntimeLogger } from "@sevynos/runtime";

const logger = new SevynRuntimeLogger();

const runtime = new SevynRuntime({
  logger,
});

const helloPackage = {
  manifest: {
    manifestVersion: 1,
    id: "org.sevynos.hello",
    name: "Hello SevynOS",
    version: "0.1.0",
    hostId: "sevyn.host.javascript",
    entrypoint: "index.js",
  },

  files: {
    "index.js": `
      export async function start(context) {
        context.log("Hello from SevynOS!");

        return {
          title: "Hello SevynOS"
        };
      }

      export async function stop(context) {
        context.log("SevynOS application stopped.");
      }
    `,
  },
};

runtime.registerApplicationHost(
  new JavaScriptApplicationHost({
    logger,
    moduleLoader: new DataUrlJavaScriptModuleLoader(),
  }),
);

runtime.registerApplication(helloPackage);

await runtime.start();

const result = await runtime.startApplication("org.sevynos.hello");

logger.log("info", "demo.application.running", {
  sessionId: result.session.id,
  instanceId: result.host.instanceId,
});

await runtime.stop("Demo completed.");
