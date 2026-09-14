import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import type { AudioSnapshot, SevynAudioService } from "@sevynos/react-native/internal";

export interface LinuxAudioServiceOptions {
  readonly cardsPath?: string;
  readonly runCommand?: (command: string, args: readonly string[]) => Promise<string>;
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
