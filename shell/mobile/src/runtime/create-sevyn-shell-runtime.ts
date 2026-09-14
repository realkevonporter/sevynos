import {
  InMemoryReactNativeComponentRegistry,
  ReactNativeApplicationHost,
} from "@sevynos/react-native-host";

import { HelloApplication } from "../applications/hello-application";
import { BrowserApplication } from "../applications/browser-application";
import { ReactNativeSurfaceStore } from "./react-native-surface-store";
import { SevynReactNativeSurface } from "./sevyn-react-native-surface";

const HELLO_COMPONENT_ID = "sevyn.builtin.hello.root";
const BROWSER_COMPONENT_ID = "sevyn.builtin.browser.root";

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
  componentRegistry.register(BROWSER_COMPONENT_ID, BrowserApplication);

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

export { BROWSER_COMPONENT_ID, HELLO_COMPONENT_ID };
