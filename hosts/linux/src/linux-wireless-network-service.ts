import { spawn } from "node:child_process";
import { access, readdir } from "node:fs/promises";
import type {
  SevynWirelessNetworkService,
  WirelessNetwork,
  WirelessNetworkSnapshot,
} from "@sevynos/react-native/internal";

export interface LinuxCommandRequest {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly input?: string;
  readonly timeoutMilliseconds?: number;
}

export interface LinuxCommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export type LinuxCommandExecutor = (
  request: LinuxCommandRequest,
) => Promise<LinuxCommandResult>;

export interface LinuxWirelessNetworkServiceOptions {
  readonly execute?: LinuxCommandExecutor;
  readonly discoverInterfaces?: () => Promise<readonly string[]>;
  readonly delay?: (milliseconds: number) => Promise<void>;
}

const initialSnapshot = (): WirelessNetworkSnapshot =>
  Object.freeze({
    available: false,
    enabled: false,
    state: "unavailable",
    networks: Object.freeze([]),
  });

export class LinuxWirelessNetworkService implements SevynWirelessNetworkService {
  readonly #execute: LinuxCommandExecutor;
  readonly #discoverInterfaces: () => Promise<readonly string[]>;
  readonly #delay: (milliseconds: number) => Promise<void>;
  readonly #listeners = new Set<() => void>();
  #current = initialSnapshot();
  #enabled = true;

  public constructor(options: LinuxWirelessNetworkServiceOptions = {}) {
    this.#execute = options.execute ?? executeLinuxCommand;
    this.#discoverInterfaces = options.discoverInterfaces ?? discoverWirelessInterfaces;
    this.#delay =
      options.delay ??
      ((milliseconds) =>
        new Promise((resolve) => {
          setTimeout(resolve, milliseconds);
        }));
  }

  #timer: NodeJS.Timeout | undefined;

