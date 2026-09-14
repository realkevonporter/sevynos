import electronPath from "electron";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { watchSystemApplications } from "./build-system-applications.mjs";

const hostRoot = resolve(import.meta.dirname, "..");
const buildContext = await watchSystemApplications();
const electron = spawn(electronPath, [hostRoot], { stdio: "inherit" });

const stop = async () => {
  await buildContext.dispose();
  if (electron.exitCode === null) electron.kill("SIGTERM");
};

process.once("SIGINT", () => {
  void stop();
});
process.once("SIGTERM", () => {
  void stop();
});
electron.once("error", async (error) => {
  console.error(error);
  await stop();
  process.exitCode = 1;
});
electron.once("exit", async (code) => {
  await buildContext.dispose();
  process.exitCode = code ?? 1;
});
