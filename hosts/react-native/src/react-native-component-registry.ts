import type { ReactNativeApplicationComponent } from "./react-native-application.js";

export interface ReactNativeComponentRegistry {
  get(componentId: string): ReactNativeApplicationComponent | undefined;
}
