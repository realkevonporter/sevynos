// SevynOS v2 M4 — the Settings system app.
//
// Changes a real, persisted system value: the update channel
// (nightly vs stable), written to /data/update-config.json through
// `sevyn update channel` and read back through `sevyn update
// status`. The app logs SETTINGS channel=<c> after every apply —
// the harness asserts on that line, then reads the persisted value
// itself over the updater's control serial.
//
// Also shows Sevyn Code status (read-only) and the AI-choice surface
// (M4.5): which AI is plugged into the connector, picked through
// `sevyn ai select` and read back through `sevyn ai list`. The
// daemon persists the choice, so the selected AI survives a reboot.
//
// M9 adds the Wi-Fi section: scan for networks, connect with a
// password, show the connected state — through `sevyn net wifi`
// (scan/status/connect/disconnect/forget). Scan and connect run
// async (they wait seconds); the section degrades cleanly to "No
// Wi-Fi hardware" where there is no wlan device (QEMU). The body
// scrolls, so the new section never clips the older ones at the
// default 800x500 window.
//
// The Date & Time section shows the clock, last sync, and timezone
// through `sevyn time` (status/sync/timezone). Sync Now runs the
// NTP client in the CLI and the privileged set in statusd, so it
// works from the unprivileged session — the path Genesis lost in
// cc1639c. The section degrades to "unavailable" where statusd is
// unreachable.
//
// The Power section (shutdown fix) shuts down or restarts the
// system through `sevyn poweroff` / `sevyn reboot` — the same verbs
// the tray power menu runs.
//
// The Appearance section picks the desktop wallpaper (style +
// solid color) through `sevyn settings get/set`, backed by
// /data/settings.json. The shell re-reads the setting when
// Settings closes, so the new wallpaper applies then — not while
// Settings stays open.

import * as React from "react";
import { View, Text, Image, Pressable, ScrollView, TextInput } from "./host";
import { WindowButtons } from "./window-buttons";
import { runCli, runCliAsync, parseField } from "./cli";
import { appIconTitlePath, symbolPath } from "./icons";

function readWallpaperStyle(): string {
  const { out } = runCli("sevyn settings get wallpaperStyle");
  return parseField(out, "wallpaperStyle") ?? "default";
}

function readWallpaperColor(): string {
  const { out } = runCli("sevyn settings get wallpaperColor");
  return parseField(out, "wallpaperColor") ?? "#090b11";
}

const WALLPAPER_STYLES = [
  { label: "Default", value: "default" },
  { label: "Solid", value: "solid" },
  { label: "Cosmic", value: "cosmic" },
  { label: "Minimal", value: "minimal" },
  { label: "macOS", value: "macos" },
] as const;

/** Flat colors offered for the solid wallpaper style. */
const WALLPAPER_COLORS = [
  { name: "Sevyn Night", value: "#090b11" },
  { name: "Slate", value: "#1E293B" },
  { name: "Indigo", value: "#312E81" },
  { name: "Violet", value: "#4C1D95" },
  { name: "Crimson", value: "#7F1D1D" },
  { name: "Forest", value: "#14532D" },
  { name: "Amber", value: "#78350F" },
  { name: "Teal", value: "#0F766E" },
] as const;

function readChannel(): string {
  const { out } = runCli("sevyn update status");
  return parseField(out, "channel") ?? "unknown";
}

function readAi(): { selected: string; backends: string[] } {
  const { out } = runCli("sevyn ai list");
  const selected = parseField(out, "selected") ?? "unknown";
  const backends = parseField(out, "backends");
  return { selected, backends: backends ? backends.split(",") : [] };
}

type WifiState = {
  available: boolean;
  state: string;
  ssid: string;
  address: string;
};

function readWifi(): WifiState {
  const { code, out } = runCli("sevyn net wifi status");
  if (code !== 0) return { available: false, state: "", ssid: "", address: "" };
  return {
    available: true,
    state: parseField(out, "state") ?? "unknown",
    ssid: parseField(out, "ssid") ?? "none",
    address: parseField(out, "address") ?? "none",
  };
}

type WifiNetwork = { ssid: string; signal: number; secured: boolean };

