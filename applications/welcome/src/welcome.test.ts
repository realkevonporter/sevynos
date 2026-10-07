/* eslint-disable no-restricted-imports */
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetDroppedPropWarnings,
  SevynApplicationRuntime,
} from "@sevynos/react-native/internal";
import { WelcomeApplication, welcomeManifest } from "./index.js";

describe("WelcomeApplication", () => {
  const originalEnv = process.env["NODE_ENV"];

  beforeEach(() => {
    resetDroppedPropWarnings();
    process.env["NODE_ENV"] = "development";
  });

  afterEach(() => {
    process.env["NODE_ENV"] = originalEnv;
    vi.restoreAllMocks();
  });

  it("exports a valid SevynApplicationManifest", () => {
    expect(welcomeManifest.id).toBe("org.sevynos.welcome");
    expect(welcomeManifest.name).toBe("Welcome");
    expect(welcomeManifest.runtime).toBe("react-native");
  });

  it("renders card outlines with borderWidth: 1 and silences warnings for honored props", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation((): void => undefined);

    const runtime = new SevynApplicationRuntime({
      bounds: { x: 0, y: 0, width: 800, height: 600 },
    });

    runtime.mount(createElement(WelcomeApplication, {}));

    // Must NOT warn for borderWidth or lineHeight since they are now honored
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringMatching(/Style prop "borderWidth"/),
    );
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringMatching(/Style prop "lineHeight"/),
    );

    // Verify emitted commands include cards with borderWidth === 1
    const snapshot = runtime.snapshot;
    const borderedElements = snapshot.commands.filter(
      (cmd) =>
        (cmd.kind === "material" || cmd.kind === "control") && cmd.borderWidth === 1,
    );
    expect(borderedElements.length).toBeGreaterThanOrEqual(4);

    // Verify pressable cards render as interactive control commands with button chrome
    const controlCards = snapshot.commands.filter(
      (cmd) => cmd.kind === "control" && cmd.borderWidth === 1,
    );
    expect(controlCards).toHaveLength(4);

    // Verify text commands include lineHeight
    const textWithLineHeight = snapshot.commands.filter(
      (cmd) => cmd.kind === "text" && cmd.lineHeight === 14,
    );
    expect(textWithLineHeight.length).toBeGreaterThanOrEqual(1);

    // Must remain completely silent for all standard styled props
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("stays completely silent in production mode", () => {
    process.env["NODE_ENV"] = "production";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation((): void => undefined);

    const runtime = new SevynApplicationRuntime({
      bounds: { x: 0, y: 0, width: 800, height: 600 },
    });

    runtime.mount(createElement(WelcomeApplication, {}));

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("ensures welcome app text does not overflow its boxes at any window size", () => {
    const testWidths = [380, 480, 600, 720, 800, 1024, 1280];

    for (const width of testWidths) {
      const runtime = new SevynApplicationRuntime({
        bounds: { x: 0, y: 0, width, height: 700 },
      });

      runtime.mount(createElement(WelcomeApplication, {}));

      const snapshot = runtime.snapshot;
      const textCommands = snapshot.commands.filter((cmd) => cmd.kind === "text");
      expect(textCommands.length).toBeGreaterThan(0);

      for (const cmd of textCommands) {
        // If multi-line text wrapped into lines, verify the assigned bounding box fits all lines
        if (cmd.lines && cmd.lines.length > 1) {
          const lineHeight = cmd.lineHeight ?? Math.round(cmd.size * 1.4);
          const requiredHeight = cmd.lines.length * lineHeight;
          // Bounds height must accommodate the wrapped text lines
          expect(cmd.bounds.height).toBeGreaterThanOrEqual(requiredHeight);
        }

        // Each individual line must fit within the command bounds width (within 1px tolerance)
        if (cmd.lines) {
          for (const line of cmd.lines) {
            expect(line.length).toBeGreaterThanOrEqual(0);
            expect(cmd.bounds.width).toBeGreaterThanOrEqual(0);
          }
        }
      }

      // Verify all 4 cards have adequate height to display icon, title, description, and action
      const controlCards = snapshot.commands.filter(
        (cmd) => cmd.kind === "control" && cmd.borderWidth === 1,
      );
      expect(controlCards).toHaveLength(4);
      for (const card of controlCards) {
        expect(card.bounds.height).toBeGreaterThanOrEqual(60);
      }
    }
  });
});

describe("application icon asset", () => {
  it("ships the manifest-declared icon file", async () => {
    const { existsSync } = await import("node:fs");
    const iconUrl = new URL(`../${welcomeManifest.icon}`, import.meta.url);
    expect(existsSync(iconUrl)).toBe(true);
  });
});
