import { useEffect, useState, type JSX } from "react";
import {
  NativeModules,
  Pressable,
  ScrollView,
  SevynIcon,
  StyleSheet,
  Text,
  TextInput,
  View,
  type SevynIconName,
  type SevynAudioService,
  type SevynBatteryService,
  type SevynPowerService,
  type SevynSystemService,
  type SevynTimeService,
  type TimeSyncState,
  type SevynWirelessNetworkService,
  type SavedWirelessNetwork,
  type WirelessNetworkSnapshot,
  type SevynApplicationManifest,
} from "@sevynos/react-native";
import type {
  OsUpdateService,
  StagedUpdate,
  UpdateCheckResult,
} from "@sevynos/os-update";

export const settingsManifest: SevynApplicationManifest = {
  manifestVersion: 1,
  id: "org.sevynos.settings",
  name: "Settings",
  version: "1.0.0",
  runtime: "react-native",
  applicationKey: "Settings",
  developer: "SevynOS",
  icon: "icons/settings.svg",
  entrypoint: "dist/index.js",
  minimumSevynOSVersion: "0.1.0",
  permissions: [],
  services: [],
  windowModes: ["standard"],
  instanceMode: "single",
};

export type SettingsCategory =
  | "appearance"
  | "display"
  | "network"
  | "bluetooth"
  | "sound"
  | "battery"
  | "datetime"
  | "applications"
  | "shortcuts"
  | "update"
  | "about";

export interface InstalledAppInfo {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly permissions?: readonly string[] | undefined;
  readonly system?: boolean | undefined;
  readonly icon?: string | undefined;
}

export const DEFAULT_INSTALLED_APPS: readonly InstalledAppInfo[] = [
  {
    id: "org.sevynos.shell",
    name: "Desktop Shell",
    version: "2.0.0",
    permissions: ["runtime:lifecycle", "runtime:windows", "system:power"],
    system: true,
  },
  {
    id: "org.sevynos.terminal",
    name: "Terminal",
    version: "1.0.0",
    permissions: ["filesystem.read", "filesystem.write"],
    system: true,
  },
  {
    id: "org.sevynos.browser",
    name: "Browser",
    version: "1.0.0",
    permissions: ["network:http", "storage:cookies"],
    system: false,
  },
  {
    id: "org.sevynos.files",
    name: "Files",
    version: "1.0.0",
    permissions: ["filesystem:user"],
    system: false,
  },
  {
    id: "org.sevynos.notes",
    name: "Notes",
    version: "1.0.0",
    permissions: ["storage:local"],
    system: false,
  },
  {
    id: "org.sevynos.text-editor",
    name: "Text Editor",
    version: "1.0.0",
    permissions: ["filesystem:user"],
    system: false,
  },
  {
    id: "org.sevynos.calculator",
    name: "Calculator",
    version: "1.0.0",
    permissions: [],
    system: false,
  },
  {
    id: "org.sevynos.settings",
    name: "Settings",
    version: "1.0.0",
    permissions: ["system:config", "hardware:query"],
    system: false,
  },
  {
    id: "org.sevynos.system-monitor",
    name: "System Monitor",
    version: "1.0.0",
    permissions: ["process:inspect", "hardware:query"],
    system: false,
  },
  {
    id: "org.sevynos.welcome",
    name: "Welcome",
    version: "1.0.0",
    permissions: [],
    system: false,
  },
  {
    id: "org.sevynos.camera",
    name: "Camera",
    version: "1.0.0",
    permissions: ["hardware:camera", "filesystem:user"],
    system: false,
  },
  {
    id: "org.sevynos.music",
    name: "Music",
    version: "1.0.0",
    permissions: ["hardware:media", "filesystem:user"],
    system: false,
  },
];

export function isAppProtected(app: InstalledAppInfo): boolean {
  return app.system === true;
}

export function canUninstallApp(app: InstalledAppInfo): boolean {
  return !app.system;
}

export interface SettingsModel {
  theme?: ("dark" | "light" | "system") | undefined;
  accentColor?: string | undefined;
  taskbarPosition?: ("bottom" | "top" | "left" | "right") | undefined;
  dockAutohide?: boolean | undefined;
  scaleFactor?: number | undefined;
  idleLockTimeoutMinutes?: number | undefined;
}

export interface SettingsApplicationProps {
  readonly settings?: SettingsModel | undefined;
  readonly network?: SevynWirelessNetworkService | undefined;
  readonly power?: SevynPowerService | undefined;
  readonly battery?: SevynBatteryService | undefined;
  readonly audio?: SevynAudioService | undefined;
  readonly time?: SevynTimeService | undefined;
  readonly system?: SevynSystemService | undefined;
  readonly update?: OsUpdateService | undefined;
  readonly onUpdateSetting?: ((key: string, value: unknown) => void) | undefined;
  readonly installedApplications?: readonly InstalledAppInfo[] | undefined;
  readonly onUninstallApp?: ((id: string) => void) | undefined;
  readonly onReinstallApp?: ((id: string) => void) | undefined;
}

const ACCENT_COLORS = [
  { name: "Sevyn Gold", value: "#D7AC57" },
  { name: "Obsidian Silver", value: "#A0AEC0" },
  { name: "Cyber Emerald", value: "#10B981" },
  { name: "Hyper Sapphire", value: "#3B82F6" },
  { name: "Neon Amethyst", value: "#8B5CF6" },
  { name: "Crimson Blaze", value: "#EF4444" },
];

/* ------------------------------------------------------------------ */
/* Phase 2 (c): Bluetooth / Display / Power view models and parsing.  */
/* The host adapters return `unknown`; these helpers coerce defensively */
/* so a malformed backend response can never crash the Settings UI.    */
/* ------------------------------------------------------------------ */

export interface BluetoothDeviceViewModel {
  readonly address: string;
  readonly name: string;
  readonly alias: string;
  readonly paired: boolean;
  readonly trusted: boolean;
  readonly connected: boolean;
  readonly rssi: number | null;
  readonly icon: SevynIconName;
}

export interface BluetoothAdapterViewModel {
  readonly available: boolean;
  readonly powered: boolean;
  readonly discovering: boolean;
  readonly name: string;
  readonly address: string;
}

export interface BluetoothPairOutcomeViewModel {
  readonly status: "paired" | "failed" | "confirm-passkey" | "pin-request";
  readonly prompt: string | null;
  readonly error: string | null;
}

export interface DisplayModeViewModel {
  readonly width: number;
  readonly height: number;
  readonly refreshHz: number | null;
}

export interface DisplayOutputViewModel {
  readonly id: string;
  readonly connected: boolean;
  readonly modes: readonly DisplayModeViewModel[];
  readonly configuredMode: DisplayModeViewModel | null;
  readonly rotation: 0 | 90 | 180 | 270;
}

export interface ChargeLimitViewModel {
  readonly supported: boolean;
  readonly battery: string | null;
  readonly startPct: number | null;
  readonly endPct: number | null;
}

const BLUETOOTH_ICON_NAMES: readonly SevynIconName[] = [
  "bluetooth",
  "monitor",
  "wifi",
  "music-note",
  "volume",
  "keyboard",
  "pointer",
  "controls",
  "image",
  "clock",
  "heart",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asBluetoothIcon(value: unknown): SevynIconName {
  return typeof value === "string" &&
    (BLUETOOTH_ICON_NAMES as readonly string[]).includes(value)
    ? (value as SevynIconName)
    : "bluetooth";
}

function parseBluetoothAdapter(value: unknown): BluetoothAdapterViewModel | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value["available"] !== "boolean") return undefined;
  return {
    available: value["available"],
    powered: value["powered"] === true,
    discovering: value["discovering"] === true,
    name: typeof value["name"] === "string" ? value["name"] : "",
    address: typeof value["address"] === "string" ? value["address"] : "",
  };
}

function parseBluetoothDevices(value: unknown): BluetoothDeviceViewModel[] {
  if (!Array.isArray(value)) return [];
  const devices: BluetoothDeviceViewModel[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry["address"] !== "string") continue;
    devices.push({
      address: entry["address"],
      name: typeof entry["name"] === "string" ? entry["name"] : entry["address"],
      alias: typeof entry["alias"] === "string" ? entry["alias"] : "",
      paired: entry["paired"] === true,
      trusted: entry["trusted"] === true,
      connected: entry["connected"] === true,
      rssi: typeof entry["rssi"] === "number" ? entry["rssi"] : null,
      icon: asBluetoothIcon(entry["icon"]),
    });
  }
  return devices;
}

function parsePairOutcome(value: unknown): BluetoothPairOutcomeViewModel | undefined {
  if (!isRecord(value) || typeof value["status"] !== "string") return undefined;
  const status = value["status"];
  if (
    status !== "paired" &&
    status !== "failed" &&
    status !== "confirm-passkey" &&
    status !== "pin-request"
  ) {
    return undefined;
  }
  return {
    status,
    prompt: typeof value["prompt"] === "string" ? value["prompt"] : null,
    error: typeof value["error"] === "string" ? value["error"] : null,
  };
}

function parseDisplayMode(value: unknown): DisplayModeViewModel | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value["width"] !== "number" || typeof value["height"] !== "number") {
    return undefined;
  }
  return {
    width: value["width"],
    height: value["height"],
    refreshHz: typeof value["refreshHz"] === "number" ? value["refreshHz"] : null,
  };
}

function parseDisplayOutputs(value: unknown): DisplayOutputViewModel[] {
  if (!Array.isArray(value)) return [];
  const outputs: DisplayOutputViewModel[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry["id"] !== "string") continue;
    const modes: DisplayModeViewModel[] = [];
    if (Array.isArray(entry["modes"])) {
      for (const mode of entry["modes"]) {
        const parsed = parseDisplayMode(mode);
        if (parsed) modes.push(parsed);
      }
    }
    const rotation =
      entry["rotation"] === 90 || entry["rotation"] === 180 || entry["rotation"] === 270
        ? entry["rotation"]
        : 0;
    outputs.push({
      id: entry["id"],
      connected: entry["connected"] === true,
      modes,
      configuredMode: parseDisplayMode(entry["configuredMode"]) ?? null,
      rotation,
    });
  }
  return outputs;
}

function parseChargeLimit(value: unknown): ChargeLimitViewModel | undefined {
  if (!isRecord(value) || typeof value["supported"] !== "boolean") return undefined;
  return {
    supported: value["supported"],
    battery: typeof value["battery"] === "string" ? value["battery"] : null,
    startPct: typeof value["startPct"] === "number" ? value["startPct"] : null,
    endPct: typeof value["endPct"] === "number" ? value["endPct"] : null,
  };
}

/**
 * Call a HardwareModules entry defensively: adapters throw
 * NativeModuleUnavailableError when the host did not install them (e.g. in
 * dev shells), and methods may be absent on older hosts.
 */
async function callHardware<T>(
  fn: () => Promise<T> | T | undefined,
): Promise<T | undefined> {
  try {
    const result = fn();
    if (result === undefined) return undefined;
    return await result;
  } catch {
    return undefined;
  }
}

function hardwareErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "The operation failed.";
}

