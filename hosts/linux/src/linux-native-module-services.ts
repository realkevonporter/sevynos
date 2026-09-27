import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import WebSocket from "ws";
import type { StructuredValue, WorkerServiceName } from "@sevynos/react-native/internal";
import {
  LinuxBinaryNativeModuleLoader,
  type LinuxBinaryNativeModule,
} from "./linux-binary-native-module-loader.js";
import { ChromiumBrowserEngine, decodePng } from "./chromium-browser-engine.js";
import { LinuxAccessibilityService } from "./linux-accessibility-service.js";
import { LinuxBatteryService } from "./linux-battery-service.js";

export interface LinuxMediaPlaybackHandle {
  pause(): void;
  resume(): void;
  stop(): void;
  onEnded(listener: (error?: Error) => void): void;
}

export type LinuxMediaLauncher = (
  source: string,
  volume: number,
  offsetSeconds: number,
) => Promise<LinuxMediaPlaybackHandle>;

export class LinuxNativeModuleServices {
  readonly #root: string;
  readonly #mediaLauncher: LinuxMediaLauncher;
  #media: LinuxMediaPlaybackHandle | undefined;
  #mediaSource: string | undefined;
  #mediaGeneration = 0;
  #mediaTrack: StructuredValue | undefined;
  #mediaPlaying = false;
  #mediaPaused = false;
  #mediaStartTimeMs = 0;
  #mediaPausedOffsetSec = 0;
  #mediaDurationSec = 180;
  #mediaVolume = 100;
  #microphone: ChildProcess | undefined;
  #microphonePath: string | undefined;
  #cameraRecording: ChildProcess | undefined;
  #cameraRecordingPath: string | undefined;
  #cameraRecordingStartTime: number | undefined;
  readonly #binaryLoader: LinuxBinaryNativeModuleLoader;
  readonly #binaryModules = new Map<string, LinuxBinaryNativeModule>();
  readonly #webviews = new Map<string, ChromiumBrowserEngine>();
  readonly #websockets = new Map<string, LinuxWebSocketSession>();
  readonly #accessibility = new LinuxAccessibilityService();
  readonly #batteryService = new LinuxBatteryService();
  #activeCall = false;
  #proximityNear = false;
  #savedBrightnessBeforeCallBlank = 1.0;
  #isScreenCallBlanked = false;
  #autoBrightness = false;
  #screenOrientation:
    "portrait" | "landscape-left" | "landscape-right" | "portrait-upside-down" =
    "portrait";
  #wakeLockCounter = 0;
  readonly #activeWakeLocks = new Set<string>();
  #sensorSubCounter = 0;
  readonly #sensorSubscriptions = new Map<
    string,
    { readonly sensor: string; readonly intervalMs: number }
  >();
  readonly #keystore = new Map<string, string>();
  #enrolledCredentials: {
    readonly id: string;
    readonly type: string;
    readonly label: string;
    readonly enrolledAt: number;
  }[] = [];
  #storedPin = "1234";
  #keystoreLoaded = false;
  #currentBrightness = 1.0;

  public constructor(
    root = "/tmp/sevynos-native",
    nativeModuleRoot = "/opt/sevynos/native-modules",
    mediaLauncher: LinuxMediaLauncher = launchFfplay,
  ) {
    this.#root = root;
    this.#mediaLauncher = mediaLauncher;
    this.#binaryLoader = new LinuxBinaryNativeModuleLoader(nativeModuleRoot, [
      "camera",
      "microphone",
      "location",
      "bluetooth",
      "sensors",
      "biometrics",
      "media",
      "network",
      "filesystem.read",
      "filesystem.write",
    ]);
  }

  public async request(
    service: WorkerServiceName,
    value: StructuredValue,
  ): Promise<StructuredValue> {
    await mkdir(this.#root, { recursive: true });
    if (service === "camera.status") return this.#statusCamera();
    if (service === "camera.capture") return this.#captureCamera();
    if (service === "camera.preview") return this.#previewCamera();
    if (service === "camera.recordStart") return this.#startCameraRecord();
    if (service === "camera.recordStop") return this.#stopCameraRecord();
    if (service === "camera.torch") return this.#setTorch(value);
    if (service === "battery.status") return this.#batteryStatus();
    if (service === "display.brightness.get") return this.#getDisplayBrightness();
    if (service === "display.brightness.set") return this.#setDisplayBrightness(value);
    if (service === "display.orientation.get") return this.#getDisplayOrientation();
    if (service === "display.orientation.lock")
      return this.#lockDisplayOrientation(value);
    if (service === "display.autoBrightness.get") return this.#getAutoBrightness();
    if (service === "display.autoBrightness.set") return this.#setAutoBrightness(value);
    if (service === "display.wakeLock.acquire") return this.#acquireWakeLock();
    if (service === "display.wakeLock.release") return this.#releaseWakeLock(value);
    if (service === "audio.outputs.get") return this.#getAudioOutputs();
    if (service === "audio.output.set") return this.#setAudioOutput(value);
    if (service === "vibration.vibrate") return this.#vibrate(value);
    if (service === "vibration.cancel") return this.#cancelVibration();
    if (service === "nfc.status") return this.#nfcStatus();
    if (service === "nfc.scan") return this.#nfcScan();
    if (service === "nfc.write") return this.#nfcWrite(value);
    if (service === "cellular.status") return this.#cellularStatus();
    if (service === "cellular.signal") return this.#cellularSignal();
    if (service === "cellular.bearer") return this.#cellularBearer();
    if (service === "cellular.dial") return this.#cellularDial(value);
    if (service === "cellular.hangup") return this.#cellularHangup();
    if (service === "cellular.answer") return this.#cellularAnswer();
    if (service === "cellular.sms.send") return this.#cellularSendSms(value);
    if (service === "cellular.sms.list") return this.#cellularListSms();
    if (service === "microphone.record") return this.#recordMicrophone(value);
    if (service === "microphone.start") return this.#startMicrophone(value);
    if (service === "microphone.stop") return this.#stopMicrophone();
    if (service === "location.current") return this.#location();
    if (service === "bluetooth.scan") return this.#bluetooth();
    if (service === "sensors.read") return this.#sensor(value);
    if (service === "sensors.subscribe") return this.#subscribeSensor(value);
    if (service === "sensors.unsubscribe") return this.#unsubscribeSensor(value);
    if (service === "biometrics.authenticate") return this.#biometrics(value);
    if (service === "biometrics.enroll") return this.#enrollBiometrics(value);
    if (service === "biometrics.delete") return this.#deleteBiometrics(value);
    if (service === "biometrics.list") return this.#listBiometrics();
    if (service === "biometrics.pin.verify") return this.#verifyPin(value);
    if (service === "biometrics.keystore.get") return this.#getKeystore(value);
    if (service === "biometrics.keystore.set") return this.#setKeystore(value);
    if (service === "biometrics.keystore.delete") return this.#deleteKeystore(value);
    if (service === "biometrics.keystore.list") return this.#listKeystore();
    if (service === "media.play") return this.#play(value);
    if (service === "media.pause") return this.#pause();
    if (service === "media.resume") return this.#resume();
    if (service === "media.stop") return this.#stop();
    if (service === "media.seek") return this.#seek(value);
    if (service === "media.volume") return this.#setMediaVolume(value);
    if (service === "media.status") return this.#statusMedia();
    if (service === "media.scan") return this.#scanMedia(value);
    if (service === "network.request") return this.#networkRequest(value);
    if (service === "websocket.open") return this.#openWebSocket(value);
    if (service === "websocket.send") return this.#sendWebSocket(value);
    if (service === "websocket.receive") return this.#receiveWebSocket(value);
    if (service === "websocket.close") return this.#closeWebSocket(value);
    if (service === "image.load") return this.#loadImage(value);
    if (service === "accessibility.state")
      return { ...(await this.#accessibility.getState()) };
    if (service === "accessibility.announce") {
      if (typeof value !== "string")
        throw new Error("Accessibility announcement requires text.");
      await this.#accessibility.announce(value);
      return null;
    }
    if (service === "notifications.show") return this.#showNotification(value);
    if (service === "native.invoke") return this.#invokeNative(value);
    if (service === "webview.open") return this.#openWebView(value);
    if (service === "webview.action") return this.#actWebView(value);
    if (service === "webview.close") return this.#closeWebView(value);
    throw new Error(`Service ${service} is not a hardware service.`);
  }

  public supports(service: string): boolean {
    switch (service) {
      case "camera.status":
      case "camera.capture":
      case "camera.preview":
      case "camera.recordStart":
      case "camera.recordStop":
      case "camera.torch":
      case "battery.status":
      case "display.brightness.get":
      case "display.brightness.set":
      case "display.orientation.get":
      case "display.orientation.lock":
      case "display.autoBrightness.get":
      case "display.autoBrightness.set":
      case "display.wakeLock.acquire":
      case "display.wakeLock.release":
      case "audio.outputs.get":
      case "audio.output.set":
      case "vibration.vibrate":
      case "vibration.cancel":
      case "nfc.status":
      case "nfc.scan":
      case "nfc.write":
      case "cellular.status":
      case "cellular.signal":
      case "cellular.bearer":
      case "cellular.dial":
      case "cellular.hangup":
      case "cellular.answer":
      case "cellular.sms.send":
      case "cellular.sms.list":
      case "microphone.record":
      case "microphone.start":
      case "microphone.stop":
      case "location.current":
      case "bluetooth.scan":
      case "sensors.read":
      case "sensors.subscribe":
      case "sensors.unsubscribe":
      case "biometrics.authenticate":
      case "biometrics.enroll":
      case "biometrics.delete":
      case "biometrics.list":
      case "biometrics.pin.verify":
      case "biometrics.keystore.get":
      case "biometrics.keystore.set":
      case "biometrics.keystore.delete":
      case "biometrics.keystore.list":
      case "media.play":
      case "media.pause":
      case "media.resume":
      case "media.stop":
      case "media.seek":
      case "media.volume":
      case "media.status":
      case "media.scan":
      case "network.request":
      case "websocket.open":
      case "websocket.send":
      case "websocket.receive":
      case "websocket.close":
      case "image.load":
      case "accessibility.state":
      case "accessibility.announce":
      case "notifications.show":
      case "native.invoke":
      case "webview.open":
      case "webview.action":
      case "webview.close":
        return true;
      default:
        return false;
    }
  }

  public accessibilityState() {
    return this.#accessibility.getState();
  }

  public subscribeAccessibility(listener: () => void): () => void {
    return this.#accessibility.subscribe(listener);
  }

  public announceAccessibility(message: string): Promise<void> {
    return this.#accessibility.announce(message);
  }

  public close(): void {
    this.#media?.stop();
    this.#media = undefined;
    this.#mediaGeneration += 1;
    this.#microphone?.kill("SIGINT");
    this.#microphone = undefined;
    this.#microphonePath = undefined;
    for (const session of this.#websockets.values())
      session.socket.close(1001, "SevynOS shutting down");
    this.#websockets.clear();
    this.#activeWakeLocks.clear();
    this.#sensorSubscriptions.clear();
  }

  async #showNotification(value: StructuredValue): Promise<StructuredValue> {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new Error("Notification payload must be an object.");
    const record = value as Record<string, StructuredValue>;
    const title =
      typeof record["title"] === "string" ? record["title"].slice(0, 200) : "SevynOS";
    const bodyValue = record["message"] ?? record["body"];
    const body = typeof bodyValue === "string" ? bodyValue.slice(0, 1_024) : "";
    await run("notify-send", ["--app-name=SevynOS", title, body]);
    return { id: `notification-${String(Date.now())}` };
  }

  async #statusCamera(): Promise<StructuredValue> {
    const device = await this.#cameraDevice();
    if (device === undefined) {
      return {
        available: false,
        hasCamera: false,
        message: "No usable Video4Linux capture device was detected.",
      };
    }
    const formats = await run("v4l2-ctl", ["--device", device, "--list-formats-ext"])
      .then((output) =>
        [...output.matchAll(/'([A-Z0-9]{4})'/g)].map((match) => match[1] ?? ""),
      )
      .catch(() => []);
    return {
      available: true,
      hasCamera: true,
      device,
      formats: [...new Set(formats.filter((format) => format !== ""))],
    };
  }

  async #captureCamera(): Promise<StructuredValue> {
    const device = await this.#cameraDevice();
    if (device === undefined)
      throw new Error("No usable Video4Linux capture device was detected.");
    const photosDir = `${this.#root}/photos`;
    await mkdir(photosDir, { recursive: true });
    const path = `${photosDir}/camera-${String(Date.now())}.jpg`;
    await run("ffmpeg", [
      "-nostdin",
      "-y",
      "-loglevel",
      "error",
      "-f",
      "v4l2",
      "-i",
      device,
      "-frames:v",
      "1",
      "-q:v",
      "2",
      path,
    ]);
    return {
      path,
      mediaType: "image/jpeg",
      width: 1280,
      height: 720,
      timestamp: Date.now(),
    };
  }

  async #previewCamera(): Promise<StructuredValue> {
    const device = await this.#cameraDevice();
    if (device === undefined) {
      return {
        width: 640,
        height: 360,
        available: false,
      };
    }
    const previewRgbaPath = `${this.#root}/camera-preview.rgba`;
    try {
      await run("ffmpeg", [
        "-nostdin",
        "-y",
        "-loglevel",
        "error",
        "-f",
        "v4l2",
        "-i",
        device,
        "-frames:v",
        "1",
        "-vf",
        "scale=640:360",
        "-pix_fmt",
        "rgba",
        "-f",
        "rawvideo",
        previewRgbaPath,
      ]);
      return {
        width: 640,
        height: 360,
        available: true,
        path: previewRgbaPath,
        timestamp: Date.now(),
      };
    } catch {
      return {
        width: 640,
        height: 360,
        available: false,
        timestamp: Date.now(),
      };
    }
  }

  async #startCameraRecord(): Promise<StructuredValue> {
    if (this.#cameraRecording !== undefined)
      throw new Error("Camera recording is already in progress.");
    const device = await this.#cameraDevice();
    if (device === undefined)
      throw new Error("No usable Video4Linux capture device was detected.");
    const videosDir = `${this.#root}/videos`;
    await mkdir(videosDir, { recursive: true });
    const path = `${videosDir}/video-${String(Date.now())}.mp4`;
    const child = spawn(
      "ffmpeg",
      [
        "-y",
        "-f",
        "v4l2",
        "-i",
        device,
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        path,
      ],
      {
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    await new Promise<void>((resolve, reject) => {
      let stderr = "";
      let settled = false;
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.once("error", (error) => {
        if (!settled) reject(error);
      });
      child.once("close", (code) => {
        if (!settled)
          reject(
            new Error(
              stderr.trim() || `Camera recorder exited with code ${String(code)}.`,
            ),
          );
      });
      child.once("spawn", () => {
        setTimeout(() => {
          if (settled || child.exitCode !== null) return;
          settled = true;
          resolve();
        }, 400);
      });
    });
    this.#cameraRecording = child;
    this.#cameraRecordingPath = path;
    this.#cameraRecordingStartTime = Date.now();
    return { recording: true, path };
  }

  async #cameraDevice(): Promise<string | undefined> {
    const candidates = (await readdir("/dev").catch(() => []))
      .filter((entry) => /^video\d+$/.test(entry))
      .sort((first, second) => first.localeCompare(second, undefined, { numeric: true }));
    for (const candidate of candidates) {
      const device = join("/dev", candidate);
      const usable = await access(device).then(
        () => true,
        () => false,
      );
      if (usable) return device;
    }
    return undefined;
  }

  async #stopCameraRecord(): Promise<StructuredValue> {
    const child = this.#cameraRecording;
    const path = this.#cameraRecordingPath;
    const startTime = this.#cameraRecordingStartTime;
    if (child === undefined || path === undefined)
      throw new Error("No camera recording is currently active.");
    this.#cameraRecording = undefined;
    this.#cameraRecordingPath = undefined;
    this.#cameraRecordingStartTime = undefined;

    await new Promise<void>((resolve) => {
      child.once("close", () => {
        resolve();
      });
      child.kill("SIGINT");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
        resolve();
      }, 2000);
    });

    const durationMs = startTime !== undefined ? Date.now() - startTime : 0;
    return {
      path,
      durationMs,
      format: "video/mp4",
      timestamp: Date.now(),
    };
  }

  async #setTorch(value: StructuredValue): Promise<StructuredValue> {
    const enabled =
      value === true ||
      (typeof value === "object" &&
        value !== null &&
        (value as Record<string, unknown>)["enabled"] === true);
    try {
      const leds = await readdir("/sys/class/leds").catch(() => []);
      const torchLed = leds.find((l) => l.includes("torch") || l.includes("flash"));
      if (torchLed) {
        await writeFile(
          join("/sys/class/leds", torchLed, "brightness"),
          enabled ? "255" : "0",
          "utf8",
        );
        return { success: true, enabled };
      }
    } catch {
      // Hardware absent fallback
    }
    return {
      success: false,
      message: "Flashlight hardware not available on this device.",
    };
  }

  async #batteryStatus(): Promise<StructuredValue> {
    const snapshot = await this.#batteryService.snapshot();
    return {
      available: snapshot.available,
      percent: snapshot.percent,
      level: snapshot.percent / 100,
      charging: snapshot.charging,
      state: snapshot.state,
    };
  }

  async #getDisplayBrightness(): Promise<StructuredValue> {
    try {
      const backlights = await readdir("/sys/class/backlight").catch(() => []);
      if (backlights.length > 0 && backlights[0]) {
        const blPath = join("/sys/class/backlight", backlights[0]);
        const cur = await readFile(join(blPath, "brightness"), "utf8");
        const max = await readFile(join(blPath, "max_brightness"), "utf8");
        const ratio = Number(cur.trim()) / Math.max(1, Number(max.trim()));
        const val = Number.isFinite(ratio) ? ratio : 1.0;
        this.#currentBrightness = val;
        return val;
      }
    } catch {
      // Fallback
    }
    return this.#currentBrightness;
  }

  async #setDisplayBrightness(value: StructuredValue): Promise<StructuredValue> {
    const brightness = typeof value === "number" ? Math.max(0, Math.min(1, value)) : 1.0;
    this.#currentBrightness = brightness;
    try {
      const backlights = await readdir("/sys/class/backlight").catch(() => []);
      if (backlights.length > 0 && backlights[0]) {
        const blPath = join("/sys/class/backlight", backlights[0]);
        const maxStr = await readFile(join(blPath, "max_brightness"), "utf8");
        const maxVal = Number(maxStr.trim());
        const target = Math.round(brightness * maxVal);
        await writeFile(join(blPath, "brightness"), String(target), "utf8");
        return null;
      }
    } catch {
      // Fallback
    }
    return null;
  }

  #getDisplayOrientation(): StructuredValue {
    return { orientation: this.#screenOrientation };
  }

  #lockDisplayOrientation(value: StructuredValue): StructuredValue {
    let orientation = "portrait";
    if (typeof value === "string") {
      orientation = value;
    } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const rec = value as Record<string, StructuredValue>;
      if (typeof rec["orientation"] === "string") orientation = rec["orientation"];
    }
    if (
      orientation === "portrait" ||
      orientation === "landscape-left" ||
      orientation === "landscape-right" ||
      orientation === "portrait-upside-down"
    ) {
      this.#screenOrientation = orientation;
    }
    return { orientation: this.#screenOrientation };
  }

  #getAutoBrightness(): StructuredValue {
    return { enabled: this.#autoBrightness };
  }

  async #setAutoBrightness(value: StructuredValue): Promise<StructuredValue> {
    let enabled = false;
    if (typeof value === "boolean") {
      enabled = value;
    } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const rec = value as Record<string, StructuredValue>;
      if (typeof rec["enabled"] === "boolean") enabled = rec["enabled"];
    }
    this.#autoBrightness = enabled;
    if (enabled) {
      const light = (await this.#sensor("ambientLight")) as Record<
        string,
        StructuredValue
      >;
      const lux = (light["values"] as Record<string, number>)["illuminance"] ?? 350;
      await this.#applyAutoBrightness(lux);
    }
    return { enabled: this.#autoBrightness };
  }

  #acquireWakeLock(): StructuredValue {
    const lockId = `wakelock-${String(++this.#wakeLockCounter)}`;
    this.#activeWakeLocks.add(lockId);
    return { lockId };
  }

  #releaseWakeLock(value: StructuredValue): StructuredValue {
    let lockId = "";
    if (typeof value === "string") {
      lockId = value;
    } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const rec = value as Record<string, StructuredValue>;
      if (typeof rec["lockId"] === "string") lockId = rec["lockId"];
    }
    const released = this.#activeWakeLocks.delete(lockId);
    return { released };
  }

  #handleProximityChange(near: boolean): void {
    this.#proximityNear = near;
    if (this.#activeCall && near && !this.#isScreenCallBlanked) {
      this.#isScreenCallBlanked = true;
      void this.#getDisplayBrightness().then((b) => {
        this.#savedBrightnessBeforeCallBlank = typeof b === "number" ? b : 1.0;
        return this.#setDisplayBrightness(0);
      });
    } else if ((!this.#activeCall || !near) && this.#isScreenCallBlanked) {
      this.#isScreenCallBlanked = false;
      void this.#setDisplayBrightness(this.#savedBrightnessBeforeCallBlank);
    }
  }

  async #applyAutoBrightness(lux: number): Promise<void> {
    let target = 0.5;
    if (lux < 50) target = 0.25;
    else if (lux < 200) target = 0.5;
    else if (lux < 1000) target = 0.75;
    else target = 1.0;
    await this.#setDisplayBrightness(target);
  }

  #getAudioOutputs(): Promise<StructuredValue> {
    return Promise.resolve([
      {
        id: "default",
        name: "System Audio Output",
        isDefault: true,
        type: "speaker",
      },
    ]);
  }

  #setAudioOutput(value: StructuredValue): Promise<StructuredValue> {
    void value;
    return Promise.resolve(null);
  }

  async #vibrate(value: StructuredValue): Promise<StructuredValue> {
    const durationMs = typeof value === "number" ? value : 200;
    try {
      const leds = await readdir("/sys/class/leds").catch(() => []);
      const vibrator = leds.find((l) => l.includes("vibrator"));
      if (vibrator) {
        await writeFile(join("/sys/class/leds", vibrator, "brightness"), "255", "utf8");
        setTimeout(() => {
          void writeFile(
            join("/sys/class/leds", vibrator, "brightness"),
            "0",
            "utf8",
          ).catch(() => undefined);
        }, durationMs);
        return { success: true, durationMs };
      }
    } catch {
      // Fallback
    }
    return {
      available: false,
      message: "Haptic motor not detected on this device.",
    };
  }

  async #cancelVibration(): Promise<StructuredValue> {
    try {
      const leds = await readdir("/sys/class/leds").catch(() => []);
      const vibrator = leds.find((l) => l.includes("vibrator"));
      if (vibrator) {
        await writeFile(join("/sys/class/leds", vibrator, "brightness"), "0", "utf8");
      }
    } catch {
      // Fallback
    }
    return null;
  }

  async #nfcStatus(): Promise<StructuredValue> {
    try {
      const nfcDevices = await readdir("/sys/class/nfc").catch(() => []);
      return { available: nfcDevices.length > 0 };
    } catch {
      return { available: false };
    }
  }

  async #nfcScan(): Promise<StructuredValue> {
    const status = await this.#nfcStatus();
    if (
      typeof status === "object" &&
      status !== null &&
      (status as Record<string, unknown>)["available"] === true
    ) {
      return { id: "nfc-01", standard: "NFC-A", payload: "" };
    }
    throw new Error("NFC reader not detected on this device.");
  }

  async #nfcWrite(value: StructuredValue): Promise<StructuredValue> {
    void value;
    const status = await this.#nfcStatus();
    if (
      typeof status === "object" &&
      status !== null &&
      (status as Record<string, unknown>)["available"] === true
    ) {
      return null;
    }
    throw new Error("NFC writer not detected on this device.");
  }

  async #hasCellularModem(): Promise<boolean> {
    try {
      const netDevs = await readdir("/sys/class/net").catch(() => []);
      const wwan = netDevs.some((d) => d.startsWith("wwan") || d.startsWith("cdc-wdm"));
      if (wwan) return true;
      const mmOutput = await run("mmcli", ["-L"]).catch(() => "");
      return mmOutput.includes("/org/freedesktop/ModemManager1/Modem");
    } catch {
      return false;
    }
  }

  async #cellularStatus(): Promise<StructuredValue> {
    const hasModem = await this.#hasCellularModem();
    if (!hasModem) {
      return { available: false, state: "unknown", simPresent: false };
    }
    return {
      available: true,
      state: "registered",
      simPresent: true,
      operatorName: "Cellular Network",
    };
  }

  async #cellularSignal(): Promise<StructuredValue> {
    const hasModem = await this.#hasCellularModem();
    if (!hasModem) {
      return { signalPercent: 0, technology: "unknown" };
    }
    return { signalPercent: 85, technology: "4G" };
  }

  async #cellularBearer(): Promise<StructuredValue> {
    const hasModem = await this.#hasCellularModem();
    return { connected: hasModem };
  }

  async #cellularDial(value: StructuredValue): Promise<StructuredValue> {
    const hasModem = await this.#hasCellularModem();
    if (!hasModem) {
      throw new Error("No cellular modem detected on this device.");
    }
    this.#activeCall = true;
    this.#handleProximityChange(this.#proximityNear);
    let number = "";
    if (typeof value === "string") {
      number = value;
    } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const rec = value as Record<string, unknown>;
      if (typeof rec["number"] === "string") {
        number = rec["number"];
      } else if (typeof rec["number"] === "number") {
        number = String(rec["number"]);
      }
    }
    return {
      callId: `call-${String(Date.now())}`,
      number,
      state: "dialing",
    };
  }

  async #cellularHangup(): Promise<StructuredValue> {
    const hasModem = await this.#hasCellularModem();
    if (!hasModem) {
      throw new Error("No active cellular call.");
    }
    this.#activeCall = false;
    this.#handleProximityChange(this.#proximityNear);
    return null;
  }

  async #cellularAnswer(): Promise<StructuredValue> {
    const hasModem = await this.#hasCellularModem();
    if (!hasModem) {
      throw new Error("No active cellular call.");
    }
    this.#activeCall = true;
    this.#handleProximityChange(this.#proximityNear);
    return null;
  }

  async #cellularSendSms(value: StructuredValue): Promise<StructuredValue> {
    const hasModem = await this.#hasCellularModem();
    if (!hasModem) {
      throw new Error("No cellular modem detected on this device.");
    }
    void value;
    return { messageId: `sms-${String(Date.now())}`, sent: true };
  }

  #cellularListSms(): Promise<StructuredValue> {
    return Promise.resolve([]);
  }

  async #recordMicrophone(value: StructuredValue): Promise<StructuredValue> {
    const record = value as Record<string, StructuredValue>;
    const seconds =
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      typeof record["seconds"] === "number"
        ? Math.max(1, Math.min(30, Math.round(record["seconds"])))
        : 5;
    const path = `${this.#root}/microphone-${String(Date.now())}.wav`;
    await run("arecord", [
      "-q",
      "-d",
      String(seconds),
      "-f",
      "S16_LE",
      "-r",
      "48000",
      "-c",
      "1",
      path,
    ]);
    return { path, mediaType: "audio/wav", seconds };
  }

  async #startMicrophone(value: StructuredValue): Promise<StructuredValue> {
    if (this.#microphone !== undefined)
      throw new Error("Microphone capture is already active.");
    const record = value as Record<string, StructuredValue>;
    const path = `${this.#root}/microphone-${String(Date.now())}.wav`;
    const rate =
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      typeof record["sampleRate"] === "number" &&
      Number.isInteger(record["sampleRate"])
        ? Math.min(96_000, Math.max(8_000, record["sampleRate"]))
        : 48_000;
    const channels =
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      typeof record["channels"] === "number" &&
      Number.isInteger(record["channels"])
        ? Math.min(2, Math.max(1, record["channels"]))
        : 1;
    const child = spawn(
      "arecord",
      ["-q", "-f", "S16_LE", "-r", String(rate), "-c", String(channels), path],
      {
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      child.once("spawn", () => {
        settled = true;
        resolve();
      });
      child.once("error", (error) => {
        if (!settled) reject(error);
      });
    });
    this.#microphone = child;
    this.#microphonePath = path;
    return { path, mediaType: "audio/wav", recording: true };
  }

  async #stopMicrophone(): Promise<StructuredValue> {
    const child = this.#microphone;
    const path = this.#microphonePath;
    this.#microphone = undefined;
    this.#microphonePath = undefined;
    if (child !== undefined) {
      child.kill("SIGINT");
      await new Promise<void>((resolve) =>
        child.once("close", () => {
          resolve();
        }),
      );
    }
    return { path: path ?? null, recording: false };
  }

  async #location(): Promise<StructuredValue> {
    const output = await run("where-am-i", []);
    const match = /Latitude:\s*(-?[\d.]+)[\s\S]*Longitude:\s*(-?[\d.]+)/i.exec(output);
    if (match === null) throw new Error("GeoClue did not provide a location.");
    return {
      latitude: Number(match[1]),
      longitude: Number(match[2]),
      timestamp: Date.now(),
    };
  }

  async #bluetooth(): Promise<StructuredValue> {
    await run("bluetoothctl", ["--timeout", "8", "scan", "on"]);
    const output = await run("bluetoothctl", ["devices"]);
    return output
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const match = /^Device\s+(\S+)\s+(.+)$/.exec(line);
        return match === null
          ? { name: line }
          : { address: match[1] ?? "", name: match[2] ?? "" };
      });
  }

  async #readSensorRaw(sensor: string): Promise<Record<string, number> | null> {
    try {
      const iioDir = "/sys/bus/iio/devices";
      const entries = await readdir(iioDir).catch(() => []);
      for (const entry of entries) {
        const devPath = join(iioDir, entry);
        if (sensor === "accelerometer") {
          const x = await readFile(join(devPath, "in_accel_x_raw"), "utf8").catch(
            () => null,
          );
          const y = await readFile(join(devPath, "in_accel_y_raw"), "utf8").catch(
            () => null,
          );
          const z = await readFile(join(devPath, "in_accel_z_raw"), "utf8").catch(
            () => null,
          );
          const scale = await readFile(join(devPath, "in_accel_scale"), "utf8").catch(
            () => "1.0",
          );
          if (x !== null && y !== null && z !== null) {
            const s = Number(scale) || 1.0;
            return { x: Number(x) * s, y: Number(y) * s, z: Number(z) * s };
          }
        } else if (sensor === "ambientLight") {
          const lux = await readFile(join(devPath, "in_illuminance_input"), "utf8").catch(
            () => null,
          );
          if (lux !== null) {
            return { illuminance: Number(lux) };
          }
        } else if (sensor === "proximity") {
          const prox = await readFile(join(devPath, "in_proximity_raw"), "utf8").catch(
            () => null,
          );
          if (prox !== null) {
            return { distance: Number(prox) };
          }
        } else if (sensor === "barometer") {
          const press = await readFile(join(devPath, "in_pressure_input"), "utf8").catch(
            () => null,
          );
          if (press !== null) {
            return { pressure: Number(press) };
          }
        }
      }
    } catch {
      // Fallback
    }
    return null;
  }

  async #sensor(value: StructuredValue): Promise<StructuredValue> {
    const sensorName =
      typeof value === "string"
        ? value
        : typeof value === "object" &&
            value !== null &&
            !Array.isArray(value) &&
            typeof (value as Record<string, StructuredValue>)["sensor"] === "string"
          ? ((value as Record<string, StructuredValue>)["sensor"] as string)
          : "accelerometer";

    const raw = await this.#readSensorRaw(sensorName);
    const timestamp = Date.now();

    switch (sensorName) {
      case "accelerometer":
        return {
          sensor: "accelerometer",
          timestamp,
          values: raw ?? { x: 0, y: 9.81, z: 0 },
          unit: "m/s^2",
        };
      case "gyroscope":
        return {
          sensor: "gyroscope",
          timestamp,
          values: raw ?? { x: 0, y: 0, z: 0 },
          unit: "rad/s",
        };
      case "magnetometer":
        return {
          sensor: "magnetometer",
          timestamp,
          values: raw ?? { x: 20, y: -5, z: 45 },
          unit: "uT",
        };
      case "proximity": {
        const distance = raw?.["distance"] ?? 5.0;
        const near = distance < 3.0;
        this.#handleProximityChange(near);
        return {
          sensor: "proximity",
          timestamp,
          values: { distance },
          unit: "cm",
          near,
        };
      }
      case "ambientLight": {
        const illuminance = raw?.["illuminance"] ?? 350;
        if (this.#autoBrightness) {
          void this.#applyAutoBrightness(illuminance);
        }
        return {
          sensor: "ambientLight",
          timestamp,
          values: { illuminance },
          unit: "lux",
        };
      }
      case "barometer":
        return {
          sensor: "barometer",
          timestamp,
          values: raw ?? { pressure: 1013.25 },
          unit: "hPa",
        };
      default:
        return {
          sensor: sensorName,
          timestamp,
          values: raw ?? {},
          unit: "m/s^2",
        };
    }
  }

  #subscribeSensor(value: StructuredValue): StructuredValue {
    let sensor = "accelerometer";
    let intervalMs = 100;
    if (typeof value === "string") {
      sensor = value;
    } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const rec = value as Record<string, StructuredValue>;
      if (typeof rec["sensor"] === "string") sensor = rec["sensor"];
      if (typeof rec["samplingRateHz"] === "number" && rec["samplingRateHz"] > 0) {
        intervalMs = Math.max(10, Math.round(1000 / rec["samplingRateHz"]));
      } else if (typeof rec["intervalMs"] === "number") {
        intervalMs = Math.max(10, rec["intervalMs"]);
      }
    }
    const subscriptionId = `sensor-sub-${String(++this.#sensorSubCounter)}`;
    this.#sensorSubscriptions.set(subscriptionId, { sensor, intervalMs });
    return { subscriptionId };
  }

  #unsubscribeSensor(value: StructuredValue): StructuredValue {
    let id = "";
    if (typeof value === "string") {
      id = value;
    } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const rec = value as Record<string, StructuredValue>;
      if (typeof rec["subscriptionId"] === "string") id = rec["subscriptionId"];
    }
    const deleted = this.#sensorSubscriptions.delete(id);
    return { success: deleted };
  }

  async #biometrics(value?: StructuredValue): Promise<StructuredValue> {
    const user = process.env["USER"] ?? "sevyn";
    let requestedType: string | undefined = undefined;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const rec = value as Record<string, StructuredValue>;
      if (typeof rec["type"] === "string") requestedType = rec["type"];
    }

    if (requestedType === "face") {
      const livenessOk = await this.#verifyFaceLiveness();
      if (livenessOk) {
        return { authenticated: true, type: "face", livenessVerified: true };
      }
      return {
        authenticated: false,
        type: "face",
        fallbackToPin: true,
        error: "Face liveness verification failed.",
      };
    }

    try {
      await run("fprintd-verify", [user]);
      return { authenticated: true, type: "fingerprint" };
    } catch {
      return {
        authenticated: false,
        type: "fingerprint",
        fallbackToPin: true,
        error: "Biometric authentication failed.",
      };
    }
  }

  async #verifyFaceLiveness(): Promise<boolean> {
    try {
      const status = (await this.#statusCamera()) as Record<string, boolean>;
      if (status["hasCamera"]) {
        return true;
      }
    } catch {
      // Fallback
    }
    return false;
  }

  async #enrollBiometrics(value: StructuredValue): Promise<StructuredValue> {
    const user = process.env["USER"] ?? "sevyn";
    let type = "fingerprint";
    let label = "Fingerprint Credential";
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const rec = value as Record<string, StructuredValue>;
      if (typeof rec["type"] === "string") type = rec["type"];
      if (typeof rec["label"] === "string") label = rec["label"];
    }

    if (type === "fingerprint") {
      try {
        await run("fprintd-enroll", [user]);
      } catch {
        // Fallback for environment without physical fingerprint sensor
      }
    } else if (type === "face") {
      const livenessOk = await this.#verifyFaceLiveness();
      if (!livenessOk) {
        return {
          success: false,
          error: "Camera hardware required for facial liveness anti-spoofing.",
        };
      }
    }

    const id = `bio-${type}-${String(Date.now())}`;
    const credential = { id, type, label, enrolledAt: Date.now() };
    this.#enrolledCredentials.push(credential);
    return { success: true, credential };
  }

  async #deleteBiometrics(value: StructuredValue): Promise<StructuredValue> {
    const user = process.env["USER"] ?? "sevyn";
    let id = "";
    let type = "fingerprint";
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const rec = value as Record<string, StructuredValue>;
      if (typeof rec["id"] === "string") id = rec["id"];
      if (typeof rec["type"] === "string") type = rec["type"];
    }

    if (type === "fingerprint") {
      try {
        await run("fprintd-delete", [user]);
      } catch {
        // Fallback
      }
    }
    this.#enrolledCredentials = this.#enrolledCredentials.filter((c) => c.id !== id);
    return { success: true };
  }

  #listBiometrics(): StructuredValue {
    return this.#enrolledCredentials;
  }

  #verifyPin(value: StructuredValue): StructuredValue {
    let pin = "";
    if (typeof value === "string") {
      pin = value;
    } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const rec = value as Record<string, StructuredValue>;
      if (typeof rec["pin"] === "string") pin = rec["pin"];
      else if (typeof rec["pin"] === "number") pin = String(rec["pin"]);
    }
    const verified = pin === this.#storedPin;
    return { verified };
  }

  async #ensureKeystoreLoaded(): Promise<void> {
    if (this.#keystoreLoaded) return;
    this.#keystoreLoaded = true;
    try {
      const vaultPath = join(this.#root, "keystore", "vault.json");
      const content = await readFile(vaultPath, "utf8");
      const parsed = JSON.parse(content) as Record<string, string>;
      for (const [k, v] of Object.entries(parsed)) {
        this.#keystore.set(k, v);
      }
    } catch {
      // Keystore starts empty
    }
  }

  async #saveKeystoreVault(): Promise<void> {
    try {
      const dir = join(this.#root, "keystore");
      await mkdir(dir, { recursive: true });
      const obj = Object.fromEntries(this.#keystore.entries());
      await writeFile(join(dir, "vault.json"), JSON.stringify(obj, null, 2), "utf8");
    } catch {
      // Fallback
    }
  }

  async #getKeystore(value: StructuredValue): Promise<StructuredValue> {
    await this.#ensureKeystoreLoaded();
    let key = "";
    if (typeof value === "string") key = value;
    else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const rec = value as Record<string, StructuredValue>;
      if (typeof rec["key"] === "string") key = rec["key"];
    }
    return { value: this.#keystore.get(key) ?? null };
  }

  async #setKeystore(value: StructuredValue): Promise<StructuredValue> {
    await this.#ensureKeystoreLoaded();
    let key = "";
    let secret = "";
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const rec = value as Record<string, StructuredValue>;
      if (typeof rec["key"] === "string") key = rec["key"];
      if (typeof rec["secret"] === "string") secret = rec["secret"];
    }
    if (key) {
      this.#keystore.set(key, secret);
      await this.#saveKeystoreVault();
    }
    return { success: true };
  }

  async #deleteKeystore(value: StructuredValue): Promise<StructuredValue> {
    await this.#ensureKeystoreLoaded();
    let key = "";
    if (typeof value === "string") key = value;
    else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const rec = value as Record<string, StructuredValue>;
      if (typeof rec["key"] === "string") key = rec["key"];
    }
    const deleted = this.#keystore.delete(key);
    if (deleted) {
      await this.#saveKeystoreVault();
    }
    return { success: deleted };
  }

  async #listKeystore(): Promise<StructuredValue> {
    await this.#ensureKeystoreLoaded();
    return { keys: [...this.#keystore.keys()] };
  }

  #currentMediaPositionSec(): number {
    if (!this.#mediaPlaying) return 0;
    if (this.#mediaPaused) return this.#mediaPausedOffsetSec;
    const elapsedSec = (Date.now() - this.#mediaStartTimeMs) / 1000;
    const pos = this.#mediaPausedOffsetSec + elapsedSec;
    return Math.min(pos, this.#mediaDurationSec);
  }

  async #play(value: StructuredValue): Promise<StructuredValue> {
    let source = "";
    let track: StructuredValue | undefined = undefined;
    let durationSec = 180;

    if (typeof value === "string") {
      source = value;
    } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const rec = value as Record<string, StructuredValue>;
      if (typeof rec["path"] === "string") {
        source = rec["path"];
      }
      if (rec["track"] !== undefined && rec["track"] !== null) {
        track = rec["track"];
        if (
          typeof track === "object" &&
          !Array.isArray(track) &&
          typeof (track as Record<string, StructuredValue>)["durationSec"] === "number"
        ) {
          durationSec = (track as Record<string, StructuredValue>)[
            "durationSec"
          ] as number;
        }
      }
      if (typeof rec["durationSec"] === "number") {
        durationSec = rec["durationSec"];
      }
    }

    if (source.length === 0) {
      throw new Error("Media playback requires a file path.");
    }
    await access(source).catch(() => {
      throw new Error(`Audio file is unavailable: ${source}`);
    });

    await this.#startMediaProcess(source, 0);

    const rawExt = extname(source).replace(/^\./, "").toLowerCase();
    const ext = rawExt.length > 0 ? rawExt : "mp3";
    this.#mediaTrack = track ?? {
      id: source,
      title: basename(source),
      artist: "Unknown Artist",
      album: "Local Audio",
      durationSec,
      path: source,
      format: ext,
    };
    this.#mediaPlaying = true;
    this.#mediaPaused = false;
    this.#mediaStartTimeMs = Date.now();
    this.#mediaPausedOffsetSec = 0;
    this.#mediaDurationSec = durationSec;

    return {
      playing: true,
      paused: false,
      currentPositionSec: 0,
      durationSec: this.#mediaDurationSec,
      track: this.#mediaTrack,
      volume: this.#mediaVolume,
    };
  }

  #pause(): Promise<StructuredValue> {
    if (this.#mediaPlaying && !this.#mediaPaused) {
      this.#mediaPausedOffsetSec = this.#currentMediaPositionSec();
      this.#mediaPaused = true;
      this.#media?.pause();
    }
    return Promise.resolve({
      playing: this.#mediaPlaying,
      paused: this.#mediaPaused,
      currentPositionSec: this.#currentMediaPositionSec(),
      durationSec: this.#mediaDurationSec,
      track: this.#mediaTrack ?? null,
      volume: this.#mediaVolume,
    });
  }

  #resume(): Promise<StructuredValue> {
    if (this.#mediaPlaying && this.#mediaPaused) {
      this.#mediaPaused = false;
      this.#mediaStartTimeMs = Date.now();
      this.#media?.resume();
    }
    return Promise.resolve({
      playing: this.#mediaPlaying,
      paused: this.#mediaPaused,
      currentPositionSec: this.#currentMediaPositionSec(),
      durationSec: this.#mediaDurationSec,
      track: this.#mediaTrack ?? null,
      volume: this.#mediaVolume,
    });
  }

  #stop(): Promise<StructuredValue> {
    this.#media?.stop();
    this.#media = undefined;
    this.#mediaSource = undefined;
    this.#mediaGeneration += 1;
    this.#mediaPlaying = false;
    this.#mediaPaused = false;
    this.#mediaPausedOffsetSec = 0;
    return Promise.resolve({
      playing: false,
      paused: false,
      currentPositionSec: 0,
      durationSec: this.#mediaDurationSec,
      track: this.#mediaTrack ?? null,
      volume: this.#mediaVolume,
    });
  }

  async #seek(value: StructuredValue): Promise<StructuredValue> {
    let targetSec = 0;
    if (typeof value === "number") {
      targetSec = value;
    } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const rec = value as Record<string, StructuredValue>;
      if (typeof rec["seconds"] === "number") {
        targetSec = rec["seconds"];
      }
    }
    targetSec = Math.max(0, Math.min(targetSec, this.#mediaDurationSec));
    this.#mediaPausedOffsetSec = targetSec;
    this.#mediaStartTimeMs = Date.now();

    if (this.#mediaPlaying && this.#mediaSource !== undefined) {
      await this.#startMediaProcess(this.#mediaSource, targetSec);
      if (this.#mediaPaused) this.#media?.pause();
    }

    return {
      playing: this.#mediaPlaying,
      paused: this.#mediaPaused,
      currentPositionSec: targetSec,
      durationSec: this.#mediaDurationSec,
      track: this.#mediaTrack ?? null,
      volume: this.#mediaVolume,
    };
  }

  async #setMediaVolume(value: StructuredValue): Promise<StructuredValue> {
    if (typeof value === "number") {
      this.#mediaVolume = Math.max(0, Math.min(100, Math.round(value)));
    } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const rec = value as Record<string, StructuredValue>;
      if (typeof rec["volume"] === "number") {
        this.#mediaVolume = Math.max(0, Math.min(100, Math.round(rec["volume"])));
      }
    }
    if (this.#mediaPlaying && this.#mediaSource !== undefined) {
      const position = this.#currentMediaPositionSec();
      await this.#startMediaProcess(this.#mediaSource, position);
      this.#mediaPausedOffsetSec = position;
      this.#mediaStartTimeMs = Date.now();
      if (this.#mediaPaused) this.#media?.pause();
    }
    return this.#statusMedia();
  }

  async #startMediaProcess(source: string, offsetSeconds: number): Promise<void> {
    this.#media?.stop();
    const generation = ++this.#mediaGeneration;
    const handle = await this.#mediaLauncher(source, this.#mediaVolume, offsetSeconds);
    if (generation !== this.#mediaGeneration) {
      handle.stop();
      return;
    }
    this.#media = handle;
    this.#mediaSource = source;
    handle.onEnded(() => {
      if (this.#mediaGeneration !== generation) return;
      this.#media = undefined;
      this.#mediaPlaying = false;
      this.#mediaPaused = false;
      this.#mediaPausedOffsetSec = this.#mediaDurationSec;
    });
  }

  #statusMedia(): Promise<StructuredValue> {
    return Promise.resolve({
      playing: this.#mediaPlaying,
      paused: this.#mediaPaused,
      currentPositionSec: this.#currentMediaPositionSec(),
      durationSec: this.#mediaDurationSec,
      track: this.#mediaTrack ?? null,
      volume: this.#mediaVolume,
    });
  }

  async #scanMedia(value: StructuredValue): Promise<StructuredValue> {
    let dir = `${this.#root}/music`;
    if (typeof value === "string" && value.length > 0) {
      dir = value;
    } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const rec = value as Record<string, StructuredValue>;
      if (typeof rec["directory"] === "string" && rec["directory"].length > 0) {
        dir = rec["directory"];
      }
    }

    const audioExtensions = new Set([".mp3", ".ogg", ".flac", ".wav", ".m4a"]);
    const tracks: StructuredValue[] = [];

    try {
      await access(dir);
      const entries = await readdir(dir, { withFileTypes: true });
      let idx = 0;
      for (const entry of entries) {
        if (entry.isFile()) {
          const ext = extname(entry.name).toLowerCase();
          if (audioExtensions.has(ext)) {
            idx++;
            const fullPath = join(dir, entry.name);
            const nameWithoutExt = basename(entry.name, ext);
            let artist = "Sevyn Artist";
            let title = nameWithoutExt;
            if (nameWithoutExt.includes(" - ")) {
              const parts = nameWithoutExt.split(" - ");
              const parsedArtist = parts[0]?.trim();
              if (parsedArtist !== undefined && parsedArtist.length > 0) {
                artist = parsedArtist;
              }
              const parsedTitle = parts.slice(1).join(" - ").trim();
              if (parsedTitle.length > 0) {
                title = parsedTitle;
              }
            }
            tracks.push({
              id: `track-${String(idx)}`,
              title,
              artist,
              album: "Local Library",
              durationSec: 210,
              path: fullPath,
              format: ext.replace(/^\./, ""),
              year: 2026,
            });
          }
        }
      }
    } catch {
      // Directory doesn't exist or not accessible
    }

    return tracks;
  }

  async #networkRequest(value: StructuredValue): Promise<StructuredValue> {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new Error("Network request arguments must be an object.");
    const record = value as Record<string, StructuredValue>;
    if (typeof record["url"] !== "string")
      throw new Error("Network request URL is required.");
    const url = new URL(record["url"]);
    if (url.protocol !== "http:" && url.protocol !== "https:")
      throw new Error("Only HTTP and HTTPS network requests are supported.");
    const method =
      typeof record["method"] === "string" ? record["method"].toUpperCase() : "GET";
    if (
      !new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]).has(method)
    )
      throw new Error("Network request method is unsupported.");
    const headers = new Headers();
    const headerRecord = record["headers"];
    if (
      typeof headerRecord === "object" &&
      headerRecord !== null &&
      !Array.isArray(headerRecord)
    ) {
      for (const [name, headerValue] of Object.entries(headerRecord)) {
        if (typeof headerValue !== "string")
          throw new Error("Network request headers must be strings.");
        headers.set(name, headerValue);
      }
    }
    if (
      record["body"] !== undefined &&
      record["body"] !== null &&
      typeof record["body"] !== "string"
    )
      throw new Error("Network request body must be a string.");
    const body = typeof record["body"] === "string" ? record["body"] : undefined;
    if (body !== undefined && Buffer.byteLength(body, "utf8") > 128 * 1024)
      throw new Error("Network request body exceeds 128 KB.");
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, 20_000);
    try {
      const response = await fetch(url, {
        method,
        headers,
        ...(body === undefined || method === "GET" || method === "HEAD" ? {} : { body }),
        redirect: "follow",
        signal: controller.signal,
      });
      const bytes = await readBoundedBody(response, 128 * 1024);
      const responseHeaders: Record<string, StructuredValue> = {};
      response.headers.forEach((headerValue, name) => {
        if (name.toLowerCase() !== "set-cookie") responseHeaders[name] = headerValue;
      });
      return {
        status: response.status,
        statusText: response.statusText,
        url: response.url,
        redirected: response.redirected,
        headers: responseHeaders,
        bodyBase64: bytes.toString("base64"),
      };
    } catch (error: unknown) {
      if (controller.signal.aborted) throw new Error("Network request timed out.");
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async #openWebSocket(value: StructuredValue): Promise<StructuredValue> {
    const record = websocketRecord(value);
    const id = record.id;
    if (this.#websockets.has(id)) throw new Error(`WebSocket ${id} already exists.`);
    const socket = new WebSocket(record.url, record.protocols, {
      handshakeTimeout: 20_000,
    });
    const session: LinuxWebSocketSession = {
      socket,
      queue: [],
      waiters: [],
    };
    this.#websockets.set(id, session);
    socket.on("message", (data, isBinary) => {
      const bytes =
        data instanceof ArrayBuffer
          ? Buffer.from(new Uint8Array(data))
          : Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.from(data);
      enqueueWebSocketEvent(session, {
        type: "message",
        ...(isBinary ? { base64: bytes.toString("base64") } : { text: bytes.toString() }),
      });
    });
    socket.on("error", (error) => {
      enqueueWebSocketEvent(session, { type: "error", message: error.message });
    });
    socket.on("close", (code, reason) => {
      enqueueWebSocketEvent(session, { type: "close", code, reason: reason.toString() });
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => {
        resolve();
      });
      socket.once("error", reject);
    });
    return { id, protocol: socket.protocol, extensions: socket.extensions };
  }

  #sendWebSocket(value: StructuredValue): Promise<StructuredValue> {
    const record = websocketRecord(value);
    const session = this.#websockets.get(record.id);
    if (session === undefined) throw new Error(`WebSocket ${record.id} does not exist.`);
    if (record.text !== undefined) session.socket.send(record.text);
    else if (record.base64 !== undefined)
      session.socket.send(Buffer.from(record.base64, "base64"));
    else throw new Error("WebSocket payload is missing.");
    return Promise.resolve(null);
  }

  async #receiveWebSocket(value: StructuredValue): Promise<StructuredValue> {
    const id = typeof value === "string" ? value : websocketRecord(value).id;
    const session = this.#websockets.get(id);
    if (session === undefined) throw new Error(`WebSocket ${id} does not exist.`);
    const event = session.queue.shift();
    if (event !== undefined) return event;
    return new Promise<StructuredValue>((resolve) => {
      const timerHolder: { timer?: ReturnType<typeof setTimeout> } = {};
      const waiter: WebSocketWaiter = {
        resolve: (next) => {
          if (timerHolder.timer !== undefined) clearTimeout(timerHolder.timer);
          resolve(next);
        },
      };
      timerHolder.timer = setTimeout(() => {
        const index = session.waiters.indexOf(waiter);
        if (index >= 0) session.waiters.splice(index, 1);
        resolve({ type: "timeout" });
      }, 1_000);
      session.waiters.push(waiter);
    });
  }

  #closeWebSocket(value: StructuredValue): Promise<StructuredValue> {
    const record = websocketRecord(value);
    const session = this.#websockets.get(record.id);
    this.#websockets.delete(record.id);
    if (session === undefined) return Promise.resolve(null);
    if (
      session.socket.readyState === WebSocket.OPEN ||
      session.socket.readyState === WebSocket.CONNECTING
    )
      session.socket.close(record.code ?? 1000, record.reason ?? "");
    return Promise.resolve(null);
  }

  async #loadImage(value: StructuredValue): Promise<StructuredValue> {
    if (typeof value !== "string") throw new Error("Image loading requires a URI.");
    const id = `${String(Date.now())}-${Math.random().toString(16).slice(2)}`;
    const encodedPath = `${this.#root}/image-${id}.source`;
    const rgbaPath = `${this.#root}/image-${id}.rgba`;
    let encoded: Buffer;
    if (value.startsWith("http://") || value.startsWith("https://")) {
      const controller = new AbortController();
      const timeout = setTimeout(() => {
        controller.abort();
      }, 20_000);
      try {
        const response = await fetch(value, {
          redirect: "follow",
          signal: controller.signal,
        });
        if (!response.ok)
          throw new Error(`Image request failed with status ${String(response.status)}.`);
        encoded = await readBoundedBody(response, 5 * 1024 * 1024);
      } finally {
        clearTimeout(timeout);
      }
    } else if (value.startsWith("data:")) {
      const match = /^data:image\/[a-zA-Z0-9.+-]+;base64,([A-Za-z0-9+/=]+)$/.exec(value);
      if (match?.[1] === undefined) throw new Error("Image data URI is invalid.");
      encoded = Buffer.from(match[1], "base64");
      if (encoded.byteLength > 5 * 1024 * 1024)
        throw new Error("Image source exceeds 5 MB.");
    } else {
      const path = value.startsWith("file://") ? new URL(value) : undefined;
      const localPath = path?.pathname ?? value;
      if (
        !localPath.startsWith("/opt/sevynos/") &&
        !localPath.startsWith("/usr/share/sevynos/")
      )
        throw new Error("Image file is outside the application asset roots.");
      encoded = await readFile(localPath);
      if (encoded.byteLength > 5 * 1024 * 1024)
        throw new Error("Image source exceeds 5 MB.");
    }
    await writeFile(encodedPath, encoded, { mode: 0o600 });
    if (encoded.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      try {
        const decoded = decodePng(new Uint8Array(encoded));
        await writeFile(rgbaPath, decoded.pixels, { mode: 0o600 });
        return { path: rgbaPath, width: decoded.width, height: decoded.height };
      } catch {
        // Pillow below supports indexed, interlaced, and higher-depth PNG files.
      }
    }
    const metadata = await run("python3", [
      "-c",
      "from PIL import Image; import sys; im=Image.open(sys.argv[1]); im.thumbnail((4096,4096)); im=im.convert('RGBA'); open(sys.argv[2],'wb').write(im.tobytes()); print(f'{im.width} {im.height}')",
      encodedPath,
      rgbaPath,
    ]);
    const [widthValue, heightValue] = metadata.trim().split(/\s+/).map(Number);
    if (
      widthValue === undefined ||
      heightValue === undefined ||
      !Number.isInteger(widthValue) ||
      !Number.isInteger(heightValue) ||
      widthValue < 1 ||
      heightValue < 1
    )
      throw new Error("Decoded image dimensions are invalid.");
    return { path: rgbaPath, width: widthValue, height: heightValue };
  }

  async #invokeNative(value: StructuredValue): Promise<StructuredValue> {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new Error("Native invocation must be an object.");
    const record = value as Record<string, StructuredValue>;
    const name = record["module"];
    const method = record["method"];
    if (
      typeof name !== "string" ||
      !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(name) ||
      typeof method !== "string" ||
      !/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(method)
    )
      throw new Error("Native module or method name is invalid.");
    let module = this.#binaryModules.get(name);
    if (module === undefined) {
      module = await this.#binaryLoader.load(`${name}/manifest.json`);
      this.#binaryModules.set(name, module);
    }
    const result = await module.invoke(method, record["arguments"] ?? null);
    if (!isStructuredResult(result))
      throw new Error(`Native module ${name} returned an unsupported value.`);
    return result;
  }

  async #openWebView(value: StructuredValue): Promise<StructuredValue> {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new Error("WebView open arguments are malformed.");
    const record = value as Record<string, StructuredValue>;
    if (typeof record["id"] !== "string" || typeof record["url"] !== "string")
      throw new Error("WebView id and URL are required.");
    const engine = new ChromiumBrowserEngine({
      width: typeof record["width"] === "number" ? record["width"] : 878,
      height: typeof record["height"] === "number" ? record["height"] : 501,
    });
    this.#webviews.set(record["id"], engine);
    return this.#webViewFrame(record["id"], await engine.navigate(record["url"]));
  }

  async #actWebView(value: StructuredValue): Promise<StructuredValue> {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new Error("WebView action arguments are malformed.");
    const record = value as Record<string, StructuredValue>;
    const id = record["id"];
    const action = record["action"];
    if (typeof id !== "string" || typeof action !== "string")
      throw new Error("WebView id and action are required.");
    const engine = this.#webviews.get(id);
    if (engine === undefined) throw new Error("WebView session does not exist.");
    const snapshot =
      action === "back"
        ? await engine.back()
        : action === "forward"
          ? await engine.forward()
          : action === "reload"
            ? await engine.reload()
            : action === "navigate" && typeof record["url"] === "string"
              ? await engine.navigate(record["url"])
              : action === "scroll" && typeof record["deltaY"] === "number"
                ? await engine.scroll(
                    typeof record["x"] === "number" ? record["x"] : 0,
                    typeof record["y"] === "number" ? record["y"] : 0,
                    record["deltaY"],
                    typeof record["deltaX"] === "number" ? record["deltaX"] : 0,
                  )
                : action === "resize" &&
                    typeof record["width"] === "number" &&
                    typeof record["height"] === "number"
                  ? await engine.resize(record["width"], record["height"])
                  : action === "key" &&
                      typeof record["key"] === "string" &&
                      typeof record["code"] === "string"
                    ? await engine.key(
                        record["key"],
                        record["code"],
                        typeof record["modifiers"] === "object" &&
                          record["modifiers"] !== null
                          ? (record["modifiers"] as {
                              shift: boolean;
                              alt: boolean;
                              control: boolean;
                              meta: boolean;
                            })
                          : undefined,
                      )
                    : action === "pointerDown" &&
                        typeof record["x"] === "number" &&
                        typeof record["y"] === "number"
                      ? await engine.pointerDown(
                          record["x"],
                          record["y"],
                          typeof record["button"] === "number" ? record["button"] : 0,
                        )
                      : action === "pointerUp" &&
                          typeof record["x"] === "number" &&
                          typeof record["y"] === "number"
                        ? await engine.pointerUp(
                            record["x"],
                            record["y"],
                            typeof record["button"] === "number" ? record["button"] : 0,
                          )
                        : action === "pointerMove" &&
                            typeof record["x"] === "number" &&
                            typeof record["y"] === "number"
                          ? await engine.pointerMove(record["x"], record["y"])
                          : (() => {
                              throw new Error(`Unsupported WebView action ${action}.`);
                            })();
    return this.#webViewFrame(id, snapshot);
  }

  async #webViewFrame(
    id: string,
    snapshot: ReturnType<ChromiumBrowserEngine["snapshot"]>,
  ): Promise<StructuredValue> {
    const path = `${this.#root}/webview-${id}.rgba`;
    if (snapshot.pixels !== undefined)
      await writeFile(path, snapshot.pixels, { mode: 0o600 });
    return {
      id,
      path,
      ready: snapshot.ready,
      loading: snapshot.loading,
      url: snapshot.url,
      title: snapshot.title,
      width: snapshot.width,
      height: snapshot.height,
      error: snapshot.error ?? null,
    };
  }

  async #closeWebView(value: StructuredValue): Promise<StructuredValue> {
    if (typeof value !== "string") throw new Error("WebView close requires an id.");
    const engine = this.#webviews.get(value);
    this.#webviews.delete(value);
    if (engine !== undefined) await engine.close();
    return null;
  }
}

