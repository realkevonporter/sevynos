import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import type { AudioSnapshot, SevynAudioService } from "@sevynos/react-native/internal";
import {
  alsaCardArgs,
  parseArecordList,
  parsePactlSinkInputs,
  parsePactlSourcesShort,
  parseWpctlSources,
  parseWpctlStreams,
} from "./audio-output-parsers.js";

export interface LinuxAudioServiceOptions {
  readonly cardsPath?: string;
  readonly runCommand?: (command: string, args: readonly string[]) => Promise<string>;
  /**
   * Runs a recorder process for the given duration, then stops it. Used by
   * recordInput(); injectable so tests don't spawn real audio tooling.
   */
  readonly runRecorder?: (
    command: string,
    args: readonly string[],
    durationMs: number,
  ) => Promise<void>;
}

/**
 * A single microphone / capture source exposed by the audio stack.
 */
export interface AudioInputDevice {
  /** Backend-specific identifier (wpctl node id, Pulse source name, ALSA hw id). */
  readonly id: string;
  readonly name: string;
  readonly isDefault: boolean;
  /** Capture volume, 0..100. */
  readonly volume: number;
  readonly muted: boolean;
}

export interface AudioInputSnapshot {
  readonly available: boolean;
  readonly devices: readonly AudioInputDevice[];
  readonly defaultDeviceId: string;
  /** Capture volume of the default source, 0..100. */
  readonly volume: number;
  readonly muted: boolean;
}

/**
 * A single application playback stream (per-app mixer row). Only the
 * PipeWire and PulseAudio backends expose per-application streams; ALSA
 * mixes in hardware and returns an empty list.
 */
export interface AudioPlaybackStream {
  /** Backend-specific stream identifier (wpctl node id, Pulse sink-input index). */
  readonly id: string;
  readonly name: string;
  readonly applicationName: string;
  /** Stream volume, 0..100. */
  readonly volume: number;
  readonly muted: boolean;
}

export interface AudioInputRecordingOptions {
  /** Capture length in seconds, clamped to 1..30. Defaults to 5. */
  readonly seconds?: number;
  /** Sample rate in Hz, clamped to 8000..96000. Defaults to 48000. */
  readonly sampleRate?: number;
  /** Channel count, clamped to 1..2. Defaults to 1. */
  readonly channels?: number;
  /**
   * Capture from this input device (AudioInputDevice.id). PipeWire always
   * records from the default source — call setDefaultInputDevice() first.
   */
  readonly deviceId?: string;
}

export interface AudioInputRecording {
  readonly path: string;
  readonly mediaType: "audio/wav";
  readonly seconds: number;
}

export class LinuxAudioService implements SevynAudioService {
  readonly #options: LinuxAudioServiceOptions;
  readonly #listeners = new Set<() => void>();
  #volume = 0;
  #muted = false;
  #outputDevice = "";
  #hasHeadphones = false;
  #available = false;

  public constructor(options: LinuxAudioServiceOptions = {}) {
    this.#options = options;
  }

  #backend: "pipewire" | "pulse" | "alsa" | undefined;
  #inputBackend: "pipewire" | "pulse" | "alsa" | undefined;

  public async snapshot(): Promise<AudioSnapshot> {
    await this.#queryAudio();
    return Object.freeze({
      available: this.#available,
      volume: this.#volume,
      muted: this.#muted,
      outputDevice: this.#outputDevice,
      hasHeadphones: this.#hasHeadphones,
    });
  }