export interface SystemShortcutEntry {
  readonly label: string;
  readonly keys: string;
  readonly description: string;
}

export interface SystemShortcutGroup {
  readonly category: string;
  readonly shortcuts: readonly SystemShortcutEntry[];
}

export const SYSTEM_SHORTCUTS: readonly SystemShortcutGroup[] = [
  {
    category: "Window Management",
    shortcuts: [
      {
        label: "Close Window",
        keys: "Alt + F4",
        description: "Close the currently focused window",
      },
      {
        label: "Minimize Window",
        keys: "Super + ↓",
        description: "Minimize window to the dock",
      },
      {
        label: "Maximize / Restore",
        keys: "Super + ↑",
        description: "Toggle window between maximized and normal bounds",
      },
      {
        label: "Snap Left (Half)",
        keys: "Super + ←",
        description: "Snap window to the left half of the display",
      },
      {
        label: "Snap Right (Half)",
        keys: "Super + →",
        description: "Snap window to the right half of the display",
      },
      {
        label: "Snap Top-Left (Quarter)",
        keys: "Super + Alt + ←",
        description: "Snap window to the top-left quarter",
      },
      {
        label: "Snap Top-Right (Quarter)",
        keys: "Super + Alt + →",
        description: "Snap window to the top-right quarter",
      },
      {
        label: "Snap Bottom-Left (Quarter)",
        keys: "Super + Alt + ↓",
        description: "Snap window to the bottom-left quarter",
      },
      {
        label: "Snap Bottom-Right (Quarter)",
        keys: "Super + Alt + ↑",
        description: "Snap window to the bottom-right quarter",
      },
      {
        label: "Window Switcher",
        keys: "Alt + Tab",
        description: "Cycle through open windows in MRU order",
      },
      {
        label: "Window Switcher (Reverse)",
        keys: "Alt + Shift + Tab",
        description: "Cycle backwards through open windows",
      },
    ],
  },
  {
    category: "System & Shell",
    shortcuts: [
      {
        label: "App Launcher",
        keys: "Super + Space",
        description: "Open or close the application launcher",
      },
      {
        label: "Lock Screen",
        keys: "Super + L",
        description: "Immediately lock the screen",
      },
      {
        label: "Copy",
        keys: "Ctrl + C",
        description: "Copy selected content to clipboard",
      },
      {
        label: "Cut",
        keys: "Ctrl + X",
        description: "Cut selected content to clipboard",
      },
      { label: "Paste", keys: "Ctrl + V", description: "Paste content from clipboard" },
      {
        label: "Select All",
        keys: "Ctrl + A",
        description: "Select all content in the focused element",
      },
      { label: "Undo", keys: "Ctrl + Z", description: "Undo the last action" },
      { label: "Redo", keys: "Ctrl + Shift + Z", description: "Redo the undone action" },
      { label: "Save", keys: "Ctrl + S", description: "Save current document or state" },
    ],
  },
  {
    category: "Workspaces",
    shortcuts: [
      {
        label: "Switch to Workspace 1..4",
        keys: "Super + 1..4",
        description: "Switch active desktop workspace",
      },
      {
        label: "Move Window to Workspace 1..4",
        keys: "Super + Shift + 1..4",
        description: "Move focused window directly to workspace",
      },
      {
        label: "Move Window Left",
        keys: "Super + Shift + ←",
        description: "Move focused window to the previous workspace",
      },
      {
        label: "Move Window Right",
        keys: "Super + Shift + →",
        description: "Move focused window to the next workspace",
      },
    ],
  },
];

