import { describe, expect, it } from "vitest";
import { renderDesktopLauncher, type DesktopLauncherRenderInput } from "./desktop.js";

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