  public async setVolume(volume: number): Promise<AudioSnapshot> {
    if (!Number.isFinite(volume)) throw new Error("Volume must be finite.");
    const clamped = Math.min(100, Math.max(0, Math.round(volume)));
    await this.#requireOutput();
    if (this.#backend === "pipewire") {
      await this.#runCommand("wpctl", [
        "set-volume",
        "@DEFAULT_AUDIO_SINK@",
        (clamped / 100).toFixed(2),
      ]);
    } else if (this.#backend === "pulse") {
      await this.#runCommand("pactl", [
        "set-sink-volume",
        "@DEFAULT_SINK@",
        `${String(clamped)}%`,
      ]);
    } else {
      await this.#runCommand("amixer", ["set", "Master", `${String(clamped)}%`]);
    }
    this.#volume = clamped;
    const result = await this.snapshot();
    if (!result.available) throw new Error("Audio output became unavailable.");
    if (Math.abs(result.volume - clamped) > 5) throw new Error("Failed to set volume.");
    this.#notify();
    return result;
  }

  public async setMuted(muted: boolean): Promise<AudioSnapshot> {
    await this.#requireOutput();
    if (this.#backend === "pipewire") {
      await this.#runCommand("wpctl", [
        "set-mute",
        "@DEFAULT_AUDIO_SINK@",
        muted ? "1" : "0",
      ]);
    } else if (this.#backend === "pulse") {
      await this.#runCommand("pactl", [
        "set-sink-mute",
        "@DEFAULT_SINK@",
        muted ? "1" : "0",
      ]);
    } else {
      await this.#runCommand("amixer", ["set", "Master", muted ? "mute" : "unmute"]);
    }
    this.#muted = muted;
    const result = await this.snapshot();
    if (!result.available) throw new Error("Audio output became unavailable.");
    if (result.muted !== muted) throw new Error("Failed to set muted state.");
    this.#notify();
    return result;
  }

  #timer: NodeJS.Timeout | undefined;

  /**
   * Captures the current microphone / input state: enumerated sources, the
   * default source, and its volume/mute. App-facing microphone recording is
   * permission-gated at the capability layer (the "microphone" application
   * permission in application-platform.ts); this system service is not
   * reachable from application sandboxes.
   */
  public async inputSnapshot(): Promise<AudioInputSnapshot> {
    await this.#queryInput();
    return Object.freeze({
      available: this.#inputAvailable,
      devices: this.#inputDevices,
      defaultDeviceId: this.#inputDefaultDeviceId,
      volume: this.#inputVolume,
      muted: this.#inputMuted,
    });
  }

  public async listInputDevices(): Promise<readonly AudioInputDevice[]> {
    return (await this.inputSnapshot()).devices;
  }

  public async setInputVolume(
    volume: number,
    deviceId?: string,
  ): Promise<AudioInputSnapshot> {
    if (!Number.isFinite(volume)) throw new Error("Volume must be finite.");
    const clamped = Math.min(100, Math.max(0, Math.round(volume)));
    await this.#requireInput();
    const target = deviceId ?? this.#defaultInputTarget();
    if (this.#inputBackend === "pipewire") {
      await this.#runCommand("wpctl", ["set-volume", target, (clamped / 100).toFixed(2)]);
    } else if (this.#inputBackend === "pulse") {
      await this.#runCommand("pactl", [
        "set-source-volume",
        target,
        `${String(clamped)}%`,
      ]);
    } else {
      const cardArgs = alsaCardArgs(deviceId);
      await this.#runCommand("amixer", [
        ...cardArgs,
        "set",
        "Capture",
        `${String(clamped)}%`,
      ]);
    }
    const result = await this.inputSnapshot();
    if (!result.available) throw new Error("Audio input became unavailable.");
    const changed = result.devices.find(
      (d) => d.id === (deviceId ?? result.defaultDeviceId),
    );
    if (changed !== undefined && Math.abs(changed.volume - clamped) > 5)
      throw new Error("Failed to set input volume.");
    return result;
  }

  public async setInputMuted(
    muted: boolean,
    deviceId?: string,
  ): Promise<AudioInputSnapshot> {
    await this.#requireInput();
    const target = deviceId ?? this.#defaultInputTarget();
    if (this.#inputBackend === "pipewire") {
      await this.#runCommand("wpctl", ["set-mute", target, muted ? "1" : "0"]);
    } else if (this.#inputBackend === "pulse") {
      await this.#runCommand("pactl", ["set-source-mute", target, muted ? "1" : "0"]);
    } else {
      const cardArgs = alsaCardArgs(deviceId);
      await this.#runCommand("amixer", [
        ...cardArgs,
        "set",
        "Capture",
        muted ? "nocap" : "cap",
      ]);
    }
    const result = await this.inputSnapshot();
    if (!result.available) throw new Error("Audio input became unavailable.");
    const changed = result.devices.find(
      (d) => d.id === (deviceId ?? result.defaultDeviceId),
    );
    if (changed !== undefined && changed.muted !== muted)
      throw new Error("Failed to set input muted state.");
    return result;
  }

  public async setDefaultInputDevice(deviceId: string): Promise<AudioInputSnapshot> {
    if (deviceId.trim().length === 0) throw new Error("Device id must not be empty.");
    await this.#requireInput();
    if (this.#inputBackend === "pipewire") {
      await this.#runCommand("wpctl", ["set-default", deviceId]);
    } else if (this.#inputBackend === "pulse") {
      await this.#runCommand("pactl", ["set-default-source", deviceId]);
    } else {
      throw new Error("Selecting the default input is not supported on ALSA.");
    }
    const result = await this.inputSnapshot();
    if (result.defaultDeviceId !== deviceId)
      throw new Error("Failed to select the default input device.");
    return result;
  }

  /**
   * Lists application playback streams for the per-app mixer. Returns an
   * empty list on ALSA, which has no per-application stream concept — callers
   * should surface that honestly rather than fake rows.
   */
  public async listPlaybackStreams(): Promise<readonly AudioPlaybackStream[]> {
    await this.#queryInput();
    if (this.#inputBackend === "pipewire") return this.#listPipeWireStreams();
    if (this.#inputBackend === "pulse") return this.#listPulseStreams();
    return Object.freeze([]);
  }

  public async setStreamVolume(
    streamId: string,
    volume: number,
  ): Promise<readonly AudioPlaybackStream[]> {
    if (!Number.isFinite(volume)) throw new Error("Volume must be finite.");
    const clamped = Math.min(100, Math.max(0, Math.round(volume)));
    await this.#queryInput();
    if (this.#inputBackend === "pipewire") {
      await this.#runCommand("wpctl", [
        "set-volume",
        streamId,
        (clamped / 100).toFixed(2),
      ]);
    } else if (this.#inputBackend === "pulse") {
      await this.#runCommand("pactl", [
        "set-sink-input-volume",
        streamId,
        `${String(clamped)}%`,
      ]);
    } else {
      throw new Error("Per-application mixing requires PipeWire or PulseAudio.");
    }
    const streams = await this.listPlaybackStreams();
    const changed = streams.find((s) => s.id === streamId);
    if (changed !== undefined && Math.abs(changed.volume - clamped) > 5)
      throw new Error("Failed to set stream volume.");
    return streams;
  }

  public async setStreamMuted(
    streamId: string,
    muted: boolean,
  ): Promise<readonly AudioPlaybackStream[]> {
    await this.#queryInput();
    if (this.#inputBackend === "pipewire") {
      await this.#runCommand("wpctl", ["set-mute", streamId, muted ? "1" : "0"]);
    } else if (this.#inputBackend === "pulse") {
      await this.#runCommand("pactl", [
        "set-sink-input-mute",
        streamId,
        muted ? "1" : "0",
      ]);
    } else {
      throw new Error("Per-application mixing requires PipeWire or PulseAudio.");
    }
    const streams = await this.listPlaybackStreams();
    const changed = streams.find((s) => s.id === streamId);
    if (changed !== undefined && changed.muted !== muted)
      throw new Error("Failed to set stream muted state.");
    return streams;
  }

  /**
   * Records from the microphone to a WAV file using the real capture tool
   * for the active backend (pw-record / parecord / arecord). System-level
   * hook: Settings' microphone test and system components use this; apps use
   * the permission-gated microphone native module instead.
   */
  public async recordInput(
    path: string,
    options: AudioInputRecordingOptions = {},
  ): Promise<AudioInputRecording> {
    if (path.trim().length === 0) throw new Error("Recording path must not be empty.");
    const seconds = Math.max(1, Math.min(30, Math.round(options.seconds ?? 5)));
    const sampleRate = Math.min(
      96_000,
      Math.max(8_000, Math.round(options.sampleRate ?? 48_000)),
    );
    const channels = Math.min(2, Math.max(1, Math.round(options.channels ?? 1)));
    await this.#requireInput();
    if (this.#inputBackend === "pipewire") {
      // pw-record always captures the default source; select it first with
      // setDefaultInputDevice() if a specific device is needed.
      await this.#runRecorder("pw-record", ["--format=wav", path], seconds * 1000);
    } else if (this.#inputBackend === "pulse") {
      const args = ["--file-format=wav"];
      if (options.deviceId !== undefined) args.push(`--device=${options.deviceId}`);
      args.push(path);
      await this.#runRecorder("parecord", args, seconds * 1000);
    } else {
      const args = [
        "-q",
        "-f",
        "S16_LE",
        "-r",
        String(sampleRate),
        "-c",
        String(channels),
      ];
      if (options.deviceId !== undefined) args.push("-D", options.deviceId);
      args.push(path);
      await this.#runRecorder("arecord", args, seconds * 1000 + 5000);
    }
    const file = await stat(path).catch(() => undefined);
    if (file === undefined || !file.isFile() || file.size === 0)
      throw new Error("Recording produced no audio file.");
    return Object.freeze({ path, mediaType: "audio/wav", seconds });
  }

  public subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    if (this.#timer === undefined) {
      this.#timer = setInterval(() => {
        void this.snapshot().then(() => {
          this.#notify();
        });
      }, 5000);
      if (typeof this.#timer === "object" && "unref" in this.#timer) {
        this.#timer.unref();
      }
    }
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0 && this.#timer !== undefined) {
        clearInterval(this.#timer);
        this.#timer = undefined;
      }
    };
  }

  #notify(): void {
    for (const l of this.#listeners) l();
  }

  async #requireOutput(): Promise<void> {
    if (!(await this.snapshot()).available)
      throw new Error("No supported audio output is available.");
  }

  #inputAvailable = false;
  #inputDevices: readonly AudioInputDevice[] = Object.freeze([]);
  #inputDefaultDeviceId = "";
  #inputVolume = 0;
  #inputMuted = false;

  async #requireInput(): Promise<void> {
    if (!(await this.inputSnapshot()).available)
      throw new Error("No supported audio input is available.");
  }

  #defaultInputTarget(): string {
    if (this.#inputBackend === "pipewire" || this.#inputBackend === "pulse") {
      return this.#inputBackend === "pipewire"
        ? "@DEFAULT_AUDIO_SOURCE@"
        : "@DEFAULT_SOURCE@";
    }
    return "";
  }

  async #queryInput(): Promise<void> {
    if (await this.#queryPipeWireInput()) return;
    if (await this.#queryPulseInput()) return;
    await this.#queryAlsaInput();
  }

  async #queryPipeWireInput(): Promise<boolean> {
    try {
      const status = await this.#runCommand("wpctl", ["status"]);
      const sources = parseWpctlSources(status);
      if (sources.length === 0) return false;
      const devices: AudioInputDevice[] = [];
      for (const source of sources) {
        let volume = 0;
        let muted = false;
        try {
          const volOutput = await this.#runCommand("wpctl", ["get-volume", source.id]);
          const match = /^Volume:\s*([\d.]+)/m.exec(volOutput.trim());
          if (match?.[1]) {
            const raw = parseFloat(match[1]);
            if (Number.isFinite(raw))
              volume = Math.min(100, Math.max(0, Math.round(raw * 100)));
          }
          muted = volOutput.includes("[MUTED]");
        } catch {
          // Keep volume 0 / unmuted when the node can't be queried.
        }
        devices.push(
          Object.freeze({
            id: source.id,
            name: source.name,
            isDefault: source.isDefault,
            volume,
            muted,
          }),
        );
      }
      const defaultDevice = devices.find((d) => d.isDefault) ?? devices[0];
      if (defaultDevice === undefined) return false;
      this.#inputBackend = "pipewire";
      this.#inputAvailable = true;
      this.#inputDevices = Object.freeze(devices);
      this.#inputDefaultDeviceId = defaultDevice.id;
      this.#inputVolume = defaultDevice.volume;
      this.#inputMuted = defaultDevice.muted;
      return true;
    } catch {
      // PipeWire / wpctl not available
    }
    return false;
  }

  async #queryPulseInput(): Promise<boolean> {
    try {
      const shortOutput = await this.#runCommand("pactl", ["list", "sources", "short"]);
      const names = parsePactlSourcesShort(shortOutput);
      if (names.length === 0) return false;
      const defaultName = await this.#runCommand("pactl", ["get-default-source"])
        .then((o) => o.trim())
        .catch(() => "");
      const devices: AudioInputDevice[] = [];
      for (const name of names) {
        let volume = 0;
        let muted = false;
        try {
          const volOutput = await this.#runCommand("pactl", ["get-source-volume", name]);
          const match = /\/\s*(\d+)%/.exec(volOutput);
          if (match?.[1]) {
            const vol = parseInt(match[1], 10);
            if (Number.isFinite(vol)) volume = Math.min(100, Math.max(0, vol));
          }
        } catch {
          // Keep volume 0 when the source can't be queried.
        }
        try {
          const muteOutput = await this.#runCommand("pactl", ["get-source-mute", name]);
          muted = /yes/i.test(muteOutput);
        } catch {
          // Keep unmuted when the source can't be queried.
        }
        devices.push(
          Object.freeze({
            id: name,
            name,
            isDefault: name === defaultName,
            volume,
            muted,
          }),
        );
      }
      const defaultDevice = devices.find((d) => d.isDefault) ?? devices[0];
      if (defaultDevice === undefined) return false;
      this.#inputBackend = "pulse";
      this.#inputAvailable = true;
      this.#inputDevices = Object.freeze(devices);
      this.#inputDefaultDeviceId = defaultDevice.id;
      this.#inputVolume = defaultDevice.volume;
      this.#inputMuted = defaultDevice.muted;
      return true;
    } catch {
      // PulseAudio / pactl not available
    }
    return false;
  }

  async #queryAlsaInput(): Promise<void> {
    this.#inputAvailable = false;
    this.#inputDevices = Object.freeze([]);
    this.#inputDefaultDeviceId = "";
    this.#inputMuted = false;
    try {
      const list = await this.#runCommand("arecord", ["-l"]).catch(() => "");
      const devices = parseArecordList(list);
      if (devices.length === 0) return;
      const withLevels: AudioInputDevice[] = [];
      for (let index = 0; index < devices.length; index += 1) {
        const device = devices[index];
        if (device === undefined) continue;
        const captureOutput = await this.#runCommand("amixer", [
          ...alsaCardArgs(device.id),
          "get",
          "Capture",
        ]).catch(() => "");
        let volume = 0;
        let muted = false;
        const volMatch = /\[(\d+)%\]/.exec(captureOutput);
        if (volMatch?.[1]) {
          const parsed = Number(volMatch[1]);
          if (Number.isFinite(parsed) && parsed <= 100) volume = parsed;
        }
        if (captureOutput.includes("[off]")) muted = true;
        else if (captureOutput.includes("[on]")) muted = false;
        withLevels.push(
          Object.freeze({
            ...device,
            isDefault: index === 0,
            volume,
            muted,
          }),
        );
      }
      this.#inputBackend = "alsa";
      this.#inputAvailable = true;
      this.#inputDevices = Object.freeze(withLevels);
      const first = withLevels[0];
      if (first !== undefined) {
        this.#inputDefaultDeviceId = first.id;
        this.#inputVolume = first.volume;
        this.#inputMuted = first.muted;
      }
    } catch {
      this.#inputAvailable = false;
      this.#inputDevices = Object.freeze([]);
      this.#inputDefaultDeviceId = "";
      this.#inputMuted = false;
    }
  }

  async #listPipeWireStreams(): Promise<readonly AudioPlaybackStream[]> {
    const status = await this.#runCommand("wpctl", ["status"]);
    const streams = parseWpctlStreams(status);
    const result: AudioPlaybackStream[] = [];
    for (const stream of streams) {
      let volume = 0;
      let muted = false;
      try {
        const volOutput = await this.#runCommand("wpctl", ["get-volume", stream.id]);
        const match = /^Volume:\s*([\d.]+)/m.exec(volOutput.trim());
        if (match?.[1]) {
          const raw = parseFloat(match[1]);
          if (Number.isFinite(raw))
            volume = Math.min(100, Math.max(0, Math.round(raw * 100)));
        }
        muted = volOutput.includes("[MUTED]");
      } catch {
        // Omit streams that can't be queried rather than faking levels.
        continue;
      }
      result.push(
        Object.freeze({
          id: stream.id,
          name: stream.name,
          applicationName: stream.name,
          volume,
          muted,
        }),
      );
    }
    return Object.freeze(result);
  }

  async #listPulseStreams(): Promise<readonly AudioPlaybackStream[]> {
    const output = await this.#runCommand("pactl", ["list", "sink-inputs"]);
    return Object.freeze(parsePactlSinkInputs(output));
  }

  #runRecorder(
    command: string,
    args: readonly string[],
    durationMs: number,
  ): Promise<void> {
    if (this.#options.runRecorder !== undefined) {
      return this.#options.runRecorder(command, args, durationMs);
    }
    return new Promise((resolve, reject) => {
      const child = spawn(command, [...args], { stdio: ["ignore", "ignore", "pipe"] });
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        if (error) reject(error);
        else resolve();
      };
      const killTimer = setTimeout(() => {
        child.kill("SIGTERM");
        const forceTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
        child.once("close", () => {
          clearTimeout(forceTimer);
          finish();
        });
      }, durationMs);
      child.once("error", (error) => {
        finish(error);
      });
      child.once("close", () => {
        finish();
      });
    });
  }

  async #queryAudio(): Promise<void> {
    if (await this.#queryPipeWire()) return;
    if (await this.#queryPulse()) return;
    await this.#queryAlsa();
  }

  async #queryPipeWire(): Promise<boolean> {
    try {
      const output = await this.#runCommand("wpctl", [
        "get-volume",
        "@DEFAULT_AUDIO_SINK@",
      ]);
      const match = /^Volume:\s*([\d.]+)/m.exec(output.trim());
      if (match?.[1]) {
        const rawVol = parseFloat(match[1]);
        if (Number.isFinite(rawVol)) {
          this.#volume = Math.min(100, Math.max(0, Math.round(rawVol * 100)));
          this.#muted = output.includes("[MUTED]");
          this.#available = true;
          this.#backend = "pipewire";
          if (!this.#outputDevice) this.#outputDevice = "PipeWire Default Output";
          return true;
        }
      }
    } catch {
      // PipeWire / wpctl not available
    }
    return false;
  }

  async #queryPulse(): Promise<boolean> {
    try {
      const volOutput = await this.#runCommand("pactl", [
        "get-sink-volume",
        "@DEFAULT_SINK@",
      ]);
      const match = /^Volume:.*?\/\s*(\d+)%/ms.exec(volOutput.trim());
      if (match?.[1]) {
        const vol = parseInt(match[1], 10);
        if (Number.isFinite(vol)) {
          this.#volume = Math.min(100, Math.max(0, vol));
          this.#backend = "pulse";
          this.#available = true;
          if (!this.#outputDevice) this.#outputDevice = "PulseAudio Default Output";
          try {
            const muteOutput = await this.#runCommand("pactl", [
              "get-sink-mute",
              "@DEFAULT_SINK@",
            ]);
            this.#muted = /yes/i.test(muteOutput);
          } catch {
            this.#muted = false;
          }
          return true;
        }
      }
    } catch {
      // PulseAudio / pactl not available
    }
    return false;
  }

  async #queryAlsa(): Promise<void> {
    this.#available = false;
    // Retain this.#volume instead of resetting to 0!
    this.#muted = false;
    this.#outputDevice = "";
    this.#hasHeadphones = false;
    try {
      const cardsPath = this.#options.cardsPath ?? "/proc/asound/cards";
      const cards = await readFile(cardsPath, "utf8").catch(() => "");
      if (cards.length > 0) {
        const firstLine = cards.split("\n")[0];
        if (firstLine !== undefined) {
          const match = /:\s*(.+)$/.exec(firstLine);
          if (match?.[1]) {
            this.#outputDevice = match[1].trim();
          }
        }
      }

      const output = await this.#runCommand("amixer", ["get", "Master"]).catch(() => "");
      const volMatch = /\[(\d+)%\]/.exec(output);
      if (volMatch?.[1]) {
        const volume = Number(volMatch[1]);
        if (volume > 100) return;
        this.#volume = volume;
        this.#available = true;
        this.#backend = "alsa";
        if (!this.#outputDevice) this.#outputDevice = "ALSA default output";
      }
      if (output.includes("[off]")) {
        this.#muted = true;
      } else if (output.includes("[on]")) {
        this.#muted = false;
      }

      const hpOutput = await this.#runCommand("amixer", [
        "cget",
        "name=Headphone Jack",
      ]).catch(() => "");
      if (/values=on\b/.test(hpOutput)) {
        this.#hasHeadphones = true;
      }
    } catch {
      this.#outputDevice = "";
      this.#available = false;
      this.#hasHeadphones = false;
      // Volume remains retained at last-known value
    }
  }

  public close(): void {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    this.#listeners.clear();
  }

  #runCommand(command: string, args: readonly string[]): Promise<string> {
    if (this.#options.runCommand !== undefined) {
      return this.#options.runCommand(command, args);
    }
    return new Promise((resolve, reject) => {
      const child = spawn(command, [...args], {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        },
      });
      let stdout = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error("Audio command timed out"));
      }, 3000);
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(stdout);
        else reject(new Error("Command failed with code " + String(code)));
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }
}
