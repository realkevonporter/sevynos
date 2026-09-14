# SevynOS SDK Hardware Reference

The SevynOS SDK provides third-party and system application developers with a unified, capability-secured API surface for interacting with device hardware across desktops, laptops, tablets, and mobile devices.

All hardware subsystems are exposed directly through the `@sevynos/sdk` package via the singleton `sevyn` export.

```typescript
import { sevyn, CapabilityError, HardwareUnavailableError } from "@sevynos/sdk";
```

---

## Architecture & Security Model

### 1. Capability-Based Access Control

SevynOS operates under a strict principle of least privilege. An application cannot access any hardware component unless the corresponding permission is explicitly declared in the application's `manifest.json` under `permissions`:

```json
{
  "id": "com.example.devicehub",
  "name": "Device Hub",
  "version": "1.0.0",
  "permissions": [
    "camera",
    "microphone",
    "location",
    "bluetooth",
    "sensors",
    "biometrics",
    "media",
    "battery",
    "display",
    "audio",
    "vibration",
    "nfc",
    "cellular"
  ]
}
```

If an application attempts to call a hardware method without having the required permission granted in its manifest, the SDK immediately throws a `CapabilityError`:

```typescript
try {
  await sevyn.camera.capture();
} catch (error) {
  if (error instanceof CapabilityError) {
    console.error(`Permission denied for capability: ${error.capability}`);
  }
}
```

Hardware calls **never silently succeed** without explicit manifest capabilities.

### 2. Graceful Hardware Absence

Hardware availability varies significantly across deployment targets (e.g. desktop workstations lack cellular modems, virtual machines lack NFC or biometric readers).

When hardware is missing or unsupported:

- Discovery/status methods return structured `{ available: false }` status objects without throwing.
- Action-oriented methods (e.g. `dial()`, `scan()`, `write()`) reject with a `HardwareUnavailableError`.
- Operations **never crash, hang, or leave unhandled promises**.

```typescript
try {
  const status = await sevyn.nfc.isAvailable();
  if (status) {
    const tag = await sevyn.nfc.scan();
  }
} catch (error) {
  if (error instanceof HardwareUnavailableError) {
    console.warn("NFC hardware not present:", error.message);
  }
}
```

---

## Subsystem Reference

### 1. Camera (`sevyn.camera`)

**Permission:** `"camera"`

Provides photo capture, video recording, viewfinder streams, and flashlight/torch control.

```typescript
interface SevynCameraModule {
  capture(options?: CameraCaptureOptions): Promise<CameraCaptureResult>;
  recordStart(options?: CameraRecordOptions): Promise<CameraRecordStartResult>;
  recordStop(): Promise<CameraRecordStopResult>;
  preview(): Promise<CameraPreviewStatus>;
  status(): Promise<CameraStatus>;
  setTorch(enabled: boolean): Promise<CameraTorchResult>;
}
```

#### Example

```typescript
// Photo capture
const photo = await sevyn.camera.capture({ flash: "auto", quality: 0.9 });
console.log(`Saved photo to ${photo.uri} (${photo.width}x${photo.height})`);

// Flashlight toggle
await sevyn.camera.setTorch(true);
```

---

### 2. Microphone (`sevyn.microphone`)

**Permission:** `"microphone"`

Captures raw and compressed audio input from default or configured input devices.

```typescript
interface SevynMicrophoneModule {
  start(options?: MicrophoneRecordOptions): Promise<void>;
  stop(): Promise<void>;
}
```

#### Example

```typescript
await sevyn.microphone.start({ sampleRate: 44100, channels: 2 });
// ... recording ...
await sevyn.microphone.stop();
```

---

### 3. Bluetooth (`sevyn.bluetooth`)

**Permission:** `"bluetooth"`

Scans for nearby Bluetooth Low Energy (BLE) and classic peripherals.

```typescript
interface SevynBluetoothModule {
  scan(): Promise<readonly BluetoothDevice[]>;
}
```

#### Example

```typescript
const devices = await sevyn.bluetooth.scan();
for (const dev of devices) {
  console.log(`Found ${dev.name ?? "Unknown"} (${dev.address}), RSSI: ${dev.rssi}`);
}
```

---

### 4. Location & Geolocation (`sevyn.location` / `sevyn.geolocation`)

**Permission:** `"location"`

Retrieves high-accuracy WGS-84 coordinates from GPS, cellular tower trilateration, or WiFi geolocation.

```typescript
interface SevynLocationModule {
  getCurrentPosition(): Promise<GeolocationPosition>;
}
```

#### Example

```typescript
const pos = await sevyn.location.getCurrentPosition();
console.log(
  `Latitude: ${pos.latitude}, Longitude: ${pos.longitude}, Accuracy: ${pos.accuracy}m`,
);
```

---

### 5. Sensors (`sevyn.sensors`)

**Permission:** `"sensors"`

Reads telemetry from onboard physical motion and environmental sensors.

Supported sensor types:

- `"accelerometer"`: 3-axis acceleration (m/s²)
- `"gyroscope"`: 3-axis rotational velocity (rad/s)
- `"ambientLight"`: Ambient illumination (lux)
- `"proximity"`: Distance detection (cm or boolean near)
- `"barometer"`: Atmospheric pressure (hPa)
- `"magnetometer"`: 3-axis geomagnetic field (µT)

```typescript
interface SevynSensorsModule {
  read(sensor: SensorType): Promise<SensorReading>;
}
```

#### Example

```typescript
const reading = await sevyn.sensors.read("accelerometer");
console.log(`X: ${reading.values.x}, Y: ${reading.values.y}, Z: ${reading.values.z}`);
```