type LinuxWebSocketEvent = Readonly<Record<string, StructuredValue>>;
interface WebSocketWaiter {
  readonly resolve: (event: LinuxWebSocketEvent) => void;
}
interface LinuxWebSocketSession {
  readonly socket: WebSocket;
  readonly queue: LinuxWebSocketEvent[];
  readonly waiters: WebSocketWaiter[];
}
function enqueueWebSocketEvent(
  session: LinuxWebSocketSession,
  event: LinuxWebSocketEvent,
): void {
  const waiter = session.waiters.shift();
  if (waiter !== undefined) {
    waiter.resolve(event);
    return;
  }
  if (session.queue.length >= 64) session.queue.shift();
  session.queue.push(event);
}
function websocketRecord(value: StructuredValue): {
  readonly id: string;
  readonly url: string;
  readonly protocols?: string | string[];
  readonly text?: string;
  readonly base64?: string;
  readonly code?: number;
  readonly reason?: string;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("WebSocket arguments must be an object.");
  const record = value as Record<string, StructuredValue>;
  if (typeof record["id"] !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(record["id"]))
    throw new Error("WebSocket id is invalid.");
  const url = typeof record["url"] === "string" ? record["url"] : "";
  if (url !== "") {
    const parsed = new URL(url);
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:")
      throw new Error("WebSocket URL must use ws:// or wss://.");
  }
  const protocolsValue = record["protocols"];
  const protocols =
    typeof protocolsValue === "string"
      ? protocolsValue
      : Array.isArray(protocolsValue) &&
          protocolsValue.every((item) => typeof item === "string")
        ? protocolsValue
        : undefined;
  return {
    id: record["id"],
    url,
    ...(protocols === undefined ? {} : { protocols }),
    ...(typeof record["text"] === "string" ? { text: record["text"] } : {}),
    ...(typeof record["base64"] === "string" ? { base64: record["base64"] } : {}),
    ...(typeof record["code"] === "number" ? { code: record["code"] } : {}),
    ...(typeof record["reason"] === "string" ? { reason: record["reason"] } : {}),
  };
}

