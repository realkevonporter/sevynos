import type { ComponentType } from "react";
import { AppRegistry } from "@sevynos/react-native";
import type { ReactNativeApplicationProps } from "./react-native-application.js";
import type { ReactNativeComponentRegistry } from "./react-native-component-registry.js";

/** Resolves standard AppRegistry registrations for the framework-neutral host. */
export class AppRegistryReactNativeComponentRegistry implements ReactNativeComponentRegistry {
  public get(
    componentId: string,
  ): ComponentType<ReactNativeApplicationProps> | undefined {
    const runnable = AppRegistry.getRunnable(componentId);
    if (runnable === undefined) return undefined;

    return runnable.component as unknown as ComponentType<ReactNativeApplicationProps>;
  }
}
