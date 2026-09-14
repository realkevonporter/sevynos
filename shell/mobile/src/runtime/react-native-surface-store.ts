import type { ApplicationSessionId } from "@sevynos/runtime";
import type {
  ReactNativeApplicationComponent,
  ReactNativeApplicationMountOptions,
} from "@sevynos/react-native-host";

export interface MountedReactNativeApplication {
  readonly sessionId: ApplicationSessionId;
  readonly component: ReactNativeApplicationComponent;
  readonly props: ReactNativeApplicationMountOptions["props"];
}

type SurfaceListener = () => void;

export class ReactNativeSurfaceStore {
  #mountedApplication: MountedReactNativeApplication | undefined;

  readonly #listeners = new Set<SurfaceListener>();

  public getSnapshot(): MountedReactNativeApplication | undefined {
    return this.#mountedApplication;
  }

  public mount(options: ReactNativeApplicationMountOptions): void {
    this.#mountedApplication = {
      sessionId: options.sessionId,
      component: options.component,
      props: options.props,
    };

    this.#emitChange();
  }

  public unmount(sessionId: ApplicationSessionId): void {
    if (this.#mountedApplication?.sessionId !== sessionId) {
      return;
    }

    this.#mountedApplication = undefined;

    this.#emitChange();
  }

  public subscribe(listener: SurfaceListener): () => void {
    this.#listeners.add(listener);

    return (): void => {
      this.#listeners.delete(listener);
    };
  }

  #emitChange(): void {
    for (const listener of this.#listeners) {
      listener();
    }
  }
}
