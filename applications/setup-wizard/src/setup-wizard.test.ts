/* eslint-disable no-restricted-imports */
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetDroppedPropWarnings,
  SevynApplicationRuntime,
} from "@sevynos/react-native/internal";
import type {
  SevynTimeService,
  SevynWirelessNetworkService,
  TimeSyncState,
  WirelessNetworkSnapshot,
} from "@sevynos/react-native";
import {
  COMMON_TIMEZONES,
  nextSetupWizardStep,
  previousSetupWizardStep,
  setupWizardManifest,
  SETUP_WIZARD_STEPS,
  setupWizardStepIndex,
  SetupWizardApplication,
} from "./index.js";

/**
 * Emoji glyphs known to render as tofu in SevynOS (the font stack has no
 * emoji glyphs; see the icon inventory). The wizard must not use any of them
 * for iconography.
 */
const FORBIDDEN_EMOJI: readonly string[] = Object.freeze([
  "🌐",
  "⚙️",
  "📁",
  "💻",
  "⚡",
  "🦆",
  "⚛️",
  "📖",
  "🐙",
  "📰",
  "🏠",
  "🖥️",
  "📄",
  "📥",
  "🖼️",
  "🎵",
  "🎬",
  "🗑️",
]);

function expectNoEmoji(text: string): void {
  for (const emoji of FORBIDDEN_EMOJI) expect(text).not.toContain(emoji);
}

const settle = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 50);
  });

function createTimeService(timezone = "UTC"): SevynTimeService & { applied: string[] } {
  const applied: string[] = [];
  let current = timezone;
  const state = (): TimeSyncState => ({
    available: true,
    syncing: false,
    timezone: current,
  });
  return {
    applied,
    snapshot: () => Promise.resolve(state()),
    syncNow: () => Promise.resolve(state()),
    setTimezone: (zone: string) => {
      if (!/^[A-Za-z0-9_+-]+\/[A-Za-z0-9_+-]+$/.test(zone) && zone !== "UTC")
        return Promise.reject(new Error(`Unknown timezone: ${zone}`));
      applied.push(zone);
      current = zone;
      return Promise.resolve(state());
    },
    subscribe: () => () => undefined,
  };
}

function createNetworkService(): SevynWirelessNetworkService {
  const snapshot: WirelessNetworkSnapshot = {
    available: true,
    enabled: true,
    state: "disconnected",
    networks: [
      {
        ssid: "HomeNet",
        signal: 82,
        secure: true,
        security: "personal",
        supported: true,
        requiresPassword: true,
        connected: false,
      },
      {
        ssid: "CoffeeShop",
        signal: 41,
        secure: false,
        security: "open",
        supported: true,
        requiresPassword: false,
        connected: false,
      },
    ],
  };
  return {
    snapshot: () => Promise.resolve(snapshot),
    scan: () => Promise.resolve(snapshot),
    connect: (ssid: string) =>
      Promise.resolve({ ...snapshot, state: "connected", connectedSsid: ssid }),
    disconnect: () => Promise.resolve(snapshot),
    subscribe: () => () => undefined,
  };
}

describe("setupWizardManifest", () => {
  it("exports a valid SevynApplicationManifest", () => {
    expect(setupWizardManifest.id).toBe("org.sevynos.setup-wizard");
    expect(setupWizardManifest.name).toBe("Setup");
    expect(setupWizardManifest.runtime).toBe("react-native");
    expect(setupWizardManifest.icon).toBe("icons/setup-wizard.svg");
  });
});

describe("setup wizard step machine", () => {
  it("orders steps welcome -> timezone -> wifi -> finish", () => {
    expect([...SETUP_WIZARD_STEPS]).toEqual(["welcome", "timezone", "wifi", "finish"]);
  });

  it("advances and retreats one step at a time", () => {
    expect(nextSetupWizardStep("welcome")).toBe("timezone");
    expect(nextSetupWizardStep("timezone")).toBe("wifi");
    expect(nextSetupWizardStep("wifi")).toBe("finish");
    expect(previousSetupWizardStep("finish")).toBe("wifi");
    expect(previousSetupWizardStep("wifi")).toBe("timezone");
    expect(previousSetupWizardStep("timezone")).toBe("welcome");
  });

  it("clamps at the ends of the flow", () => {
    expect(nextSetupWizardStep("finish")).toBe("finish");
    expect(previousSetupWizardStep("welcome")).toBe("welcome");
  });

  it("indexes steps from zero", () => {
    expect(setupWizardStepIndex("welcome")).toBe(0);
    expect(setupWizardStepIndex("finish")).toBe(SETUP_WIZARD_STEPS.length - 1);
  });
});