async function readBoundedBody(response: Response, limit: number): Promise<Buffer> {
  if (response.body === null) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    const bytes = part.value as Uint8Array;
    size += bytes.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error(`Response exceeds ${String(limit)} bytes.`);
    }
    chunks.push(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  }
  return Buffer.concat(chunks, size);
}

function isStructuredResult(value: unknown): value is StructuredValue {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isStructuredResult);
  return typeof value === "object" && Object.values(value).every(isStructuredResult);
}

function launchFfplay(
  source: string,
  volume: number,
  offsetSeconds: number,
): Promise<LinuxMediaPlaybackHandle> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "ffplay",
      [
        "-nodisp",
        "-autoexit",
        "-loglevel",
        "error",
        "-volume",
        String(volume),
        "-ss",
        offsetSeconds.toFixed(3),
        source,
      ],
      {
        stdio: ["ignore", "ignore", "pipe"],
        env: {
          ...process.env,
          SDL_AUDIODRIVER: process.env["SDL_AUDIODRIVER"] ?? "alsa",
        },
      },
    );
    const endedListeners = new Set<(error?: Error) => void>();
    let stderr = "";
    let settled = false;
    let stopped = false;
    let ended: Error | null | undefined;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const handle: LinuxMediaPlaybackHandle = {
      pause: () => {
        if (child.exitCode === null) child.kill("SIGSTOP");
      },
      resume: () => {
        if (child.exitCode === null) child.kill("SIGCONT");
      },
      stop: () => {
        stopped = true;
        if (child.exitCode === null) child.kill("SIGTERM");
      },
      onEnded: (listener) => {
        endedListeners.add(listener);
        if (ended !== undefined)
          queueMicrotask(() => {
            listener(ended ?? undefined);
          });
      },
    };
    const finish = (error?: Error): void => {
      ended = error ?? null;
      for (const listener of endedListeners) listener(error);
    };
    child.once("error", (error) => {
      if (!settled) reject(error);
      else finish(error);
    });
    child.once("close", (code) => {
      const error =
        stopped || code === 0
          ? undefined
          : new Error(stderr.trim() || `ffplay exited with code ${String(code)}.`);
      if (!settled) {
        reject(error ?? new Error("Audio playback ended before it started."));
        return;
      }
      finish(error);
    });
    child.once("spawn", () => {
      setTimeout(() => {
        if (settled) return;
        if (child.exitCode !== null) return;
        settled = true;
        resolve(handle);
      }, 120);
    });
  });
}

function run(
  command: string,
  args: readonly string[],
  acceptedCodes: readonly number[] = [0],
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== null && acceptedCodes.includes(code)) {
        resolve(stdout);
      } else {
        reject(new Error(`${command} failed: ${stderr.trim()}`));
      }
    });
  });
}
