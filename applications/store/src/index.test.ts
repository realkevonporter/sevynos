import { describe, expect, it } from "vitest";
import { createElement, isValidElement } from "react";
import {
  AppRegistry,
  buildSevynApplicationPackage,
  verifyPackageIntegrity,
} from "@sevynos/react-native";
import { StoreApplication, storeApplicationBundle, storeManifest } from "./index.js";

describe("standalone Software application", () => {
  it("exposes the store component and a valid public manifest", () => {
    expect(StoreApplication).toBeTypeOf("function");
    expect(storeManifest.id).toBe("org.sevynos.store");
    expect(storeManifest.name).toBe("Software");
    expect(storeManifest.applicationKey).toBe("Software");
    expect(storeManifest.icon).toBe("icons/store.svg");
    expect(storeManifest.runtime).toBe("react-native");
    expect(storeManifest.instanceMode).toBe("single");
  });

  it("creates a valid element without host-provided services (honest empty states)", () => {
    const element = createElement(StoreApplication, {});
    expect(isValidElement(element)).toBe(true);
  });

  it("builds an installable package from the manifest", async () => {
    const applicationPackage = await buildSevynApplicationPackage({
      manifest: storeManifest,
      files: { [storeManifest.entrypoint]: storeApplicationBundle },
      icons: { [storeManifest.icon]: "<svg/>" },
    });
    await expect(verifyPackageIntegrity(applicationPackage)).resolves.toBeUndefined();
  });

  it("registers the Software component when the bundle evaluates", () => {
    const host = globalThis as unknown as Record<string, unknown>;
    const previous = host["__SEVYN_MODULES__"];
    host["__SEVYN_MODULES__"] = {
      "react-native": { AppRegistry },
      "@sevynos/app-store": { StoreApplication },
    };
    try {
      // Evaluating the shipped bundle string is the point of this test: it
      // proves the bundle registers the component with the host AppRegistry.
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const evaluate = new Function(storeApplicationBundle) as () => void;
      evaluate();
      const runnable = AppRegistry.getRunnable("Software");
      expect(runnable?.component).toBe(StoreApplication);
    } finally {
      AppRegistry.unregisterComponent("Software");
      if (previous === undefined) delete host["__SEVYN_MODULES__"];
      else host["__SEVYN_MODULES__"] = previous;
    }
  });
});
