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

import * as React from "react";
import { View, Text, Pressable } from "./host";
import { runCli, parseField } from "./cli";

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

  return (
    <View
      style={{
        width: 800,
        height: 500,
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
      <View style={{ flex: 1, paddingLeft: 16, paddingRight: 16, paddingTop: 16 }}>
        <Text style={{ fontSize: 16, fontWeight: "bold", color: "#111827" }}>
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
          <Text style={{ fontSize: 14, color: "#6b7280", marginTop: 8 }}>{message}</Text>
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
      </View>
    </View>
  );
}
