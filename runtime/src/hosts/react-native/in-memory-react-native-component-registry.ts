import type { ReactNativeApplicationComponent } from "./react-native-application.js";
import type { ReactNativeComponentRegistry } from "./react-native-component-registry.js";

export class InMemoryReactNativeComponentRegistry implements ReactNativeComponentRegistry {
  readonly #components = new Map<string, ReactNativeApplicationComponent>();

  public register(componentId: string, component: ReactNativeApplicationComponent): void {
    if (this.#components.has(componentId)) {
      throw new Error(`React Native component "${componentId}" is already registered.`);
    }

    this.#components.set(componentId, component);
  }

  public unregister(componentId: string): void {
    this.#components.delete(componentId);
  }

  public get(componentId: string): ReactNativeApplicationComponent | undefined {
    return this.#components.get(componentId);
  }

  public has(componentId: string): boolean {
    return this.#components.has(componentId);
  }
}
