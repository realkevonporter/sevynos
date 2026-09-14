import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  BatterySnapshot,
  SevynBatteryService,
} from "@sevynos/react-native/internal";

export class LinuxBatteryService implements SevynBatteryService {
  readonly #powerSupplyPath: string;
  readonly #listeners = new Set<() => void>();
  #timer: NodeJS.Timeout | undefined;
  #lastSnapshot: BatterySnapshot = Object.freeze({
    available: false,
    percent: 0,
    charging: false,
    state: "unknown",
  });

  public constructor(powerSupplyPath = "/sys/class/power_supply") {
    this.#powerSupplyPath = powerSupplyPath;
  }

  public async snapshot(): Promise<BatterySnapshot> {
    let batDir: string | undefined;
    try {
      const supplies = await readdir(this.#powerSupplyPath).catch(() => []);
      for (const name of supplies) {
        const type = await readFile(
          join(this.#powerSupplyPath, name, "type"),
          "utf8",
        ).catch(() => "");
        if (type.trim() === "Battery") {
          batDir = name;
          break;
        }
      }
      if (batDir === undefined) {
        this.#lastSnapshot = Object.freeze({
          available: false,
          percent: 0,
          charging: false,
          state: "unknown",
        });
        return this.#lastSnapshot;
      }

      const batPath = join(this.#powerSupplyPath, batDir);
      const rawCapacity = await readFile(join(batPath, "capacity"), "utf8");
      const rawStatus = await readFile(join(batPath, "status"), "utf8").catch(
        () => "Unknown",
      );

      if (!/^\d+$/.test(rawCapacity.trim())) throw new Error("Invalid battery capacity.");
      const percent = Number(rawCapacity.trim());
      if (!Number.isInteger(percent) || percent < 0 || percent > 100)
        throw new Error("Battery capacity is outside its valid range.");
      const statusStr = rawStatus.trim().toLowerCase();

      let state: BatterySnapshot["state"] = "unknown";
      let charging = false;

      if (statusStr.includes("discharging")) {
        state = "discharging";
        charging = false;
      } else if (statusStr.includes("not charging")) {
        state = "not-charging";
        charging = false;
      } else if (statusStr.includes("charging")) {
        state = "charging";
        charging = true;
      } else if (statusStr.includes("full")) {
        state = "full";
        charging = false;
      }

      this.#lastSnapshot = Object.freeze({
        available: true,
        percent,
        charging,
        state,
      });
      return this.#lastSnapshot;
    } catch {
      this.#lastSnapshot = Object.freeze({
        available: false,
        percent: 0,
        charging: false,
        state: "unknown",
      });
      return this.#lastSnapshot;
    }
  }

  public subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    if (this.#timer === undefined) {
      this.#timer = setInterval(() => {
        void this.snapshot().then(() => {
          for (const l of this.#listeners) l();
        });
      }, 15_000);
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

  public close(): void {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    this.#listeners.clear();
  }
}
