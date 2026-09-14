import type {
  ApplicationLifecycleState,
  AudioOutputDevice,
  BatteryStatus,
  BiometricAuthResult,
  BiometricCredential,
  BiometricEnrollResult,
  BiometricType,
  BluetoothDevice,
  CameraCaptureOptions,
  CameraCaptureResult,
  CameraPreviewResult,
  CameraRecordOptions,
  CameraRecordResult,
  CameraStatus,
  CellularBearerStatus,
  CellularCall,
  CellularModemStatus,
  CellularSignalStatus,
  GeolocationOptions,
  GeolocationPosition,
  MediaPlaybackStatus,
  MediaTrack,
  MicrophoneRecordOptions,
  MicrophoneRecordResult,
  MicrophoneStartOptions,
  MicrophoneStopResult,
  NfcTag,
  ScreenOrientation,
  SensorReading,
  SensorSubscribeOptions,
  SensorType,
  SensorUnit,
  SevynAppApi,
  SevynApplicationManifest,
  SevynAudioApi,
  SevynBatteryApi,
  SevynBiometricKeystore,
  SevynBiometricsApi,
  SevynBluetoothApi,
  SevynCameraApi,
  SevynCellularApi,
  SevynClient,
  SevynClientOptions,
  SevynClipboardApi,
  SevynDisplayApi,
  SevynEventsApi,
  SevynFilesApi,
  SevynLocationApi,
  SevynMediaApi,
  SevynMicrophoneApi,
  SevynNfcApi,
  SevynNotificationOptions,
  SevynNotificationsApi,
  SevynPermission,
  SevynSensorsApi,
  SevynStorageApi,
  SevynVibrationApi,
  SevynWindowsApi,
  SmsMessage,
  SmsSendResult,
} from "./types.js";

export class CapabilityError extends Error {
  public constructor(
    public readonly permission: SevynPermission,
    action: string,
  ) {
    super(`Capability '${permission}' is required to ${action}.`);
    this.name = "CapabilityError";
  }
}

export class StorageQuotaError extends Error {
  public constructor(quotaBytes: number) {
    super(`Application storage quota of ${String(quotaBytes)} bytes exceeded.`);
    this.name = "StorageQuotaError";
  }
}

export class HardwareUnavailableError extends Error {
  public constructor(
    public readonly hardware: string,
    details?: string,
  ) {
    super(`${hardware} is not available on this device.${details ? ` ${details}` : ""}`);
    this.name = "HardwareUnavailableError";
  }
}

const noop = (): void => {
  void 0;
};

const defaultManifest: SevynApplicationManifest = Object.freeze({
  manifestVersion: 1,
  id: "org.sevynos.app",
  name: "Sevyn Application",
  version: "0.1.0",
  developer: "SevynOS Developer",
  icon: "icon.svg",
  entrypoint: "dist/index.js",
  minimumSevynOSVersion: "0.1.0",
  permissions: [
    "filesystem.read",
    "filesystem.write",
    "notifications",
    "clipboard.read",
    "clipboard.write",
  ] as const satisfies readonly SevynPermission[],
});