describe("COMMON_TIMEZONES", () => {
  it("covers every inhabited continent plus UTC without duplicates", () => {
    expect(COMMON_TIMEZONES.length).toBeGreaterThan(20);
    expect(new Set(COMMON_TIMEZONES).size).toBe(COMMON_TIMEZONES.length);
    for (const zone of [
      "America/New_York",
      "Europe/Berlin",
      "Asia/Tokyo",
      "Australia/Sydney",
      "Africa/Johannesburg",
      "Pacific/Auckland",
      "UTC",
    ])
      expect(COMMON_TIMEZONES).toContain(zone);
  });

  it("only contains plausible IANA zone names", () => {
    for (const zone of COMMON_TIMEZONES)
      expect(zone).toMatch(/^[A-Za-z0-9_+-]+(\/[A-Za-z0-9_+-]+){0,2}$/);
  });

  it("contains no emoji (the font stack has no emoji glyphs)", () => {
    for (const zone of COMMON_TIMEZONES) expectNoEmoji(zone);
  });
});

describe("SetupWizardApplication", () => {
  const originalEnv = process.env["NODE_ENV"];

  beforeEach(() => {
    resetDroppedPropWarnings();
    process.env["NODE_ENV"] = "development";
  });

  afterEach(() => {
    process.env["NODE_ENV"] = originalEnv;
    vi.restoreAllMocks();
  });

  function mountWizard(props: Record<string, unknown> = {}) {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation((): void => undefined);
    const runtime = new SevynApplicationRuntime({
      bounds: { x: 0, y: 0, width: 1280, height: 800 },
    });
    runtime.mount(
      createElement(SetupWizardApplication, {
        time: createTimeService(),
        network: createNetworkService(),
        ...props,
      }),
    );
    return { runtime, warnSpy };
  }

  function textContent(runtime: SevynApplicationRuntime): string {
    return runtime.snapshot.commands
      .filter((cmd) => cmd.kind === "text")
      .map((cmd) => ("text" in cmd && typeof cmd.text === "string" ? cmd.text : ""))
      .join("\n");
  }

  it("renders the welcome step first with no prop warnings", () => {
    const { runtime, warnSpy } = mountWizard();
    const text = textContent(runtime);
    expect(text).toContain("Welcome to SevynOS");
    expect(text).toContain("Begin setup");
    expect(text).toContain("Step 1 of 4");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("renders no emoji glyphs anywhere in the wizard chrome", () => {
    const { runtime } = mountWizard();
    expectNoEmoji(textContent(runtime));
  });

  it("advances to the timezone step when the Begin setup control is pressed", async () => {
    const { runtime } = mountWizard();
    // The welcome step renders exactly one interactive control.
    const controls = runtime.snapshot.commands.filter((cmd) => cmd.kind === "control");
    expect(controls).toHaveLength(1);
    const button = controls[0] as {
      bounds: { x: number; y: number; width: number; height: number };
    };
    const cx = button.bounds.x + button.bounds.width / 2;
    const cy = button.bounds.y + button.bounds.height / 2;
    runtime.dispatchPointer("down", { x: cx, y: cy, pointerId: 1, button: 0 });
    runtime.dispatchPointer("up", { x: cx, y: cy, pointerId: 1, button: 0 });
    await settle();
    const text = textContent(runtime);
    expect(text).toContain("Choose your timezone");
    expect(text).toContain("Step 2 of 4");
  });

  it("works without services (degraded, skippable)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation((): void => undefined);
    const runtime = new SevynApplicationRuntime({
      bounds: { x: 0, y: 0, width: 1280, height: 800 },
    });
    runtime.mount(createElement(SetupWizardApplication, {}));
    expect(textContent(runtime)).toContain("Welcome to SevynOS");
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe("application icon asset", () => {
  it("ships the manifest-declared icon file", async () => {
    const { existsSync } = await import("node:fs");
    const iconUrl = new URL(`../${setupWizardManifest.icon}`, import.meta.url);
    expect(existsSync(iconUrl)).toBe(true);
  });
});
