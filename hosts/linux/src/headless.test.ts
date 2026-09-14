import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDesktopRuntime, DesktopSceneComposer } from "@sevynos/desktop-shell";
import { runHeadlessLinuxHost } from "./headless.js";

describe("Genesis headless Linux host", () => {
  it("composes the shared desktop runtime and writes a deterministic frame log", async () => {
    const output = join(process.cwd(), "dist", "test-frame-snapshot.json");
    await runHeadlessLinuxHost(output);
    const snapshot = JSON.parse(await readFile(output, "utf8")) as {
      displays?: readonly { nodeKinds?: readonly string[] }[];
    };
    expect(snapshot.displays).toHaveLength(2);
    expect(snapshot.displays?.[0]?.nodeKinds).toContain("desktop-window");
  });

  it("shares runtime composition with Electron while using a headless renderer", async () => {
    const runtime = await createDesktopRuntime();
    const scene = new DesktopSceneComposer(runtime).compose({
      width: 1200,
      height: 800,
      scaleFactor: 1,
    });
    expect(scene.nodes.some((node) => node.kind === "desktop-background")).toBe(true);
    expect(runtime.applications.listRunning()).toHaveLength(2);
    runtime.beginShutdown();
    await runtime.closeForShutdown();
  });
});
