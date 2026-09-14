import type { ApplicationSessionId } from "@sevynos/runtime";
import type {
  ReactNativeApplicationMountOptions,
  ReactNativeApplicationSurface,
} from "@sevynos/react-native-host";

import type { ReactNativeSurfaceStore } from "./react-native-surface-store";

export class SevynReactNativeSurface implements ReactNativeApplicationSurface {
  readonly #store: ReactNativeSurfaceStore;

  public constructor(store: ReactNativeSurfaceStore) {
    this.#store = store;
  }

  public mount(options: ReactNativeApplicationMountOptions): Promise<void> {
    this.#store.mount(options);

    return Promise.resolve();
  }

  public unmount(sessionId: ApplicationSessionId): Promise<void> {
    this.#store.unmount(sessionId);

    return Promise.resolve();
  }
}
