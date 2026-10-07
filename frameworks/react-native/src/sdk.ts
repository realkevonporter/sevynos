export {
  InMemoryFileSystem,
  SystemNotificationService,
  type FileSystemEntry,
  type SevynApplicationSdk,
  type SevynFileSystem,
  type SevynStorageService,
  type SevynVolume,
  type SystemNotification,
  type BrowserEngineSnapshot,
  type SevynBrowserEngine,
  type SevynWirelessNetworkService,
  type SevynBatteryService,
  type SevynAudioService,
  type SevynTimeService,
  type TimeSyncState,
  type SevynSystemService,
  type SevynProcessService,
  type ProcessInfo,
  type ProcessSnapshot,
  type DiskUsage,
  type NetworkInterfaceThroughput,
  type SevynPowerService,
  type SevynStudioService,
  type SystemHardwareSnapshot,
  type AudioSnapshot,
  type BatterySnapshot,
  type WirelessNetworkSnapshot,
  type SavedWirelessNetwork,
  type TextBrowserPage,
} from "./services.js";
export { type SevynSettingsModel } from "./settings-application.js";
export {
  useApplicationState,
  useDisplay,
  useReducedMotion,
  useSystemTheme,
  useWindow,
  useWorkspace,
} from "./lifecycle.js";

const ApplicationSdkContext = createContext<SevynApplicationSdk | undefined>(undefined);
export function SevynApplicationSdkProvider(props: {
  readonly sdk: SevynApplicationSdk;
  readonly children?: ReactNode;
}): ReactNode {
  return createElement(
    ApplicationSdkContext.Provider,
    { value: props.sdk },
    props.children,
  );
}
export function useSevynApplicationSdk(): SevynApplicationSdk {
  const sdk = useContext(ApplicationSdkContext);
  if (sdk === undefined)
    throw new Error("This application requires a Sevyn application SDK provider.");
  return sdk;
}
/**
 * Returns the current Sevyn application SDK, or undefined when no provider is
 * present. Use this for optional features (like persistence) that should degrade
 * gracefully instead of crashing the application.
 */
export function useOptionalSevynApplicationSdk(): SevynApplicationSdk | undefined {
  return useContext(ApplicationSdkContext);
}
import { createContext, createElement, useContext, type ReactNode } from "react";
import type { SevynApplicationSdk } from "./services.js";
