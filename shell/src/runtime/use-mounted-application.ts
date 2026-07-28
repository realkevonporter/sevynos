import { useSyncExternalStore } from "react";

import type {
  MountedReactNativeApplication,
  ReactNativeSurfaceStore,
} from "./react-native-surface-store";

export function useMountedApplication(
  store: ReactNativeSurfaceStore,
): MountedReactNativeApplication | undefined {
  return useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.getSnapshot(),
    () => store.getSnapshot(),
  );
}