export function SettingsApplication({
  settings = {},
  battery,
  audio,
  time,
  network,
  power,
  update,
  onUpdateSetting,
  installedApplications,
  onUninstallApp,
  onReinstallApp,
}: SettingsApplicationProps): JSX.Element {
  const [activeCategory, setActiveCategory] = useState<SettingsCategory>("appearance");
  const [themeMode, setThemeMode] = useState<string>(settings.theme ?? "dark");
  const [selectedAccent, setSelectedAccent] = useState<string>(
    settings.accentColor ?? "#D7AC57",
  );
  const [volumeLevel, setVolumeLevel] = useState<number>(75);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [wifiEnabled, setWifiEnabled] = useState<boolean>(true);
  const [wifiSnapshot, setWifiSnapshot] = useState<WirelessNetworkSnapshot>({
    available: true,
    enabled: true,
    state: "disconnected",
    networks: [],
  });
  const [selectedSsid, setSelectedSsid] = useState<string | null>(null);
  const [wifiPassword, setWifiPassword] = useState<string>("");
  const [wifiBusy, setWifiBusy] = useState<boolean>(false);
  const [wifiError, setWifiError] = useState<string | null>(null);
  const [savedNetworks, setSavedNetworks] = useState<readonly SavedWirelessNetwork[]>([]);
  const [updateStatus, setUpdateStatus] = useState<string>("idle");
  const [updateResult, setUpdateResult] = useState<UpdateCheckResult | undefined>(
    undefined,
  );
  const [updateBusy, setUpdateBusy] = useState<boolean>(false);
  const [stagedUpdate, setStagedUpdate] = useState<StagedUpdate | undefined>(undefined);
  const [downloadProgress, setDownloadProgress] = useState<
    { received: number; total: number } | undefined
  >(undefined);
  const [batteryPercent, setBatteryPercent] = useState<number>(85);
  const [isCharging, setIsCharging] = useState<boolean>(true);
  const [timeState, setTimeState] = useState<TimeSyncState>({
    available: false,
    syncing: false,
    timezone: "UTC",
  });
  const [timezoneInput, setTimezoneInput] = useState<string>("");
  const [apps, setApps] = useState<readonly InstalledAppInfo[]>(
    installedApplications ?? DEFAULT_INSTALLED_APPS,
  );
  const [idleLockTimeout, setIdleLockTimeout] = useState<number>(
    settings.idleLockTimeoutMinutes ?? 0,
  );
  const [appActionError, setAppActionError] = useState<string | null>(null);
  const [appActionSuccess, setAppActionSuccess] = useState<string | null>(null);

  /* ---------------- Phase 2 (c): Bluetooth state ---------------- */
  const [btAdapter, setBtAdapter] = useState<BluetoothAdapterViewModel | undefined>(
    undefined,
  );
  const [btDevices, setBtDevices] = useState<BluetoothDeviceViewModel[]>([]);
  const [btScanning, setBtScanning] = useState(false);
  const [btError, setBtError] = useState<string | null>(null);
  const [btBusyAddress, setBtBusyAddress] = useState<string | null>(null);
  const [btPairing, setBtPairing] = useState<{
    readonly address: string;
    readonly name: string;
    readonly prompt: string;
    readonly pinRequired: boolean;
  } | null>(null);
  const [btPin, setBtPin] = useState("");

  /* ---------------- Phase 2 (c): Display state ---------------- */
  const [displayOutputs, setDisplayOutputs] = useState<DisplayOutputViewModel[]>([]);
  const [displayError, setDisplayError] = useState<string | null>(null);
  const [displayRestartNeeded, setDisplayRestartNeeded] = useState(false);
  const [brightnessLevel, setBrightnessLevel] = useState(1);

  /* ---------------- Phase 2 (c): Power extras state ---------------- */
  const [chargeLimit, setChargeLimit] = useState<ChargeLimitViewModel | undefined>(
    undefined,
  );
  const [lidAction, setLidActionState] = useState<"sleep" | "nothing">("sleep");
  const [lidStateText, setLidStateText] = useState<string>("unknown");
  const [powerExtrasError, setPowerExtrasError] = useState<string | null>(null);

  const btHardware = NativeModules.HardwareModules.bluetooth;
  const displayHardware = NativeModules.HardwareModules.display;
  const powerHardware = NativeModules.HardwareModules.power;

  const refreshBluetooth = async () => {
    setBtError(null);
    const adapter = parseBluetoothAdapter(
      await callHardware(() => btHardware.getState()),
    );
    setBtAdapter(adapter);
    if (adapter?.available && adapter.powered) {
      setBtDevices(
        parseBluetoothDevices(await callHardware(() => btHardware.listDevices())),
      );
    } else {
      setBtDevices([]);
    }
  };

  const handleBluetoothPower = async (next: boolean) => {
    setBtError(null);
    try {
      await btHardware.setPowered(next);
      await refreshBluetooth();
    } catch (error: unknown) {
      setBtError(hardwareErrorMessage(error));
      await refreshBluetooth();
    }
  };

  const handleBluetoothScan = async () => {
    if (btScanning) return;
    setBtScanning(true);
    setBtError(null);
    try {
      await btHardware.scan();
      await refreshBluetooth();
    } catch (error: unknown) {
      setBtError(hardwareErrorMessage(error));
    } finally {
      setBtScanning(false);
    }
  };

  const handleBluetoothPair = async (device: BluetoothDeviceViewModel) => {
    if (btBusyAddress !== null) return;
    setBtBusyAddress(device.address);
    setBtError(null);
    try {
      const outcome = parsePairOutcome(await btHardware.pair(device.address));
      if (outcome === undefined) {
        setBtError("Bluetooth is unavailable on this device.");
      } else if (outcome.status === "paired") {
        await refreshBluetooth();
      } else if (
        outcome.status === "confirm-passkey" ||
        outcome.status === "pin-request"
      ) {
        setBtPin("");
        setBtPairing({
          address: device.address,
          name: device.name,
          prompt: outcome.prompt ?? "Confirm pairing on the device.",
          pinRequired: outcome.status === "pin-request",
        });
      } else {
        setBtError(outcome.error ?? "Pairing failed.");
      }
    } catch (error: unknown) {
      setBtError(hardwareErrorMessage(error));
    } finally {
      setBtBusyAddress(null);
    }
  };

  const handlePairRespond = async (accept: boolean) => {
    if (btPairing === null) return;
    const pairing = btPairing;
    setBtBusyAddress(pairing.address);
    try {
      const outcome = parsePairOutcome(
        await btHardware.respondToPairing(accept, btPin === "" ? undefined : btPin),
      );
      setBtPairing(null);
      setBtPin("");
      if (outcome === undefined) {
        setBtError("Bluetooth is unavailable on this device.");
      } else if (outcome.status === "paired") {
        await refreshBluetooth();
      } else if (outcome.status !== "failed" || !accept) {
        await refreshBluetooth();
      } else {
        setBtError(outcome.error ?? "Pairing failed.");
      }
    } catch (error: unknown) {
      setBtError(hardwareErrorMessage(error));
      setBtPairing(null);
    } finally {
      setBtBusyAddress(null);
    }
  };

  const handleBluetoothDeviceAction = async (
    device: BluetoothDeviceViewModel,
    action: "connect" | "disconnect" | "remove",
  ) => {
    if (btBusyAddress !== null) return;
    setBtBusyAddress(device.address);
    setBtError(null);
    try {
      if (action === "connect") await btHardware.connect(device.address);
      else if (action === "disconnect") await btHardware.disconnect(device.address);
      else await btHardware.remove(device.address);
      await refreshBluetooth();
    } catch (error: unknown) {
      setBtError(hardwareErrorMessage(error));
    } finally {
      setBtBusyAddress(null);
    }
  };

  const refreshDisplay = async () => {
    setDisplayError(null);
    setDisplayOutputs(
      parseDisplayOutputs(await callHardware(() => displayHardware.getOutputs())),
    );
    const level = await callHardware(() => displayHardware.getBrightness());
    if (typeof level === "number") setBrightnessLevel(level);
  };

  const handleDisplayMode = async (outputId: string, mode: DisplayModeViewModel) => {
    setDisplayError(null);
    try {
      await displayHardware.setMode(
        outputId,
        mode.refreshHz === null
          ? { width: mode.width, height: mode.height }
          : {
              width: mode.width,
              height: mode.height,
              refreshHz: mode.refreshHz,
            },
      );
      setDisplayRestartNeeded(true);
      await refreshDisplay();
    } catch (error: unknown) {
      setDisplayError(hardwareErrorMessage(error));
    }
  };

  const handleDisplayRotation = async (outputId: string, degrees: 0 | 90 | 180 | 270) => {
    setDisplayError(null);
    try {
      await displayHardware.setRotation(outputId, degrees);
      setDisplayRestartNeeded(true);
      await refreshDisplay();
    } catch (error: unknown) {
      setDisplayError(hardwareErrorMessage(error));
    }
  };

  const handleBrightnessChange = async (next: number) => {
    const clamped = Math.max(0.05, Math.min(1, next));
    setBrightnessLevel(clamped);
    try {
      await displayHardware.setBrightness(clamped);
    } catch (error: unknown) {
      setDisplayError(hardwareErrorMessage(error));
    }
  };

  const refreshPowerExtras = async () => {
    setPowerExtrasError(null);
    setChargeLimit(
      parseChargeLimit(await callHardware(() => powerHardware.getChargeLimit())),
    );
    const action = await callHardware(() => powerHardware.getLidAction());
    if (action === "sleep" || action === "nothing") setLidActionState(action);
    const lid = await callHardware(() => powerHardware.getLidState());
    if (typeof lid === "string") setLidStateText(lid);
  };

  const handleLidActionChange = async (action: "sleep" | "nothing") => {
    setLidActionState(action);
    try {
      await powerHardware.setLidAction(action);
    } catch (error: unknown) {
      setPowerExtrasError(hardwareErrorMessage(error));
    }
  };

  const handleChargeLimitChange = async (endPct: number) => {
    const clamped = Math.max(1, Math.min(100, Math.round(endPct)));
    try {
      const updated = parseChargeLimit(
        await powerHardware.setChargeLimit({ endPct: clamped }),
      );
      if (updated) setChargeLimit(updated);
    } catch (error: unknown) {
      setPowerExtrasError(hardwareErrorMessage(error));
    }
  };

  const handleSleepNow = () => {
    void power?.sleep?.();
  };

  // Load pane data when its category becomes active.
  useEffect(() => {
    if (activeCategory === "bluetooth" && btAdapter === undefined) {
      void refreshBluetooth();
    }
    if (activeCategory === "display" && displayOutputs.length === 0) {
      void refreshDisplay();
    }
    if (activeCategory === "battery" && chargeLimit === undefined) {
      void refreshPowerExtras();
    }
    // Intentionally keyed on category only: pane data loads on first visit.
  }, [activeCategory]);

  const handleIdleLockChange = (minutes: number) => {
    setIdleLockTimeout(minutes);
    onUpdateSetting?.("idleLockTimeoutMinutes", minutes);
  };

  useEffect(() => {
    if (audio) {
      void audio.snapshot().then((snap) => {
        setVolumeLevel(snap.volume);
        setIsMuted(snap.muted);
      });
    }
    if (battery) {
      void battery.snapshot().then((snap) => {
        setBatteryPercent(snap.percent);
        setIsCharging(snap.charging);
      });
    }
    if (time) {
      void time.snapshot().then((snap) => {
        setTimeState(snap);
        setTimezoneInput(snap.timezone);
      });
      return time.subscribe(() => {
        void time.snapshot().then(setTimeState);
      });
    }
    return undefined;
  }, [audio, battery, time]);

  useEffect(() => {
    if (!update) return undefined;
    setUpdateStatus(update.status);
    setUpdateResult(update.lastResult);
    return update.subscribe(() => {
      setUpdateStatus(update.status);
      setUpdateResult(update.lastResult);
    });
  }, [update]);

  const handleCheckForUpdates = () => {
    if (!update || updateBusy) return;
    setUpdateBusy(true);
    void update
      .checkNow()
      .catch((error: unknown) => {
        console.warn("update check failed:", error);
      })
      .finally(() => {
        setUpdateBusy(false);
      });
  };

  const handleDownloadUpdate = () => {
    if (!update || updateStatus === "downloading") return;
    setDownloadProgress({ received: 0, total: 0 });
    void update
      .downloadUpdate((received, total) => {
        setDownloadProgress({ received, total });
      })
      .then((staged) => {
        setStagedUpdate(staged);
        setDownloadProgress(undefined);
      })
      .catch((error: unknown) => {
        console.warn("update download failed:", error);
        setDownloadProgress(undefined);
      });
  };

  const handleInstallUpdate = () => {
    if (!update || !stagedUpdate) return;
    void update
      .applyUpdate(stagedUpdate)
      .then(() => power?.restart?.())
      .catch((error: unknown) => {
        console.warn("update apply failed:", error);
      });
  };

  const handleReboot = () => {
    void power?.restart?.();
  };

  const handleTimezoneSave = () => {
    if (!time || timezoneInput.trim().length === 0) return;
    void time
      .setTimezone(timezoneInput.trim())
      .then((snap) => {
        setTimeState(snap);
        setTimezoneInput(snap.timezone);
      })
      .catch((error: unknown) => {
        console.warn("time.setTimezone failed:", error);
      });
  };

  const handleSyncNow = () => {
    if (!time) return;
    void time
      .syncNow()
      .then(setTimeState)
      .catch((error: unknown) => {
        console.warn("time.syncNow failed:", error);
      });
  };

  const canManageSavedNetworks =
    network !== undefined &&
    typeof network.savedNetworks === "function" &&
    typeof network.forgetNetwork === "function";

  const loadSavedNetworks = () => {
    if (network === undefined || typeof network.savedNetworks !== "function") return;
    void network
      .savedNetworks()
      .then(setSavedNetworks)
      .catch(() => undefined);
  };

  useEffect(() => {
    if (!network) return undefined;
    let active = true;
    const refresh = () => {
      void network
        .snapshot()
        .then((snap) => {
          if (active) {
            setWifiSnapshot(snap);
            setWifiEnabled(snap.enabled);
            if (snap.error) setWifiError(snap.error);
          }
        })
        .catch((err: unknown) => {
          if (active) {
            setWifiError(err instanceof Error ? err.message : "Wi-Fi query failed.");
          }
        });
    };
    refresh();
    loadSavedNetworks();
    void network.scan().catch(() => undefined);
    const unsubscribe = network.subscribe(refresh);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [network]);

  const handleScan = () => {
    if (!network || wifiBusy) return;
    setWifiBusy(true);
    setWifiError(null);
    void network
      .scan()
      .then((snap) => {
        setWifiSnapshot(snap);
      })
      .catch((err: unknown) => {
        setWifiError(err instanceof Error ? err.message : "Scan failed.");
      })
      .finally(() => {
        setWifiBusy(false);
      });
  };

  const handleWifiEnabledChange = () => {
    if (!network || wifiBusy) return;
    const enabled = !wifiEnabled;
    setWifiBusy(true);
    setWifiError(null);
    const operation = network.setEnabled?.(enabled);
    if (!operation) {
      setWifiEnabled(enabled);
      setWifiBusy(false);
      return;
    }
    void operation
      .then((snapshot) => {
        setWifiSnapshot(snapshot);
        setWifiEnabled(snapshot.enabled);
      })
      .catch((error: unknown) => {
        setWifiError(
          error instanceof Error ? error.message : "Wi-Fi power change failed.",
        );
      })
      .finally(() => {
        setWifiBusy(false);
      });
  };

  const handleConnect = (ssid: string, pwd?: string) => {
    if (!network || wifiBusy) return;
    setWifiBusy(true);
    setWifiError(null);
    void network
      .connect(ssid, pwd)
      .then((snap) => {
        setWifiSnapshot(snap);
        loadSavedNetworks();
        if (snap.state === "connected") {
          setSelectedSsid(null);
          setWifiPassword("");
        }
      })
      .catch((err: unknown) => {
        setWifiError(err instanceof Error ? err.message : "Connection failed.");
      })
      .finally(() => {
        setWifiBusy(false);
      });
  };

  const handleDisconnect = () => {
    if (!network || wifiBusy) return;
    setWifiBusy(true);
    setWifiError(null);
    void network
      .disconnect()
      .then((snap) => {
        setWifiSnapshot(snap);
        loadSavedNetworks();
      })
      .catch((err: unknown) => {
        setWifiError(err instanceof Error ? err.message : "Disconnect failed.");
      })
      .finally(() => {
        setWifiBusy(false);
      });
  };

  const handleForgetNetwork = (networkId: string) => {
    const service = network;
    if (!service || typeof service.forgetNetwork !== "function" || wifiBusy) return;
    setWifiBusy(true);
    setWifiError(null);
    void service
      .forgetNetwork(networkId)
      .then((list) => {
        setSavedNetworks(list);
      })
      .catch((err: unknown) => {
        setWifiError(
          err instanceof Error ? err.message : "Could not forget this network.",
        );
      })
      .finally(() => {
        setWifiBusy(false);
      });
  };

  const handleAccentChange = (color: string) => {
    setSelectedAccent(color);
    onUpdateSetting?.("accentColor", color);
  };

  const handleThemeChange = (mode: string) => {
    setThemeMode(mode);
    onUpdateSetting?.("theme", mode);
  };

  const handleVolumeChange = (newVol: number) => {
    const clamped = Math.max(0, Math.min(100, newVol));
    setVolumeLevel(clamped);
    if (audio) {
      void audio.setVolume(clamped).catch((error: unknown) => {
        console.warn("audio.setVolume failed:", error);
      });
    }
  };

  const toggleMute = () => {
    const nextMuted = !isMuted;
    setIsMuted(nextMuted);
    if (audio) {
      void audio.setMuted(nextMuted).catch((error: unknown) => {
        console.warn("audio.setMuted failed:", error);
      });
    }
  };

  return (
    <View
      accessibilityRole="application"
      accessibilityLabel="Settings"
      style={styles.container}
    >
      {/* Left Sidebar */}
      <View style={styles.sidebar}>
        <View style={styles.sidebarHeader}>
          <Text style={styles.sidebarTitle}>System Settings</Text>
        </View>

        <ScrollView style={styles.navList}>
          <SidebarItem
            active={activeCategory === "appearance"}
            icon="appearance"
            label="Appearance"
            onPress={() => {
              setActiveCategory("appearance");
            }}
          />
          <SidebarItem
            active={activeCategory === "display"}
            icon="display"
            label="Display"
            onPress={() => {
              setActiveCategory("display");
            }}
          />
          <SidebarItem
            active={activeCategory === "network"}
            icon="wifi"
            label="Network & Wi-Fi"
            onPress={() => {
              setActiveCategory("network");
            }}
          />
          <SidebarItem
            active={activeCategory === "bluetooth"}
            icon="bluetooth"
            label="Bluetooth"
            onPress={() => {
              setActiveCategory("bluetooth");
            }}
          />
          <SidebarItem
            active={activeCategory === "sound"}
            icon="volume"
            label="Sound & Audio"
            onPress={() => {
              setActiveCategory("sound");
            }}
          />
          <SidebarItem
            active={activeCategory === "battery"}
            icon="battery"
            label="Power & Battery"
            onPress={() => {
              setActiveCategory("battery");
            }}
          />
          <SidebarItem
            active={activeCategory === "datetime"}
            icon="clock"
            label="Date & Time"
            onPress={() => {
              setActiveCategory("datetime");
            }}
          />
          <SidebarItem
            active={activeCategory === "applications"}
            icon="package"
            label="Applications"
            onPress={() => {
              setActiveCategory("applications");
            }}
          />
          <SidebarItem
            active={activeCategory === "shortcuts"}
            icon="keyboard"
            label="Keyboard Shortcuts"
            onPress={() => {
              setActiveCategory("shortcuts");
            }}
          />
          <SidebarItem
            active={activeCategory === "update"}
            icon="download"
            label="Software Update"
            onPress={() => {
              setActiveCategory("update");
            }}
          />
          <SidebarItem
            active={activeCategory === "about"}
            icon="info"
            label="About SevynOS"
            onPress={() => {
              setActiveCategory("about");
            }}
          />
        </ScrollView>
      </View>

      {/* Main Settings Panel */}
      <View style={styles.mainPanel}>
        <ScrollView style={styles.panelScroll}>
          {activeCategory === "appearance" && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Appearance & Personalization</Text>
              <Text style={styles.sectionSubtitle}>
                Customize the visual aesthetics, theme, and color accents of SevynOS.
              </Text>

              {/* Theme Mode Card */}
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Desktop Theme</Text>
                <View style={styles.segmentedControl}>
                  {["dark", "light", "system"].map((mode) => (
                    <Pressable
                      key={mode}
                      action="theme"
                      value={mode}
                      onPress={() => {
                        handleThemeChange(mode);
                      }}
                      style={
                        themeMode === mode
                          ? styles.segmentButtonActive
                          : styles.segmentButton
                      }
                    >
                      <Text
                        style={
                          themeMode === mode
                            ? styles.segmentTextActive
                            : styles.segmentText
                        }
                      >
                        {mode.charAt(0).toUpperCase() + mode.slice(1)}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </View>

              {/* Accent Color Card */}
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Accent Color</Text>
                <Text style={styles.cardDesc}>
                  Select the primary accent color used across the dock, buttons, and
                  indicators.
                </Text>
                <View style={styles.accentGrid}>
                  {ACCENT_COLORS.map((accent) => (
                    <Pressable
                      key={accent.value}
                      onPress={() => {
                        handleAccentChange(accent.value);
                      }}
                      style={{
                        ...styles.accentSwatch,
                        backgroundColor: accent.value,
                        ...(selectedAccent === accent.value
                          ? styles.accentSwatchActive
                          : {}),
                      }}
                    >
                      {selectedAccent === accent.value && (
                        <SevynIcon name="check" size={16} color="#000000" />
                      )}
                    </Pressable>
                  ))}
                </View>
              </View>

              {/* Dock Behavior */}
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Dock & Taskbar</Text>
                <View style={styles.rowBetween}>
                  <Text style={styles.settingLabel}>Position</Text>
                  <Text style={styles.settingValue}>Bottom (Default)</Text>
                </View>
                <View style={styles.rowBetween}>
                  <Text style={styles.settingLabel}>Specular Glass Effect</Text>
                  <Text style={styles.settingValue}>Enabled</Text>
                </View>
              </View>

              {/* Idle Screen Lock */}
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Idle Screen Lock</Text>
                <Text style={styles.cardDesc}>
                  Automatically lock the screen after a period of inactivity.
                </Text>
                <View style={styles.segmentedControl}>
                  {[
                    { label: "Never", value: 0 },
                    { label: "1m", value: 1 },
                    { label: "5m", value: 5 },
                    { label: "10m", value: 10 },
                    { label: "15m", value: 15 },
                    { label: "30m", value: 30 },
                  ].map((option) => (
                    <Pressable
                      key={String(option.value)}
                      onPress={() => {
                        handleIdleLockChange(option.value);
                      }}
                      style={
                        idleLockTimeout === option.value
                          ? styles.segmentButtonActive
                          : styles.segmentButton
                      }
                    >
                      <Text
                        style={
                          idleLockTimeout === option.value
                            ? styles.segmentTextActive
                            : styles.segmentText
                        }
                      >
                        {option.label}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            </View>
          )}

          {activeCategory === "display" && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Display</Text>
              <Text style={styles.sectionSubtitle}>
                Resolution, rotation, and brightness. Modes are read from the connected
                displays themselves.
              </Text>

              {displayError !== null && (
                <View style={styles.card}>
                  <Text style={styles.errorText}>{displayError}</Text>
                </View>
              )}

              {displayOutputs.filter((output) => output.connected).length === 0 && (
                <View style={styles.card}>
                  <Text style={styles.cardDesc}>
                    No connected displays were detected.
                  </Text>
                  <Pressable
                    onPress={() => {
                      void refreshDisplay();
                    }}
                    style={styles.muteButton}
                  >
                    <Text style={styles.muteButtonText}>Refresh</Text>
                  </Pressable>
                </View>
              )}

              {displayOutputs
                .filter((output) => output.connected)
                .map((output) => (
                  <View key={output.id} style={styles.card}>
                    <View style={styles.rowBetween}>
                      <View>
                        <Text style={styles.cardTitle}>{output.id}</Text>
                        <Text style={styles.cardDesc}>Connected display</Text>
                      </View>
                      <Pressable
                        onPress={() => {
                          void refreshDisplay();
                        }}
                        style={styles.muteButton}
                      >
                        <Text style={styles.muteButtonText}>Refresh</Text>
                      </Pressable>
                    </View>

                    <Text style={styles.groupLabel}>Resolution</Text>
                    <View style={styles.modeGrid}>
                      {output.modes.map((mode) => {
                        const label =
                          `${String(mode.width)} × ${String(mode.height)}` +
                          (mode.refreshHz !== null
                            ? ` · ${String(Math.round(mode.refreshHz))} Hz`
                            : "");
                        const active =
                          output.configuredMode !== null &&
                          output.configuredMode.width === mode.width &&
                          output.configuredMode.height === mode.height;
                        return (
                          <Pressable
                            key={label}
                            onPress={() => {
                              void handleDisplayMode(output.id, mode);
                            }}
                            style={active ? styles.muteButtonActive : styles.muteButton}
                          >
                            <Text style={styles.muteButtonText}>{label}</Text>
                          </Pressable>
                        );
                      })}
                      {output.modes.length === 0 && (
                        <Text style={styles.cardDesc}>
                          This display reported no modes.
                        </Text>
                      )}
                    </View>

                    <Text style={styles.groupLabel}>Rotation</Text>
                    <View style={styles.segmentedControl}>
                      {([0, 90, 180, 270] as const).map((degrees) => (
                        <Pressable
                          key={String(degrees)}
                          onPress={() => {
                            void handleDisplayRotation(output.id, degrees);
                          }}
                          style={
                            output.rotation === degrees
                              ? styles.segmentButtonActive
                              : styles.segmentButton
                          }
                        >
                          <Text
                            style={
                              output.rotation === degrees
                                ? styles.segmentTextActive
                                : styles.segmentText
                            }
                          >
                            {degrees}°
                          </Text>
                        </Pressable>
                      ))}
                    </View>
                  </View>
                ))}

              {displayRestartNeeded && (
                <View style={styles.card}>
                  <View style={styles.rowBetween}>
                    <View>
                      <Text style={styles.cardTitle}>Restart required</Text>
                      <Text style={styles.cardDesc}>
                        Resolution and rotation changes apply after a restart.
                      </Text>
                    </View>
                    <Pressable onPress={handleReboot} style={styles.muteButton}>
                      <Text style={styles.muteButtonText}>Restart now</Text>
                    </Pressable>
                  </View>
                </View>
              )}

              <View style={styles.card}>
                <View style={styles.rowBetween}>
                  <Text style={styles.cardTitle}>Brightness</Text>
                  <Text style={styles.settingValue}>
                    {Math.round(brightnessLevel * 100)}%
                  </Text>
                </View>
                <View style={styles.volumeControls}>
                  <Pressable
                    onPress={() => {
                      void handleBrightnessChange(brightnessLevel - 0.1);
                    }}
                    style={styles.volumeStepButton}
                  >
                    <Text style={styles.stepButtonText}>-</Text>
                  </Pressable>
                  <View style={styles.volumeBar}>
                    <View
                      style={{ ...styles.volumeFill, width: brightnessLevel * 200 }}
                    />
                  </View>
                  <Pressable
                    onPress={() => {
                      void handleBrightnessChange(brightnessLevel + 0.1);
                    }}
                    style={styles.volumeStepButton}
                  >
                    <Text style={styles.stepButtonText}>+</Text>
                  </Pressable>
                </View>
              </View>

              <View style={styles.card}>
                <Text style={styles.cardTitle}>Night Light</Text>
                <Text style={styles.cardDesc}>
                  Not available on this device: the system compositor does not expose
                  gamma or color-temperature control.
                </Text>
              </View>
            </View>
          )}

          {activeCategory === "network" && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Network & Wi-Fi</Text>
              <Text style={styles.sectionSubtitle}>
                Manage wireless networking and internet connectivity.
              </Text>

              {wifiError && (
                <View style={styles.wifiErrorBanner}>
                  <Text style={styles.wifiErrorText}>{wifiError}</Text>
                </View>
              )}

              <View style={styles.card}>
                <View style={styles.rowBetween}>
                  <View>
                    <Text style={styles.cardTitle}>Wi-Fi Adapter</Text>
                    <Text style={styles.cardDesc}>
                      {wifiEnabled
                        ? wifiSnapshot.interfaceName
                          ? `Active (${wifiSnapshot.interfaceName})`
                          : "Active"
                        : "Wi-Fi is turned off"}
                    </Text>
                  </View>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={wifiEnabled ? "Turn Wi-Fi off" : "Turn Wi-Fi on"}
                    disabled={wifiBusy || !wifiSnapshot.available}
                    onPress={handleWifiEnabledChange}
                    style={wifiEnabled ? styles.toggleButtonActive : styles.toggleButton}
                  >
                    <Text style={styles.toggleText}>{wifiEnabled ? "ON" : "OFF"}</Text>
                  </Pressable>
                </View>
              </View>

              <View style={styles.card}>
                <View style={styles.rowBetween}>
                  <Text style={styles.cardTitle}>Available Networks</Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Scan for Wi-Fi networks"
                    disabled={wifiBusy || !wifiEnabled}
                    onPress={handleScan}
                    style={
                      wifiBusy || !wifiEnabled
                        ? { ...styles.scanButton, ...styles.buttonDisabled }
                        : styles.scanButton
                    }
                  >
                    <Text style={styles.scanButtonText}>
                      {wifiBusy ? "Scanning..." : "Scan Networks"}
                    </Text>
                  </Pressable>
                </View>

                {wifiSnapshot.networks.length === 0 ? (
                  <View style={styles.emptyNetworks}>
                    <Text style={styles.emptyNetworksText}>
                      {wifiBusy
                        ? "Scanning for nearby Wi-Fi networks..."
                        : wifiSnapshot.available
                          ? "No Wi-Fi networks found. Click 'Scan Networks' to search."
                          : "Wi-Fi adapter is currently unavailable."}
                    </Text>
                  </View>
                ) : (
                  wifiSnapshot.networks.map((net) => {
                    const isConnected =
                      wifiSnapshot.state === "connected" &&
                      (wifiSnapshot.connectedSsid === net.ssid || net.connected);
                    const isSelected = selectedSsid === net.ssid;
                    const isConnecting = wifiBusy && selectedSsid === net.ssid;

                    return (
                      <View key={net.ssid} style={styles.networkItemCard}>
                        <View style={styles.networkRow}>
                          <WifiSignalBars signal={net.signal} />
                          <View style={styles.networkInfo}>
                            <Text style={styles.networkName}>{net.ssid}</Text>
                            <Text style={styles.networkStatus}>
                              {isConnected
                                ? `Connected (${wifiSnapshot.ipAddress ?? "Active"}) • ${net.security.toUpperCase()}`
                                : isConnecting
                                  ? "Connecting..."
                                  : !net.supported
                                    ? "Enterprise (802.1X) - not supported in this version"
                                    : `${net.security === "open" ? "Open Network" : "Secure (" + net.security.toUpperCase() + ")"} • ${String(net.signal)}%`}
                            </Text>
                          </View>
                          {isConnected ? (
                            <View style={styles.connectedRow}>
                              <Text style={styles.networkConnectedBadge}>Connected</Text>
                              <Pressable
                                accessibilityRole="button"
                                accessibilityLabel={`Disconnect from ${net.ssid}`}
                                disabled={wifiBusy}
                                onPress={handleDisconnect}
                                style={styles.disconnectButton}
                              >
                                <Text style={styles.disconnectButtonText}>
                                  Disconnect
                                </Text>
                              </Pressable>
                            </View>
                          ) : !net.supported ? (
                            <View style={styles.unsupportedRow}>
                              <Text style={styles.unsupportedBadge}>Not supported</Text>
                            </View>
                          ) : (
                            <Pressable
                              accessibilityRole="button"
                              accessibilityLabel={`Join ${net.ssid}`}
                              disabled={wifiBusy}
                              onPress={() => {
                                if (net.security === "open" || !net.requiresPassword) {
                                  handleConnect(net.ssid);
                                } else {
                                  setSelectedSsid(isSelected ? null : net.ssid);
                                  setWifiPassword("");
                                }
                              }}
                              style={styles.joinButton}
                            >
                              <Text style={styles.joinButtonText}>
                                {isSelected ? "Cancel" : "Join"}
                              </Text>
                            </Pressable>
                          )}
                        </View>

                        {isSelected && !isConnected && net.supported && (
                          <View style={styles.passwordRow}>
                            <TextInput
                              accessibilityLabel="Wi-Fi Password"
                              placeholder="Enter Wi-Fi password"
                              value={wifiPassword}
                              secureTextEntry
                              onChangeText={setWifiPassword}
                              style={styles.passwordInput}
                            />
                            <Pressable
                              accessibilityRole="button"
                              accessibilityLabel="Connect to network"
                              disabled={
                                wifiBusy ||
                                (net.requiresPassword && wifiPassword.length < 8)
                              }
                              onPress={() => {
                                handleConnect(net.ssid, wifiPassword);
                              }}
                              style={
                                wifiBusy ||
                                (net.requiresPassword && wifiPassword.length < 8)
                                  ? {
                                      ...styles.connectSubmitButton,
                                      ...styles.buttonDisabled,
                                    }
                                  : styles.connectSubmitButton
                              }
                            >
                              <Text style={styles.connectSubmitText}>
                                {wifiBusy ? "Connecting..." : "Connect"}
                              </Text>
                            </Pressable>
                          </View>
                        )}
                      </View>
                    );
                  })
                )}
              </View>

              {canManageSavedNetworks && (
                <View style={styles.card}>
                  <Text style={styles.cardTitle}>Saved Networks</Text>
                  <Text style={styles.cardDesc}>
                    SevynOS reconnects to these networks automatically at boot.
                  </Text>
                  {savedNetworks.length === 0 ? (
                    <View style={styles.emptyNetworks}>
                      <Text style={styles.emptyNetworksText}>
                        No saved networks yet. Join a network to save it here.
                      </Text>
                    </View>
                  ) : (
                    savedNetworks.map((saved) => (
                      <View key={saved.networkId} style={styles.savedNetworkRow}>
                        <Text style={styles.networkName}>{saved.ssid}</Text>
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={`Forget ${saved.ssid}`}
                          disabled={wifiBusy}
                          onPress={() => {
                            handleForgetNetwork(saved.networkId);
                          }}
                          style={
                            wifiBusy
                              ? { ...styles.forgetButton, ...styles.buttonDisabled }
                              : styles.forgetButton
                          }
                        >
                          <Text style={styles.forgetButtonText}>Forget</Text>
                        </Pressable>
                      </View>
                    ))
                  )}
                </View>
              )}
            </View>
          )}

          {activeCategory === "bluetooth" && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Bluetooth</Text>
              <Text style={styles.sectionSubtitle}>
                Pair and manage Bluetooth devices.
              </Text>

              {btError !== null && (
                <View style={styles.card}>
                  <Text style={styles.errorText}>{btError}</Text>
                </View>
              )}

              <View style={styles.card}>
                <View style={styles.rowBetween}>
                  <View>
                    <Text style={styles.cardTitle}>Bluetooth</Text>
                    <Text style={styles.cardDesc}>
                      {btAdapter === undefined
                        ? "Checking for a Bluetooth adapter…"
                        : !btAdapter.available
                          ? "No Bluetooth adapter found on this device."
                          : btAdapter.name !== ""
                            ? btAdapter.name
                            : btAdapter.address}
                    </Text>
                  </View>
                  <Pressable
                    onPress={() => {
                      void handleBluetoothPower(!btAdapter?.powered);
                    }}
                    disabled={!btAdapter?.available}
                    style={
                      btAdapter?.powered === true
                        ? styles.muteButtonActive
                        : styles.muteButton
                    }
                  >
                    <Text style={styles.muteButtonText}>
                      {btAdapter?.powered === true ? "On" : "Off"}
                    </Text>
                  </Pressable>
                </View>
              </View>

              {btAdapter?.available === true && btAdapter.powered && (
                <View style={styles.card}>
                  <Text style={styles.cardTitle}>Paired Devices</Text>
                  {btDevices.filter(
                    (device) => device.paired || device.connected || device.trusted,
                  ).length === 0 && (
                    <Text style={styles.cardDesc}>No paired devices yet.</Text>
                  )}
                  {btDevices
                    .filter(
                      (device) => device.paired || device.connected || device.trusted,
                    )
                    .map((device) => (
                      <View key={device.address} style={styles.deviceRow}>
                        <View style={styles.deviceIconWrap}>
                          <SevynIcon name={device.icon} size={18} color="#9AA3B2" />
                        </View>
                        <View style={styles.deviceMeta}>
                          <Text style={styles.deviceName}>{device.name}</Text>
                          <Text style={styles.deviceSub}>
                            {device.connected
                              ? "Connected"
                              : device.paired
                                ? "Paired"
                                : "Saved"}
                            {device.rssi !== null ? ` · ${String(device.rssi)} dBm` : ""}
                          </Text>
                        </View>
                        <View style={styles.deviceActions}>
                          {device.connected ? (
                            <Pressable
                              onPress={() => {
                                void handleBluetoothDeviceAction(device, "disconnect");
                              }}
                              style={styles.muteButton}
                            >
                              <Text style={styles.muteButtonText}>
                                {btBusyAddress === device.address
                                  ? "Working…"
                                  : "Disconnect"}
                              </Text>
                            </Pressable>
                          ) : (
                            <Pressable
                              onPress={() => {
                                void handleBluetoothDeviceAction(device, "connect");
                              }}
                              style={styles.muteButton}
                            >
                              <Text style={styles.muteButtonText}>
                                {btBusyAddress === device.address
                                  ? "Working…"
                                  : "Connect"}
                              </Text>
                            </Pressable>
                          )}
                          <Pressable
                            onPress={() => {
                              void handleBluetoothDeviceAction(device, "remove");
                            }}
                            style={styles.forgetButton}
                          >
                            <Text style={styles.forgetButtonText}>Forget</Text>
                          </Pressable>
                        </View>
                      </View>
                    ))}
                </View>
              )}

              {btAdapter?.available === true && btAdapter.powered && (
                <View style={styles.card}>
                  <View style={styles.rowBetween}>
                    <Text style={styles.cardTitle}>Available Devices</Text>
                    <Pressable
                      onPress={() => {
                        void handleBluetoothScan();
                      }}
                      style={btScanning ? styles.muteButtonActive : styles.muteButton}
                    >
                      <Text style={styles.muteButtonText}>
                        {btScanning ? "Scanning…" : "Scan"}
                      </Text>
                    </Pressable>
                  </View>
                  {btDevices.filter(
                    (device) => !device.paired && !device.connected && !device.trusted,
                  ).length === 0 && (
                    <Text style={styles.cardDesc}>
                      Put a device in pairing mode, then scan.
                    </Text>
                  )}
                  {btDevices
                    .filter(
                      (device) => !device.paired && !device.connected && !device.trusted,
                    )
                    .map((device) => (
                      <View key={device.address} style={styles.deviceRow}>
                        <View style={styles.deviceIconWrap}>
                          <SevynIcon name={device.icon} size={18} color="#9AA3B2" />
                        </View>
                        <View style={styles.deviceMeta}>
                          <Text style={styles.deviceName}>{device.name}</Text>
                          <Text style={styles.deviceSub}>
                            {device.address}
                            {device.rssi !== null ? ` · ${String(device.rssi)} dBm` : ""}
                          </Text>
                        </View>
                        <View style={styles.deviceActions}>
                          <Pressable
                            onPress={() => {
                              void handleBluetoothPair(device);
                            }}
                            style={styles.muteButton}
                          >
                            <Text style={styles.muteButtonText}>
                              {btBusyAddress === device.address ? "Working…" : "Pair"}
                            </Text>
                          </Pressable>
                        </View>
                      </View>
                    ))}
                </View>
              )}

              {btPairing !== null && (
                <View style={styles.card}>
                  <Text style={styles.cardTitle}>Pair with {btPairing.name}</Text>
                  <Text style={styles.cardDesc}>{btPairing.prompt}</Text>
                  {btPairing.pinRequired && (
                    <TextInput
                      value={btPin}
                      onChangeText={setBtPin}
                      placeholder="Device PIN"
                      keyboardType="numeric"
                      style={styles.passwordInput}
                    />
                  )}
                  <View style={styles.rowBetween}>
                    <Pressable
                      onPress={() => {
                        void handlePairRespond(false);
                      }}
                      style={styles.forgetButton}
                    >
                      <Text style={styles.forgetButtonText}>Deny</Text>
                    </Pressable>
                    <Pressable
                      onPress={() => {
                        void handlePairRespond(true);
                      }}
                      style={styles.muteButtonActive}
                    >
                      <Text style={styles.muteButtonText}>Confirm</Text>
                    </Pressable>
                  </View>
                </View>
              )}
            </View>
          )}

          {activeCategory === "sound" && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Sound & Audio</Text>
              <Text style={styles.sectionSubtitle}>
                Configure speaker volume, microphones, and sound outputs.
              </Text>

              <View style={styles.card}>
                <View style={styles.rowBetween}>
                  <Text style={styles.cardTitle}>Master Volume</Text>
                  <Text style={styles.settingValue}>{volumeLevel}%</Text>
                </View>
                <View style={styles.volumeControls}>
                  <Pressable
                    onPress={() => {
                      handleVolumeChange(volumeLevel - 10);
                    }}
                    style={styles.volumeStepButton}
                  >
                    <Text style={styles.stepButtonText}>-</Text>
                  </Pressable>
                  <View style={styles.volumeBar}>
                    <View style={{ ...styles.volumeFill, width: volumeLevel * 2 }} />
                  </View>
                  <Pressable
                    onPress={() => {
                      handleVolumeChange(volumeLevel + 10);
                    }}
                    style={styles.volumeStepButton}
                  >
                    <Text style={styles.stepButtonText}>+</Text>
                  </Pressable>
                  <Pressable
                    onPress={toggleMute}
                    style={isMuted ? styles.muteButtonActive : styles.muteButton}
                  >
                    <Text style={styles.muteButtonText}>
                      {isMuted ? "Unmute" : "Mute"}
                    </Text>
                  </Pressable>
                </View>
              </View>
            </View>
          )}

          {activeCategory === "battery" && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Power & Battery</Text>
              <Text style={styles.sectionSubtitle}>
                Battery diagnostics and power management.
              </Text>

              <View style={styles.card}>
                <View style={styles.rowBetween}>
                  <View>
                    <Text style={styles.cardTitle}>Battery Status</Text>
                    <Text style={styles.cardDesc}>
                      {isCharging ? "Charging on AC Power" : "Discharging"}
                    </Text>
                  </View>
                  <Text style={styles.batteryPercentText}>{batteryPercent}%</Text>
                </View>
                <View style={styles.batteryBar}>
                  <View
                    style={{
                      ...styles.batteryFill,
                      width: batteryPercent * 2,
                      backgroundColor: isCharging ? "#10B981" : "#D7AC57",
                    }}
                  />
                </View>
              </View>

              <View style={styles.card}>
                <Text style={styles.cardTitle}>Power Actions</Text>
                <Text style={styles.cardDesc}>
                  Suspend, restart, or shut down this device.
                </Text>
                <View style={styles.rowBetween}>
                  <Pressable onPress={handleSleepNow} style={styles.muteButton}>
                    <Text style={styles.muteButtonText}>Sleep now</Text>
                  </Pressable>
                  <Pressable onPress={handleReboot} style={styles.muteButton}>
                    <Text style={styles.muteButtonText}>Restart</Text>
                  </Pressable>
                </View>
              </View>

              <View style={styles.card}>
                <Text style={styles.cardTitle}>When the lid closes</Text>
                <Text style={styles.cardDesc}>
                  {lidStateText === "unknown"
                    ? "No lid switch was detected on this device."
                    : `The lid is currently ${lidStateText}.`}
                </Text>
                <View style={styles.segmentedControl}>
                  {(
                    [
                      { value: "sleep", label: "Sleep" },
                      { value: "nothing", label: "Do nothing" },
                    ] as const
                  ).map((option) => (
                    <Pressable
                      key={option.value}
                      onPress={() => {
                        void handleLidActionChange(option.value);
                      }}
                      style={
                        lidAction === option.value
                          ? styles.segmentButtonActive
                          : styles.segmentButton
                      }
                    >
                      <Text
                        style={
                          lidAction === option.value
                            ? styles.segmentTextActive
                            : styles.segmentText
                        }
                      >
                        {option.label}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </View>

              {chargeLimit?.supported && (
                <View style={styles.card}>
                  <View style={styles.rowBetween}>
                    <View>
                      <Text style={styles.cardTitle}>Charge Limit</Text>
                      <Text style={styles.cardDesc}>
                        Stop charging at {String(chargeLimit.endPct ?? 100)}% to extend
                        battery lifespan
                        {chargeLimit.battery !== null ? ` (${chargeLimit.battery})` : ""}.
                      </Text>
                    </View>
                    <Text style={styles.settingValue}>
                      {String(chargeLimit.endPct ?? 100)}%
                    </Text>
                  </View>
                  <View style={styles.volumeControls}>
                    <Pressable
                      onPress={() => {
                        void handleChargeLimitChange((chargeLimit.endPct ?? 100) - 5);
                      }}
                      style={styles.volumeStepButton}
                    >
                      <Text style={styles.stepButtonText}>-</Text>
                    </Pressable>
                    <View style={styles.volumeBar}>
                      <View
                        style={{
                          ...styles.volumeFill,
                          width: (chargeLimit.endPct ?? 100) * 2,
                        }}
                      />
                    </View>
                    <Pressable
                      onPress={() => {
                        void handleChargeLimitChange((chargeLimit.endPct ?? 100) + 5);
                      }}
                      style={styles.volumeStepButton}
                    >
                      <Text style={styles.stepButtonText}>+</Text>
                    </Pressable>
                  </View>
                  {powerExtrasError !== null && (
                    <Text style={styles.errorText}>{powerExtrasError}</Text>
                  )}
                </View>
              )}
            </View>
          )}

          {activeCategory === "datetime" && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Date & Time</Text>
              <Text style={styles.sectionSubtitle}>
                System clock synchronization and timezone.
              </Text>

              <View style={styles.card}>
                <View style={styles.rowBetween}>
                  <View>
                    <Text style={styles.cardTitle}>Clock Synchronization</Text>
                    <Text style={styles.cardDesc}>
                      {timeState.lastSyncAt
                        ? `Last synced ${new Date(timeState.lastSyncAt).toLocaleString()}`
                        : "Never synced"}
                      {timeState.offsetMs !== undefined &&
                        ` (offset ${String(timeState.offsetMs)} ms)`}
                    </Text>
                  </View>
                  <Pressable
                    onPress={handleSyncNow}
                    style={
                      timeState.syncing ? styles.muteButtonActive : styles.muteButton
                    }
                  >
                    <Text style={styles.muteButtonText}>
                      {timeState.syncing ? "Syncing…" : "Sync Now"}
                    </Text>
                  </Pressable>
                </View>
                {timeState.error && (
                  <Text style={styles.cardDesc}>Sync failed: {timeState.error}</Text>
                )}
              </View>

              <View style={styles.card}>
                <Text style={styles.cardTitle}>Timezone</Text>
                <Text style={styles.cardDesc}>
                  IANA timezone name, e.g. America/New_York
                </Text>
                <View style={styles.rowBetween}>
                  <TextInput
                    value={timezoneInput}
                    onChangeText={setTimezoneInput}
                    placeholder="America/New_York"
                    style={styles.passwordInput}
                  />
                  <Pressable onPress={handleTimezoneSave} style={styles.muteButton}>
                    <Text style={styles.muteButtonText}>Apply</Text>
                  </Pressable>
                </View>
              </View>
            </View>
          )}

          {activeCategory === "applications" && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Applications & Packages</Text>
              <Text style={styles.sectionSubtitle}>
                Manage installed applications, inspect permissions, and restore stock
                packages.
              </Text>

              {appActionError && (
                <View style={styles.errorBanner}>
                  <Text style={styles.errorBannerText}>{appActionError}</Text>
                </View>
              )}

              {appActionSuccess && (
                <View style={styles.successBanner}>
                  <Text style={styles.successBannerText}>{appActionSuccess}</Text>
                </View>
              )}

              <View style={styles.card}>
                <Text style={styles.cardTitle}>
                  Installed Applications ({apps.length})
                </Text>
                <Text style={styles.cardDesc}>
                  Core system applications are protected against uninstallation to
                  preserve OS stability.
                </Text>

                {apps.map((app) => (
                  <View key={app.id} style={styles.appRow}>
                    <View style={styles.appInfo}>
                      <View style={styles.appHeaderRow}>
                        <Text style={styles.appName}>{app.name}</Text>
                        <Text style={styles.appVersion}>v{app.version}</Text>
                        {app.system ? (
                          <View style={styles.protectedBadge}>
                            <Text style={styles.protectedBadgeText}>Protected Core</Text>
                          </View>
                        ) : (
                          <View style={styles.deletableBadge}>
                            <Text style={styles.deletableBadgeText}>Deletable Stock</Text>
                          </View>
                        )}
                      </View>
                      <Text style={styles.appId}>{app.id}</Text>
                      {app.permissions && app.permissions.length > 0 ? (
                        <View style={styles.permissionsList}>
                          <Text style={styles.permissionsTitle}>Permissions:</Text>
                          {app.permissions.map((perm) => (
                            <View key={perm} style={styles.permissionPill}>
                              <Text style={styles.permissionPillText}>{perm}</Text>
                            </View>
                          ))}
                        </View>
                      ) : (
                        <Text style={styles.noPermissionsText}>
                          No special permissions required
                        </Text>
                      )}
                    </View>

                    <View style={styles.appActions}>
                      {app.system ? (
                        <View style={styles.lockedBadge}>
                          <SevynIcon name="lock" size={11} color="#9CA3AF" />
                          <Text style={styles.lockedBadgeText}>Protected</Text>
                        </View>
                      ) : (
                        <Pressable
                          action="uninstall-app"
                          value={app.id}
                          style={styles.uninstallButton}
                          onPress={() => {
                            if (app.system) {
                              setAppActionError(
                                `Cannot uninstall protected system application "${app.name}" (${app.id}).`,
                              );
                              setAppActionSuccess(null);
                              return;
                            }
                            setApps((prev) => prev.filter((a) => a.id !== app.id));
                            setAppActionError(null);
                            setAppActionSuccess(`Successfully uninstalled ${app.name}`);
                            onUninstallApp?.(app.id);
                          }}
                        >
                          <Text style={styles.uninstallButtonText}>Uninstall</Text>
                        </Pressable>
                      )}
                    </View>
                  </View>
                ))}
              </View>

              {DEFAULT_INSTALLED_APPS.some(
                (stock) => !apps.some((a) => a.id === stock.id),
              ) && (
                <View style={styles.card}>
                  <Text style={styles.cardTitle}>
                    Pristine Packages Available to Restore
                  </Text>
                  <Text style={styles.cardDesc}>
                    Stock applications uninstalled from the system can be restored from
                    /usr/share/sevyn/pristine/.
                  </Text>

                  {DEFAULT_INSTALLED_APPS.filter(
                    (stock) => !apps.some((a) => a.id === stock.id),
                  ).map((stock) => (
                    <View key={stock.id} style={styles.appRow}>
                      <View style={styles.appInfo}>
                        <View style={styles.appHeaderRow}>
                          <Text style={styles.appName}>{stock.name}</Text>
                          <Text style={styles.appVersion}>v{stock.version}</Text>
                        </View>
                        <Text style={styles.appId}>{stock.id}</Text>
                      </View>
                      <Pressable
                        action="reinstall-app"
                        value={stock.id}
                        style={styles.reinstallButton}
                        onPress={() => {
                          setApps((prev) => [...prev, stock]);
                          setAppActionError(null);
                          setAppActionSuccess(
                            `Restored ${stock.name} from pristine storage.`,
                          );
                          onReinstallApp?.(stock.id);
                        }}
                      >
                        <Text style={styles.reinstallButtonText}>Reinstall</Text>
                      </Pressable>
                    </View>
                  ))}
                </View>
              )}
            </View>
          )}

          {activeCategory === "shortcuts" && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Keyboard Shortcuts</Text>
              <Text style={styles.sectionSubtitle}>
                Master SevynOS with system, window management, and workspace shortcuts.
              </Text>

              {SYSTEM_SHORTCUTS.map((group) => (
                <View key={group.category} style={styles.card}>
                  <Text style={styles.cardTitle}>{group.category}</Text>
                  <View style={styles.shortcutList}>
                    {group.shortcuts.map((sc, i) => (
                      <View
                        key={sc.label}
                        style={{
                          ...styles.shortcutRow,
                          ...(i > 0 ? styles.shortcutRowBorder : {}),
                        }}
                      >
                        <View style={styles.shortcutInfo}>
                          <Text style={styles.shortcutLabel}>{sc.label}</Text>
                          <Text style={styles.shortcutDesc}>{sc.description}</Text>
                        </View>
                        <View style={styles.keyBadge}>
                          <Text style={styles.keyBadgeText}>{sc.keys}</Text>
                        </View>
                      </View>
                    ))}
                  </View>
                </View>
              ))}
            </View>
          )}

          {activeCategory === "update" && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Software Update</Text>
              <Text style={styles.sectionSubtitle}>
                Check for SevynOS system updates, download, and install them.
              </Text>

              <View style={styles.card}>
                <View style={styles.rowBetween}>
                  <Text style={styles.settingLabel}>Installed version</Text>
                  <Text style={styles.settingValueBold}>
                    {update?.currentVersion ?? "unknown"}
                  </Text>
                </View>
                <View style={styles.rowBetween}>
                  <Text style={styles.settingLabel}>Status</Text>
                  <Text style={styles.settingValue}>
                    {updateStatusLabel(updateStatus)}
                  </Text>
                </View>
                {updateResult?.checkedAt !== undefined && (
                  <View style={styles.rowBetween}>
                    <Text style={styles.settingLabel}>Last checked</Text>
                    <Text style={styles.settingValue}>
                      {new Date(updateResult.checkedAt).toLocaleString()}
                    </Text>
                  </View>
                )}
                {updateResult?.error !== undefined && (
                  <Text style={styles.wifiErrorText}>{updateResult.error}</Text>
                )}
                {update === undefined && (
                  <Text style={styles.settingValue}>
                    The update service is unavailable on this system.
                  </Text>
                )}
              </View>

              {update !== undefined && updateResult?.status === "update-available" && (
                <View style={styles.card}>
                  <View style={styles.rowBetween}>
                    <Text style={styles.settingLabel}>Available version</Text>
                    <Text style={styles.settingValueBold}>
                      {updateResult.latestVersion}
                    </Text>
                  </View>
                  <Text style={styles.settingValue}>{updateResult.releaseNotes}</Text>
                </View>
              )}

              {downloadProgress !== undefined && (
                <View style={styles.card}>
                  <Text style={styles.settingLabel}>
                    Downloading… {formatBytes(downloadProgress.received)} of{" "}
                    {formatBytes(downloadProgress.total)}
                  </Text>
                </View>
              )}

              <View style={styles.updateButtonRow}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Check for updates"
                  disabled={
                    update === undefined || updateBusy || updateStatus === "checking"
                  }
                  onPress={() => {
                    handleCheckForUpdates();
                  }}
                  style={
                    updateBusy || updateStatus === "checking"
                      ? { ...styles.scanButton, ...styles.buttonDisabled }
                      : styles.scanButton
                  }
                >
                  <Text style={styles.scanButtonText}>
                    {updateStatus === "checking" ? "Checking…" : "Check for updates"}
                  </Text>
                </Pressable>

                {updateResult?.status === "update-available" && (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Download update"
                    disabled={updateStatus === "downloading"}
                    onPress={() => {
                      handleDownloadUpdate();
                    }}
                    style={
                      updateStatus === "downloading"
                        ? { ...styles.scanButton, ...styles.buttonDisabled }
                        : styles.scanButton
                    }
                  >
                    <Text style={styles.scanButtonText}>
                      {updateStatus === "downloading" ? "Downloading…" : "Download"}
                    </Text>
                  </Pressable>
                )}

                {updateStatus === "downloaded" && stagedUpdate !== undefined && (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Install update and reboot"
                    onPress={() => {
                      handleInstallUpdate();
                    }}
                    style={styles.scanButton}
                  >
                    <Text style={styles.scanButtonText}>Install & reboot</Text>
                  </Pressable>
                )}

                {updateStatus === "pending-reboot" && (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Reboot to apply the update"
                    onPress={() => {
                      handleReboot();
                    }}
                    style={styles.scanButton}
                  >
                    <Text style={styles.scanButtonText}>Reboot to apply</Text>
                  </Pressable>
                )}
              </View>

              {(updateStatus === "downloaded" || updateStatus === "pending-reboot") && (
                <Text style={styles.sectionSubtitle}>
                  The update is staged and will be applied before the desktop starts on
                  the next boot. Your files and settings are preserved.
                </Text>
              )}
            </View>
          )}

          {activeCategory === "about" && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>About SevynOS</Text>
              <Text style={styles.sectionSubtitle}>
                Operating system specifications and framework runtime.
              </Text>

              <View style={styles.card}>
                <View style={styles.rowBetween}>
                  <Text style={styles.settingLabel}>Operating System</Text>
                  <Text style={styles.settingValueBold}>SevynOS 1.0 (Genesis)</Text>
                </View>
                <View style={styles.rowBetween}>
                  <Text style={styles.settingLabel}>Application Runtime</Text>
                  <Text style={styles.settingValue}>React Native on SevynOS</Text>
                </View>
                <View style={styles.rowBetween}>
                  <Text style={styles.settingLabel}>Compositor & Display</Text>
                  <Text style={styles.settingValue}>Genesis Wayland Engine</Text>
                </View>
                <View style={styles.rowBetween}>
                  <Text style={styles.settingLabel}>Architecture</Text>
                  <Text style={styles.settingValue}>x86_64 / amd64</Text>
                </View>
                <View style={styles.rowBetween}>
                  <Text style={styles.settingLabel}>Accent Color Token</Text>
                  <Text style={{ ...styles.settingValue, color: selectedAccent }}>
                    {selectedAccent}
                  </Text>
                </View>
              </View>
            </View>
          )}
        </ScrollView>
      </View>
    </View>
  );
}

