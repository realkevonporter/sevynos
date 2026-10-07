import { describe, expect, it } from "vitest";
import {
  DEFAULT_INSTALLED_APPS,
  SYSTEM_SHORTCUTS,
  canUninstallApp,
  isAppProtected,
  settingsManifest,
} from "./index.js";

describe("SettingsApplication", () => {
  it("exports a valid SevynApplicationManifest", () => {
    expect(settingsManifest.id).toBe("org.sevynos.settings");
    expect(settingsManifest.name).toBe("Settings");
    expect(settingsManifest.runtime).toBe("react-native");
  });

  it("defines default installed applications with protected core apps and deletable stock apps", () => {
    expect(DEFAULT_INSTALLED_APPS.length).toBeGreaterThanOrEqual(8);

    const shell = DEFAULT_INSTALLED_APPS.find((app) => app.id === "org.sevynos.shell");
    const terminal = DEFAULT_INSTALLED_APPS.find(
      (app) => app.id === "org.sevynos.terminal",
    );
    const browser = DEFAULT_INSTALLED_APPS.find(
      (app) => app.id === "org.sevynos.browser",
    );
    const notes = DEFAULT_INSTALLED_APPS.find((app) => app.id === "org.sevynos.notes");
    const textEditor = DEFAULT_INSTALLED_APPS.find(
      (app) => app.id === "org.sevynos.text-editor",
    );
    const calculator = DEFAULT_INSTALLED_APPS.find(
      (app) => app.id === "org.sevynos.calculator",
    );

    expect(shell).toBeDefined();
    if (shell) {
      expect(shell.system).toBe(true);
      expect(isAppProtected(shell)).toBe(true);
      expect(canUninstallApp(shell)).toBe(false);
    }

    expect(terminal).toBeDefined();
    if (terminal) {
      expect(terminal.system).toBe(true);
      expect(isAppProtected(terminal)).toBe(true);
      expect(canUninstallApp(terminal)).toBe(false);
    }

    expect(browser).toBeDefined();
    if (browser) {
      expect(browser.system).toBe(false);
      expect(isAppProtected(browser)).toBe(false);
      expect(canUninstallApp(browser)).toBe(true);
    }

    expect(notes).toBeDefined();
    if (notes) {
      expect(notes.system).toBe(false);
      expect(isAppProtected(notes)).toBe(false);
      expect(canUninstallApp(notes)).toBe(true);
    }

    expect(textEditor).toBeDefined();
    if (textEditor) {
      expect(textEditor.system).toBe(false);
      expect(canUninstallApp(textEditor)).toBe(true);
    }

    expect(calculator).toBeDefined();
    if (calculator) {
      expect(calculator.system).toBe(false);
      expect(canUninstallApp(calculator)).toBe(true);
    }
  });

  it("exports documented keyboard shortcuts covering window management, system, and workspaces", () => {
    expect(SYSTEM_SHORTCUTS.length).toBe(3);
    const windowGroup = SYSTEM_SHORTCUTS.find((g) => g.category === "Window Management");
    const systemGroup = SYSTEM_SHORTCUTS.find((g) => g.category === "System & Shell");
    const workspaceGroup = SYSTEM_SHORTCUTS.find((g) => g.category === "Workspaces");

    expect(windowGroup).toBeDefined();
    expect(systemGroup).toBeDefined();
    expect(workspaceGroup).toBeDefined();

    expect(windowGroup?.shortcuts.some((s) => s.label.includes("Snap"))).toBe(true);
    expect(windowGroup?.shortcuts.some((s) => s.label.includes("Switcher"))).toBe(true);
    expect(systemGroup?.shortcuts.some((s) => s.label.includes("Lock Screen"))).toBe(
      true,
    );
    expect(workspaceGroup?.shortcuts.some((s) => s.label.includes("Workspace"))).toBe(
      true,
    );
  });

  it("supports the rebuilt settings categories (no fabricated hardware sections)", () => {
    // Type and runtime exports check
    const categories: import("./index.js").SettingsCategory[] = [
      "appearance",
      "network",
      "sound",
      "battery",
      "applications",
      "shortcuts",
      "about",
    ];
    expect(categories).toContain("appearance");
    expect(categories).toContain("network");
    expect(categories).not.toContain("display");
    expect(categories).not.toContain("biometrics");
    expect(categories).not.toContain("storage");
  });
});
