import { describe, expect, it } from "vitest";
import { isValidElement } from "react";
import {
  AppRegistry,
  buildSevynApplicationPackage,
  verifyPackageIntegrity,
  type SevynApplicationSdk,
} from "@sevynos/react-native";
import {
  CalculatorApplication,
  calculatorApplicationBundle,
  calculatorManifest,
  createCalculatorApplicationElement,
  createCalculatorState,
} from "./index.js";

describe("standalone Calculator application", () => {
  it("exposes the calculator component and a valid public manifest", () => {
    expect(CalculatorApplication).toBeTypeOf("function");
    expect(createCalculatorApplicationElement).toBeTypeOf("function");
    expect(createCalculatorState().display).toBe("0");
    expect(calculatorManifest.id).toBe("org.sevynos.calculator");
    expect(calculatorManifest.applicationKey).toBe("Calculator");
    expect(calculatorManifest.icon).toBe("icons/calculator.svg");
    expect(calculatorManifest.permissions).toEqual([]);
  });

  it("builds an installable package from the manifest", async () => {
    const applicationPackage = await buildSevynApplicationPackage({
      manifest: calculatorManifest,
      files: { [calculatorManifest.entrypoint]: calculatorApplicationBundle },
      icons: { [calculatorManifest.icon]: "<svg/>" },
    });
    await expect(verifyPackageIntegrity(applicationPackage)).resolves.toBeUndefined();
    expect(applicationPackage.manifest.instanceMode).toBe("multiple");
  });

  it("registers the Calculator component when the bundle evaluates", () => {
    const host = globalThis as unknown as Record<string, unknown>;
    const previous = host["__SEVYN_MODULES__"];
    host["__SEVYN_MODULES__"] = {
      "react-native": { AppRegistry },
      "@sevynos/app-calculator": { CalculatorApplication },
    };
    try {
      // Evaluating the shipped bundle string is the point of this test: it
      // proves the bundle registers the component with the host AppRegistry.
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const evaluate = new Function(calculatorApplicationBundle) as () => void;
      evaluate();
      const runnable = AppRegistry.getRunnable("Calculator");
      expect(runnable?.component).toBe(CalculatorApplication);
    } finally {
      AppRegistry.unregisterComponent("Calculator");
      if (previous === undefined) delete host["__SEVYN_MODULES__"];
      else host["__SEVYN_MODULES__"] = previous;
    }
  });

  it("wraps the calculator in the SDK provider element", () => {
    const sdk = {
      application: {
        id: "org.sevynos.calculator",
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
    expect(isValidElement(createCalculatorApplicationElement(sdk))).toBe(true);
  });
});

describe("application icon asset", () => {
  it("ships the manifest-declared icon file", async () => {
    const { existsSync } = await import("node:fs");
    const iconUrl = new URL(`../${calculatorManifest.icon}`, import.meta.url);
    expect(existsSync(iconUrl)).toBe(true);
  });
});
