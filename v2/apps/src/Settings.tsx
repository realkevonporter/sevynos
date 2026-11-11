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
// The Power section (shutdown fix) shuts down or restarts the
// system through `sevyn poweroff` / `sevyn reboot` — the same verbs
// the tray power menu runs.

import * as React from "react";
import { View, Text, Pressable, ScrollView, TextInput } from "./host";
import { WindowButtons } from "./window-buttons";
import { runCli, runCliAsync, parseField } from "./cli";

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
          <Text style={{ fontSize: 16, color: "#ffffff", textAlign: "center" }}>✕</Text>
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
          {networks.map((n) => networkRow(n))}
          {selected ? (
            <View style={{ marginTop: 12 }}>
              <Text style={{ fontSize: 14, color: "#374151" }}>
                Password for {selected}
              </Text>
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
                onPress={() => void connectWifi(selected, password)}
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
                  {connecting === selected ? "Connecting…" : "Connect"}
                </Text>
              </Pressable>
            </View>
          ) : null}
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
        </View>
      </ScrollView>
    </View>
  );
}