  public async snapshot(): Promise<WirelessNetworkSnapshot> {
    const interfaceName = await this.#interfaceName();
    if (interfaceName === undefined) {
      this.#current = initialSnapshot();
      return this.#current;
    }
    if (!this.#enabled) {
      this.#current = Object.freeze({
        available: true,
        enabled: false,
        interfaceName,
        state: "disconnected",
        networks: Object.freeze([]),
      });
      return this.#current;
    }
    try {
      const status = parseProperties((await this.#wpa(interfaceName, ["status"])).stdout);
      const connected = status.get("wpa_state") === "COMPLETED";
      const connectedSsid = connected ? status.get("ssid") : undefined;
      let networks: readonly WirelessNetwork[] = this.#current.networks;
      try {
        networks = parseScanResults(
          (await this.#wpa(interfaceName, ["scan_results"])).stdout,
          connectedSsid,
        );
      } catch {
        // A status result is still useful while the first scan is pending.
      }
      const state = connected
        ? "connected"
        : this.#current.state === "connecting" || this.#current.state === "scanning"
          ? this.#current.state
          : this.#current.state === "failed"
            ? "failed"
            : "disconnected";
      this.#current = Object.freeze({
        available: true,
        enabled: true,
        interfaceName,
        state,
        ...(connectedSsid === undefined ? {} : { connectedSsid }),
        ...(status.get("ip_address") === undefined
          ? {}
          : { ipAddress: status.get("ip_address") }),
        networks,
        ...(state === "failed" && this.#current.error !== undefined
          ? { error: this.#current.error }
          : {}),
      });
      return this.#current;
    } catch (error: unknown) {
      this.#current = Object.freeze({
        available: true,
        enabled: false,
        interfaceName,
        state: "failed",
        networks: this.#current.networks,
        error: friendlyError(error, "The Wi-Fi service is not ready."),
      });
      return this.#current;
    }
  }

  public async setEnabled(enabled: boolean): Promise<WirelessNetworkSnapshot> {
    const interfaceName = await this.#requireInterface();
    try {
      if (enabled) {
        await this.#execute({
          executable: "/usr/sbin/rfkill",
          arguments: ["unblock", "wifi"],
          timeoutMilliseconds: 2_500,
        }).catch(() => undefined);
        await this.#execute({
          executable: "/sbin/ip",
          arguments: ["link", "set", interfaceName, "up"],
          timeoutMilliseconds: 2_500,
        });
        this.#enabled = true;
        await this.#ensureWpaSupplicant(interfaceName);
        return await this.snapshot();
      }

      await this.#execute({
        executable: "/sbin/wpa_cli",
        arguments: ["-p", "/run/wpa_supplicant", "-i", interfaceName, "disconnect"],
        timeoutMilliseconds: 2_500,
      }).catch(() => undefined);
      await this.#execute({
        executable: "/sbin/ip",
        arguments: ["link", "set", interfaceName, "down"],
        timeoutMilliseconds: 2_500,
      });
      await this.#execute({
        executable: "/usr/sbin/rfkill",
        arguments: ["block", "wifi"],
        timeoutMilliseconds: 2_500,
      }).catch(() => undefined);
      this.#enabled = false;
      return this.#publish(
        Object.freeze({
          available: true,
          enabled: false,
          interfaceName,
          state: "disconnected",
          networks: Object.freeze([]),
        }),
      );
    } catch (error: unknown) {
      return this.#failure(
        interfaceName,
        error,
        enabled ? "Unable to enable Wi-Fi." : "Unable to disable Wi-Fi.",
      );
    }
  }

  public async scan(): Promise<WirelessNetworkSnapshot> {
    if (!this.#enabled) throw new Error("Wi-Fi is turned off.");
    const interfaceName = await this.#requireInterface();
    this.#publish(
      Object.freeze({
        ...this.#current,
        available: true,
        enabled: true,
        interfaceName,
        state: "scanning",
        error: undefined,
      }),
    );
    try {
      await this.#expectOkay(interfaceName, ["scan"]);
      await this.#delay(1_500);
      // Real hardware needs time to scan across all channels.
      await this.#delay(4_000);
      this.#current = Object.freeze({ ...this.#current, state: "disconnected" });
      return await this.snapshot();
    } catch (error: unknown) {
      return this.#failure(interfaceName, error, "Unable to scan for Wi-Fi networks.");
    }
  }

  public async connect(
    ssid: string,
    password?: string,
  ): Promise<WirelessNetworkSnapshot> {
    validateSsid(ssid);
    const selected = this.#current.networks.find((network) => network.ssid === ssid);
    if (selected !== undefined && !selected.supported)
      throw new Error("This Wi-Fi security mode is not supported yet.");
    if (selected?.requiresPassword === true || password !== undefined)
      validatePassword(password);
    const interfaceName = await this.#requireInterface();
    this.#publish(
      Object.freeze({
        ...this.#current,
        available: true,
        enabled: true,
        interfaceName,
        state: "connecting",
        error: undefined,
      }),
    );
    let networkId: string | undefined;
    try {
      networkId = parseNetworkId(
        (await this.#wpa(interfaceName, ["add_network"])).stdout,
      );
      await this.#expectOkay(interfaceName, [
        "set_network",
        networkId,
        "ssid",
        quoteWpaValue(ssid),
      ]);
      if (selected?.security === "enhanced-open")
        await this.#expectOkay(interfaceName, [
          "set_network",
          networkId,
          "key_mgmt",
          "OWE",
        ]);
      else if (password === undefined)
        await this.#expectOkay(interfaceName, [
          "set_network",
          networkId,
          "key_mgmt",
          "NONE",
        ]);
      else
        await this.#setPersonalPassword(
          interfaceName,
          networkId,
          password,
          selected?.flags,
        );
      await this.#expectOkay(interfaceName, ["enable_network", networkId]);
      await this.#expectOkay(interfaceName, ["select_network", networkId]);

      let connected = false;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await this.#delay(1_000);
        const status = parseProperties(
          (await this.#wpa(interfaceName, ["status"])).stdout,
        );
        if (status.get("wpa_state") === "COMPLETED") {
          connected = true;
          break;
        }
      }
      if (!connected) throw new Error("The network did not accept the connection.");
      await this.#execute({
        executable: "/sbin/udhcpc",
        arguments: [
          "-q",
          "-n",
          "-t",
          "3",
          "-T",
          "3",
          "-s",
          "/usr/share/udhcpc/default.script",
          "-i",
          interfaceName,
        ],
        timeoutMilliseconds: 20_000,
      });
      await this.#wpa(interfaceName, ["save_config"]);
      this.#current = Object.freeze({ ...this.#current, state: "disconnected" });
      return await this.snapshot();
    } catch (error: unknown) {
      if (networkId !== undefined)
        try {
          await this.#wpa(interfaceName, ["remove_network", networkId]);
        } catch {
          // Preserve the original connection error.
        }
      return this.#failure(interfaceName, error, "Unable to connect to this network.");
    }
  }

  public async disconnect(): Promise<WirelessNetworkSnapshot> {
    const interfaceName = await this.#requireInterface();
    try {
      await this.#expectOkay(interfaceName, ["disconnect"]);
      await this.#execute({
        executable: "/sbin/ip",
        arguments: ["address", "flush", "dev", interfaceName, "scope", "global"],
        timeoutMilliseconds: 5_000,
      });
      this.#current = Object.freeze({
        ...this.#current,
        state: "disconnected",
        connectedSsid: undefined,
        ipAddress: undefined,
      });
      return await this.snapshot();
    } catch (error: unknown) {
      return this.#failure(interfaceName, error, "Unable to disconnect Wi-Fi.");
    }
  }

  public subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    if (this.#timer === undefined) {
      this.#timer = setInterval(() => {
        void this.snapshot()
          .then(() => {
            for (const l of this.#listeners) l();
          })
          .catch(() => undefined);
      }, 10_000);
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

  async #interfaceName(): Promise<string | undefined> {
    return [...(await this.#discoverInterfaces())].sort()[0];
  }

  async #requireInterface(): Promise<string> {
    const interfaceName = await this.#interfaceName();
    if (interfaceName === undefined) throw new Error("No wireless adapter was detected.");
    return interfaceName;
  }

  async #ensureWpaSupplicant(interfaceName: string): Promise<void> {
    if (process.platform !== "linux") return;
    const socketPath = `/run/wpa_supplicant/${interfaceName}`;
    const exists = await access(socketPath).then(
      () => true,
      () => false,
    );
    if (exists) return;
    try {
      await this.#execute({
        executable: "/sbin/ip",
        arguments: ["link", "set", interfaceName, "up"],
        timeoutMilliseconds: 2_500,
      }).catch(() => undefined);
      await this.#execute({
        executable: "/sbin/wpa_supplicant",
        arguments: [
          "-B",
          "-i",
          interfaceName,
          "-c",
          "/var/lib/sevynos/wpa_supplicant.conf",
          "-D",
          "nl80211,wext",
        ],
        timeoutMilliseconds: 4_000,
      }).catch(() => undefined);
      for (let attempt = 0; attempt < 6; attempt += 1) {
        await this.#delay(250);
        if (
          await access(socketPath).then(
            () => true,
            () => false,
          )
        )
          break;
      }
    } catch {
      // Best effort on live system
    }
  }

  async #wpa(
    interfaceName: string,
    argumentsValue: readonly string[],
  ): Promise<LinuxCommandResult> {
    await this.#ensureWpaSupplicant(interfaceName);
    if (process.platform === "linux") {
      const socketPath = `/run/wpa_supplicant/${interfaceName}`;
      const socketReady = await access(socketPath).then(
        () => true,
        () => false,
      );
      if (!socketReady)
        throw new Error(`Wireless control socket at ${socketPath} is not available.`);
    }
    return this.#execute({
      executable: "/sbin/wpa_cli",
      arguments: ["-p", "/run/wpa_supplicant", "-i", interfaceName, ...argumentsValue],
      timeoutMilliseconds: 2_500,
    });
  }

  async #expectOkay(
    interfaceName: string,
    argumentsValue: readonly string[],
  ): Promise<void> {
    const result = await this.#wpa(interfaceName, argumentsValue);
    if (result.stdout.trim() !== "OK") {
      // wpa_cli may prepend "Selected interface 'wlan0'" or interactive prompts
      // before the actual OK/FAIL response. Check the last non-empty line.
      const lines = result.stdout.trim().split("\n");
      const lastLine = lines[lines.length - 1]?.trim() ?? "";
      if (lastLine !== "OK") throw new Error("The Wi-Fi service refused the request.");
    }
  }

  async #setPersonalPassword(
    interfaceName: string,
    networkId: string,
    password: string,
    flags?: string,
  ): Promise<void> {
    const keyMgmt = flags?.includes("SAE") && !flags.includes("PSK") ? "SAE" : "WPA-PSK";
    const result = await this.#execute({
      executable: "/sbin/wpa_cli",
      arguments: ["-p", "/run/wpa_supplicant", "-i", interfaceName],
      input: `set_network ${networkId} psk ${quoteWpaValue(password)}\nset_network ${networkId} key_mgmt ${keyMgmt}\nquit\n`,
      timeoutMilliseconds: 15_000,
    });
    if (result.stdout.includes("FAIL")) {
      const fallback = await this.#execute({
        executable: "/sbin/wpa_cli",
        arguments: ["-p", "/run/wpa_supplicant", "-i", interfaceName],
        input: `set_network ${networkId} psk ${quoteWpaValue(password)}\nset_network ${networkId} key_mgmt WPA-PSK\nquit\n`,
        timeoutMilliseconds: 15_000,
      });
      if (fallback.stdout.includes("FAIL"))
        throw new Error("The Wi-Fi password was rejected.");
    }
  }

  #failure(
    interfaceName: string,
    error: unknown,
    fallback: string,
  ): WirelessNetworkSnapshot {
    return this.#publish(
      Object.freeze({
        ...this.#current,
        available: true,
        enabled: true,
        interfaceName,
        state: "failed",
        error: friendlyError(error, fallback),
      }),
    );
  }

  #publish(snapshot: WirelessNetworkSnapshot): WirelessNetworkSnapshot {
    this.#current = snapshot;
    for (const listener of this.#listeners) listener();
    return snapshot;
  }
}

