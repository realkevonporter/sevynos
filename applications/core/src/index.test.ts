import { describe, expect, it } from "vitest";
import { isValidElement } from "react";
import { InMemoryFileSystem, SystemNotificationService } from "@sevynos/react-native";
import {
  AppManagerApplication,
  ComponentGalleryApplication,
  InstallerApplication,
  NotesApplication,
  ReactNativeIdeApplication,
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
      ReactNativeIdeApplication,
      NotesApplication,
    ])
      expect(component).toBeTypeOf("function");
  });

  it("creates a valid element for every core application kind", () => {
    const filesystem = new InMemoryFileSystem();
    const notifications = new SystemNotificationService();
    const elements = [
      createCoreSystemApplication({ kind: "installer" }),
      createCoreSystemApplication({ kind: "gallery" }),
      createCoreSystemApplication({ kind: "text-editor", filesystem, notifications }),
      createCoreSystemApplication({
        kind: "app-manager",
        applications: [],
      }),
      createCoreSystemApplication({ kind: "ide", filesystem, notifications }),
      createCoreSystemApplication({ kind: "notes", filesystem, notifications }),
      createCoreSystemApplication({ kind: "files", filesystem, notifications }),
    ];
    expect(elements).toHaveLength(7);
    for (const element of elements) expect(isValidElement(element)).toBe(true);
  });
});