---

### 6. Biometrics (`sevyn.biometrics`)

**Permission:** `"biometrics"`

Prompts for hardware biometric authentication (fingerprint reader or secure facial recognition).

```typescript
interface SevynBiometricsModule {
  authenticate(reason?: string): Promise<boolean>;
}
```

#### Example

```typescript
const verified = await sevyn.biometrics.authenticate("Confirm payment transaction");
if (verified) {
  // Execute protected action
}
```

---

### 7. Media (`sevyn.media`)

**Permission:** `"media"`

System audio/video playback engine, playlist management, and local music index scanning.

```typescript
interface SevynMediaModule {
  play(source: string | MediaTrack): Promise<MediaPlaybackStatus>;
  pause(): Promise<MediaPlaybackStatus>;
  resume(): Promise<MediaPlaybackStatus>;
  stop(): Promise<MediaPlaybackStatus>;
  seek(seconds: number): Promise<MediaPlaybackStatus>;
  setVolume(volume: number): Promise<MediaPlaybackStatus>;
  status(): Promise<MediaPlaybackStatus>;
  scan(directory?: string): Promise<readonly MediaTrack[]>;
}
```

#### Example

```typescript
await sevyn.media.play("/usr/share/sevyn/music/ambient.mp3");
await sevyn.media.setVolume(85);
await sevyn.media.seek(30);
```

---

### 8. Battery (`sevyn.battery`)

**Permission:** `"battery"`

Queries current battery percentage, charge status, and power supply state via Linux `power_supply` subsystem.

```typescript
interface SevynBatteryModule {
  getStatus(): Promise<BatteryStatus>;
}
```

#### Example

```typescript
const battery = await sevyn.battery.getStatus();
console.log(
  `Battery: ${battery.percent}%, Charging: ${battery.charging}, State: ${battery.state}`,
);
```

---

### 9. Display (`sevyn.display`)

**Permission:** `"display"`

Controls screen backlight brightness (0.0 to 1.0) and manages system idle sleep locks.

```typescript
interface SevynDisplayModule {
  getBrightness(): Promise<number>;
  setBrightness(brightness: number): Promise<void>;
  requestWakeLock(): Promise<WakeLockSentinel>;
}
```

#### Example

```typescript
await sevyn.display.setBrightness(0.75);

const lock = await sevyn.display.requestWakeLock();
// Screen stays awake during video playback
await lock.release();
```

---

### 10. Audio Output Routing (`sevyn.audio`)

**Permission:** `"audio"`

Lists audio output sinks (speakers, 3.5mm jack, USB-C DACs, Bluetooth A2DP) and routes active stream routing.

```typescript
interface SevynAudioModule {
  getOutputs(): Promise<readonly AudioOutputDevice[]>;
  setOutput(deviceId: string): Promise<void>;
}
```

#### Example

```typescript
const sinks = await sevyn.audio.getOutputs();
const headphones = sinks.find((sink) => sink.type === "headphones");
if (headphones) {
  await sevyn.audio.setOutput(headphones.id);
}
```

---

### 11. Vibration & Haptics (`sevyn.vibration` / `sevyn.haptics`)

**Permission:** `"vibration"`

Drives linear resonant actuators (LRA) or eccentric rotating mass (ERM) vibrator motors.

```typescript
interface SevynVibrationModule {
  vibrate(pattern?: number | readonly number[]): Promise<void>;
  cancel(): Promise<void>;
}
```

#### Example

```typescript
// Single pulse of 200ms
await sevyn.vibration.vibrate(200);

// Pattern: wait 100ms, pulse 200ms, wait 100ms, pulse 400ms
await sevyn.vibration.vibrate([100, 200, 100, 400]);
```

---

### 12. Near Field Communication (`sevyn.nfc`)

**Permission:** `"nfc"`

Detects NFC tags, reads NDEF records, and writes contactless payloads.

```typescript
interface SevynNfcModule {
  isAvailable(): Promise<boolean>;
  scan(): Promise<NfcTag>;
  write(data: NfcTagPayload): Promise<void>;
}
```

#### Example

```typescript
if (await sevyn.nfc.isAvailable()) {
  const tag = await sevyn.nfc.scan();
  console.log(`Scanned tag ID: ${tag.id}, technology: ${tag.tech}`);
}
```

---

### 13. Cellular Telephony (`sevyn.cellular`)

**Permission:** `"cellular"`

Direct ModemManager integration for voice telephony, cellular registration, signal strength metrics, and SMS messaging.

```typescript
interface SevynCellularModule {
  getModemStatus(): Promise<CellularModemStatus>;
  getSignal(): Promise<CellularSignal>;
  getBearer(): Promise<CellularBearer>;
  dial(number: string): Promise<CellularCall>;
  answer(): Promise<void>;
  hangup(): Promise<void>;
  sendSms(recipient: string, message: string): Promise<CellularSmsResult>;
  listSms(): Promise<readonly CellularSmsMessage[]>;
}
```

#### Example

```typescript
const modem = await sevyn.cellular.getModemStatus();
if (modem.available && modem.simPresent) {
  // Send SMS
  await sevyn.cellular.sendSms("+15551234567", "Hello from SevynOS!");

  // Place phone call
  const call = await sevyn.cellular.dial("+15551234567");
  console.log(`Call initiated with ID: ${call.callId}`);
}
```

---

## Backward Compatibility

For existing applications utilizing React Native modules, `@sevynos/react-native` continues to export `NativeModules.HardwareModules` as a compatibility bridge.

However, all new applications should prefer importing the unified `sevyn` singleton from `@sevynos/sdk`.
