import {
  InMemoryReactNativeComponentRegistry,
  ReactNativeApplicationHost,
} from "@sevynos/runtime";

import { HelloApplication } from "../applications/hello-application";
import { ReactNativeSurfaceStore } from "./react-native-surface-store";
import { SevynReactNativeSurface } from "./sevyn-react-native-surface";

const HELLO_COMPONENT_ID = "sevyn.builtin.hello.root";

export interface SevynShellInfrastructure {
  readonly componentRegistry: InMemoryReactNativeComponentRegistry;

  readonly surfaceStore: ReactNativeSurfaceStore;

  readonly reactNativeHost: ReactNativeApplicationHost;
}

export function createSevynShellInfrastructure(
  logger: ConstructorParameters<typeof ReactNativeApplicationHost>[0]["logger"],
): SevynShellInfrastructure {
  const componentRegistry = new InMemoryReactNativeComponentRegistry();

  componentRegistry.register(HELLO_COMPONENT_ID, HelloApplication);

  const surfaceStore = new ReactNativeSurfaceStore();

  const surface = new SevynReactNativeSurface(surfaceStore);

  const reactNativeHost = new ReactNativeApplicationHost({
    logger,
    componentRegistry,
    surface,
  });

  return {
    componentRegistry,
    surfaceStore,
    reactNativeHost,
  };
}

export { HELLO_COMPONENT_ID };
