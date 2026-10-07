/**
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * LinuxBluetoothService — real Bluetooth adapter/device management via
 * bluetoothctl (BlueZ). Covers adapter state, discovery, pairing (with
 * passkey/PIN confirmation flows), connect/disconnect, trust, and forget.
 *
 * The command runner and the interactive pairing-session factory are injected
 * so unit tests can drive the service without a Bluetooth adapter.
 */
import { spawn } from "node:child_process";

export interface BluetoothCommandResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export type BluetoothCommandRunner = (
  args: readonly string[],
) => Promise<BluetoothCommandResult>;

/** Line-oriented interactive bluetoothctl session (used for pairing). */
export interface BluetoothCtlSession {
  writeLine(line: string): void;
  close(): void;
}

export type BluetoothCtlSessionFactory = (
  onLine: (line: string) => void,
  onClose: (code: number | null) => void,
) => BluetoothCtlSession;

export interface BluetoothAdapterState {
  readonly available: boolean;
  readonly powered: boolean;
  readonly discoverable: boolean;
  readonly pairable: boolean;
  readonly discovering: boolean;
  readonly name: string;
  readonly address: string;
}

export interface BluetoothDeviceInfo {
  readonly address: string;
  readonly name: string;
  readonly alias: string;
  readonly paired: boolean;
  readonly trusted: boolean;
  readonly connected: boolean;
  readonly rssi: number | undefined;
  readonly deviceClass: number | undefined;
  /** SevynIconName for the device's Class of Device (never emoji). */
  readonly icon: string;
  readonly legacyPairing: boolean;
}

export type BluetoothPairStatus = "paired" | "failed" | "confirm-passkey" | "pin-request";

export interface BluetoothPairOutcome {
  readonly status: BluetoothPairStatus;
  /** Human-readable prompt, e.g. the passkey to confirm on both devices. */
  readonly prompt: string | undefined;
  readonly error: string | undefined;
}

const MAC_PATTERN = /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/;
const PAIR_TIMEOUT_MS = 45_000;
const PAIR_RESPONSE_TIMEOUT_MS = 30_000;