function updateStatusLabel(status: string): string {
  switch (status) {
    case "checking":
      return "Checking…";
    case "up-to-date":
      return "Up to date";
    case "update-available":
      return "Update available";
    case "downloading":
      return "Downloading…";
    case "downloaded":
      return "Downloaded";
    case "applying":
      return "Applying…";
    case "pending-reboot":
      return "Reboot to apply";
    case "error":
      return "Check failed";
    case "idle":
    default:
      return "Not checked yet";
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function WifiSignalBars({ signal }: { signal: number }): JSX.Element {
  const filled = signal >= 75 ? 4 : signal >= 50 ? 3 : signal >= 25 ? 2 : 1;
  return (
    <View
      style={styles.signalBars}
      accessibilityLabel={`Signal strength ${String(signal)} percent`}
    >
      {[0, 1, 2, 3].map((index) => (
        <View
          key={`signal-bar-${String(index)}`}
          style={{
            ...styles.signalBar,
            height: 6 + index * 5,
            ...(index < filled ? styles.signalBarOn : styles.signalBarOff),
          }}
        />
      ))}
    </View>
  );
}

function SidebarItem({
  active,
  icon,
  label,
  onPress,
}: {
  active: boolean;
  icon: SevynIconName;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={active ? styles.sidebarItemActive : styles.sidebarItem}
    >
      <SevynIcon name={icon} size={16} color={active ? "#FFFFFF" : "#9AA3B2"} />
      <Text style={active ? styles.sidebarItemLabelActive : styles.sidebarItemLabel}>
        {label}
      </Text>
    </Pressable>
  );
}

export default SettingsApplication;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    flexDirection: "row",
    backgroundColor: "#0F1115",
  },
  sidebar: {
    width: 220,
    backgroundColor: "#161920",
    borderRightWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.08)",
  },
  sidebarHeader: {
    padding: 16,
    borderBottomWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.06)",
  },
  sidebarTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: "#F3F4F6",
  },
  navList: {
    flex: 1,
    paddingVertical: 8,
    paddingHorizontal: 8,
  },
  sidebarItem: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    gap: 8,
    marginBottom: 4,
  },
  sidebarItemActive: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    gap: 8,
    marginBottom: 4,
    backgroundColor: "rgba(215, 172, 87, 0.15)",
  },
  sidebarItemIcon: {
    fontSize: 16,
  },
  sidebarItemLabel: {
    fontSize: 13,
    color: "#9CA3AF",
    fontWeight: "500",
  },
  sidebarItemLabelActive: {
    fontSize: 13,
    color: "#D7AC57",
    fontWeight: "700",
  },
  mainPanel: {
    flex: 1,
  },
  panelScroll: {
    padding: 24,
  },
  section: {
    maxWidth: 680,
  },
  sectionTitle: {
    fontSize: 22,
    fontWeight: "700",
    color: "#F3F4F6",
    marginBottom: 8,
  },
  sectionSubtitle: {
    fontSize: 13,
    color: "#9CA3AF",
    marginBottom: 24,
  },
  card: {
    backgroundColor: "#1A1D24",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.08)",
    padding: 16,
    marginBottom: 16,
  },
  cardTitle: {
    fontSize: 15,
    fontWeight: "600",
    color: "#F3F4F6",
    marginBottom: 4,
  },
  cardDesc: {
    fontSize: 12,
    color: "#9CA3AF",
    marginBottom: 12,
  },
  segmentedControl: {
    flexDirection: "row",
    backgroundColor: "#12141A",
    borderRadius: 8,
    padding: 4,
    gap: 4,
    marginTop: 8,
  },
  segmentButton: {
    flex: 1,
    paddingVertical: 8,
    alignItems: "center",
    borderRadius: 6,
  },
  segmentButtonActive: {
    flex: 1,
    paddingVertical: 8,
    alignItems: "center",
    borderRadius: 6,
    backgroundColor: "#D7AC57",
  },
  segmentText: {
    fontSize: 12,
    color: "#9CA3AF",
    fontWeight: "600",
  },
  segmentTextActive: {
    fontSize: 12,
    color: "#0F1115",
    fontWeight: "700",
  },
  accentGrid: {
    flexDirection: "row",
    gap: 12,
    marginTop: 8,
  },
  accentSwatch: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
  },
  accentSwatchActive: {
    borderWidth: 3,
    borderColor: "#FFFFFF",
  },
  checkMark: {
    color: "#000000",
    fontWeight: "900",
    fontSize: 16,
  },
  rowBetween: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 8,
    gap: 12,
  },
  settingLabel: {
    fontSize: 13,
    color: "#E2E8F0",
  },
  settingValue: {
    fontSize: 13,
    color: "#9CA3AF",
  },
  settingValueBold: {
    fontSize: 13,
    color: "#D7AC57",
    fontWeight: "700",
  },
  toggleButton: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 16,
    backgroundColor: "rgba(255, 255, 255, 0.1)",
  },
  toggleButtonActive: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 16,
    backgroundColor: "#10B981",
  },
  toggleText: {
    fontSize: 11,
    fontWeight: "700",
    color: "#FFFFFF",
  },
  networkItem: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.05)",
    gap: 12,
  },
  signalBars: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 2,
    marginRight: 4,
    height: 24,
    paddingTop: 4,
  },
  signalBar: {
    width: 4,
    borderRadius: 1,
  },
  signalBarOn: {
    backgroundColor: "#D7AC57",
  },
  signalBarOff: {
    backgroundColor: "rgba(255, 255, 255, 0.15)",
  },
  unsupportedRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  unsupportedBadge: {
    fontSize: 11,
    fontWeight: "600",
    color: "#9CA3AF",
    backgroundColor: "rgba(255, 255, 255, 0.06)",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.12)",
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    overflow: "hidden",
  },
  savedNetworkRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.05)",
    gap: 12,
  },
  forgetButton: {
    backgroundColor: "rgba(239, 68, 68, 0.12)",
    borderWidth: 1,
    borderColor: "rgba(239, 68, 68, 0.3)",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  forgetButtonText: {
    fontSize: 11,
    fontWeight: "600",
    color: "#EF4444",
  },
  networkInfo: {
    flex: 1,
  },
  networkName: {
    fontSize: 13,
    fontWeight: "600",
    color: "#F3F4F6",
  },
  /* Phase 2 (c): Bluetooth / Display / Power pane styles. */
  errorText: {
    fontSize: 12,
    color: "#EF4444",
  },
  groupLabel: {
    fontSize: 11,
    fontWeight: "600",
    color: "#9AA3B2",
    textTransform: "uppercase",
    letterSpacing: 0.8,
    marginTop: 14,
    marginBottom: 8,
  },
  modeGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  deviceRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    borderTopWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.06)",
    gap: 12,
  },
  deviceIconWrap: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: "rgba(255, 255, 255, 0.06)",
    alignItems: "center",
    justifyContent: "center",
  },
  deviceMeta: {
    flex: 1,
  },
  deviceName: {
    fontSize: 13,
    fontWeight: "600",
    color: "#F3F4F6",
  },
  deviceSub: {
    fontSize: 11,
    color: "#9CA3AF",
    marginTop: 2,
  },
  deviceActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  networkStatus: {
    fontSize: 11,
    color: "#9CA3AF",
  },
  networkConnectedBadge: {
    fontSize: 11,
    fontWeight: "600",
    color: "#10B981",
  },
  volumeControls: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 8,
  },
  volumeStepButton: {
    width: 32,
    height: 32,
    borderRadius: 6,
    backgroundColor: "rgba(255, 255, 255, 0.08)",
    alignItems: "center",
    justifyContent: "center",
  },
  stepButtonText: {
    color: "#F3F4F6",
    fontSize: 16,
    fontWeight: "700",
  },
  volumeBar: {
    flex: 1,
    height: 8,
    borderRadius: 4,
    backgroundColor: "rgba(255, 255, 255, 0.1)",
    overflow: "hidden",
  },
  volumeFill: {
    height: 8,
    backgroundColor: "#D7AC57",
  },
  muteButton: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 6,
    backgroundColor: "rgba(255, 255, 255, 0.08)",
  },
  muteButtonActive: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 6,
    backgroundColor: "#EF4444",
  },
  muteButtonText: {
    color: "#F3F4F6",
    fontSize: 12,
    fontWeight: "600",
  },
  batteryPercentText: {
    fontSize: 22,
    fontWeight: "700",
    color: "#F3F4F6",
  },
  batteryBar: {
    height: 10,
    borderRadius: 5,
    backgroundColor: "rgba(255, 255, 255, 0.1)",
    overflow: "hidden",
    marginTop: 8,
  },
  batteryFill: {
    height: 10,
  },
  storageBar: {
    height: 10,
    borderRadius: 5,
    backgroundColor: "rgba(255, 255, 255, 0.1)",
    overflow: "hidden",
    marginTop: 8,
  },
  storageFill: {
    height: 10,
    backgroundColor: "#3B82F6",
  },
  errorBanner: {
    backgroundColor: "rgba(239, 68, 68, 0.15)",
    borderColor: "#EF4444",
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    marginBottom: 16,
  },
  errorBannerText: {
    color: "#EF4444",
    fontSize: 13,
    fontWeight: "600",
  },
  successBanner: {
    backgroundColor: "rgba(16, 185, 129, 0.15)",
    borderColor: "#10B981",
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    marginBottom: 16,
  },
  successBannerText: {
    color: "#10B981",
    fontSize: 13,
    fontWeight: "600",
  },
  appRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.06)",
    gap: 12,
  },
  appInfo: {
    flex: 1,
  },
  appHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 4,
  },
  appName: {
    fontSize: 14,
    fontWeight: "600",
    color: "#F3F4F6",
  },
  appVersion: {
    fontSize: 11,
    color: "#9CA3AF",
  },
  protectedBadge: {
    backgroundColor: "rgba(215, 172, 87, 0.15)",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: "rgba(215, 172, 87, 0.4)",
  },
  protectedBadgeText: {
    fontSize: 10,
    fontWeight: "700",
    color: "#D7AC57",
  },
  deletableBadge: {
    backgroundColor: "rgba(59, 130, 246, 0.15)",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
  },
  deletableBadgeText: {
    fontSize: 10,
    fontWeight: "600",
    color: "#60A5FA",
  },
  appId: {
    fontSize: 11,
    fontFamily: "monospace",
    color: "#6B7280",
    marginBottom: 4,
  },
  permissionsList: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 4,
    marginTop: 2,
  },
  permissionsTitle: {
    fontSize: 11,
    color: "#9CA3AF",
    marginRight: 4,
  },
  permissionPill: {
    backgroundColor: "rgba(255, 255, 255, 0.06)",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
  },
  permissionPillText: {
    fontSize: 10,
    fontFamily: "monospace",
    color: "#CBD5E1",
  },
  noPermissionsText: {
    fontSize: 11,
    color: "#6B7280",
    fontStyle: "italic",
  },
  appActions: {
    flexDirection: "row",
    alignItems: "center",
  },
  lockedBadge: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 6,
    backgroundColor: "rgba(255, 255, 255, 0.05)",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  lockedBadgeText: {
    fontSize: 11,
    color: "#9CA3AF",
  },
  uninstallButton: {
    backgroundColor: "rgba(239, 68, 68, 0.15)",
    borderWidth: 1,
    borderColor: "rgba(239, 68, 68, 0.4)",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 6,
  },
  uninstallButtonText: {
    fontSize: 12,
    fontWeight: "600",
    color: "#EF4444",
  },
  reinstallButton: {
    backgroundColor: "rgba(16, 185, 129, 0.15)",
    borderWidth: 1,
    borderColor: "rgba(16, 185, 129, 0.4)",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 6,
  },
  reinstallButtonText: {
    fontSize: 12,
    fontWeight: "600",
    color: "#10B981",
  },
  shortcutList: {
    marginTop: 8,
  },
  shortcutRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 8,
    gap: 16,
  },
  shortcutRowBorder: {
    borderTopWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.06)",
  },
  shortcutInfo: {
    flex: 1,
  },
  shortcutLabel: {
    fontSize: 13,
    fontWeight: "600",
    color: "#F3F4F6",
  },
  shortcutDesc: {
    fontSize: 11,
    color: "#9CA3AF",
    marginTop: 2,
  },
  keyBadge: {
    backgroundColor: "rgba(255, 255, 255, 0.08)",
    borderColor: "rgba(255, 255, 255, 0.16)",
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  keyBadgeText: {
    fontSize: 11,
    fontWeight: "700",
    color: "#E5E7EB",
    fontFamily: "monospace",
  },
  scanButton: {
    backgroundColor: "rgba(215, 172, 87, 0.15)",
    borderWidth: 1,
    borderColor: "#D7AC57",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 6,
  },
  scanButtonText: {
    fontSize: 12,
    fontWeight: "600",
    color: "#D7AC57",
  },
  connectedRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  disconnectButton: {
    backgroundColor: "rgba(239, 68, 68, 0.12)",
    borderWidth: 1,
    borderColor: "rgba(239, 68, 68, 0.3)",
    paddingHorizontal: 8,
    paddingVertical: 8,
    borderRadius: 8,
  },
  disconnectButtonText: {
    fontSize: 11,
    fontWeight: "600",
    color: "#EF4444",
  },
  joinButton: {
    backgroundColor: "rgba(255, 255, 255, 0.08)",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.16)",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  joinButtonText: {
    fontSize: 12,
    fontWeight: "600",
    color: "#F3F4F6",
  },
  networkItemCard: {
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255, 255, 255, 0.06)",
  },
  networkRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  passwordRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 8,
    paddingLeft: 34,
  },
  passwordInput: {
    flex: 1,
    height: 36,
    backgroundColor: "rgba(255, 255, 255, 0.05)",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.15)",
    borderRadius: 6,
    paddingHorizontal: 10,
    color: "#FFFFFF",
    fontSize: 13,
  },
  connectSubmitButton: {
    backgroundColor: "#D7AC57",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 6,
  },
  connectSubmitText: {
    fontSize: 12,
    fontWeight: "700",
    color: "#07090D",
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  updateButtonRow: {
    flexDirection: "row",
    gap: 8,
    marginTop: 12,
    flexWrap: "wrap",
  },
  wifiErrorBanner: {
    backgroundColor: "rgba(239, 68, 68, 0.15)",
    borderWidth: 1,
    borderColor: "rgba(239, 68, 68, 0.4)",
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    marginBottom: 16,
  },
  wifiErrorText: {
    color: "#EF4444",
    fontSize: 13,
    fontWeight: "600",
  },
  emptyNetworks: {
    paddingVertical: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyNetworksText: {
    color: "#9CA3AF",
    fontSize: 13,
    textAlign: "center",
  },
});
