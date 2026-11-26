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
  { label: "macOS Light", value: "macos-light" },
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

function readAi(): { selected: string; backends: string[]; godMode: boolean } {
  const { out } = runCli("sevyn ai list");
  const selected = parseField(out, "selected") ?? "unknown";
  const backends = parseField(out, "backends");
  // P2: god mode is live state, read from the daemon's STATUS (the
  // e2e handler does not cover `ai status`, so it returns "0\n"
  // there and godMode reads false — god mode is off in the harness).
  const status = runCli("sevyn ai status");
  const godMode = parseField(status.out, "god_mode") === "on";
  return { selected, backends: backends ? backends.split(",") : [], godMode };
}

type RelayState = {
  status: string;
  relay: boolean;
  tailnet: string;
  hostname: string;
  loginServer: string;
  authUrl: string;
};

// Relay 1b: the tailnet join state, read from `sevyn tailscale
// status`. `status` is the daemon's live state (parseField would
// only take the first word of "not logged in", so the line is
// matched whole). `relay` is the R6 marker (the user joined and
// wants to stay joined); `tailnet` is the 100.x address when the
// daemon is running and joined; `loginServer` comes from the
// marker (prefills the join form on a re-join); `authUrl` is the
// pending interactive-login URL, while a Terminal-initiated `up`
// waits for approval. The e2e handler does not cover `tailscale
// status`, so it returns "0\n" there and the relay reads off.
function readRelay(): RelayState {
  const { code, out } = runCli("sevyn tailscale status");
  const off: RelayState = {
    status: "unknown",
    relay: false,
    tailnet: "",
    hostname: "",
    loginServer: "",
    authUrl: "",
  };
  if (code !== 0) return off;
  let status = "unknown";
  if (out.includes("status: running")) status = "running";
  else if (out.includes("status: not logged in")) status = "not logged in";
  else if (out.includes("status: stopped")) status = "stopped";
  return {
    status,
    relay: parseField(out, "relay") === "enabled",
    tailnet: parseField(out, "tailnet") ?? "",
    hostname: parseField(out, "hostname") ?? "",
    loginServer: parseField(out, "login_server") ?? "",
    authUrl: parseField(out, "auth_url") ?? "",
  };
}

/* The last few audit log entries (P2, §2.5). Only real audit lines
 * are shown: a timestamped entry, or the CLI's own "No AI activity
 * yet." — anything else (e.g. the harness's empty "0") is not an
 * audit line and is dropped. */
function readAudit(): string[] {
  const { out } = runCli("sevyn ai audit 5");
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(
      (l) =>
        l !== "" &&
        ((l.startsWith("20") && l.includes(" -> ")) || l === "No AI activity yet."),
    );
}

type AgentState = {
  enabled: boolean;
  paired: string;
  pendingPeer: string;
  pendingCode: string;
  session: string;
};

