import { spawn } from "node:child_process";

export interface LinuxAccessibilityState {
  readonly accessibilityServiceEnabled: boolean;
  readonly screenReaderEnabled: boolean;
  readonly boldTextEnabled: boolean;
  readonly grayscaleEnabled: boolean;
  readonly invertColorsEnabled: boolean;
  readonly reduceMotionEnabled: boolean;
  readonly reduceTransparencyEnabled: boolean;
}

const disabled: LinuxAccessibilityState = Object.freeze({
  accessibilityServiceEnabled: false,
  screenReaderEnabled: false,
  boldTextEnabled: false,
  grayscaleEnabled: false,
  invertColorsEnabled: false,
  reduceMotionEnabled: false,
  reduceTransparencyEnabled: false,
});

export class LinuxAccessibilityService {
  readonly #listeners = new Set<() => void>();
  #state: LinuxAccessibilityState = disabled;
  #poll: ReturnType<typeof setInterval> | undefined;

  public async getState(): Promise<LinuxAccessibilityState> {
    const screenReaderSetting = await booleanSetting(
      "org.gnome.desktop.a11y.applications",
      "screen-reader-enabled",
    );
    const screenReaderProcess = (await tryRun("pgrep", ["-x", "orca"])) !== undefined;
    const accessibilityBus = process.env["AT_SPI_BUS_ADDRESS"] !== undefined;
    const animations = await booleanSetting(
      "org.gnome.desktop.interface",
      "enable-animations",
    );
    const highContrast = await stringSetting("org.gnome.desktop.interface", "gtk-theme");
    const screenReaderEnabled =
      process.env["SEVYN_SCREEN_READER"] === "1" ||
      screenReaderSetting === true ||
      screenReaderProcess;
    const next = Object.freeze({
      accessibilityServiceEnabled: screenReaderEnabled || accessibilityBus,
      screenReaderEnabled,
      boldTextEnabled: process.env["SEVYN_BOLD_TEXT"] === "1",
      grayscaleEnabled: process.env["SEVYN_GRAYSCALE"] === "1",
      invertColorsEnabled: process.env["SEVYN_INVERT_COLORS"] === "1",
      reduceMotionEnabled:
        process.env["SEVYN_REDUCE_MOTION"] === "1" || animations === false,
      reduceTransparencyEnabled:
        process.env["SEVYN_REDUCE_TRANSPARENCY"] === "1" ||
        highContrast?.toLowerCase().includes("highcontrast") === true,
    });
    this.#state = next;
    return next;
  }

  public subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    if (this.#poll === undefined) {
      this.#poll = setInterval(() => {
        void this.#pollState();
      }, 2_000);
      this.#poll.unref();
    }
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0 && this.#poll !== undefined) {
        clearInterval(this.#poll);
        this.#poll = undefined;
      }
    };
  }

  public async announce(message: string): Promise<void> {
    const text = message.trim().slice(0, 1_024);
    if (text.length === 0) return;
    await tryRun("spd-say", ["--wait", text]);
  }

  async #pollState(): Promise<void> {
    const previous = JSON.stringify(this.#state);
    const next = await this.getState();
    if (JSON.stringify(next) === previous) return;
    for (const listener of this.#listeners) listener();
  }
}

async function booleanSetting(schema: string, key: string): Promise<boolean | undefined> {
  const value = await tryRun("gsettings", ["get", schema, key]);
  if (value === undefined) return undefined;
  if (value.trim() === "true") return true;
  if (value.trim() === "false") return false;
  return undefined;
}

async function stringSetting(schema: string, key: string): Promise<string | undefined> {
  const value = await tryRun("gsettings", ["get", schema, key]);
  return value?.trim().replace(/^['"]|['"]$/g, "");
}

function tryRun(command: string, args: readonly string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.once("error", () => {
      resolve(undefined);
    });
    child.once("close", (code) => {
      resolve(code === 0 ? stdout : undefined);
    });
  });
}