export function createSevynClient(options: SevynClientOptions = {}): SevynClient {
  const manifest = options.manifest ?? defaultManifest;
  const permissions = new Set<SevynPermission>(
    options.permissions ?? manifest.permissions,
  );
  const checkPermission = (
    perm: SevynPermission,
    action: string,
  ): Promise<never> | null => {
    if (!permissions.has(perm)) {
      return Promise.reject(new CapabilityError(perm, action));
    }
    return null;
  };

  const currentState: ApplicationLifecycleState = "running";
  const stateListeners = new Set<(state: ApplicationLifecycleState) => void>();

  const app: SevynAppApi = {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    manifest,
    get state() {
      return currentState;
    },
    onStateChange(listener) {
      stateListeners.add(listener);
      return () => {
        stateListeners.delete(listener);
      };
    },
  };

  const notifications: SevynNotificationsApi = {
    show(notification: SevynNotificationOptions): Promise<void> {
      const denied = checkPermission("notifications", "show notifications");
      if (denied) return denied;

      if (options.notificationHandler) {
        options.notificationHandler(notification);
      }
      return Promise.resolve();
    },
  };

  let clipboardBuffer = "";
  const clipboard: SevynClipboardApi = {
    readText(): Promise<string> {
      const denied = checkPermission("clipboard.read", "read from clipboard");
      if (denied) return denied;

      return Promise.resolve(clipboardBuffer);
    },
    writeText(text: string): Promise<void> {
      const denied = checkPermission("clipboard.write", "write to clipboard");
      if (denied) return denied;

      clipboardBuffer = text;
      return Promise.resolve();
    },
  };

  const storageStore = new Map<string, string>(
    Object.entries(options.initialStorage ?? {}),
  );
  const quotaBytes = options.storageQuotaBytes ?? 2 * 1024 * 1024; // 2MB default

  const storage: SevynStorageApi = {
    get(key: string): Promise<string | undefined> {
      return Promise.resolve(storageStore.get(key));
    },
    set(key: string, value: string): Promise<void> {
      const currentUsage = [...storageStore.entries()].reduce(
        (acc, [k, v]) => acc + k.length + v.length,
        0,
      );
      const existing = storageStore.get(key);
      const diff = value.length - (existing?.length ?? 0);
      if (currentUsage + diff > quotaBytes) {
        return Promise.reject(new StorageQuotaError(quotaBytes));
      }
      storageStore.set(key, value);
      return Promise.resolve();
    },
    remove(key: string): Promise<void> {
      storageStore.delete(key);
      return Promise.resolve();
    },
    usage(): Promise<number> {
      const bytes = [...storageStore.entries()].reduce(
        (acc, [k, v]) => acc + k.length + v.length,
        0,
      );
      return Promise.resolve(bytes);
    },
  };

  const fileStore = new Map<string, string>(Object.entries(options.initialFiles ?? {}));

  const files: SevynFilesApi = {
    read(path: string): Promise<string> {
      const denied = checkPermission("filesystem.read", "read files");
      if (denied) return denied;

      const content = fileStore.get(path);
      if (content === undefined) {
        return Promise.reject(new Error(`File not found: ${path}`));
      }
      return Promise.resolve(content);
    },
    write(path: string, content: string): Promise<void> {
      const denied = checkPermission("filesystem.write", "write files");
      if (denied) return denied;

      fileStore.set(path, content);
      return Promise.resolve();
    },
    list(directory: string): Promise<readonly string[]> {
      const denied = checkPermission("filesystem.read", "list directory contents");
      if (denied) return denied;

      const normalized = directory.endsWith("/") ? directory : `${directory}/`;
      const matches = new Set<string>();
      for (const key of fileStore.keys()) {
        if (key.startsWith(normalized)) {
          const sub = key.slice(normalized.length).split("/")[0];
          if (sub) matches.add(sub);
        }
      }
      return Promise.resolve([...matches].sort());
    },
    createDirectory(path: string): Promise<void> {
      const denied = checkPermission("filesystem.write", "create directories");
      if (denied) return denied;

      const norm = path.endsWith("/") ? path : `${path}/`;
      fileStore.set(`${norm}.gitkeep`, "");
      return Promise.resolve();
    },
  };

  const windows: SevynWindowsApi = {
    setTitle(title: string): Promise<void> {
      options.windowHandler?.setTitle?.(title);
      return Promise.resolve();
    },
    setSize(width: number, height: number): Promise<void> {
      options.windowHandler?.setSize?.(width, height);
      return Promise.resolve();
    },
    minimize(): Promise<void> {
      options.windowHandler?.minimize?.();
      return Promise.resolve();
    },
    maximize(): Promise<void> {
      options.windowHandler?.maximize?.();
      return Promise.resolve();
    },
    restore(): Promise<void> {
      options.windowHandler?.restore?.();
      return Promise.resolve();
    },
    close(): Promise<void> {
      options.windowHandler?.close?.();
      return Promise.resolve();
    },
  };

  const eventSubscribers = new Map<string, Set<(payload: unknown) => void>>();

  const events: SevynEventsApi = {
    on(channel: string, handler: (payload: unknown) => void): () => void {
      let subscribers = eventSubscribers.get(channel);
      if (!subscribers) {
        subscribers = new Set();
        eventSubscribers.set(channel, subscribers);
      }
      subscribers.add(handler);
      return () => {
        subscribers.delete(handler);
      };
    },
    emit(channel: string, payload: unknown): void {
      const subscribers = eventSubscribers.get(channel);
      if (subscribers) {
        for (const handler of subscribers) {
          handler(payload);
        }
      }
    },
    send(channel: string, payload: unknown): Promise<void> {
      this.emit(channel, payload);
      return Promise.resolve();
    },
  };

  // ---------------------------------------------------------------------------
  // Hardware Subsystems Implementation
  // ---------------------------------------------------------------------------

  const hh = options.hardwareHandler;

  // 1. Camera
  const camera: SevynCameraApi = {
    capture(opts?: CameraCaptureOptions): Promise<CameraCaptureResult> {
      const denied = checkPermission("camera", "capture camera images");
      if (denied) return denied;
      if (hh?.camera?.capture) return hh.camera.capture(opts);
      return Promise.reject(
        new HardwareUnavailableError("Camera", "No camera capture device detected."),
      );
    },
    recordStart(opts?: CameraRecordOptions): Promise<void> {
      const denied = checkPermission("camera", "record camera video");
      if (denied) return denied;
      if (hh?.camera?.recordStart) return hh.camera.recordStart(opts);
      return Promise.reject(
        new HardwareUnavailableError("Camera", "No camera recording device detected."),
      );
    },
    recordStop(): Promise<CameraRecordResult> {
      const denied = checkPermission("camera", "stop camera recording");
      if (denied) return denied;
      if (hh?.camera?.recordStop) return hh.camera.recordStop();
      return Promise.reject(
        new HardwareUnavailableError("Camera", "No active camera recording session."),
      );
    },
    preview(): Promise<CameraPreviewResult> {
      const denied = checkPermission("camera", "access camera preview");
      if (denied) return denied;
      if (hh?.camera?.preview) return hh.camera.preview();
      return Promise.reject(
        new HardwareUnavailableError("Camera", "No camera preview stream available."),
      );
    },
    status(): Promise<CameraStatus> {
      const denied = checkPermission("camera", "query camera status");
      if (denied) return denied;
      if (hh?.camera?.status) return hh.camera.status();
      return Promise.resolve({
        available: false,
        active: false,
        recording: false,
        torch: false,
      });
    },
    setTorch(enabled: boolean): Promise<void> {
      const denied = checkPermission("camera", "control flashlight/torch");
      if (denied) return denied;
      if (hh?.camera?.setTorch) return hh.camera.setTorch(enabled);
      return Promise.reject(
        new HardwareUnavailableError("Torch", "Flashlight hardware not detected."),
      );
    },
  };

  // 2. Microphone
  const microphone: SevynMicrophoneApi = {
    start(opts?: MicrophoneStartOptions): Promise<void> {
      const denied = checkPermission("microphone", "start audio recording");
      if (denied) return denied;
      if (hh?.microphone?.start) return hh.microphone.start(opts);
      return Promise.reject(
        new HardwareUnavailableError("Microphone", "No audio input hardware detected."),
      );
    },
    stop(): Promise<MicrophoneStopResult> {
      const denied = checkPermission("microphone", "stop audio recording");
      if (denied) return denied;
      if (hh?.microphone?.stop) return hh.microphone.stop();
      return Promise.reject(
        new HardwareUnavailableError("Microphone", "No active recording stream."),
      );
    },
    record(opts?: MicrophoneRecordOptions): Promise<MicrophoneRecordResult> {
      const denied = checkPermission("microphone", "record audio clip");
      if (denied) return denied;
      if (hh?.microphone?.record) return hh.microphone.record(opts);
      return Promise.reject(
        new HardwareUnavailableError("Microphone", "No audio input hardware detected."),
      );
    },
  };

  // 3. Bluetooth
  const bluetooth: SevynBluetoothApi = {
    scan(): Promise<readonly BluetoothDevice[]> {
      const denied = checkPermission("bluetooth", "scan for bluetooth devices");
      if (denied) return denied;
      if (hh?.bluetooth?.scan) return hh.bluetooth.scan();
      return Promise.resolve([]);
    },
    isEnabled(): Promise<boolean> {
      const denied = checkPermission("bluetooth", "query bluetooth state");
      if (denied) return denied;
      if (hh?.bluetooth?.isEnabled) return hh.bluetooth.isEnabled();
      return Promise.resolve(false);
    },
    requestEnable(): Promise<boolean> {
      const denied = checkPermission("bluetooth", "request enabling bluetooth");
      if (denied) return denied;
      if (hh?.bluetooth?.requestEnable) return hh.bluetooth.requestEnable();
      return Promise.resolve(false);
    },
  };

  // 4. Location / Geolocation
  const location: SevynLocationApi = {
    getCurrentPosition(opts?: GeolocationOptions): Promise<GeolocationPosition> {
      const denied = checkPermission("location", "access current location");
      if (denied) return denied;
      if (hh?.location?.getCurrentPosition) return hh.location.getCurrentPosition(opts);
      return Promise.reject(
        new HardwareUnavailableError("Location", "Location services unavailable."),
      );
    },
    watchPosition(
      onPosition: (pos: GeolocationPosition) => void,
      onError?: (err: Error) => void,
      opts?: GeolocationOptions,
    ): () => void {
      if (!permissions.has("location")) {
        onError?.(new CapabilityError("location", "watch location position"));
        return noop;
      }
      if (hh?.location?.watchPosition) {
        return hh.location.watchPosition(onPosition, onError, opts);
      }
      onError?.(
        new HardwareUnavailableError("Location", "Location streaming not available."),
      );
      return noop;
    },
  };

  const SENSOR_UNITS: Record<SensorType, SensorUnit> = {
    accelerometer: "m/s^2",
    gyroscope: "rad/s",
    magnetometer: "uT",
    proximity: "cm",
    ambientLight: "lux",
    barometer: "hPa",
  };

  // 5. Sensors
  const sensors: SevynSensorsApi = {
    async read(sensor: SensorType): Promise<SensorReading> {
      const denied = checkPermission("sensors", `read sensor '${sensor}'`);
      if (denied) return denied;
      if (hh?.sensors?.read) {
        const result = await hh.sensors.read(sensor);
        const customUnit = (result as Partial<SensorReading>).unit;
        return {
          ...result,
          unit: customUnit ?? SENSOR_UNITS[sensor],
        };
      }
      return Promise.reject(
        new HardwareUnavailableError(
          `Sensor '${sensor}'`,
          "Sensor hardware not detected.",
        ),
      );
    },
    subscribe(
      sensor: SensorType,
      listener: (reading: SensorReading) => void,
      options?: SensorSubscribeOptions,
    ): () => void {
      if (!permissions.has("sensors")) {
        throw new CapabilityError("sensors", `subscribe to sensor '${sensor}'`);
      }
      if (hh?.sensors?.subscribe) {
        return hh.sensors.subscribe(sensor, listener, options);
      }
      return noop;
    },
    list(): Promise<readonly string[]> {
      const denied = checkPermission("sensors", "list available sensors");
      if (denied) return denied;
      if (hh?.sensors?.list) return hh.sensors.list();
      return Promise.resolve([]);
    },
  };

  // 6. Biometrics
  const biometricKeystoreStore = new Map<string, string>();

  const keystore: SevynBiometricKeystore = {
    setKey(key: string, secret: string): Promise<void> {
      const denied = checkPermission("biometrics", "write to biometric keystore");
      if (denied) return denied;
      if (hh?.biometrics?.keystore?.setKey) {
        return hh.biometrics.keystore.setKey(key, secret);
      }
      biometricKeystoreStore.set(key, secret);
      return Promise.resolve();
    },
    getKey(key: string): Promise<string | null> {
      const denied = checkPermission("biometrics", "read from biometric keystore");
      if (denied) return denied;
      if (hh?.biometrics?.keystore?.getKey) {
        return hh.biometrics.keystore.getKey(key);
      }
      return Promise.resolve(biometricKeystoreStore.get(key) ?? null);
    },
    deleteKey(key: string): Promise<boolean> {
      const denied = checkPermission("biometrics", "delete from biometric keystore");
      if (denied) return denied;
      if (hh?.biometrics?.keystore?.deleteKey) {
        return hh.biometrics.keystore.deleteKey(key);
      }
      return Promise.resolve(biometricKeystoreStore.delete(key));
    },
    listKeys(): Promise<readonly string[]> {
      const denied = checkPermission("biometrics", "list biometric keystore keys");
      if (denied) return denied;
      if (hh?.biometrics?.keystore?.listKeys) {
        return hh.biometrics.keystore.listKeys();
      }
      return Promise.resolve([...biometricKeystoreStore.keys()]);
    },
  };

  const biometrics: SevynBiometricsApi = {
    authenticate(reason?: string): Promise<BiometricAuthResult> {
      const denied = checkPermission("biometrics", "authenticate with biometrics");
      if (denied) return denied;
      if (hh?.biometrics?.authenticate) return hh.biometrics.authenticate(reason);
      return Promise.reject(
        new HardwareUnavailableError(
          "Biometrics",
          "Biometric authentication hardware not available.",
        ),
      );
    },
    isAvailable(): Promise<boolean> {
      const denied = checkPermission("biometrics", "check biometric availability");
      if (denied) return denied;
      if (hh?.biometrics?.isAvailable) return hh.biometrics.isAvailable();
      return Promise.resolve(false);
    },
    getEnrolledType(): Promise<BiometricType> {
      const denied = checkPermission("biometrics", "query enrolled biometric type");
      if (denied) return denied;
      if (hh?.biometrics?.getEnrolledType) return hh.biometrics.getEnrolledType();
      return Promise.resolve("none");
    },
    enroll(type: BiometricType, label?: string): Promise<BiometricEnrollResult> {
      const denied = checkPermission("biometrics", "enroll biometric credential");
      if (denied) return denied;
      if (hh?.biometrics?.enroll) return hh.biometrics.enroll(type, label);
      return Promise.reject(
        new HardwareUnavailableError("Biometrics", "Biometric enrollment not supported."),
      );
    },
    deleteEnrolled(
      type: BiometricType,
      id: string,
    ): Promise<{ readonly success: boolean }> {
      const denied = checkPermission("biometrics", "delete biometric credential");
      if (denied) return denied;
      if (hh?.biometrics?.deleteEnrolled) return hh.biometrics.deleteEnrolled(type, id);
      return Promise.resolve({ success: false });
    },
    listEnrolled(): Promise<readonly BiometricCredential[]> {
      const denied = checkPermission("biometrics", "list enrolled biometrics");
      if (denied) return denied;
      if (hh?.biometrics?.listEnrolled) return hh.biometrics.listEnrolled();
      return Promise.resolve([]);
    },
    verifyPin(pin: string): Promise<boolean> {
      const denied = checkPermission("biometrics", "verify security PIN");
      if (denied) return denied;
      if (hh?.biometrics?.verifyPin) return hh.biometrics.verifyPin(pin);
      return Promise.resolve(false);
    },
    keystore,
  };

  // 7. Media
  const media: SevynMediaApi = {
    play(source: string): Promise<void> {
      const denied = checkPermission("media", "play media track");
      if (denied) return denied;
      if (hh?.media?.play) return hh.media.play(source);
      return Promise.reject(
        new HardwareUnavailableError("Media", "Audio playback sink not available."),
      );
    },
    pause(): Promise<void> {
      const denied = checkPermission("media", "pause media track");
      if (denied) return denied;
      if (hh?.media?.pause) return hh.media.pause();
      return Promise.resolve();
    },
    resume(): Promise<void> {
      const denied = checkPermission("media", "resume media track");
      if (denied) return denied;
      if (hh?.media?.resume) return hh.media.resume();
      return Promise.resolve();
    },
    stop(): Promise<void> {
      const denied = checkPermission("media", "stop media track");
      if (denied) return denied;
      if (hh?.media?.stop) return hh.media.stop();
      return Promise.resolve();
    },
    seek(seconds: number): Promise<void> {
      const denied = checkPermission("media", "seek media track");
      if (denied) return denied;
      if (hh?.media?.seek) return hh.media.seek(seconds);
      return Promise.resolve();
    },
    setVolume(volume: number): Promise<void> {
      const denied = checkPermission("media", "adjust media volume");
      if (denied) return denied;
      if (hh?.media?.setVolume) return hh.media.setVolume(volume);
      return Promise.resolve();
    },
    status(): Promise<MediaPlaybackStatus> {
      const denied = checkPermission("media", "query media playback status");
      if (denied) return denied;
      if (hh?.media?.status) return hh.media.status();
      return Promise.resolve({
        isPlaying: false,
        isPaused: false,
        positionSec: 0,
        durationSec: 0,
        volume: 100,
      });
    },
    scan(directory?: string): Promise<readonly MediaTrack[]> {
      const denied = checkPermission("media", "scan media library");
      if (denied) return denied;
      if (hh?.media?.scan) return hh.media.scan(directory);
      return Promise.resolve([]);
    },
  };

  // 8. Battery
  const batteryListeners = new Set<(status: BatteryStatus) => void>();
  const battery: SevynBatteryApi = {
    getStatus(): Promise<BatteryStatus> {
      const denied = checkPermission("battery", "query battery status");
      if (denied) return denied;
      if (hh?.battery?.getStatus) return hh.battery.getStatus();
      return Promise.resolve({
        available: false,
        percent: 0,
        charging: false,
        state: "unknown",
      });
    },
    onStatusChange(listener: (status: BatteryStatus) => void): () => void {
      if (!permissions.has("battery")) {
        throw new CapabilityError("battery", "subscribe to battery status changes");
      }
      if (hh?.battery?.onStatusChange) {
        return hh.battery.onStatusChange(listener);
      }
      batteryListeners.add(listener);
      return () => {
        batteryListeners.delete(listener);
      };
    },
  };

  // 9. Display
  let autoBrightnessEnabled = false;
  let screenOrientation: ScreenOrientation = "portrait";
  let displayWakeLockCount = 0;
  const orientationListeners = new Set<(orientation: ScreenOrientation) => void>();

  const display: SevynDisplayApi = {
    getBrightness(): Promise<number> {
      const denied = checkPermission("display", "query display brightness");
      if (denied) return denied;
      if (hh?.display?.getBrightness) return hh.display.getBrightness();
      return Promise.resolve(1.0);
    },
    setBrightness(brightness: number): Promise<void> {
      const denied = checkPermission("display", "set display brightness");
      if (denied) return denied;
      if (hh?.display?.setBrightness) return hh.display.setBrightness(brightness);
      return Promise.resolve();
    },
    getAutoBrightness(): Promise<boolean> {
      const denied = checkPermission("display", "query auto-brightness status");
      if (denied) return denied;
      if (hh?.display?.getAutoBrightness) return hh.display.getAutoBrightness();
      return Promise.resolve(autoBrightnessEnabled);
    },
    setAutoBrightness(enabled: boolean): Promise<void> {
      const denied = checkPermission("display", "set auto-brightness");
      if (denied) return denied;
      if (hh?.display?.setAutoBrightness) return hh.display.setAutoBrightness(enabled);
      autoBrightnessEnabled = enabled;
      return Promise.resolve();
    },
    getOrientation(): Promise<ScreenOrientation> {
      const denied = checkPermission("display", "query screen orientation");
      if (denied) return denied;
      if (hh?.display?.getOrientation) return hh.display.getOrientation();
      return Promise.resolve(screenOrientation);
    },
    lockOrientation(orientation: ScreenOrientation | "auto"): Promise<void> {
      const denied = checkPermission("display", "lock screen orientation");
      if (denied) return denied;
      if (hh?.display?.lockOrientation) return hh.display.lockOrientation(orientation);
      if (orientation !== "auto") {
        screenOrientation = orientation;
        for (const listener of orientationListeners) {
          listener(screenOrientation);
        }
      }
      return Promise.resolve();
    },
    onOrientationChange(listener: (orientation: ScreenOrientation) => void): () => void {
      if (!permissions.has("display")) {
        throw new CapabilityError("display", "listen to orientation changes");
      }
      if (hh?.display?.onOrientationChange) {
        return hh.display.onOrientationChange(listener);
      }
      orientationListeners.add(listener);
      return () => {
        orientationListeners.delete(listener);
      };
    },
    acquireWakeLock(): Promise<() => void> {
      const denied = checkPermission("display", "acquire display wake lock");
      if (denied) return denied;
      if (hh?.display?.acquireWakeLock) return hh.display.acquireWakeLock();
      displayWakeLockCount++;
      let released = false;
      return Promise.resolve(() => {
        if (!released) {
          released = true;
          displayWakeLockCount = Math.max(0, displayWakeLockCount - 1);
        }
      });
    },
    isWakeLocked(): boolean {
      if (hh?.display?.isWakeLocked) return hh.display.isWakeLocked();
      return displayWakeLockCount > 0;
    },
  };

  // 10. Audio
  const audio: SevynAudioApi = {
    getOutputs(): Promise<readonly AudioOutputDevice[]> {
      const denied = checkPermission("audio", "query audio outputs");
      if (denied) return denied;
      if (hh?.audio?.getOutputs) return hh.audio.getOutputs();
      return Promise.resolve([
        {
          id: "default",
          name: "Default Audio Device",
          isDefault: true,
          type: "speaker",
        },
      ]);
    },
    setOutput(deviceId: string): Promise<void> {
      const denied = checkPermission("audio", "set active audio output");
      if (denied) return denied;
      if (hh?.audio?.setOutput) return hh.audio.setOutput(deviceId);
      return Promise.resolve();
    },
    getVolume(): Promise<number> {
      const denied = checkPermission("audio", "query audio volume");
      if (denied) return denied;
      if (hh?.audio?.getVolume) return hh.audio.getVolume();
      return Promise.resolve(100);
    },
    setVolume(volume: number): Promise<void> {
      const denied = checkPermission("audio", "set audio volume");
      if (denied) return denied;
      if (hh?.audio?.setVolume) return hh.audio.setVolume(volume);
      return Promise.resolve();
    },
  };

  // 11. Vibration / Haptics
  const vibration: SevynVibrationApi = {
    vibrate(pattern?: number | readonly number[]): Promise<void> {
      const denied = checkPermission("vibration", "trigger haptic vibration");
      if (denied) return denied;
      if (hh?.vibration?.vibrate) return hh.vibration.vibrate(pattern);
      return Promise.reject(
        new HardwareUnavailableError(
          "Vibration",
          "Haptic motor not detected on this device.",
        ),
      );
    },
    cancel(): Promise<void> {
      const denied = checkPermission("vibration", "cancel vibration");
      if (denied) return denied;
      if (hh?.vibration?.cancel) return hh.vibration.cancel();
      return Promise.resolve();
    },
  };

  // 12. NFC
  const nfc: SevynNfcApi = {
    isAvailable(): Promise<boolean> {
      const denied = checkPermission("nfc", "check NFC availability");
      if (denied) return denied;
      if (hh?.nfc?.isAvailable) return hh.nfc.isAvailable();
      return Promise.resolve(false);
    },
    scan(): Promise<NfcTag> {
      const denied = checkPermission("nfc", "scan NFC tags");
      if (denied) return denied;
      if (hh?.nfc?.scan) return hh.nfc.scan();
      return Promise.reject(
        new HardwareUnavailableError("NFC", "NFC reader not detected on this device."),
      );
    },
    write(data: string | Uint8Array): Promise<void> {
      const denied = checkPermission("nfc", "write NFC tag");
      if (denied) return denied;
      if (hh?.nfc?.write) return hh.nfc.write(data);
      return Promise.reject(
        new HardwareUnavailableError("NFC", "NFC writer not detected on this device."),
      );
    },
  };

  // 13. Cellular
  const cellular: SevynCellularApi = {
    getModemStatus(): Promise<CellularModemStatus> {
      const denied = checkPermission("cellular", "query cellular modem status");
      if (denied) return denied;
      if (hh?.cellular?.getModemStatus) return hh.cellular.getModemStatus();
      return Promise.resolve({
        available: false,
        state: "unknown",
        simPresent: false,
      });
    },
    getSignal(): Promise<CellularSignalStatus> {
      const denied = checkPermission("cellular", "query cellular signal strength");
      if (denied) return denied;
      if (hh?.cellular?.getSignal) return hh.cellular.getSignal();
      return Promise.resolve({
        signalPercent: 0,
        technology: "unknown",
      });
    },
    getBearer(): Promise<CellularBearerStatus> {
      const denied = checkPermission("cellular", "query mobile data bearer status");
      if (denied) return denied;
      if (hh?.cellular?.getBearer) return hh.cellular.getBearer();
      return Promise.resolve({
        connected: false,
      });
    },
    dial(number: string): Promise<CellularCall> {
      const denied = checkPermission("cellular", "initiate voice call");
      if (denied) return denied;
      if (hh?.cellular?.dial) return hh.cellular.dial(number);
      return Promise.reject(
        new HardwareUnavailableError(
          "Cellular",
          "No cellular modem detected on this device.",
        ),
      );
    },
    answer(): Promise<void> {
      const denied = checkPermission("cellular", "answer voice call");
      if (denied) return denied;
      if (hh?.cellular?.answer) return hh.cellular.answer();
      return Promise.reject(
        new HardwareUnavailableError("Cellular", "No active cellular call."),
      );
    },
    hangup(): Promise<void> {
      const denied = checkPermission("cellular", "hang up voice call");
      if (denied) return denied;
      if (hh?.cellular?.hangup) return hh.cellular.hangup();
      return Promise.reject(
        new HardwareUnavailableError("Cellular", "No active cellular call."),
      );
    },
    sendSms(recipient: string, message: string): Promise<SmsSendResult> {
      const denied = checkPermission("cellular", "send SMS message");
      if (denied) return denied;
      if (hh?.cellular?.sendSms) return hh.cellular.sendSms(recipient, message);
      return Promise.reject(
        new HardwareUnavailableError(
          "Cellular",
          "No cellular modem detected on this device.",
        ),
      );
    },
    listSms(): Promise<readonly SmsMessage[]> {
      const denied = checkPermission("cellular", "list SMS messages");
      if (denied) return denied;
      if (hh?.cellular?.listSms) return hh.cellular.listSms();
      return Promise.resolve([]);
    },
  };

  return Object.freeze({
    app,
    notifications,
    clipboard,
    storage,
    files,
    windows,
    events,

    // Unified hardware modules
    camera,
    microphone,
    bluetooth,
    location,
    geolocation: location,
    sensors,
    biometrics,
    media,
    battery,
    display,
    audio,
    vibration,
    haptics: vibration,
    nfc,
    cellular,
  });
}
