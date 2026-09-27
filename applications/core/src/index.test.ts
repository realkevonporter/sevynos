import { describe, expect, it } from "vitest";
import { isValidElement } from "react";
import {
  InMemoryFileSystem,
  SystemNotificationService,
  type BrowserEngineSnapshot,
  type SevynBrowserEngine,
} from "@sevynos/react-native";
import {
  AppManagerApplication,
  ComponentGalleryApplication,
  InstallerApplication,
  NotesApplication,
  TextEditorApplication,
  createCoreSystemApplication,
} from "./index.js";

describe("core system applications", () => {
  it("exports every built-in application component", () => {
    for (const component of [
      InstallerApplication,
      ComponentGalleryApplication,
      TextEditorApplication,
      AppManagerApplication,
      NotesApplication,
    ])
      expect(component).toBeTypeOf("function");
  });

  it("creates a valid element for every core application kind", () => {
    const filesystem = new InMemoryFileSystem();
    const notifications = new SystemNotificationService();
    const emptySnapshot = (): BrowserEngineSnapshot => ({
      ready: false,
      loading: false,
      url: "about:blank",
      title: "",
      width: 0,
      height: 0,
      pixels: undefined,
    });
    const mockBrowserEngine: SevynBrowserEngine = {
      snapshot: emptySnapshot,
      subscribe: () => {
        return () => undefined;
      },
      navigate: () => Promise.resolve(emptySnapshot()),
      back: () => Promise.resolve(emptySnapshot()),
      forward: () => Promise.resolve(emptySnapshot()),
      reload: () => Promise.resolve(emptySnapshot()),
      resize: () => Promise.resolve(emptySnapshot()),
      click: () => Promise.resolve(emptySnapshot()),
      pointerDown: () => Promise.resolve(emptySnapshot()),
      pointerUp: () => Promise.resolve(emptySnapshot()),
      pointerMove: () => Promise.resolve(emptySnapshot()),
      scroll: () => Promise.resolve(emptySnapshot()),
      key: () => Promise.resolve(emptySnapshot()),
      close: () => Promise.resolve(),
    };
    const elements = [
      createCoreSystemApplication({ kind: "installer" }),
      createCoreSystemApplication({ kind: "gallery" }),
      createCoreSystemApplication({ kind: "text-editor", filesystem, notifications }),
      createCoreSystemApplication({
        kind: "app-manager",
        applications: [],
      }),
      createCoreSystemApplication({ kind: "ide", browserEngine: mockBrowserEngine }),
      createCoreSystemApplication({ kind: "notes", filesystem, notifications }),
      createCoreSystemApplication({ kind: "files", filesystem, notifications }),
    ];
    expect(elements).toHaveLength(7);
    for (const element of elements) expect(isValidElement(element)).toBe(true);
  });
});
