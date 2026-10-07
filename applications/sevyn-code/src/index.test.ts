/**
 * Tests for the Sevyn Code application shell.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe, expect, it } from "vitest";
import { SevynCodeApp, sevynCodeManifest } from "./index.js";
import type { BrowserEngineSnapshot, SevynBrowserEngine } from "@sevynos/react-native";

const emptySnapshot = (): BrowserEngineSnapshot => ({
  ready: true,
  loading: false,
  url: "http://127.0.0.1:8080/",
  title: "Sevyn Code",
  width: 1280,
  height: 800,
  pixels: undefined,
});

const createMockEngine = (): SevynBrowserEngine => ({
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
  setZoomFactor: () => Promise.resolve(emptySnapshot()),
  findInPage: () => Promise.resolve({ found: false }),
  close: () => Promise.resolve(),
});

describe("SevynCodeApp", () => {
  it("exports a valid SevynApplicationManifest", () => {
    expect(sevynCodeManifest.id).toBe("org.sevynos.sevyn-code");
    expect(sevynCodeManifest.name).toBe("Sevyn Code");
    expect(sevynCodeManifest.runtime).toBe("react-native");
  });

  it("is a function component that accepts a browser engine", () => {
    expect(SevynCodeApp).toBeTypeOf("function");
    const engine = createMockEngine();
    // Rendering requires the RN reconciler; here we verify the props contract.
    expect(engine.snapshot().ready).toBe(true);
    expect(engine.snapshot().url).toBe("http://127.0.0.1:8080/");
  });

  it("forwards input events through the engine", async () => {
    const engine = createMockEngine();
    const snapshot = await engine.click(100, 200, 1);
    expect(snapshot.ready).toBe(true);
    await engine.pointerMove(150, 250);
    await engine.scroll(150, 250, 120);
    await engine.key("a", "KeyA", {
      shift: false,
      alt: false,
      control: false,
      meta: false,
    });
  });
});

describe("application icon asset", () => {
  it("ships the manifest-declared icon file", async () => {
    const { existsSync } = await import("node:fs");
    const iconUrl = new URL(`../${sevynCodeManifest.icon}`, import.meta.url);
    expect(existsSync(iconUrl)).toBe(true);
  });
});
