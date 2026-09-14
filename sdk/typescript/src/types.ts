export type SevynPermission =
  | "filesystem.read"
  | "filesystem.write"
  | "notifications"
  | "clipboard.read"
  | "clipboard.write"
  | "network"
  | "location"
  | "camera"
  | "microphone"
  | "bluetooth"
  | "sensors"
  | "biometrics"
  | "media"
  | "native-modules"
  | "battery"
  | "display"
  | "audio"
  | "vibration"
  | "nfc"
  | "cellular";

export type SevynWindowMode = "standard" | "dialog" | "utility" | "fullscreen";
export type SevynInstanceMode = "single" | "multiple";

export interface SevynApplicationManifest {
  readonly manifestVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly developer: string;
  readonly icon: string;
  readonly entrypoint: string;
  readonly minimumSevynOSVersion: string;
  readonly permissions: readonly SevynPermission[];
  readonly services?: readonly string[];
  readonly windowModes?: readonly SevynWindowMode[];
  readonly instanceMode?: SevynInstanceMode;
}

export type ApplicationLifecycleState =
  "starting" | "running" | "suspended" | "stopping" | "stopped" | "crashed";

export interface SevynNotificationOptions {
  readonly title: string;
  readonly body?: string;
  readonly icon?: string;
}

export interface SevynWindowOptions {
  readonly title?: string;
  readonly width?: number;
  readonly height?: number;
  readonly x?: number;
  readonly y?: number;
}

export interface SevynAppApi {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly manifest: SevynApplicationManifest;
  readonly state: ApplicationLifecycleState;
  onStateChange(listener: (state: ApplicationLifecycleState) => void): () => void;
}

export interface SevynNotificationsApi {
  show(options: SevynNotificationOptions): Promise<void>;
}

export interface SevynClipboardApi {
  readText(): Promise<string>;
  writeText(text: string): Promise<void>;
}

export interface SevynStorageApi {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  usage(): Promise<number>;
}

export interface SevynFilesApi {
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  list(path: string): Promise<readonly string[]>;
  createDirectory(path: string): Promise<void>;
}

export interface SevynWindowsApi {
  setTitle(title: string): Promise<void>;
  setSize(width: number, height: number): Promise<void>;
  minimize(): Promise<void>;
  maximize(): Promise<void>;
  restore(): Promise<void>;
  close(): Promise<void>;
}

export interface SevynEventsApi {
  on(channel: string, handler: (payload: unknown) => void): () => void;
  emit(channel: string, payload: unknown): void;
  send(channel: string, payload: unknown): Promise<void>;
}

// ---------------------------------------------------------------------------
// Hardware API Interfaces
// ---------------------------------------------------------------------------

export interface CameraCaptureOptions {
  readonly quality?: number;
  readonly width?: number;
  readonly height?: number;
}

export interface CameraCaptureResult {
  readonly uri: string;
  readonly width?: number;
  readonly height?: number;
}

export interface CameraRecordOptions {
  readonly maxDurationSec?: number;
  readonly quality?: "low" | "medium" | "high";
}

export interface CameraRecordResult {
  readonly uri: string;
  readonly durationSec: number;
}

export interface CameraPreviewResult {
  readonly frameBase64: string;
  readonly width: number;
  readonly height: number;
}

export interface CameraStatus {
  readonly available: boolean;
  readonly active: boolean;
  readonly recording: boolean;
  readonly torch: boolean;
}

export interface SevynCameraApi {
  capture(options?: CameraCaptureOptions): Promise<CameraCaptureResult>;
  recordStart(options?: CameraRecordOptions): Promise<void>;
  recordStop(): Promise<CameraRecordResult>;
  preview(): Promise<CameraPreviewResult>;
  status(): Promise<CameraStatus>;
  setTorch(enabled: boolean): Promise<void>;
}

export interface MicrophoneStartOptions {
  readonly sampleRate?: number;
  readonly channels?: number;
}

export interface MicrophoneStopResult {
  readonly uri: string;
  readonly durationSec?: number;
}

export interface MicrophoneRecordOptions {
  readonly durationSec: number;
}

export interface MicrophoneRecordResult {
  readonly uri: string;
  readonly durationSec: number;
}

export interface SevynMicrophoneApi {
  start(options?: MicrophoneStartOptions): Promise<void>;
  stop(): Promise<MicrophoneStopResult>;
  record(options?: MicrophoneRecordOptions): Promise<MicrophoneRecordResult>;
}

export interface BluetoothDevice {
  readonly id: string;
  readonly name: string;
  readonly rssi?: number;
  readonly connected?: boolean;
}

export interface SevynBluetoothApi {
  scan(): Promise<readonly BluetoothDevice[]>;
  isEnabled(): Promise<boolean>;
  requestEnable(): Promise<boolean>;
}

export interface GeolocationCoordinates {
  readonly latitude: number;
  readonly longitude: number;
  readonly altitude?: number;
  readonly accuracy?: number;
  readonly speed?: number;
  readonly heading?: number;
}