// Relay agent (Phase 2): the cloud-agent listener, read from
// `sevyn ai relay status` — one line per fact, `relay: ...` style
// like `tailscale status` (INTERFACES.md §CLI). The CLI's exact
// lines (sevyn.c, cmd_ai_relay status branch): `relay agent:
// enabled|disabled`, `agent: running (pid N)|not running`,
// `fingerprint: <full>`, `paired: <fp16>|unpaired`,
// `pairing: pending <fp16> code <code>` (only while a pairing is
// pending), `daemon relay: on|idle|off|unknown` (or
// `daemon: unreachable`). `paired` is the pinned peer fingerprint,
// or "unpaired"; `session` is the daemon's live state (on/idle/off).
// parseField is unanchored (cli.ts), so "relay agent:" also matches
// a bare "agent" key — the reads below use the full field names so
// they do not depend on that accident. A stub that returns "0\n"
// reads as disabled/unpaired, like the tailnet relay does in the
// harness.
function readAgent(): AgentState {
  const { code, out } = runCli("sevyn ai relay status");
  const off: AgentState = {
    enabled: false,
    paired: "",
    pendingPeer: "",
    pendingCode: "",
    session: "",
  };
  if (code !== 0) return off;
  const enabled =
    parseField(out, "relay agent") === "enabled" ||
    parseField(out, "agent") === "enabled" ||
    parseField(out, "agent") === "on";
  const pairedField =
    parseField(out, "paired") ?? parseField(out, "peer_fingerprint") ?? "";
  const paired = pairedField === "unpaired" || pairedField === "none" ? "" : pairedField;
  const sessionField =
    parseField(out, "session") ?? parseField(out, "daemon relay") ?? "";
  const session =
    sessionField === "on" || sessionField === "idle" || sessionField === "off"
      ? sessionField
      : "";
  // The pending pairing rides one line: `pairing: pending <fp16>
  // code <code>`. parseField cannot split it (it returns the first
  // token only), so match the whole line.
  const pairingLine = out.match(/pairing:\s*pending\s+(\S+)\s+code\s+(\S+)/);
  return {
    enabled,
    paired,
    pendingPeer: pairingLine ? pairingLine[1] : "",
    pendingCode: pairingLine ? pairingLine[2] : "",
    session,
  };
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
  const [ai, setAi] = React.useState<{
    selected: string;
    backends: string[];
    godMode: boolean;
  }>(() => readAi());
  // God mode (P2, D1): the two-step confirm. The toggle opens the
  // dialog; Confirm runs the enable. The dialog lists every power
  // in plain language — there is no one-tap enable.
  const [godConfirm, setGodConfirm] = React.useState<boolean>(false);
  // Relay (1b, R1-R6): the tailnet join. The login server is
  // prefilled from the marker when re-joining (it is empty on a
  // first join); the auth-key input is cleared after a join so the
  // single-use key does not sit in the field.
  const [relay, setRelay] = React.useState<RelayState>(() => readRelay());
  const [loginServer, setLoginServer] = React.useState<string>(relay.loginServer);
  const [relayKey, setRelayKey] = React.useState<string>("");
  const [relayConfirm, setRelayConfirm] = React.useState<boolean>(false);
  const [relayMessage, setRelayMessage] = React.useState<string>("");
  // Relay agent (Phase 2): the cloud-agent listener. `agentConfirm`
  // is the two-step enable dialog; `revokeConfirm` the two-step
  // forget dialog; `pairingDismissed` holds the fingerprint of a
  // pending peer the user dismissed, so Dismiss hides the dialog
  // without clearing the pending pairing (a different peer re-opens
  // it). The pairing code is never logged.
  const [agent, setAgent] = React.useState<AgentState>(() => readAgent());
  const [agentConfirm, setAgentConfirm] = React.useState<boolean>(false);
  const [revokeConfirm, setRevokeConfirm] = React.useState<boolean>(false);
  const [pairingDismissed, setPairingDismissed] = React.useState<string>("");
  const [agentMessage, setAgentMessage] = React.useState<string>("");
  const [auditLines, setAuditLines] = React.useState<string[]>(() => readAudit());
  // Muse API key (P0): the muse-ai backend reads it from
  // /data/ai/muse-key. It is typed here, written to a temp file, and
  // handed to `sevyn ai key --file` (which unlinks the temp file) —
  // the key itself never appears in a log or on screen.
  const [museKey, setMuseKey] = React.useState<string>("");
  const [museKeyMessage, setMuseKeyMessage] = React.useState<string>("");
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

  // Save the Muse API key (P0): write it to a temp file, then let
  // `sevyn ai key --file` move it into /data/ai/muse-key (0600) and
  // unlink the temp file. The input is cleared on success so the
  // key does not sit in the field.
  function saveMuseKey(): void {
    if (museKey.trim() === "") {
      setMuseKeyMessage("Enter a Muse API key first.");
      return;
    }
    const { code } = runCli("sevyn files write /tmp/muse-key.tmp " + q(museKey.trim()));
    if (code !== 0) {
      setMuseKeyMessage("Could not save the key.");
      return;
    }
    const saved = runCli("sevyn ai key --file /tmp/muse-key.tmp");
    if (saved.code !== 0) {
      setMuseKeyMessage("Could not save the key.");
      return;
    }
    setMuseKey("");
    setMuseKeyMessage("Muse API key saved.");
    Sevyn.log("SETTINGS muse-key=saved");
  }

  function clearMuseKey(): void {
    const { code } = runCli("sevyn ai key --clear");
    if (code !== 0) {
      setMuseKeyMessage("Could not clear the key.");
      return;
    }
    setMuseKey("");
    setMuseKeyMessage("Muse API key cleared.");
    Sevyn.log("SETTINGS muse-key=cleared");
  }

  // God mode (P2, D1-D2): enable runs the two-step confirm — the
  // caller (the dialog's Confirm button) already showed the powers,
  // and the CLI refuses a bare enable anyway. Disable is immediate
  // (revoking access needs no confirm). After either, the state is
  // re-read from the daemon and the audit view refreshed, so the
  // enable/disable event shows up below.
  function setGodMode(on: boolean): void {
    const { code } = runCli(
      on ? "sevyn ai god on --confirm --via settings" : "sevyn ai god off",
    );
    if (code !== 0) {
      setMessage(on ? "Could not turn god mode on." : "Could not turn god mode off.");
      return;
    }
    const current = readAi();
    setAi(current);
    setAuditLines(readAudit());
    setMessage(current.godMode ? "God mode is on." : "God mode is off.");
    Sevyn.log("SETTINGS god_mode=" + (current.godMode ? "on" : "off"));
  }

  // Relay (1b): join runs the two-step confirm — the caller (the
  // dialog's Confirm button) already showed the exposure, and the
  // CLI refuses a bare join anyway. The auth key travels through a
  // temp file (`--file`, which unlinks it), like the Muse key.
  // Leave is immediate (revoking access needs no confirm). After
  // either, the state is re-read, so the banner and the pill follow
  // the real state.
  function joinRelay(): void {
    if (loginServer.trim() === "" || relayKey.trim() === "") {
      setRelayMessage("Enter a login server and an auth key first.");
      return;
    }
    const { code } = runCli(
      "sevyn files write /tmp/relay-authkey.tmp " + q(relayKey.trim()),
    );
    if (code !== 0) {
      setRelayMessage("Could not join the tailnet.");
      return;
    }
    const joined = runCli(
      "sevyn tailscale up --login-server " +
        q(loginServer.trim()) +
        " --file /tmp/relay-authkey.tmp --confirm --via settings",
    );
    if (joined.code !== 0) {
      setRelayMessage("Could not join the tailnet.");
      return;
    }
    setRelayKey("");
    const current = readRelay();
    setRelay(current);
    setRelayMessage(
      current.tailnet !== ""
        ? "Joined the tailnet at " + current.tailnet + "."
        : "Joined the tailnet.",
    );
    Sevyn.log("SETTINGS relay=on tailnet=" + current.tailnet);
  }

  function leaveRelay(): void {
    const { code } = runCli("sevyn tailscale down");
    if (code !== 0) {
      setRelayMessage("Could not leave the tailnet.");
      return;
    }
    const current = readRelay();
    setRelay(current);
    setRelayMessage("Left the tailnet.");
    Sevyn.log("SETTINGS relay=off");
  }

  // Relay agent (Phase 2): enable runs the two-step confirm — the
  // caller (the dialog's Confirm button) already showed the
  // exposure, and the CLI refuses a bare enable anyway. Disable is
  // immediate (revoking access needs no confirm). Pair approves a
  // pending pairing; revoke deletes the keys and the pin (two-step,
  // via its own dialog — the caller already showed what is deleted).
  // After each, the state is re-read and the audit view refreshed,
  // so the banner and the pairing dialog follow the real state. The
  // pairing code is never logged.
  function enableAgent(): void {
    const { code } = runCli("sevyn ai relay on --confirm --via settings");
    if (code !== 0) {
      setAgentMessage("Could not turn the relay agent on.");
      return;
    }
    const current = readAgent();
    setAgent(current);
    setAuditLines(readAudit());
    setAgentMessage(current.enabled ? "Relay agent is on." : "Relay agent is off.");
    Sevyn.log("SETTINGS relay_agent=on");
  }

  function disableAgent(): void {
    const { code } = runCli("sevyn ai relay off");
    if (code !== 0) {
      setAgentMessage("Could not turn the relay agent off.");
      return;
    }
    const current = readAgent();
    setAgent(current);
    setAuditLines(readAudit());
    setAgentMessage("Relay agent is off.");
    Sevyn.log("SETTINGS relay_agent=off");
  }

  function pairAgent(): void {
    const { code } = runCli("sevyn ai relay pair --confirm");
    if (code !== 0) {
      setAgentMessage("Could not pair the cloud agent.");
      return;
    }
    const current = readAgent();
    setAgent(current);
    setAuditLines(readAudit());
    setAgentMessage("Cloud agent paired.");
    Sevyn.log("SETTINGS relay_agent=paired");
  }

  function revokeAgent(): void {
    const { code } = runCli("sevyn ai relay revoke --confirm");
    if (code !== 0) {
      setAgentMessage("Could not forget the pairing.");
      return;
    }
    const current = readAgent();
    setAgent(current);
    setAuditLines(readAudit());
    setAgentMessage("Pairing forgotten.");
    Sevyn.log("SETTINGS relay_agent=revoked");
  }

  function agentStatusLine(): string {
    if (!agent.enabled) return "Relay agent: disabled";
    let line = "Relay agent: enabled";
    line +=
      agent.paired !== "" ? " — paired to " + agent.paired.slice(0, 16) : " — unpaired";
    if (agent.session === "on") line += " — session live";
    else if (agent.session === "idle") line += " — session idle";
    return line;
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
          <Text style={{ fontSize: 14, color: "#374151", marginTop: 16 }}>
            Muse API key — the muse-ai backend needs a Model API key (dev.meta.ai). It is
            stored on this device only.
          </Text>
          <TextInput
            value={museKey}
            onChangeText={setMuseKey}
            placeholder="Muse API key"
            secureTextEntry={true}
            autoCapitalize="none"
            autoCorrect={false}
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
              onPress={() => void saveMuseKey()}
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
                Save key
              </Text>
            </Pressable>
            <Pressable
              onPress={() => void clearMuseKey()}
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
                Clear key
              </Text>
            </Pressable>
          </View>
          {museKeyMessage ? (
            <Text style={{ fontSize: 14, color: "#374151", marginTop: 8 }}>
              {museKeyMessage}
            </Text>
          ) : null}
          {/* God mode (P2, D1): the toggle. Pressing it while off
              opens the confirm dialog below (which lists every
              power); pressing it while on turns god mode off
              immediately. One focusable, after Clear key. */}
          <View style={{ flexDirection: "row", marginTop: 16 }}>
            <Pressable
              onPress={() => {
                if (ai.godMode) setGodMode(false);
                else setGodConfirm(true);
              }}
              style={{
                width: 180,
                height: 36,
                borderRadius: 8,
                backgroundColor: ai.godMode ? "#b45309" : "#e5e7eb",
                justifyContent: "center",
                alignItems: "center",
              }}
            >
              <Text
                style={{
                  fontSize: 15,
                  fontWeight: "bold",
                  color: ai.godMode ? "#ffffff" : "#111827",
                  textAlign: "center",
                }}
              >
                {ai.godMode ? "Turn god mode off" : "Turn god mode on"}
              </Text>
            </Pressable>
          </View>
          {/* Persistent banner while god mode is on (D1): the mode
              is never silent — the banner, the tray's GOD pill, and
              the boot log line all say so. */}
          {ai.godMode ? (
            <Text
              style={{
                fontSize: 14,
                color: "#92400e",
                backgroundColor: "#fef3c7",
                marginTop: 12,
                padding: 12,
                borderRadius: 8,
              }}
            >
              God mode is ON — the AI has full access to this device. Every action is
              logged.
            </Text>
          ) : null}
          {/* Two-step confirm (D1): the dialog lists every power in
              plain language. Its buttons exist only while it is
              open, so they never shift the focus order. */}
          {godConfirm ? (
            <View style={{ marginTop: 12 }}>
              <Text style={{ fontSize: 14, color: "#374151" }}>
                God mode gives the AI full access to this device:
              </Text>
              <Text style={{ fontSize: 14, color: "#374151", marginTop: 4 }}>
                - install and uninstall apps
              </Text>
              <Text style={{ fontSize: 14, color: "#374151", marginTop: 4 }}>
                - reboot the device
              </Text>
              <Text style={{ fontSize: 14, color: "#374151", marginTop: 4 }}>
                - apply system updates
              </Text>
              <Text style={{ fontSize: 14, color: "#374151", marginTop: 4 }}>
                - read and write your files
              </Text>
              <Text style={{ fontSize: 14, color: "#374151", marginTop: 4 }}>
                - run any sevyn command
              </Text>
              <Text style={{ fontSize: 14, color: "#374151", marginTop: 4 }}>
                Every action is logged to the AI audit log.
              </Text>
              <View style={{ flexDirection: "row", marginTop: 12 }}>
                <Pressable
                  onPress={() => {
                    setGodConfirm(false);
                    setGodMode(true);
                  }}
                  style={{
                    width: 120,
                    height: 36,
                    borderRadius: 8,
                    backgroundColor: "#b45309",
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
                    Confirm
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => setGodConfirm(false)}
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
                    Cancel
                  </Text>
                </Pressable>
              </View>
            </View>
          ) : null}
          {/* Relay (1b, R1-R6): the tailnet join. The join form is
              only shown while the relay is off (login server, auth
              key, Join — three focusables); the Leave button only
              while it is on (one focusable). The dialog buttons exist
              only while the dialog is open, so they never shift the
              focus order. The Join button validates the fields before
              opening the dialog. */}
          <Text
            style={{ fontSize: 16, fontWeight: "bold", color: "#111827", marginTop: 24 }}
          >
            AI relay
          </Text>
          <Text style={{ fontSize: 14, color: "#374151", marginTop: 8 }}>
            Let the cloud agent reach this device over its own tailnet (Tailscale). The
            device is addressable by its tailnet IP only; the tailnet's ACL decides which
            nodes may reach it.
          </Text>
          <Text style={{ fontSize: 14, color: "#374151", marginTop: 8 }}>
            Relay:{" "}
            {relay.tailnet !== ""
              ? "on — " +
                relay.tailnet +
                (relay.hostname ? " (" + relay.hostname + ")" : "")
              : relay.relay
                ? "on, reconnecting…"
                : "off"}
          </Text>
          {relay.relay ? (
            <View style={{ flexDirection: "row", marginTop: 12 }}>
              <Pressable
                onPress={() => void leaveRelay()}
                style={{
                  width: 180,
                  height: 36,
                  borderRadius: 8,
                  backgroundColor: "#e5e7eb",
                  justifyContent: "center",
                  alignItems: "center",
                }}
              >
                <Text
                  style={{
                    fontSize: 15,
                    fontWeight: "bold",
                    color: "#111827",
                    textAlign: "center",
                  }}
                >
                  Leave tailnet
                </Text>
              </Pressable>
            </View>
          ) : (
            <View>
              <TextInput
                value={loginServer}
                onChangeText={setLoginServer}
                placeholder="https://headscale.sevynos.org"
                autoCapitalize="none"
                autoCorrect={false}
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
              <TextInput
                value={relayKey}
                onChangeText={setRelayKey}
                placeholder="Auth key (from the tailnet admin)"
                secureTextEntry={true}
                autoCapitalize="none"
                autoCorrect={false}
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
                  onPress={() => {
                    if (loginServer.trim() === "" || relayKey.trim() === "") {
                      setRelayMessage("Enter a login server and an auth key first.");
                      return;
                    }
                    setRelayConfirm(true);
                  }}
                  style={{
                    width: 180,
                    height: 36,
                    borderRadius: 8,
                    backgroundColor: "#1e40af",
                    justifyContent: "center",
                    alignItems: "center",
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
                    Join tailnet
                  </Text>
                </Pressable>
              </View>
            </View>
          )}
          {/* Persistent banner while the relay is on (R6): the mode
              is never silent — the banner, the tray's RELAY pill,
              and the boot re-join all say so. Blue, distinct from
              god mode's amber. */}
          {relay.tailnet !== "" ? (
            <Text
              style={{
                fontSize: 14,
                color: "#1e40af",
                backgroundColor: "#dbeafe",
                marginTop: 12,
                padding: 12,
                borderRadius: 8,
              }}
            >
              Relay is ON — this device is reachable from the tailnet at {relay.tailnet}.
              It stays joined across reboots.
            </Text>
          ) : null}
          {/* Auth-URL row (1b): while a Terminal-initiated interactive
              login waits, the URL to approve is shown here — approve
              it on another device (your phone). */}
          {relay.authUrl !== "" ? (
            <Text style={{ fontSize: 14, color: "#374151", marginTop: 12 }}>
              Approve the join on another device: {relay.authUrl}
            </Text>
          ) : null}
          {relayMessage ? (
            <Text style={{ fontSize: 14, color: "#374151", marginTop: 8 }}>
              {relayMessage}
            </Text>
          ) : null}
          {/* Two-step confirm (R1/R3): the dialog lists what joining
              exposes, in plain language. Its buttons exist only
              while it is open, so they never shift the focus order. */}
          {relayConfirm ? (
            <View style={{ marginTop: 12 }}>
              <Text style={{ fontSize: 14, color: "#374151" }}>
                Joining a tailnet makes this device reachable from it:
              </Text>
              <Text style={{ fontSize: 14, color: "#374151", marginTop: 4 }}>
                - any node the tailnet ACL allows can reach this device
              </Text>
              <Text style={{ fontSize: 14, color: "#374151", marginTop: 4 }}>
                - this device can reach the tailnet's nodes (per the ACL)
              </Text>
              <Text style={{ fontSize: 14, color: "#374151", marginTop: 4 }}>
                - the tailnet's control plane (the login server) sees this device's
                tailnet address and connection state
              </Text>
              <Text style={{ fontSize: 14, color: "#374151", marginTop: 4 }}>
                The device stays joined across reboots until you leave.
              </Text>
              <View style={{ flexDirection: "row", marginTop: 12 }}>
                <Pressable
                  onPress={() => {
                    setRelayConfirm(false);
                    joinRelay();
                  }}
                  style={{
                    width: 120,
                    height: 36,
                    borderRadius: 8,
                    backgroundColor: "#1e40af",
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
                    Confirm
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => setRelayConfirm(false)}
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
                    Cancel
                  </Text>
                </Pressable>
              </View>
            </View>
          ) : null}
          {/* Relay agent (Phase 2): the cloud-agent listener, below
              the tailnet join block. The toggle and Forget are always
              present (two focusables); the dialogs' buttons exist
              only while their dialog is open, so they never shift the
              focus order. The pairing dialog opens whenever a pending
              pairing exists, unless this peer was dismissed. */}
          <Text
            style={{ fontSize: 16, fontWeight: "bold", color: "#111827", marginTop: 24 }}
          >
            Relay agent
          </Text>
          <Text style={{ fontSize: 14, color: "#374151", marginTop: 8 }}>
            Let the paired cloud agent run AI tasks on this device over the tailnet. It
            acts only with the AI permissions already granted here, and every action is
            logged.
          </Text>
          <Text style={{ fontSize: 14, color: "#374151", marginTop: 8 }}>
            {agentStatusLine()}
          </Text>
          <View style={{ flexDirection: "row", marginTop: 12 }}>
            <Pressable
              onPress={() => {
                if (agent.enabled) disableAgent();
                else setAgentConfirm(true);
              }}
              style={{
                width: 180,
                height: 36,
                borderRadius: 8,
                backgroundColor: agent.enabled ? "#1e40af" : "#e5e7eb",
                justifyContent: "center",
                alignItems: "center",
                marginRight: 12,
              }}
            >
              <Text
                style={{
                  fontSize: 15,
                  fontWeight: "bold",
                  color: agent.enabled ? "#ffffff" : "#111827",
                  textAlign: "center",
                }}
              >
                {agent.enabled ? "Turn relay agent off" : "Turn relay agent on"}
              </Text>
            </Pressable>
            <Pressable
              onPress={() => {
                if (agent.paired !== "") setRevokeConfirm(true);
                else setAgentMessage("Nothing paired to forget.");
              }}
              style={{
                width: 180,
                height: 36,
                borderRadius: 8,
                backgroundColor: "#e5e7eb",
                justifyContent: "center",
                alignItems: "center",
              }}
            >
              <Text
                style={{
                  fontSize: 15,
                  fontWeight: "bold",
                  color: "#111827",
                  textAlign: "center",
                }}
              >
                Forget this pairing
              </Text>
            </Pressable>
          </View>
          {/* Persistent banner while the agent is enabled: blue like
              the tailnet banner, but it names the paired agent (not
              the tailnet address), so the two are never confused. */}
          {agent.enabled ? (
            <Text
              style={{
                fontSize: 14,
                color: "#1e40af",
                backgroundColor: "#dbeafe",
                marginTop: 12,
                padding: 12,
                borderRadius: 8,
              }}
            >
              Relay agent is ON —{" "}
              {agent.paired !== ""
                ? "paired to " + agent.paired.slice(0, 16)
                : "waiting for the cloud agent to pair"}
              {agent.session === "on" ? ". A remote session is live." : "."}
            </Text>
          ) : null}
          {agentMessage ? (
            <Text style={{ fontSize: 14, color: "#374151", marginTop: 8 }}>
              {agentMessage}
            </Text>
          ) : null}
          {/* Two-step confirm (D1): the dialog lists what enabling
              exposes, in plain language. Its buttons exist only
              while it is open, so they never shift the focus order. */}
          {agentConfirm ? (
            <View style={{ marginTop: 12 }}>
              <Text style={{ fontSize: 14, color: "#374151" }}>
                Turning the relay agent on lets the paired cloud agent run AI tasks on
                this device:
              </Text>
              <Text style={{ fontSize: 14, color: "#374151", marginTop: 4 }}>
                - the cloud agent connects over the tailnet only (no tailnet, no
                connection)
              </Text>
              <Text style={{ fontSize: 14, color: "#374151", marginTop: 4 }}>
                - it acts only with the AI permissions already granted on this device —
                nothing more
              </Text>
              <Text style={{ fontSize: 14, color: "#374151", marginTop: 4 }}>
                - it can read and write your files and run sevyn commands the AI is
                allowed to run
              </Text>
              <Text style={{ fontSize: 14, color: "#374151", marginTop: 4 }}>
                - every action is logged to the AI audit log
              </Text>
              <Text style={{ fontSize: 14, color: "#374151", marginTop: 4 }}>
                The agent stays on across reboots until you turn it off.
              </Text>
              <View style={{ flexDirection: "row", marginTop: 12 }}>
                <Pressable
                  onPress={() => {
                    setAgentConfirm(false);
                    enableAgent();
                  }}
                  style={{
                    width: 120,
                    height: 36,
                    borderRadius: 8,
                    backgroundColor: "#1e40af",
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
                    Confirm
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => setAgentConfirm(false)}
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
                    Cancel
                  </Text>
                </Pressable>
              </View>
            </View>
          ) : null}
          {/* Pairing dialog (Phase 2): shown while a pending pairing
              exists. Confirm pins the peer key; Dismiss only hides
              this dialog — the pending pairing stays until approved
              or revoked. Its buttons exist only while it is open, so
              they never shift the focus order. */}
          {agent.pendingPeer !== "" && pairingDismissed !== agent.pendingPeer ? (
            <View style={{ marginTop: 12 }}>
              <Text style={{ fontSize: 14, color: "#374151" }}>
                A cloud agent wants to pair with this device:
              </Text>
              <Text style={{ fontSize: 14, color: "#374151", marginTop: 4 }}>
                Peer: {agent.pendingPeer.slice(0, 16)}
              </Text>
              <Text style={{ fontSize: 14, color: "#374151", marginTop: 4 }}>
                Pairing code: {agent.pendingCode}
              </Text>
              <Text style={{ fontSize: 14, color: "#374151", marginTop: 4 }}>
                Compare the code with the one the cloud agent shows. Confirm only if they
                match.
              </Text>
              <View style={{ flexDirection: "row", marginTop: 12 }}>
                <Pressable
                  onPress={() => pairAgent()}
                  style={{
                    width: 120,
                    height: 36,
                    borderRadius: 8,
                    backgroundColor: "#1e40af",
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
                    Confirm
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => setPairingDismissed(agent.pendingPeer)}
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
                    Dismiss
                  </Text>
                </Pressable>
              </View>
            </View>
          ) : null}
          {/* Two-step confirm for Forget: revoking deletes the device
              keypair and the pinned peer key, so it needs the confirm
              step. Its buttons exist only while it is open, so they
              never shift the focus order. */}
          {revokeConfirm ? (
            <View style={{ marginTop: 12 }}>
              <Text style={{ fontSize: 14, color: "#374151" }}>
                Forgetting this pairing deletes the device keypair and the pinned
                cloud-agent key. The cloud agent will have to pair again from scratch.
              </Text>
              <View style={{ flexDirection: "row", marginTop: 12 }}>
                <Pressable
                  onPress={() => {
                    setRevokeConfirm(false);
                    revokeAgent();
                  }}
                  style={{
                    width: 120,
                    height: 36,
                    borderRadius: 8,
                    backgroundColor: "#1e40af",
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
                    Confirm
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => setRevokeConfirm(false)}
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
                    Cancel
                  </Text>
                </Pressable>
              </View>
            </View>
          ) : null}
          {/* AI activity (P2, §2.5): the last few audit log entries.
              Text lines, not focusable. */}
          <Text style={{ fontSize: 14, color: "#374151", marginTop: 16 }}>
            AI activity
          </Text>
          {auditLines.length > 0 ? (
            auditLines.map((line, i) => (
              <Text key={i} style={{ fontSize: 13, color: "#6b7280", marginTop: 4 }}>
                {/* Phase 2: audit lines from a relay session carry
                    " via=relay" — they show a "remote" badge (the
                    lines render as plain Text, so the badge is a
                    suffix, not a separate View). */}
                {line.includes("via=relay") ? line + " · remote" : line}
              </Text>
            ))
          ) : (
            <Text style={{ fontSize: 13, color: "#6b7280", marginTop: 4 }}>
              No AI activity yet.
            </Text>
          )}
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