type TimeState = {
  available: boolean;
  now: string;
  lastSync: string;
  offsetMs: string;
  source: string;
  timezone: string;
  rtc: string;
};

function readTime(): TimeState {
  const unavailable: TimeState = {
    available: false,
    now: "",
    lastSync: "",
    offsetMs: "",
    source: "",
    timezone: "",
    rtc: "",
  };
  const { code, out } = runCli("sevyn time status");
  if (code !== 0) return unavailable;
  return {
    available: true,
    now: parseField(out, "now") ?? "",
    lastSync: parseField(out, "last_sync") ?? "never",
    offsetMs: parseField(out, "offset_ms") ?? "",
    source: parseField(out, "source") ?? "",
    timezone: parseField(out, "timezone") ?? "",
    rtc: parseField(out, "rtc") ?? "",
  };
}

// Double-quote one CLI argument (the host's tokenizer strips the
// quotes and unescapes \" / \\, so SSIDs and passwords with spaces
// pass through intact).
function q(s: string): string {
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

export function Settings(): React.ReactElement {
  // Lazy initializers: the reads run once, synchronously, on mount
  // (this renderer is sync; there is no effect flush to wait for).
  const [channel, setChannel] = React.useState<string>(() => readChannel());
  const [ai, setAi] = React.useState<{ selected: string; backends: string[] }>(() =>
    readAi(),
  );
  const [codeInfo, setCodeInfo] = React.useState<string>(() =>
    runCli("sevyn code status").out.trim(),
  );
  const [message, setMessage] = React.useState<string>("");
  const [wifi, setWifi] = React.useState<WifiState>(() => readWifi());
  const [networks, setNetworks] = React.useState<WifiNetwork[]>([]);
  const [scanning, setScanning] = React.useState<boolean>(false);
  const [connecting, setConnecting] = React.useState<string>("");
  const [selected, setSelected] = React.useState<string>("");
  const [password, setPassword] = React.useState<string>("");
  const [wifiMessage, setWifiMessage] = React.useState<string>("");
  const [powerMessage, setPowerMessage] = React.useState<string>("");
  const [timeState, setTimeState] = React.useState<TimeState>(() => readTime());
  const [timezoneInput, setTimezoneInput] = React.useState<string>(timeState.timezone);
  const [syncing, setSyncing] = React.useState<boolean>(false);
  const [timeMessage, setTimeMessage] = React.useState<string>("");
  const [wallpaperStyle, setWallpaperStyle] = React.useState<string>(() =>
    readWallpaperStyle(),
  );
  const [wallpaperColor, setWallpaperColor] = React.useState<string>(() =>
    readWallpaperColor(),
  );
  const [wallpaperMessage, setWallpaperMessage] = React.useState<string>("");
  const color = Sevyn.appColor;

  function setChannelTo(next: string): void {
    const { code } = runCli("sevyn update channel " + next);
    if (code !== 0) {
      setMessage("Could not set the channel.");
      return;
    }
    const current = readChannel();
    setChannel(current);
    setMessage(
      current === next ? "Channel set to " + next + "." : "Channel is " + current + ".",
    );
    Sevyn.log("SETTINGS channel=" + current);
  }

  function selectAi(next: string): void {
    const { code } = runCli("sevyn ai select " + next);
    if (code !== 0) {
      setMessage("Could not select that AI.");
      return;
    }
    const current = readAi();
    setAi(current);
    setMessage(
      current.selected === next
        ? "AI set to " + next + "."
        : "AI is " + current.selected + ".",
    );
    Sevyn.log("SETTINGS ai=" + current.selected);
  }

  // Wallpaper (port of #123): the choice is written to
  // /data/settings.json and the shell picks it up when Settings
  // closes — it does not apply while Settings stays open.
  function setWallpaperStyleTo(next: string): void {
    const { code } = runCli("sevyn settings set wallpaperStyle " + next);
    if (code !== 0) {
      setWallpaperMessage("Could not set the wallpaper style.");
      return;
    }
    const current = readWallpaperStyle();
    setWallpaperStyle(current);
    setWallpaperMessage(
      current === next
        ? "Wallpaper style set to " + next + ". Applies when Settings closes."
        : "Wallpaper style is " + current + ".",
    );
    Sevyn.log("SETTINGS wallpaperStyle=" + current);
  }

  function setWallpaperColorTo(next: string): void {
    const { code } = runCli("sevyn settings set wallpaperColor " + next);
    if (code !== 0) {
      setWallpaperMessage("Could not set the wallpaper color.");
      return;
    }
    const current = readWallpaperColor();
    setWallpaperColor(current);
    setWallpaperMessage(
      current === next
        ? "Wallpaper color set. Applies when Settings closes."
        : "Wallpaper color is " + current + ".",
    );
    Sevyn.log("SETTINGS wallpaperColor=" + current);
  }

  async function shutdownSystem(): Promise<void> {
    const { code } = await runCliAsync("sevyn poweroff");
    setPowerMessage(
      code === 0 ? "Shutting down…" : "Could not shut down (status daemon unreachable).",
    );
    Sevyn.log("SETTINGS power=shutdown");
  }

  async function restartSystem(): Promise<void> {
    const { code } = await runCliAsync("sevyn reboot");
    setPowerMessage(
      code === 0 ? "Restarting…" : "Could not restart (status daemon unreachable).",
    );
    Sevyn.log("SETTINGS power=restart");
  }

  async function scanWifi(): Promise<void> {
    if (scanning) return;
    setScanning(true);
    setWifiMessage("");
    const { code, out } = await runCliAsync("sevyn net wifi scan");
    setScanning(false);
    if (code !== 0) {
      setWifiMessage(out.trim().split("\n")[0] || "Scan failed.");
      return;
    }
    const found: WifiNetwork[] = [];
    for (const line of out.split("\n")) {
      const parts = line.split("\t");
      if (parts.length >= 3 && parts[0]) {
        found.push({
          ssid: parts[0],
          signal: parseInt(parts[1], 10) || 0,
          secured: parts[2] === "secured",
        });
      }
    }
    setNetworks(found);
    setWifiMessage(found.length === 0 ? "No networks found." : "");
  }

  async function connectWifi(ssid: string, psk: string): Promise<void> {
    if (connecting) return;
    setConnecting(ssid);
    setWifiMessage("");
    const cmd = "sevyn net wifi connect " + q(ssid) + (psk ? " " + q(psk) : "");
    const { code, out } = await runCliAsync(cmd);
    setConnecting("");
    if (code !== 0) {
      setWifiMessage(out.trim().split("\n")[0] || "Could not connect.");
      return;
    }
    setWifi(readWifi());
    setSelected("");
    setPassword("");
    setWifiMessage("Connected to " + ssid + ".");
    Sevyn.log("SETTINGS wifi=" + ssid);
  }

  async function disconnectWifi(): Promise<void> {
    const { code } = await runCliAsync("sevyn net wifi disconnect");
    if (code !== 0) {
      setWifiMessage("Could not disconnect.");
      return;
    }
    setWifi(readWifi());
    setWifiMessage("Disconnected.");
  }

  async function forgetWifi(ssid: string): Promise<void> {
    const { code } = await runCliAsync("sevyn net wifi forget " + q(ssid));
    if (code !== 0) {
      setWifiMessage("Could not forget " + ssid + ".");
      return;
    }
    setNetworks(networks.filter((n) => n.ssid !== ssid));
    setWifi(readWifi());
    setWifiMessage("Forgot " + ssid + ".");
  }

  function wifiStatusLine(): string {
    if (!wifi.available) return "No Wi-Fi hardware on this device.";
    if (wifi.ssid && wifi.ssid !== "none")
      return "Connected to " + wifi.ssid + " (" + wifi.address + ")";
    return "Not connected";
  }

  function timeStatusLine(): string {
    if (!timeState.available)
      return "Clock status unavailable (status daemon unreachable).";
    return "Clock: " + (timeState.now || "unknown");
  }

  function timeSyncLine(): string {
    if (!timeState.available) return "";
    if (!timeState.lastSync || timeState.lastSync === "never") return "Never synced.";
    const offset =
      timeState.offsetMs !== ""
        ? " (offset " +
          timeState.offsetMs +
          " ms" +
          (timeState.source !== "" ? ", " + timeState.source : "") +
          ")"
        : "";
    return "Last synced " + timeState.lastSync + offset + ".";
  }

  async function syncTime(): Promise<void> {
    if (syncing) return;
    setSyncing(true);
    setTimeMessage("");
    const { code, out } = await runCliAsync("sevyn time sync");
    setSyncing(false);
    if (code !== 0) {
      setTimeMessage(out.trim().split("\n")[0] || "Sync failed.");
      return;
    }
    setTimeState(readTime());
    setTimeMessage("Clock synced.");
    Sevyn.log("SETTINGS time=synced");
  }

  async function applyTimezone(): Promise<void> {
    const tz = timezoneInput.trim();
    if (tz === "") return;
    setTimeMessage("");
    const { code, out } = await runCliAsync("sevyn time timezone " + q(tz));
    if (code !== 0) {
      setTimeMessage(out.trim().split("\n")[0] || "Could not set the timezone.");
      return;
    }
    setTimeState(readTime());
    setTimeMessage("Timezone set to " + tz + ".");
    Sevyn.log("SETTINGS timezone=" + tz);
  }

  function networkRow(n: WifiNetwork): React.ReactElement {
    const isConnected = wifi.available && wifi.ssid === n.ssid;
    return (
      <Pressable
        key={n.ssid}
        onPress={() => {
          if (isConnected) return;
          if (n.secured) {
            setSelected(n.ssid);
            setPassword("");
          } else {
            void connectWifi(n.ssid, "");
          }
        }}
        style={{
          flexDirection: "row",
          alignItems: "center",
          backgroundColor: "#ffffff",
          borderRadius: 8,
          paddingLeft: 12,
          paddingRight: 12,
          paddingTop: 10,
          paddingBottom: 10,
          marginTop: 8,
        }}
      >
        <Text style={{ fontSize: 15, color: "#111827", flex: 1 }}>
          {n.ssid}
          {isConnected ? " · Connected" : ""}
        </Text>
        <Text style={{ fontSize: 13, color: "#6b7280", marginRight: 8 }}>
          {n.signal} dBm
        </Text>
        <Text style={{ fontSize: 13, color: "#6b7280" }}>
          {n.secured ? "Secured" : "Open"}
        </Text>
      </Pressable>
    );
  }

  function passwordPrompt(ssid: string): React.ReactElement {
    return (
      <View style={{ marginTop: 12 }}>
        <Text style={{ fontSize: 14, color: "#374151" }}>Password for {ssid}</Text>
        <TextInput
          value={password}
          onChangeText={setPassword}
          placeholder="Password"
          secureTextEntry={true}
          style={{
            height: 36,
            backgroundColor: "#ffffff",
            borderRadius: 8,
            paddingLeft: 12,
            paddingRight: 12,
            marginTop: 8,
            fontSize: 15,
            color: "#111827",
          }}
        />
        <Pressable
          onPress={() => void connectWifi(ssid, password)}
          style={{
            width: 120,
            height: 36,
            borderRadius: 8,
            backgroundColor: connecting ? "#9ca3af" : "#111827",
            justifyContent: "center",
            alignItems: "center",
            marginTop: 12,
          }}
        >
          <Text
            style={{
              fontSize: 15,
              fontWeight: "bold",
              color: "#ffffff",
              textAlign: "center",
            }}
          >
            {connecting === ssid ? "Connecting…" : "Connect"}
          </Text>
        </Pressable>
      </View>
    );
  }

  function aiButton(label: string, value: string): React.ReactElement {
    const active = ai.selected === value;
    return (
      <Pressable
        onPress={() => selectAi(value)}
        style={{
          width: 120,
          height: 36,
          borderRadius: 8,
          backgroundColor: active ? "#111827" : "#e5e7eb",
          justifyContent: "center",
          alignItems: "center",
          marginRight: 12,
        }}
      >
        <Text
          style={{
            fontSize: 15,
            fontWeight: active ? "bold" : "normal",
            color: active ? "#ffffff" : "#111827",
            textAlign: "center",
          }}
        >
          {label}
        </Text>
      </Pressable>
    );
  }

  function channelButton(label: string, value: string): React.ReactElement {
    const active = channel === value;
    return (
      <Pressable
        onPress={() => setChannelTo(value)}
        style={{
          width: 120,
          height: 36,
          borderRadius: 8,
          backgroundColor: active ? "#111827" : "#e5e7eb",
          justifyContent: "center",
          alignItems: "center",
          marginRight: 12,
        }}
      >
        <Text
          style={{
            fontSize: 15,
            fontWeight: active ? "bold" : "normal",
            color: active ? "#ffffff" : "#111827",
            textAlign: "center",
          }}
        >
          {label}
        </Text>
      </Pressable>
    );
  }

  function wallpaperStyleButton(label: string, value: string): React.ReactElement {
    const active = wallpaperStyle === value;
    return (
      <Pressable
        onPress={() => setWallpaperStyleTo(value)}
        style={{
          width: 120,
          height: 36,
          borderRadius: 8,
          backgroundColor: active ? "#111827" : "#e5e7eb",
          justifyContent: "center",
          alignItems: "center",
          marginRight: 12,
        }}
      >
        <Text
          style={{
            fontSize: 15,
            fontWeight: active ? "bold" : "normal",
            color: active ? "#ffffff" : "#111827",
            textAlign: "center",
          }}
        >
          {label}
        </Text>
      </Pressable>
    );
  }

  function wallpaperColorSwatch(name: string, value: string): React.ReactElement {
    const active = wallpaperColor === value;
    return (
      <Pressable
        key={value}
        onPress={() => setWallpaperColorTo(value)}
        style={{
          width: 44,
          height: 44,
          borderRadius: 8,
          backgroundColor: value,
          justifyContent: "center",
          alignItems: "center",
          marginRight: 8,
          marginTop: 8,
        }}
      >
        {active ? (
          <Text
            style={{
              fontSize: 18,
              fontWeight: "bold",
              color: "#ffffff",
              textAlign: "center",
            }}
          >
            ✓
          </Text>
        ) : null}
      </Pressable>
    );
  }

  const connectedSsid =
    wifi.available && wifi.ssid && wifi.ssid !== "none" ? wifi.ssid : "";

  return (
    <View
      style={{
        flex: 1,
        flexDirection: "column",
        backgroundColor: "#f9fafb",
      }}
    >
      <View
        style={{
          flexDirection: "row",
          height: 44,
          backgroundColor: color,
          alignItems: "center",
          paddingLeft: 16,
          paddingRight: 12,
        }}
      >
        <Image
          source={appIconTitlePath("settings")}
          style={{ width: 20, height: 20, marginRight: 8 }}
        />
        <Text style={{ fontSize: 16, fontWeight: "bold", color: "#ffffff", flex: 1 }}>
          Settings
        </Text>
        <WindowButtons />
        <Pressable
          onPress={() => {
            Sevyn.closeApp();
          }}
          style={{
            width: 28,
            height: 28,
            borderRadius: 6,
            justifyContent: "center",
            alignItems: "center",
          }}
        >
          <Image source={symbolPath("close")} style={{ width: 16, height: 16 }} />
        </Pressable>
      </View>
      <ScrollView style={{ flex: 1 }}>
        <View
          style={{ paddingLeft: 16, paddingRight: 16, paddingTop: 16, paddingBottom: 24 }}
        >
          <Text style={{ fontSize: 16, fontWeight: "bold", color: "#111827" }}>
            Wi-Fi
          </Text>
          <Text style={{ fontSize: 14, color: "#374151", marginTop: 8 }}>
            {wifiStatusLine()}
          </Text>
          <View style={{ flexDirection: "row", marginTop: 12 }}>
            <Pressable
              onPress={() => void scanWifi()}
              style={{
                width: 120,
                height: 36,
                borderRadius: 8,
                backgroundColor: scanning ? "#9ca3af" : "#111827",
                justifyContent: "center",
                alignItems: "center",
                marginRight: 12,
              }}
            >
              <Text
                style={{
                  fontSize: 15,
                  fontWeight: "bold",
                  color: "#ffffff",
                  textAlign: "center",
                }}
              >
                {scanning ? "Scanning…" : "Scan"}
              </Text>
            </Pressable>
            {connectedSsid ? (
              <Pressable
                onPress={() => void disconnectWifi()}
                style={{
                  width: 120,
                  height: 36,
                  borderRadius: 8,
                  backgroundColor: "#e5e7eb",
                  justifyContent: "center",
                  alignItems: "center",
                  marginRight: 12,
                }}
              >
                <Text style={{ fontSize: 15, color: "#111827", textAlign: "center" }}>
                  Disconnect
                </Text>
              </Pressable>
            ) : null}
            {connectedSsid ? (
              <Pressable
                onPress={() => void forgetWifi(connectedSsid)}
                style={{
                  width: 120,
                  height: 36,
                  borderRadius: 8,
                  backgroundColor: "#e5e7eb",
                  justifyContent: "center",
                  alignItems: "center",
                }}
              >
                <Text style={{ fontSize: 15, color: "#111827", textAlign: "center" }}>
                  Forget
                </Text>
              </Pressable>
            ) : null}
          </View>
          {networks.map((n) => (
            <React.Fragment key={n.ssid}>
              {networkRow(n)}
              {n.ssid === selected ? passwordPrompt(n.ssid) : null}
            </React.Fragment>
          ))}
          {wifiMessage ? (
            <Text style={{ fontSize: 14, color: "#6b7280", marginTop: 8 }}>
              {wifiMessage}
            </Text>
          ) : null}
          <Text
            style={{ fontSize: 16, fontWeight: "bold", color: "#111827", marginTop: 24 }}
          >
            Update channel
          </Text>
          <Text style={{ fontSize: 14, color: "#374151", marginTop: 8 }}>
            Channel: {channel}
          </Text>
          <View style={{ flexDirection: "row", marginTop: 12 }}>
            {channelButton("Nightly", "nightly")}
            {channelButton("Stable", "stable")}
          </View>
          {message ? (
            <Text style={{ fontSize: 14, color: "#6b7280", marginTop: 8 }}>
              {message}
            </Text>
          ) : null}
          <Text
            style={{ fontSize: 16, fontWeight: "bold", color: "#111827", marginTop: 24 }}
          >
            Date & Time
          </Text>
          <Text style={{ fontSize: 14, color: "#374151", marginTop: 8 }}>
            {timeStatusLine()}
          </Text>
          {timeState.available ? (
            <Text style={{ fontSize: 14, color: "#374151", marginTop: 4 }}>
              {timeSyncLine()}
            </Text>
          ) : null}
          {timeState.available && timeState.rtc !== "" ? (
            <Text style={{ fontSize: 14, color: "#374151", marginTop: 4 }}>
              Hardware clock: {timeState.rtc}
            </Text>
          ) : null}
          <View style={{ flexDirection: "row", marginTop: 12 }}>
            <Pressable
              onPress={() => void syncTime()}
              style={{
                width: 120,
                height: 36,
                borderRadius: 8,
                backgroundColor: syncing ? "#9ca3af" : "#111827",
                justifyContent: "center",
                alignItems: "center",
                marginRight: 12,
              }}
            >
              <Text
                style={{
                  fontSize: 15,
                  fontWeight: "bold",
                  color: "#ffffff",
                  textAlign: "center",
                }}
              >
                {syncing ? "Syncing…" : "Sync Now"}
              </Text>
            </Pressable>
          </View>
          <Text style={{ fontSize: 14, color: "#374151", marginTop: 12 }}>
            Timezone (IANA name, e.g. America/New_York)
          </Text>
          <TextInput
            value={timezoneInput}
            onChangeText={setTimezoneInput}
            placeholder="America/New_York"
            style={{
              height: 36,
              backgroundColor: "#ffffff",
              borderRadius: 8,
              paddingLeft: 12,
              paddingRight: 12,
              marginTop: 8,
              fontSize: 15,
              color: "#111827",
            }}
          />
          <View style={{ flexDirection: "row", marginTop: 12 }}>
            <Pressable
              onPress={() => void applyTimezone()}
              style={{
                width: 120,
                height: 36,
                borderRadius: 8,
                backgroundColor: "#111827",
                justifyContent: "center",
                alignItems: "center",
                marginRight: 12,
              }}
            >
              <Text
                style={{
                  fontSize: 15,
                  fontWeight: "bold",
                  color: "#ffffff",
                  textAlign: "center",
                }}
              >
                Apply
              </Text>
            </Pressable>
          </View>
          {timeMessage ? (
            <Text style={{ fontSize: 14, color: "#6b7280", marginTop: 8 }}>
              {timeMessage}
            </Text>
          ) : null}
          <Text
            style={{ fontSize: 16, fontWeight: "bold", color: "#111827", marginTop: 24 }}
          >
            Sevyn Code
          </Text>
          {codeInfo.split("\n").map((line, i) => (
            <Text key={i} style={{ fontSize: 14, color: "#374151", marginTop: 4 }}>
              {line || " "}
            </Text>
          ))}
          <Text
            style={{ fontSize: 16, fontWeight: "bold", color: "#111827", marginTop: 24 }}
          >
            AI assistant
          </Text>
          <Text style={{ fontSize: 14, color: "#374151", marginTop: 8 }}>
            AI: {ai.selected}
          </Text>
          <View style={{ flexDirection: "row", marginTop: 12 }}>
            {ai.backends.map((id) => aiButton(id, id))}
          </View>
          <Text
            style={{ fontSize: 16, fontWeight: "bold", color: "#111827", marginTop: 24 }}
          >
            Power
          </Text>
          <Text style={{ fontSize: 14, color: "#374151", marginTop: 8 }}>
            Shut down or restart SevynOS.
          </Text>
          <View style={{ flexDirection: "row", marginTop: 12 }}>
            <Pressable
              onPress={() => void shutdownSystem()}
              style={{
                width: 120,
                height: 36,
                borderRadius: 8,
                backgroundColor: "#111827",
                justifyContent: "center",
                alignItems: "center",
                marginRight: 12,
              }}
            >
              <Text
                style={{
                  fontSize: 15,
                  fontWeight: "bold",
                  color: "#ffffff",
                  textAlign: "center",
                }}
              >
                Shut Down
              </Text>
            </Pressable>
            <Pressable
              onPress={() => void restartSystem()}
              style={{
                width: 120,
                height: 36,
                borderRadius: 8,
                backgroundColor: "#e5e7eb",
                justifyContent: "center",
                alignItems: "center",
              }}
            >
              <Text style={{ fontSize: 15, color: "#111827", textAlign: "center" }}>
                Restart
              </Text>
            </Pressable>
          </View>
          {powerMessage ? (
            <Text style={{ fontSize: 14, color: "#6b7280", marginTop: 8 }}>
              {powerMessage}
            </Text>
          ) : null}
          <Text
            style={{ fontSize: 16, fontWeight: "bold", color: "#111827", marginTop: 24 }}
          >
            Appearance
          </Text>
          <Text style={{ fontSize: 14, color: "#374151", marginTop: 8 }}>
            Choose the desktop wallpaper. It applies when Settings closes and is kept
            across reboots.
          </Text>
          <View style={{ flexDirection: "row", marginTop: 12 }}>
            {WALLPAPER_STYLES.map((s) => wallpaperStyleButton(s.label, s.value))}
          </View>
          {wallpaperStyle === "solid" ? (
            <View>
              <Text style={{ fontSize: 14, color: "#374151", marginTop: 12 }}>
                Color:{" "}
                {WALLPAPER_COLORS.find((c) => c.value === wallpaperColor)?.name ??
                  wallpaperColor}
              </Text>
              <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
                {WALLPAPER_COLORS.map((c) => wallpaperColorSwatch(c.name, c.value))}
              </View>
            </View>
          ) : (
            <Text style={{ fontSize: 14, color: "#374151", marginTop: 12 }}>
              Custom image wallpapers are not supported yet.
            </Text>
          )}
          {wallpaperMessage ? (
            <Text style={{ fontSize: 14, color: "#6b7280", marginTop: 8 }}>
              {wallpaperMessage}
            </Text>
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}