export async function discoverWirelessInterfaces(): Promise<readonly string[]> {
  const entries = await readdir("/sys/class/net", { withFileTypes: true }).catch(
    () => [],
  );
  const wireless: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    try {
      await access(`/sys/class/net/${entry.name}/wireless`).catch(() =>
        access(`/sys/class/net/${entry.name}/phy80211`),
      );
      wireless.push(entry.name);
    } catch {
      // Wired and virtual interfaces do not expose the wireless or phy80211 directory.
    }
  }
  return Object.freeze(wireless);
}

export function parseScanResults(
  output: string,
  connectedSsid?: string,
): readonly WirelessNetwork[] {
  const bySsid = new Map<string, WirelessNetwork>();
  for (const line of output.split(/\r?\n/).slice(1)) {
    if (line.trim() === "") continue;
    const [bssid, frequencyValue, signalValue, flags, ...ssidParts] = line.split("\t");
    const ssid = ssidParts.join("\t").trim();
    if (
      bssid === undefined ||
      frequencyValue === undefined ||
      signalValue === undefined ||
      flags === undefined ||
      ssid === ""
    )
      continue;
    const signal = signalPercent(Number(signalValue));
    const security = flags.includes("EAP")
      ? "enterprise"
      : flags.includes("WEP")
        ? "legacy"
        : flags.includes("OWE")
          ? "enhanced-open"
          : flags.includes("PSK") || flags.includes("SAE")
            ? "personal"
            : "open";
    const candidate: WirelessNetwork = Object.freeze({
      ssid,
      signal,
      secure: security !== "open",
      security,
      supported:
        security === "open" || security === "personal" || security === "enhanced-open",
      requiresPassword: security === "personal",
      connected: ssid === connectedSsid,
      frequency: Number(frequencyValue),
      flags,
    });
    const existing = bySsid.get(ssid);
    if (existing === undefined || candidate.signal > existing.signal)
      bySsid.set(ssid, candidate);
  }
  if (connectedSsid !== undefined && !bySsid.has(connectedSsid))
    bySsid.set(
      connectedSsid,
      Object.freeze({
        ssid: connectedSsid,
        signal: 0,
        secure: true,
        security: "personal",
        supported: true,
        requiresPassword: true,
        connected: true,
      }),
    );
  return Object.freeze(
    [...bySsid.values()].sort((first, second) =>
      first.connected === second.connected
        ? second.signal - first.signal || first.ssid.localeCompare(second.ssid)
        : first.connected
          ? -1
          : 1,
    ),
  );
}

