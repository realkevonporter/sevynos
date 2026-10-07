import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TERMINAL_APPS,
  LINUX_ESCAPE_COMMANDS,
  PRISTINE_PACKAGES,
  TerminalApplication,
  terminalManifest,
} from "./index.js";
import type { SevynFileSystem } from "@sevynos/react-native";

describe("TerminalApplication Manifest and Security", () => {
  it("exports a valid SevynApplicationManifest without raw process spawning", () => {
    expect(terminalManifest.id).toBe("org.sevynos.terminal");
    expect(terminalManifest.name).toBe("Terminal");
    expect(terminalManifest.runtime).toBe("react-native");
    expect(terminalManifest.permissions).toEqual(["filesystem.read", "filesystem.write"]);
    expect(terminalManifest.permissions).not.toContain("process:spawn");
  });

  it("defines comprehensive list of blocked Linux escape commands", () => {
    expect(LINUX_ESCAPE_COMMANDS.has("bash")).toBe(true);
    expect(LINUX_ESCAPE_COMMANDS.has("sh")).toBe(true);
    expect(LINUX_ESCAPE_COMMANDS.has("zsh")).toBe(true);
    expect(LINUX_ESCAPE_COMMANDS.has("sudo")).toBe(true);
    expect(LINUX_ESCAPE_COMMANDS.has("su")).toBe(true);
    expect(LINUX_ESCAPE_COMMANDS.has("systemctl")).toBe(true);
    expect(LINUX_ESCAPE_COMMANDS.has("chvt")).toBe(true);
    expect(LINUX_ESCAPE_COMMANDS.has("apt")).toBe(true);
    expect(LINUX_ESCAPE_COMMANDS.has("killall")).toBe(true);
    expect(LINUX_ESCAPE_COMMANDS.has("passwd")).toBe(true);
  });

  it("provides pristine packages catalog for recovery without Linux shell", () => {
    expect(PRISTINE_PACKAGES.has("org.sevynos.shell")).toBe(true);
    expect(PRISTINE_PACKAGES.has("org.sevynos.terminal")).toBe(true);
    expect(PRISTINE_PACKAGES.has("org.sevynos.settings")).toBe(true);
    expect(PRISTINE_PACKAGES.has("org.sevynos.browser")).toBe(true);
    expect(PRISTINE_PACKAGES.get("org.sevynos.shell")?.system).toBe(true);
    expect(PRISTINE_PACKAGES.get("org.sevynos.browser")?.system).toBe(false);
  });

  it("marks core applications as protected", () => {
    const shellApp = DEFAULT_TERMINAL_APPS.find((a) => a.id === "org.sevynos.shell");
    const terminalApp = DEFAULT_TERMINAL_APPS.find(
      (a) => a.id === "org.sevynos.terminal",
    );
    const musicApp = DEFAULT_TERMINAL_APPS.find((a) => a.id === "org.sevynos.music");
    expect(shellApp?.system).toBe(true);
    expect(terminalApp?.system).toBe(true);
    expect(musicApp?.system).toBe(false);
  });
});

describe("TerminalApplication Component Rendering", () => {
  it("mounts and renders initial state with filesystem and app management callbacks", () => {
    const mockFilesystem: SevynFileSystem = {
      list: vi.fn().mockResolvedValue([
        { name: "Documents", kind: "directory", path: "/var/lib/sevynos/Documents" },
        { name: "readme.txt", kind: "file", path: "/var/lib/sevynos/readme.txt" },
      ]),
      read: vi.fn().mockResolvedValue("Hello SevynOS"),
      write: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      createDirectory: vi.fn().mockResolvedValue(undefined),
      stat: vi.fn().mockResolvedValue({
        name: "readme.txt",
        kind: "file",
        path: "/var/lib/sevynos/readme.txt",
      }),
    };

    const onInstallApp = vi.fn().mockResolvedValue("Installed");
    const onUninstallApp = vi.fn().mockResolvedValue(undefined);
    const onRestoreApp = vi.fn().mockResolvedValue("Restored");
    const onRefreshApps = vi.fn().mockResolvedValue([]);

    const element = createElement(TerminalApplication, {
      filesystem: mockFilesystem,
      onRefreshApps,
      onInstallApp,
      onUninstallApp,
      onRestoreApp,
    });

    expect(element).toBeDefined();
    expect(element.type).toBe(TerminalApplication);
    expect(element.props.filesystem).toBe(mockFilesystem);
    expect(element.props.onRefreshApps).toBe(onRefreshApps);
    expect(element.props.onInstallApp).toBe(onInstallApp);
    expect(element.props.onUninstallApp).toBe(onUninstallApp);
    expect(element.props.onRestoreApp).toBe(onRestoreApp);
  });

  it("supports custom installed application inventory", () => {
    const customApps = [
      {
        id: "com.example.custom",
        name: "Custom App",
        version: "1.2.0",
        system: false,
        permissions: ["storage:local"],
      },
    ];

    const element = createElement(TerminalApplication, {
      installedApps: customApps,
    });

    expect(element.props.installedApps).toEqual(customApps);
  });
});

describe("application icon asset", () => {
  it("ships the manifest-declared icon file", async () => {
    const { existsSync } = await import("node:fs");
    const iconUrl = new URL(`../${terminalManifest.icon}`, import.meta.url);
    expect(existsSync(iconUrl)).toBe(true);
  });
});
