export type {
  SevynPermission,
  SevynWindowMode,
  SevynInstanceMode,
  SevynApplicationManifest,
  ApplicationLifecycleState,
  SevynNotificationOptions,
  SevynWindowOptions,
  SevynAppApi,
  SevynNotificationsApi,
  SevynClipboardApi,
  SevynStorageApi,
  SevynFilesApi,
  SevynWindowsApi,
  SevynEventsApi,
  CameraCaptureOptions,
  CameraCaptureResult,
  CameraRecordOptions,
  CameraRecordResult,
  CameraPreviewResult,
  CameraStatus,
  SevynCameraApi,
  MicrophoneStartOptions,
  MicrophoneStopResult,
  MicrophoneRecordOptions,
  MicrophoneRecordResult,
  SevynMicrophoneApi,
  BluetoothDevice,
  SevynBluetoothApi,
  GeolocationCoordinates,
  GeolocationPosition,
  GeolocationOptions,
  SevynLocationApi,
  SensorType,
  SensorUnit,
  SensorReading,
  SensorSubscribeOptions,
  SevynSensorsApi,
  BiometricType,
  BiometricAuthResult,
  BiometricCredential,
  BiometricEnrollResult,
  SevynBiometricKeystore,
  SevynBiometricsApi,
  MediaTrack,
  MediaPlaybackStatus,
  SevynMediaApi,
  BatteryStatus,
  SevynBatteryApi,
  ScreenOrientation,
  SevynDisplayApi,
  AudioOutputDevice,
  SevynAudioApi,
  SevynVibrationApi,
  NfcTag,
  SevynNfcApi,
  CellularModemStatus,
  CellularSignalStatus,
  CellularBearerStatus,
  CellularCall,
  SmsMessage,
  SmsSendResult,
  SevynCellularApi,
  SevynHardwareHandler,
  SevynClient,
  SevynClientOptions,
} from "./types.js";

export {
  createSevynClient,
  CapabilityError,
  StorageQuotaError,
  HardwareUnavailableError,
} from "./client.js";

import { createSevynClient } from "./client.js";
import type { SevynClient, SevynClientOptions } from "./types.js";

let defaultClient: SevynClient | undefined;

export function configureSevyn(options: SevynClientOptions): SevynClient {
  defaultClient = createSevynClient(options);
  return defaultClient;
}

export function getSevynClient(): SevynClient {
  defaultClient ??= createSevynClient();
  return defaultClient;
}

export const sevyn: SevynClient = new Proxy({} as SevynClient, {
  get(_target, prop: keyof SevynClient) {
    return getSevynClient()[prop];
  },
});
