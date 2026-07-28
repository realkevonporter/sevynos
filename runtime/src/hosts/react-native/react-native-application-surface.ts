import type { ApplicationSessionId } from "../../application/application-session.js";
import type {
  ReactNativeApplicationComponent,
  ReactNativeApplicationProps,
} from "./react-native-application.js";

export interface ReactNativeApplicationMountOptions {
  readonly sessionId: ApplicationSessionId;
  readonly component: ReactNativeApplicationComponent;
  readonly props: ReactNativeApplicationProps;
}

export interface ReactNativeApplicationSurface {
  mount(options: ReactNativeApplicationMountOptions): Promise<void>;

  unmount(sessionId: ApplicationSessionId): Promise<void>;
}
