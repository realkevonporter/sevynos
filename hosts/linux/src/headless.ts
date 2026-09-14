import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DisplayRenderPlanner, GenesisFrameExecutor } from "@sevynos/graphics";
import {
  createDesktopRuntime,
  DesktopSceneComposer,
  type DesktopScene,
} from "@sevynos/desktop-shell";
import { HeadlessGenesisRenderer } from "./headless-renderer.js";

export async function runHeadlessLinuxHost(destination?: string): Promise<string> {
  const runtime = await createDesktopRuntime();
  runtime.layout.configureViewport(1280, 720, 1, "side-by-side");
  let invalidate = (): void => undefined;
  const composer = new DesktopSceneComposer(runtime, undefined, () => {
    invalidate();
  });
  const planner = new DisplayRenderPlanner({
    displays: runtime.environment.displays,
    now: () => new Date(0),
  });
  const renderer = new HeadlessGenesisRenderer();
  renderer.initialize();
  const executor = new GenesisFrameExecutor<DesktopScene>({
    createRenderPlans: () =>
      planner.createRenderPlans(
        composer.compose({ width: 1280, height: 720, scaleFactor: 1 }),
      ),
    renderer,
    now: () => new Date(0),
  });
  invalidate = (): void => {
    executor.executeFrame();
  };
  const result = executor.executeFrame();
  if (result.failures.length > 0) throw new Error("The headless Genesis frame failed.");
  const currentDirectory = dirname(fileURLToPath(import.meta.url));
  const output = destination ?? resolve(currentDirectory, "frame-snapshot.json");
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(renderer.snapshot(), null, 2)}\n`, "utf8");
  composer.dispose();
  runtime.beginShutdown();
  await runtime.closeForShutdown();
  renderer.shutdown();
  return output;
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const output = await runHeadlessLinuxHost();
  console.log(`Genesis headless frame: ${output}`);
}