function defaultRunner(args: readonly string[]): Promise<BluetoothCommandResult> {
  return new Promise((resolve) => {
    const child = spawn("bluetoothctl", [...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", (error: Error) => {
      resolve({ code: null, stdout, stderr: error.message });
    });
    child.once("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

function defaultSessionFactory(
  onLine: (line: string) => void,
  onClose: (code: number | null) => void,
): BluetoothCtlSession {
  const child = spawn("bluetoothctl", [], { stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      onLine(buffer.slice(0, index).replace(/\r$/, ""));
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
    }
  });
  child.once("error", () => {
    onClose(null);
  });
  child.once("close", (code) => {
    onClose(code);
  });
  return {
    writeLine(line: string): void {
      child.stdin.write(`${line}\n`);
    },
    close(): void {
      try {
        child.stdin.write("quit\n");
      } catch {
        // Already gone.
      }
      child.kill();
    },
  };
}

/**
 * Map a Bluetooth Class of Device to a Sevyn icon name (emoji-free).
 * Major class = bits 8-12, minor class = bits 2-7.
 */
export function bluetoothClassIconName(deviceClass: number): string {
  const major = (deviceClass >> 8) & 0x1f;
  const minor = (deviceClass >> 2) & 0x3f;
  switch (major) {
    case 0x01:
      return "monitor"; // Computer
    case 0x02:
      return "bluetooth"; // Phone
    case 0x03:
      return "wifi"; // LAN / network access point
    case 0x04:
      return minor === 5 ? "volume" : "music-note"; // Audio/Video (5 = loudspeaker)
    case 0x05: // Peripheral
      if (minor & 0x10) return "keyboard";
      if (minor & 0x20) return "pointer";
      return "controls";
    case 0x06:
      return "image"; // Imaging
    case 0x07:
      return "clock"; // Wearable
    case 0x08:
      return "bluetooth"; // Toy
    case 0x09:
      return "heart"; // Health
    default:
      return "bluetooth";
  }
}

function parseYesNo(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "yes";
}

function parseInfoValue(output: string, key: string): string | undefined {
  const match = new RegExp(`^\\s*${key}:\\s*(.+)$`, "m").exec(output);
  return match?.[1]?.trim();
}

function parseDeviceClass(output: string): number | undefined {
  const raw = parseInfoValue(output, "Class");
  if (raw === undefined) return undefined;
  const match = /^0x([0-9a-fA-F]+)/.exec(raw);
  if (match?.[1] === undefined) return undefined;
  const value = Number.parseInt(match[1], 16);
  return Number.isSafeInteger(value) ? value : undefined;
}

function parseRssi(output: string): number | undefined {
  const raw = parseInfoValue(output, "RSSI");
  if (raw === undefined) return undefined;
  const match = /^(-?\d+)/.exec(raw);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

const UNAVAILABLE_STATE: BluetoothAdapterState = Object.freeze({
  available: false,
  powered: false,
  discoverable: false,
  pairable: false,
  discovering: false,
  name: "",
  address: "",
});

const PAIR_TIMED_OUT: BluetoothPairOutcome = Object.freeze({
  status: "failed",
  prompt: undefined,
  error: "Pairing timed out.",
});

export class LinuxBluetoothService {
  readonly #run: BluetoothCommandRunner;
  readonly #sessionFactory: BluetoothCtlSessionFactory;
  #pairingSession: BluetoothCtlSession | undefined;
  #pairingLineHandler: ((line: string) => void) | undefined;

  public constructor(
    runner: BluetoothCommandRunner = defaultRunner,
    sessionFactory: BluetoothCtlSessionFactory = defaultSessionFactory,
  ) {
    this.#run = runner;
    this.#sessionFactory = sessionFactory;
  }

  /** Adapter state from `bluetoothctl show`. Never throws for a missing adapter. */
  public async getState(): Promise<BluetoothAdapterState> {
    const result = await this.#run(["show"]).catch(() => null);
    if (result?.code !== 0) return UNAVAILABLE_STATE;
    const { stdout } = result;
    if (/no default controller/i.test(stdout)) return UNAVAILABLE_STATE;
    const controller = /^Controller\s+(\S+)/m.exec(stdout)?.[1] ?? "";
    if (controller === "") return UNAVAILABLE_STATE;
    return {
      available: true,
      powered: parseYesNo(parseInfoValue(stdout, "Powered")),
      discoverable: parseYesNo(parseInfoValue(stdout, "Discoverable")),
      pairable: parseYesNo(parseInfoValue(stdout, "Pairable")),
      discovering: parseYesNo(parseInfoValue(stdout, "Discovering")),
      name: parseInfoValue(stdout, "Name") ?? "",
      address: controller,
    };
  }

  public async setPowered(powered: boolean): Promise<BluetoothAdapterState> {
    await this.#requireAvailable();
    const result = await this.#run(["power", powered ? "on" : "off"]);
    if (result.code !== 0 || !/succeeded/i.test(result.stdout)) {
      throw new Error(
        `Failed to turn Bluetooth ${powered ? "on" : "off"}: ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
    return this.getState();
  }

  /** Enriched device list (paired/trusted/connected/RSSI/class). */
  public async listDevices(): Promise<readonly BluetoothDeviceInfo[]> {
    await this.#requireAvailable();
    const result = await this.#run(["devices"]);
    const basics: { address: string; name: string }[] = [];
    for (const line of result.stdout.split("\n")) {
      const match = /^Device\s+(\S+)\s+(.+)$/.exec(line.trim());
      if (match?.[1] !== undefined && MAC_PATTERN.test(match[1])) {
        basics.push({ address: match[1], name: (match[2] ?? "").trim() });
      }
    }
    const devices: BluetoothDeviceInfo[] = [];
    for (const basic of basics) {
      devices.push(await this.#describeDevice(basic.address, basic.name));
    }
    devices.sort((a, b) => {
      if (a.connected !== b.connected) return a.connected ? -1 : 1;
      if (a.paired !== b.paired) return a.paired ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return devices;
  }

  /**
   * Pair with a device. Most devices pair with "Just Works" and resolve
   * immediately; devices that need confirmation resolve with
   * `confirm-passkey`/`pin-request` and keep the interactive session open for
   * respondToPairing(). A successful pair is automatically trusted.
   */
  public async pair(address: string): Promise<BluetoothPairOutcome> {
    this.#assertMac(address);
    await this.#requireAvailable();
    if (this.#pairingSession !== undefined) {
      throw new Error("A pairing attempt is already in progress.");
    }
    const outcome = await this.#runPairingSession(address);
    if (outcome.status === "paired") {
      await this.#run(["trust", address]).catch(() => undefined);
    }
    return outcome;
  }

  /**
   * Answer a pending confirmation (`confirm-passkey`) or supply the PIN for
   * `pin-request`. Resolves to the terminal pairing outcome.
   */
  public async respondToPairing(
    accept: boolean,
    pin?: string,
  ): Promise<BluetoothPairOutcome> {
    const session = this.#pairingSession;
    if (session === undefined) {
      throw new Error("There is no pending pairing confirmation.");
    }
    const response = pin !== undefined && pin !== "" ? pin : accept ? "yes" : "no";
    const outcome = await new Promise<BluetoothPairOutcome>((resolve) => {
      const timer = setTimeout(() => {
        resolve(PAIR_TIMED_OUT);
      }, PAIR_RESPONSE_TIMEOUT_MS);
      this.#pairingLineHandler = (line: string): void => {
        const classified = classifyPairLine(line);
        if (classified === undefined) return;
        if (
          classified.status === "confirm-passkey" ||
          classified.status === "pin-request"
        ) {
          // A follow-up prompt (e.g. PIN after passkey): keep waiting.
          return;
        }
        clearTimeout(timer);
        resolve(classified);
      };
      try {
        session.writeLine(response);
      } catch (error) {
        clearTimeout(timer);
        resolve({
          status: "failed",
          prompt: undefined,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
    this.#closePairingSession();
    return outcome;
  }

  public cancelPairing(): void {
    this.#closePairingSession();
  }

  public async connect(address: string): Promise<void> {
    this.#assertMac(address);
    await this.#requireAvailable();
    const result = await this.#run(["connect", address]);
    if (result.code !== 0 || !/successful/i.test(result.stdout)) {
      throw new Error(
        `Failed to connect to ${address}: ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
  }

  public async disconnect(address: string): Promise<void> {
    this.#assertMac(address);
    await this.#requireAvailable();
    const result = await this.#run(["disconnect", address]);
    if (result.code !== 0 || !/successful/i.test(result.stdout)) {
      throw new Error(
        `Failed to disconnect ${address}: ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
  }

  /** Forget a device (unpair + remove). */
  public async remove(address: string): Promise<void> {
    this.#assertMac(address);
    await this.#requireAvailable();
    const result = await this.#run(["remove", address]);
    if (result.code !== 0 || !/removed/i.test(result.stdout)) {
      throw new Error(
        `Failed to forget ${address}: ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
  }

  public async setTrusted(address: string, trusted: boolean): Promise<void> {
    this.#assertMac(address);
    await this.#requireAvailable();
    const result = await this.#run([trusted ? "trust" : "untrust", address]);
    if (result.code !== 0) {
      throw new Error(
        `Failed to ${trusted ? "trust" : "untrust"} ${address}: ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
  }

  public close(): void {
    this.cancelPairing();
  }

  async #describeDevice(
    address: string,
    fallbackName: string,
  ): Promise<BluetoothDeviceInfo> {
    const result = await this.#run(["info", address]).catch(() => null);
    if (result?.code !== 0) {
      return {
        address,
        name: fallbackName,
        alias: fallbackName,
        paired: false,
        trusted: false,
        connected: false,
        rssi: undefined,
        deviceClass: undefined,
        icon: "bluetooth",
        legacyPairing: false,
      };
    }
    const { stdout } = result;
    const deviceClass = parseDeviceClass(stdout);
    const name = parseInfoValue(stdout, "Name") ?? fallbackName;
    return {
      address,
      name,
      alias: parseInfoValue(stdout, "Alias") ?? name,
      paired: parseYesNo(parseInfoValue(stdout, "Paired")),
      trusted: parseYesNo(parseInfoValue(stdout, "Trusted")),
      connected: parseYesNo(parseInfoValue(stdout, "Connected")),
      rssi: parseRssi(stdout),
      deviceClass,
      icon: deviceClass === undefined ? "bluetooth" : bluetoothClassIconName(deviceClass),
      legacyPairing: parseYesNo(parseInfoValue(stdout, "LegacyPairing")),
    };
  }

  async #requireAvailable(): Promise<void> {
    const state = await this.getState();
    if (!state.available) {
      throw new Error(
        "Bluetooth is unavailable: no adapter found (bluetoothd may not be running).",
      );
    }
  }

  #assertMac(address: string): void {
    if (!MAC_PATTERN.test(address)) {
      throw new Error(`Invalid Bluetooth address: ${address}`);
    }
  }

  #closePairingSession(): void {
    this.#pairingLineHandler = undefined;
    const session = this.#pairingSession;
    this.#pairingSession = undefined;
    try {
      session?.close();
    } catch {
      // Already gone.
    }
  }

  #runPairingSession(address: string): Promise<BluetoothPairOutcome> {
    return new Promise<BluetoothPairOutcome>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve(PAIR_TIMED_OUT);
        }
        this.#closePairingSession();
      }, PAIR_TIMEOUT_MS);
      const finish = (outcome: BluetoothPairOutcome, keepOpen: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!keepOpen) this.#closePairingSession();
        else this.#pairingLineHandler = undefined;
        resolve(outcome);
      };
      const initialHandler = (line: string): void => {
        const classified = classifyPairLine(line);
        if (classified === undefined) return;
        const pending =
          classified.status === "confirm-passkey" || classified.status === "pin-request";
        // Pending confirmations keep the session open for respondToPairing().
        finish(classified, pending);
      };
      this.#pairingLineHandler = initialHandler;
      const session = this.#sessionFactory(
        (line) => {
          this.#pairingLineHandler?.(line);
        },
        () => {
          finish(
            {
              status: "failed",
              prompt: undefined,
              error: "bluetoothctl exited during pairing.",
            },
            false,
          );
        },
      );
      this.#pairingSession = session;
      try {
        session.writeLine("agent DisplayYesNo");
        session.writeLine("default-agent");
        session.writeLine(`pair ${address}`);
      } catch (error) {
        finish(
          {
            status: "failed",
            prompt: undefined,
            error: error instanceof Error ? error.message : String(error),
          },
          false,
        );
      }
    });
  }
}

/**
 * Classify one bluetoothctl pairing line. Returns a terminal outcome for
 * paired/failed lines, a pending outcome for confirmation prompts, or
 * undefined to keep waiting.
 */
export function classifyPairLine(line: string): BluetoothPairOutcome | undefined {
  if (/pairing successful/i.test(line)) {
    return { status: "paired", prompt: undefined, error: undefined };
  }
  const passkey = /confirm passkey\s+(\d+)\s*\(yes\/no\)/i.exec(line);
  if (passkey?.[1] !== undefined) {
    return {
      status: "confirm-passkey",
      prompt: `Confirm passkey ${passkey[1]} on both devices.`,
      error: undefined,
    };
  }
  if (/request confirmation/i.test(line)) {
    return {
      status: "confirm-passkey",
      prompt: line.trim(),
      error: undefined,
    };
  }
  if (/enter pin code/i.test(line)) {
    return {
      status: "pin-request",
      prompt: "Enter the device PIN code.",
      error: undefined,
    };
  }
  const failed = /failed to pair:\s*(.+)$/i.exec(line);
  if (failed?.[1] !== undefined) {
    return { status: "failed", prompt: undefined, error: failed[1].trim() };
  }
  if (/not available|no default controller/i.test(line)) {
    return {
      status: "failed",
      prompt: undefined,
      error: "No Bluetooth adapter available.",
    };
  }
  return undefined;
}
