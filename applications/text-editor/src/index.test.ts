import { describe, expect, it } from "vitest";
import { isValidElement } from "react";
import {
  AppRegistry,
  buildSevynApplicationPackage,
  verifyPackageIntegrity,
  type SevynApplicationSdk,
} from "@sevynos/react-native";
import {
  TextEditorApplication,
  createTextEditorApplicationElement,
  resolveTextEditorFilesystem,
  textEditorApplicationBundle,
  textEditorManifest,
} from "./index.js";

describe("standalone Text Editor application", () => {
  it("exposes the editor component and a valid public manifest", () => {
    expect(TextEditorApplication).toBeTypeOf("function");
    expect(createTextEditorApplicationElement).toBeTypeOf("function");
    expect(textEditorManifest.id).toBe("org.sevynos.text-editor");
    expect(textEditorManifest.applicationKey).toBe("TextEditor");
    expect(textEditorManifest.icon).toBe("icons/text-editor.svg");
    expect(textEditorManifest.permissions).toEqual([
      "filesystem.read",
      "filesystem.write",
      "notifications",
    ]);
  });

  it("builds an installable package from the manifest", async () => {
    const applicationPackage = await buildSevynApplicationPackage({
      manifest: textEditorManifest,
      files: { [textEditorManifest.entrypoint]: textEditorApplicationBundle },
      icons: { [textEditorManifest.icon]: "<svg/>" },
    });
    await expect(verifyPackageIntegrity(applicationPackage)).resolves.toBeUndefined();
    expect(applicationPackage.manifest.instanceMode).toBe("multiple");
  });

  it("registers the TextEditor component when the bundle evaluates", () => {
    const host = globalThis as unknown as Record<string, unknown>;
    const previous = host["__SEVYN_MODULES__"];
    host["__SEVYN_MODULES__"] = {
      "react-native": { AppRegistry },
      "@sevynos/app-text-editor": { TextEditorApplication },
    };
    try {
      // Evaluating the shipped bundle string is the point of this test: it
      // proves the bundle registers the component with the host AppRegistry.
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const evaluate = new Function(textEditorApplicationBundle) as () => void;
      evaluate();
      const runnable = AppRegistry.getRunnable("TextEditor");
      expect(runnable?.component).toBe(TextEditorApplication);
    } finally {
      AppRegistry.unregisterComponent("TextEditor");
      if (previous === undefined) delete host["__SEVYN_MODULES__"];
      else host["__SEVYN_MODULES__"] = previous;
    }
  });

  it("wraps the editor in the SDK provider element", () => {
    const sdk = {
      application: {
        id: "org.sevynos.text-editor",
        sessionId: "session-1",
        state: "running",
      },
      windows: { requestWindow: () => Promise.reject(new Error("denied")) },
      theme: { appearance: "dark", accent: "gold", reducedMotion: false },
      storage: {
        get: () => Promise.resolve(undefined),
        set: () => Promise.resolve(),
      },
      workspace: { id: "workspace-1" },
      display: { id: "display-primary", scaleFactor: 1 },
    } as SevynApplicationSdk;
    expect(isValidElement(createTextEditorApplicationElement(sdk))).toBe(true);
  });

  it("requires list, read and write before handing a filesystem to the editor", () => {
    const list = (): Promise<readonly never[]> => Promise.resolve([]);
    const read = (): Promise<string> => Promise.resolve("");
    const write = (): Promise<void> => Promise.resolve();
    expect(resolveTextEditorFilesystem(undefined)).toBeUndefined();
    expect(resolveTextEditorFilesystem({ list, read })).toBeUndefined();
    expect(resolveTextEditorFilesystem({ list, read, write })).toEqual({
      list,
      read,
      write,
    });
  });
});
