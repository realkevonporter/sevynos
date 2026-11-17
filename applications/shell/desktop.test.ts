import { describe, expect, it } from "vitest";
import {
  renderDesktopLauncher,
  renderDesktopWallpaper,
  renderDesktopWorkspace,
  type DesktopLauncherRenderInput,
  type DesktopWallpaperRenderInput,
} from "./desktop.js";

const baseInput: DesktopLauncherRenderInput = {
  open: true,
  taskbarBounds: { x: 0, y: 744, width: 1280, height: 56 },
  displayBounds: { x: 0, y: 0, width: 1280, height: 800 },
  position: "bottom",
  catalog: [
    { applicationId: "org.sevynos.files", label: "Files", running: true },
    { applicationId: "org.sevynos.settings", label: "System Settings", running: false },
  ],
  order: 200,
};

describe("desktop application launcher", () => {
  it("renders a full-bleed display surface for launcher", () => {
    const nodes = renderDesktopLauncher(baseInput);
    const surface = nodes.find((node) => node.kind === "desktop-launcher-surface");
    expect(surface?.bounds).toEqual({ x: 0, y: 0, width: 1280, height: 800 });
  });

  it("renders applications as grid tiles", () => {
    const nodes = renderDesktopLauncher(baseInput);
    const entries = nodes.filter((node) => node.kind === "desktop-launcher-entry");
    expect(entries).toHaveLength(2);
    expect(entries[0]?.bounds.height).toBe(112);
    expect(entries[1]?.bounds.x).toBeGreaterThan(entries[0]?.bounds.x ?? 0);
  });

  it("filters applications using the launcher query", () => {
    const nodes = renderDesktopLauncher({ ...baseInput, searchQuery: "settings" });
    const entries = nodes.filter((node) => node.kind === "desktop-launcher-entry");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ applicationId: "org.sevynos.settings" });
  });

  it("filters applications using keyword aliases and bundle IDs", () => {
    // "folder" is an alias for Files
    const folderNodes = renderDesktopLauncher({ ...baseInput, searchQuery: "folder" });
    const folderEntries = folderNodes.filter(
      (node) => node.kind === "desktop-launcher-entry",
    );
    expect(folderEntries).toHaveLength(1);
    expect(folderEntries[0]).toMatchObject({ applicationId: "org.sevynos.files" });

    // "config" is an alias for System Settings
    const configNodes = renderDesktopLauncher({ ...baseInput, searchQuery: "config" });
    const configEntries = configNodes.filter(
      (node) => node.kind === "desktop-launcher-entry",
    );
    expect(configEntries).toHaveLength(1);
    expect(configEntries[0]).toMatchObject({ applicationId: "org.sevynos.settings" });

    // "org.sevynos.files" matches by bundle ID
    const idNodes = renderDesktopLauncher({
      ...baseInput,
      searchQuery: "org.sevynos.files",
    });
    const idEntries = idNodes.filter((node) => node.kind === "desktop-launcher-entry");
    expect(idEntries).toHaveLength(1);
    expect(idEntries[0]).toMatchObject({ applicationId: "org.sevynos.files" });
  });

  it("only renders the launcher button while closed", () => {
    const nodes = renderDesktopLauncher({ ...baseInput, open: false });
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.kind).toBe("desktop-launcher-button");
  });
});

describe("desktop wallpaper", () => {
  const wallpaperInput: DesktopWallpaperRenderInput = {
    displays: [
      {
        id: "display-1",
        bounds: { x: 0, y: 0, width: 1280, height: 800 },
        taskbarBounds: { x: 0, y: 744, width: 1280, height: 56 },
      },
    ],
  };

  it("carries the selected style and color on the background node", () => {
    const nodes = renderDesktopWallpaper({
      ...wallpaperInput,
      wallpaperStyle: "cosmic",
      wallpaperColor: "#312e81",
    });
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      kind: "desktop-background",
      wallpaperStyle: "cosmic",
      wallpaperColor: "#312e81",
    });
  });

  it("omits the wallpaper fields when no choice was made", () => {
    const nodes = renderDesktopWallpaper(wallpaperInput);
    expect(nodes[0]).not.toHaveProperty("wallpaperStyle");
    expect(nodes[0]).not.toHaveProperty("wallpaperColor");
  });
});

describe("desktop workspace fallback", () => {
  it("ignores the React Native callbacks and renders the same nodes", () => {
    const input = {
      display: { x: 0, y: 0, width: 1280, height: 800 },
      entries: [
        { name: "Photos", path: "/Desktop/Photos", kind: "directory" as const },
        { name: "notes.txt", path: "/Desktop/notes.txt", kind: "file" as const },
      ],
      order: 0.5,
    };
    const plain = renderDesktopWorkspace(input);
    const withCallbacks = renderDesktopWorkspace({
      ...input,
      onNewFolder: () => undefined,
      onNewFile: () => undefined,
      onOpenEntry: () => undefined,
      onRenameEntry: () => undefined,
      onDeleteEntry: () => undefined,
      onPasteEntry: () => undefined,
      onChangeWallpaper: () => undefined,
    });
    expect(withCallbacks).toEqual(plain);
    expect(
      withCallbacks
        .filter((node) => node.kind === "desktop-workspace-item")
        .map((node) => node.path),
    ).toEqual(["/Desktop/Photos", "/Desktop/notes.txt"]);
  });
});