export interface GeolocationPosition {
  readonly coords: GeolocationCoordinates;
  readonly timestamp: number;
}

export interface GeolocationOptions {
  readonly enableHighAccuracy?: boolean;
  readonly timeoutMs?: number;
  readonly maximumAgeMs?: number;
}

export interface SevynLocationApi {
  getCurrentPosition(options?: GeolocationOptions): Promise<GeolocationPosition>;
  watchPosition(
    onPosition: (position: GeolocationPosition) => void,
    onError?: (error: Error) => void,
    options?: GeolocationOptions,
  ): () => void;
}

export type SensorType =
  | "accelerometer"
  | "gyroscope"
  | "magnetometer"
  | "proximity"
  | "ambientLight"
  | "barometer";

export type SensorUnit = "m/s^2" | "rad/s" | "uT" | "cm" | "lux" | "hPa";

export interface SensorReading {
  readonly sensor: SensorType;
  readonly timestamp: number;
  readonly values: Record<string, number>;
  /** Standard SI unit of measure for this sensor */
  readonly unit: SensorUnit;
  /** For proximity sensors, true if an object is in near proximity (e.g. against ear) */
  readonly near?: boolean;
}

export interface SensorSubscribeOptions {
  readonly intervalMs?: number;
  readonly samplingRateHz?: number;
}

export interface SevynSensorsApi {
  read(sensor: SensorType): Promise<SensorReading>;
  subscribe(
    sensor: SensorType,
    listener: (reading: SensorReading) => void,
    options?: SensorSubscribeOptions,
  ): () => void;
  list(): Promise<readonly string[]>;
}

export type BiometricType = "fingerprint" | "face" | "iris" | "none";

export interface BiometricAuthResult {
  readonly success: boolean;
  readonly type?: BiometricType;
  readonly error?: string;
  readonly fallbackToPin?: boolean;
}

export interface BiometricCredential {
  readonly id: string;
  readonly type: BiometricType;
  readonly label: string;
  readonly enrolledAt: number;
}

export interface BiometricEnrollResult {
  readonly success: boolean;
  readonly credential?: BiometricCredential;
  readonly error?: string;
}

export interface SevynBiometricKeystore {
  setKey(key: string, secret: string): Promise<void>;
  getKey(key: string): Promise<string | null>;
  deleteKey(key: string): Promise<boolean>;
  listKeys(): Promise<readonly string[]>;
}

export interface SevynBiometricsApi {
  authenticate(reason?: string): Promise<BiometricAuthResult>;
  isAvailable(): Promise<boolean>;
  getEnrolledType(): Promise<BiometricType>;
  enroll(type: BiometricType, label?: string): Promise<BiometricEnrollResult>;
  deleteEnrolled(type: BiometricType, id: string): Promise<{ readonly success: boolean }>;
  listEnrolled(): Promise<readonly BiometricCredential[]>;
  verifyPin(pin: string): Promise<boolean>;
  readonly keystore: SevynBiometricKeystore;
}

export interface MediaTrack {
  readonly id: string;
  readonly title: string;
  readonly artist: string;
  readonly album?: string;
  readonly durationSec: number;
  readonly source: string;
  readonly format?: string;
}

export interface MediaPlaybackStatus {
  readonly isPlaying: boolean;
  readonly isPaused: boolean;
  readonly positionSec: number;
  readonly durationSec: number;
  readonly volume: number;
  readonly currentTrack?: MediaTrack;
}

export interface SevynMediaApi {
  play(source: string): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;
  seek(seconds: number): Promise<void>;
  setVolume(volume: number): Promise<void>;
  status(): Promise<MediaPlaybackStatus>;
  scan(directory?: string): Promise<readonly MediaTrack[]>;
}

export interface BatteryStatus {
  readonly available: boolean;
  readonly percent: number;
  readonly charging: boolean;
  readonly state: "charging" | "discharging" | "full" | "unknown";
  readonly timeRemainingSec?: number;
}

export interface SevynBatteryApi {
  getStatus(): Promise<BatteryStatus>;
  onStatusChange(listener: (status: BatteryStatus) => void): () => void;
}

export type ScreenOrientation =
  "portrait" | "landscape-left" | "landscape-right" | "portrait-upside-down";

export interface SevynDisplayApi {
  getBrightness(): Promise<number>;
  setBrightness(brightness: number): Promise<void>;
  getAutoBrightness(): Promise<boolean>;
  setAutoBrightness(enabled: boolean): Promise<void>;
  getOrientation(): Promise<ScreenOrientation>;
  lockOrientation(orientation: ScreenOrientation | "auto"): Promise<void>;
  onOrientationChange(listener: (orientation: ScreenOrientation) => void): () => void;
  acquireWakeLock(): Promise<() => void>;
  isWakeLocked(): boolean;
}

export interface AudioOutputDevice {
  readonly id: string;
  readonly name: string;
  readonly isDefault?: boolean;
  readonly type?: "speaker" | "headphones" | "bluetooth" | "lineout" | "other";
}

