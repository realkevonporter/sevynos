import { createElement, type ComponentType, type ReactElement } from "react";

export interface AppRegistryRunnable {
  readonly component: ComponentType<Record<string, unknown>>;
  readonly run: (applicationParameters?: {
    readonly initialProps?: Readonly<Record<string, unknown>>;
  }) => ReactElement;
}

export type ComponentProvider = () => ComponentType<Record<string, unknown>>;

/**
 * Registry used by Metro bundles and the SevynOS application host.
 *
 * This mirrors the small, stable part of React Native's AppRegistry contract
 * that applications normally use from their entry file. Host-only lifecycle
 * and surface ownership stay outside the application bundle.
 */
class SevynAppRegistry {
  readonly #providers = new Map<string, ComponentProvider>();

  public registerComponent(applicationKey: string, provider: ComponentProvider): string {
    if (applicationKey.trim().length === 0)
      throw new Error("AppRegistry application keys cannot be empty.");
    if (this.#providers.has(applicationKey))
      throw new Error(`AppRegistry already contains "${applicationKey}".`);
    this.#providers.set(applicationKey, provider);
    return applicationKey;
  }

  public unregisterComponent(applicationKey: string): void {
    this.#providers.delete(applicationKey);
  }

  public getAppKeys(): readonly string[] {
    return Object.freeze([...this.#providers.keys()]);
  }

  public getRunnable(applicationKey: string): AppRegistryRunnable | undefined {
    const provider = this.#providers.get(applicationKey);
    if (provider === undefined) return undefined;
    const component = provider();
    return Object.freeze({
      component,
      run: (parameters?: { readonly initialProps?: Readonly<Record<string, unknown>> }) =>
        createElement(component, parameters?.initialProps ?? {}) as ReactElement,
    });
  }

  /** Host API. Applications should use registerComponent instead. */
  public clear(): void {
    this.#providers.clear();
  }
}

const GLOBAL_REGISTRY_KEY = "__SEVYN_APP_REGISTRY__";
const globalScope = globalThis as unknown as Record<string, SevynAppRegistry | undefined>;

export const AppRegistry: SevynAppRegistry =
  globalScope[GLOBAL_REGISTRY_KEY] ??
  (globalScope[GLOBAL_REGISTRY_KEY] = new SevynAppRegistry());
