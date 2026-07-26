// import { JsonRuntimeLogger } from "./logger.js";
// import { SevynRuntime } from "./runtime.js";

// const logger = new JsonRuntimeLogger();

// const runtime = new SevynRuntime({
//   logger,
// });

// let shutdownRequested = false;

// async function requestShutdown(signal: NodeJS.Signals): Promise<void> {
//   if (shutdownRequested) {
//     logger.log("warn", "runtime.shutdown.repeated", {
//       signal,
//     });

//     return;
//   }

//   shutdownRequested = true;

//   logger.log("info", "runtime.shutdown.signal", {
//     signal,
//   });

//   try {
//     await runtime.stop(`signal:${signal}`);
//     process.exitCode = 0;
//   } catch {
//     process.exitCode = 1;
//   }
// }

// process.once("SIGINT", () => {
//   void requestShutdown("SIGINT");
// });

// process.once("SIGTERM", () => {
//   void requestShutdown("SIGTERM");
// });

// process.on("uncaughtException", (error: Error) => {
//   logger.log("error", "runtime.uncaught-exception", {
//     name: error.name,
//     message: error.message,
//     stack: error.stack,
//   });

//   process.exitCode = 1;
// });

// process.on("unhandledRejection", (reason: unknown) => {
//   logger.log("error", "runtime.unhandled-rejection", {
//     reason: reason instanceof Error ? reason.message : String(reason),
//   });

//   process.exitCode = 1;
// });

// try {
//   //await runtime.start();
// } catch {
//   process.exitCode = 1;
// }
