/**
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Cross-workstream integration wiring: the store app is registered in the
 * launcher catalog and its surface case mounts StoreApplication with the
 * injected host props (terminal-style controller functions plus the two new
 * store host functions).
 */
import { describe, expect, it } from "vitest";
import { createDesktopRuntime } from "./desktop-runtime.js";
import { DesktopSceneComposer } from "./desktop-scene-composer.js";
import type { ApplicationManagementController } from "./application-surfaces.js";

function stubController(): ApplicationManagementController {
  const unimplemented = (name: string): never => {
    throw new Error(`unexpected ${name} call in test`);
  };
  return {
    list: () => [],
    launch: () => Promise.resolve(),
    terminate: () => Promise.resolve(),
    listInstalledApps: () => Promise.resolve([]),
    installApp: () => unimplemented("installApp"),
    uninstallApp: () => Promise.resolve(),
    restoreApp: () => unimplemented("restoreApp"),
    inspectBundle: () => unimplemented("inspectBundle"),
    installCatalogEntry: () => unimplemented("installCatalogEntry"),
  };
}

describe("store surface wiring", () => {
  it("registers org.sevynos.store in the launcher catalog", async () => {
    const runtime = await createDesktopRuntime({ launchDefaults: false });
    try {
      // launch() resolves the id through DESKTOP_APPLICATION_CATALOG; an
      // unregistered id throws.
      const launched = await runtime.applications.launch("org.sevynos.store");
      expect(launched.definition.id).toBe("org.sevynos.store");
      expect(launched.definition.kind).toBe("store");
      expect(launched.definition.hiddenFromLauncher).not.toBe(true);
      const surface = runtime.surfaces.get(launched.windowId);
      expect(surface?.kind).toBe("store");
    } finally {
      await runtime.closeForShutdown();
    }
  });

  it("mounts the store surface with injected host props", async () => {
    const runtime = await createDesktopRuntime({ launchDefaults: false });
    try {
      runtime.surfaces.configureApplicationManagement(stubController());
      const launched = await runtime.applications.launch("org.sevynos.store");
      const composer = new DesktopSceneComposer(runtime);
      // Composing mounts the StoreApplication tree through #applicationTree;
      // a prop mismatch or missing host function would throw here.
      const scene = composer.compose({ width: 1200, height: 800, scaleFactor: 1 });
      expect(scene.nodes.length).toBeGreaterThan(0);
      composer.dispose();
      expect(runtime.surfaces.get(launched.windowId)?.kind).toBe("store");
    } finally {
      await runtime.closeForShutdown();
    }
  });

  it("exposes the archive and download-directory injection points", async () => {
    const runtime = await createDesktopRuntime({ launchDefaults: false });
    try {
      // The Files Extract UI and the browser download actions stay inert
      // until the host injects these; configuring them must not throw.
      const { FileArchiveService } = await import("@sevynos/file-archives");
      runtime.surfaces.configureArchiveService(
        new FileArchiveService({ rootDirectory: "/tmp" }),
      );
      runtime.surfaces.configureBrowserDownloadDirectory("/tmp/Downloads");
    } finally {
      await runtime.closeForShutdown();
    }
  });
});