export function parseProperties(output: string): ReadonlyMap<string, string> {
  const properties = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator > 0)
      properties.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return properties;
}

export function parseNetworkId(output: string): string {
  const networkId = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .findLast((line) => /^\d+$/.test(line));
  if (networkId === undefined) throw new Error("Unable to create a Wi-Fi profile.");
  return networkId;
}

export function executeLinuxCommand(
  request: LinuxCommandRequest,
): Promise<LinuxCommandResult> {
  return new Promise((resolve, reject) => {
    const trySpawn = (executable: string) => {
      const child = spawn(executable, [...request.arguments], {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        },
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        const killTimer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // Ignore SIGKILL failure if process has already terminated
          }
        }, 500);
        if (typeof killTimer === "object" && "unref" in killTimer) killTimer.unref();
      }, request.timeoutMilliseconds ?? 2_500);
      if (typeof timer === "object" && "unref" in timer) timer.unref();
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        if (error.code === "ENOENT" && executable.startsWith("/")) {
          const fallback = executable.split("/").pop();
          if (fallback && fallback !== executable) {
            trySpawn(fallback);
            return;
          }
        }
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut) reject(new Error("The system network request timed out."));
        else if (code !== 0)
          reject(new Error(stderr.trim() || "The system network request failed."));
        else resolve(Object.freeze({ stdout, stderr }));
      });
      child.stdin.end(request.input ?? "");
    };
    trySpawn(request.executable);
  });
}

function signalPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value >= 0) return Math.max(0, Math.min(100, Math.round(value)));
  return Math.max(0, Math.min(100, Math.round((value + 100) * 2)));
}

function validateSsid(ssid: string): void {
  const bytes = Buffer.byteLength(ssid, "utf8");
  if (bytes < 1 || bytes > 32 || /[\r\n\0]/.test(ssid))
    throw new Error("Wi-Fi names must contain between 1 and 32 bytes.");
}

function validatePassword(password: string | undefined): asserts password is string {
  if (password === undefined || password.length < 8 || password.length > 63)
    throw new Error("Wi-Fi passwords must contain between 8 and 63 characters.");
  if (!/^[\x20-\x7e]+$/.test(password))
    throw new Error("This version supports printable Wi-Fi passwords only.");
}

function quoteWpaValue(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function friendlyError(error: unknown, fallback: string): string {
  if (!(error instanceof Error) || error.message.trim() === "") return fallback;
  const message = error.message.trim();
  if (message.includes("Could not connect to wpa_supplicant"))
    return "The Wi-Fi service is still starting. Try again in a moment.";
  return message;
}