export interface SevynAudioApi {
  getOutputs(): Promise<readonly AudioOutputDevice[]>;
  setOutput(deviceId: string): Promise<void>;
  getVolume(): Promise<number>;
  setVolume(volume: number): Promise<void>;
}

export interface SevynVibrationApi {
  vibrate(pattern?: number | readonly number[]): Promise<void>;
  cancel(): Promise<void>;
}

export interface NfcTag {
  readonly id: string;
  readonly standard?: string;
  readonly payload?: string | Uint8Array;
}

export interface SevynNfcApi {
  isAvailable(): Promise<boolean>;
  scan(): Promise<NfcTag>;
  write(data: string | Uint8Array): Promise<void>;
}

export interface CellularModemStatus {
  readonly available: boolean;
  readonly state: "disabled" | "searching" | "registered" | "connected" | "unknown";
  readonly manufacturer?: string;
  readonly model?: string;
  readonly simPresent: boolean;
  readonly operatorName?: string;
}

export interface CellularSignalStatus {
  readonly signalPercent: number;
  readonly rssi?: number;
  readonly technology?: "2G" | "3G" | "4G" | "5G" | "unknown";
}

export interface CellularBearerStatus {
  readonly connected: boolean;
  readonly ipAddress?: string;
  readonly apn?: string;
}

export interface CellularCall {
  readonly callId: string;
  readonly number: string;
  readonly state: "dialing" | "ringing" | "active" | "terminated";
}

export interface SmsMessage {
  readonly id: string;
  readonly sender: string;
  readonly timestamp: number;
  readonly text: string;
  readonly unread: boolean;
}

export interface SmsSendResult {
  readonly messageId: string;
  readonly sent: boolean;
}

export interface SevynCellularApi {
  getModemStatus(): Promise<CellularModemStatus>;
  getSignal(): Promise<CellularSignalStatus>;
  getBearer(): Promise<CellularBearerStatus>;
  dial(number: string): Promise<CellularCall>;
  answer(): Promise<void>;
  hangup(): Promise<void>;
  sendSms(recipient: string, message: string): Promise<SmsSendResult>;
  listSms(): Promise<readonly SmsMessage[]>;
}

// ---------------------------------------------------------------------------
// Hardware Handler Interface for Client Options
// ---------------------------------------------------------------------------

export interface SevynHardwareHandler {
  readonly camera?: Partial<SevynCameraApi>;
  readonly microphone?: Partial<SevynMicrophoneApi>;
  readonly bluetooth?: Partial<SevynBluetoothApi>;
  readonly location?: Partial<SevynLocationApi>;
  readonly sensors?: Partial<SevynSensorsApi>;
  readonly biometrics?: Partial<SevynBiometricsApi>;
  readonly media?: Partial<SevynMediaApi>;
  readonly battery?: Partial<SevynBatteryApi>;
  readonly display?: Partial<SevynDisplayApi>;
  readonly audio?: Partial<SevynAudioApi>;
  readonly vibration?: Partial<SevynVibrationApi>;
  readonly nfc?: Partial<SevynNfcApi>;
  readonly cellular?: Partial<SevynCellularApi>;
}

// ---------------------------------------------------------------------------
// Unified SevynClient Interface
// ---------------------------------------------------------------------------

export interface SevynClient {
  readonly app: SevynAppApi;
  readonly notifications: SevynNotificationsApi;
  readonly clipboard: SevynClipboardApi;
  readonly storage: SevynStorageApi;
  readonly files: SevynFilesApi;
  readonly windows: SevynWindowsApi;
  readonly events: SevynEventsApi;

  // Unified hardware modules
  readonly camera: SevynCameraApi;
  readonly microphone: SevynMicrophoneApi;
  readonly bluetooth: SevynBluetoothApi;
  readonly location: SevynLocationApi;
  readonly geolocation: SevynLocationApi;
  readonly sensors: SevynSensorsApi;
  readonly biometrics: SevynBiometricsApi;
  readonly media: SevynMediaApi;
  readonly battery: SevynBatteryApi;
  readonly display: SevynDisplayApi;
  readonly audio: SevynAudioApi;
  readonly vibration: SevynVibrationApi;
  readonly haptics: SevynVibrationApi;
  readonly nfc: SevynNfcApi;
  readonly cellular: SevynCellularApi;
}

export interface SevynClientOptions {
  readonly manifest?: SevynApplicationManifest;
  readonly permissions?: readonly SevynPermission[];
  readonly storageQuotaBytes?: number;
  readonly initialStorage?: Record<string, string>;
  readonly initialFiles?: Record<string, string>;
  readonly notificationHandler?: (notification: SevynNotificationOptions) => void;
  readonly windowHandler?: {
    setTitle?: (title: string) => void;
    setSize?: (width: number, height: number) => void;
    minimize?: () => void;
    maximize?: () => void;
    restore?: () => void;
    close?: () => void;
  };
  readonly hardwareHandler?: SevynHardwareHandler;
}
