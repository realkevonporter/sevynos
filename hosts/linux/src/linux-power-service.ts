/**
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * LinuxPowerService — lid-close handling and battery charge limits.
 *
 * Lid events: SevynOS images run without systemd/logind (PID 1 is /init), so
 * there is no HandleLidSwitch. The real event source is the kernel's ACPI
 * button interface — the same source acpid watches — read directly from
 * /proc/acpi/button/lid/<name>/state. The service polls for open-to-closed
 * transitions and invokes the provided callback (wired to the orderly
 * power.sleep() in wayland.ts), honoring the persisted lid-close action.
 *
 * Charge limits: per-battery charge_control_{start,end}_threshold in
 * /sys/class/power_supply/BAT*. Feature-detected per battery; when the
 * hardware does not expose the knobs the control reports unsupported so the
 * UI can hide it instead of faking a slider.
 *
 * Paths and the poll interval are injected for tests.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type LidState = "open" | "closed" | "unknown";
export type LidCloseAction = "sleep" | "nothing";

export interface ChargeLimitState {
  readonly supported: boolean;
  readonly battery: string | undefined;
  readonly startPct: number | undefined;
  readonly endPct: number | undefined;
}

export interface ChargeLimitSetting {
  readonly startPct?: number | undefined;
  readonly endPct?: number | undefined;
}

function defaultStateDirectory(): string {
  return process.env["SEVYN_STATE_DIRECTORY"] ?? "/var/lib/sevynos";
}

function isValidAction(value: unknown): value is LidCloseAction {
  return value === "sleep" || value === "nothing";
}

export class LinuxPowerService {
  readonly #lidRoot: string;
  readonly #powerSupplyRoot: string;
  readonly #stateDirectory: string;
  readonly #pollIntervalMs: number;
  #watchTimer: NodeJS.Timeout | undefined;
  #lastLidState: LidState | undefined;

  public constructor(
    lidRoot = "/proc/acpi/button/lid",
    powerSupplyRoot = "/sys/class/power_supply",
    stateDirectory = defaultStateDirectory(),
    pollIntervalMs = 2000,
  ) {
    this.#lidRoot = lidRoot;
    this.#powerSupplyRoot = powerSupplyRoot;
    this.#stateDirectory = stateDirectory;
    this.#pollIntervalMs = pollIntervalMs;
  }

  /** Current lid state from the ACPI button interface. */
  public async getLidState(): Promise<LidState> {
    const states = await this.#readLidStates();
    if (states.length === 0) return "unknown";
    if (states.includes("closed")) return "closed";
    if (states.includes("open")) return "open";
    return "unknown";
  }

  /**
   * Watch for lid open->closed transitions. The callback fires at most once
   * per close (until the lid reopens) and only when the persisted lid-close
   * action is "sleep". Returns a stop function.
   */
  public startLidWatch(onLidClose: () => void): () => void {
    this.stopLidWatch();
    this.#lastLidState = undefined;
    const check = async (): Promise<void> => {
      try {
        const state = await this.getLidState();
        const previous = this.#lastLidState;
        this.#lastLidState = state;
        if (previous === "open" && state === "closed") {
          const action = await this.getLidAction();
          if (action === "sleep") onLidClose();
        }
      } catch {
        // A transient read failure must not kill the watcher.
      }
    };
    void check();
    this.#watchTimer = setInterval(() => {
      void check();
    }, this.#pollIntervalMs);
    if (typeof this.#watchTimer === "object" && "unref" in this.#watchTimer) {
      this.#watchTimer.unref();
    }
    return () => {
      this.stopLidWatch();
    };
  }

  public stopLidWatch(): void {
    if (this.#watchTimer !== undefined) {
      clearInterval(this.#watchTimer);
      this.#watchTimer = undefined;
    }
  }

  public async getLidAction(): Promise<LidCloseAction> {
    const stored = await this.#readSetting("lidCloseAction");
    return isValidAction(stored) ? stored : "sleep";
  }

  public async setLidAction(action: LidCloseAction): Promise<void> {
    if (!isValidAction(action)) throw new Error(`Invalid lid action: ${String(action)}`);
    await this.#writeSetting("lidCloseAction", action);
  }

  /**
   * Charge-limit support, feature-detected per battery. Only batteries that
   * expose charge_control_end_threshold are manageable.
   */
  public async getChargeLimit(): Promise<ChargeLimitState> {
    const battery = await this.#findManageableBattery();
    if (battery === undefined) {
      return {
        supported: false,
        battery: undefined,
        startPct: undefined,
        endPct: undefined,
      };
    }
    const end = await this.#readThreshold(battery, "charge_control_end_threshold");
    const start = await this.#readThreshold(battery, "charge_control_start_threshold");
    return { supported: true, battery, startPct: start, endPct: end };
  }

  public async setChargeLimit(setting: ChargeLimitSetting): Promise<ChargeLimitState> {
    const battery = await this.#findManageableBattery();
    if (battery === undefined) {
      throw new Error("Charge limits are not supported on this hardware.");
    }
    const { startPct, endPct } = setting;
    if (startPct !== undefined) this.#assertThreshold(startPct, "startPct");
    if (endPct !== undefined) this.#assertThreshold(endPct, "endPct");
    const resolvedStart =
      startPct ?? (await this.#readThreshold(battery, "charge_control_start_threshold"));
    const resolvedEnd =
      endPct ?? (await this.#readThreshold(battery, "charge_control_end_threshold"));
    if (
      resolvedStart !== undefined &&
      resolvedEnd !== undefined &&
      resolvedStart >= resolvedEnd
    ) {
      throw new Error(
        `Charge start threshold (${String(resolvedStart)}%) must be below the end threshold (${String(resolvedEnd)}%).`,
      );
    }
    if (startPct !== undefined) {
      await writeFile(
        join(this.#powerSupplyRoot, battery, "charge_control_start_threshold"),
        `${String(startPct)}\n`,
        "utf8",
      );
    }
    if (endPct !== undefined) {
      await writeFile(
        join(this.#powerSupplyRoot, battery, "charge_control_end_threshold"),
        `${String(endPct)}\n`,
        "utf8",
      );
    }
    return this.getChargeLimit();
  }

  public close(): void {
    this.stopLidWatch();
  }

  async #readLidStates(): Promise<LidState[]> {
    const entries = await readdir(this.#lidRoot).catch(() => []);
    const states: LidState[] = [];
    for (const entry of entries) {
      const text = await readFile(join(this.#lidRoot, entry, "state"), "utf8").catch(
        () => "",
      );
      const match = /state:\s*(\w+)/i.exec(text);
      const value = match?.[1]?.toLowerCase();
      states.push(value === "open" ? "open" : value === "closed" ? "closed" : "unknown");
    }
    return states;
  }

  async #findManageableBattery(): Promise<string | undefined> {
    const entries = await readdir(this.#powerSupplyRoot).catch(() => []);
    for (const entry of entries.sort()) {
      const type = (
        await readFile(join(this.#powerSupplyRoot, entry, "type"), "utf8").catch(() => "")
      ).trim();
      if (type !== "Battery") continue;
      const probe = await readFile(
        join(this.#powerSupplyRoot, entry, "charge_control_end_threshold"),
        "utf8",
      ).catch(() => null);
      if (probe !== null) return entry;
    }
    return undefined;
  }

  async #readThreshold(battery: string, name: string): Promise<number | undefined> {
    const raw = await readFile(join(this.#powerSupplyRoot, battery, name), "utf8").catch(
      () => null,
    );
    if (raw === null) return undefined;
    const value = Number(raw.trim());
    return Number.isInteger(value) && value >= 0 && value <= 100 ? value : undefined;
  }

  #assertThreshold(value: number, name: string): void {
    if (!Number.isInteger(value) || value < 1 || value > 100) {
      throw new Error(`${name} must be an integer between 1 and 100.`);
    }
  }

  async #readSetting(key: string): Promise<unknown> {
    try {
      const raw = await readFile(join(this.#stateDirectory, "power.json"), "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return parsed[key];
    } catch {
      return undefined;
    }
  }

  async #writeSetting(key: string, value: unknown): Promise<void> {
    const path = join(this.#stateDirectory, "power.json");
    let current: Record<string, unknown> = {};
    try {
      current = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    } catch {
      current = {};
    }
    current[key] = value;
    await mkdir(this.#stateDirectory, { recursive: true });
    await writeFile(path, JSON.stringify(current, null, 2), "utf8");
  }
}
