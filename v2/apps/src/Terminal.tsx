// SevynOS v2 M4 — the Terminal system app.
//
// The recovery path (locked rule): the Terminal exposes ONLY the
// `sevyn` CLI — no bash, no escape hatch. Every submitted line runs
// one-shot through the host's Sevyn.exec bridge (gated by the
// cli.exec permission), and the output lands in the scrollback. Kill
// the shell from here and start it again from here — that is the M4
// done-when, proven in CI.
//
// The app also logs markers the harness reads off the serial:
//   TERMINAL update-status channel=<c>   (after `update status`)
//   TERMINAL code-status running=<y/n> serving=<y/n>
//            terminal-shell=<path>       (after `code status`)
//   TERMINAL settings-json defaultProfile=<name>
//                                        (after catting the
//                                        code-server settings file)
//   TERMINAL ai-status selected=<id>     (after `ai status`)
//   TERMINAL ai-ask allowed=<n> denied=<m>
//                                        (after `ai ask ...`)
// The host logs every exec itself (EXEC <cmd> -> <code>); these
// markers carry the parsed fields the harness asserts on.

import * as React from "react";
import { View, Text, Pressable, TextInput } from "./host";
import { runCli, parseField } from "./cli";

const MAX_LINES = 500;
const VISIBLE_LINES = 21;

const HELP_LINES: string[] = [
  "SevynOS Terminal — the sevyn CLI only. No bash.",
  "",
  "  sevyn help                  this help",
  "  sevyn shell kill|start|restart|status",
  "  sevyn update status         version, channel, slots",
  "  sevyn update channel <c>    nightly | stable",
  "  sevyn files list [path]     list a directory",
  "  sevyn files cat <path>      print a file",
  "  sevyn code status           Sevyn Code status",
  "  sevyn ai list|status        which AI is plugged in",
  "  sevyn ai select <id>        plug in a different AI",
  "  sevyn ai ask <task...>      ask the AI to do something",
  "",
  "Type a command below and press Enter.",
];

function logMarkers(cmd: string, out: string): void {
  if (cmd === "update status" || cmd.startsWith("update status ")) {
    Sevyn.log(
      "TERMINAL update-status channel=" + (parseField(out, "channel") ?? "unknown"),
    );
  } else if (cmd === "code status" || cmd.startsWith("code status ")) {
    Sevyn.log(
      "TERMINAL code-status running=" +
        (parseField(out, "running") ?? "unknown") +
        " serving=" +
        (parseField(out, "serving") ?? "unknown") +
        " terminal-shell=" +
        (parseField(out, "terminal-shell") ?? "unknown"),
    );
  } else if (cmd.startsWith("files cat ") && cmd.includes("settings.json")) {
    const profile = out.includes('"terminal.integrated.defaultProfile.linux": "sevyn"')
      ? "sevyn"
      : "other";
    Sevyn.log("TERMINAL settings-json defaultProfile=" + profile);
  } else if (cmd === "ai status" || cmd.startsWith("ai status ")) {
    Sevyn.log(
      "TERMINAL ai-status selected=" + (parseField(out, "selected") ?? "unknown"),
    );
  } else if (cmd === "ai ask" || cmd.startsWith("ai ask ")) {
    Sevyn.log(
      "TERMINAL ai-ask allowed=" +
        (parseField(out, "allowed") ?? "?") +
        " denied=" +
        (parseField(out, "denied") ?? "?"),
    );
  }
}

export function Terminal(): React.ReactElement {
  const [lines, setLines] = React.useState<string[]>(HELP_LINES);
  const [input, setInput] = React.useState("");
  const color = Sevyn.appColor;

  function append(more: string[]): void {
    setLines((prev) => [...prev, ...more].slice(-MAX_LINES));
  }

  function run(cmd: string): void {
    const trimmed = cmd.trim();
    append(["sevyn> " + trimmed]);
    if (!trimmed) return;
    const { out } = runCli("sevyn " + trimmed);
    const outLines = out.split("\n");
    // Drop the single trailing "" from a trailing newline.
    if (outLines.length > 0 && outLines[outLines.length - 1] === "") outLines.pop();
    append(outLines);
    logMarkers(trimmed, out);
  }

  function submit(): void {
    const cmd = input;
    setInput("");
    run(cmd);
  }

  const visible = lines.slice(-VISIBLE_LINES);

  return (
    <View
      style={{
        width: 800,
        height: 500,
        flexDirection: "column",
        backgroundColor: "#111827",
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
          Terminal
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
      <View style={{ flex: 1, paddingLeft: 8, paddingRight: 8, paddingTop: 8 }}>
        {visible.map((line, i) => (
          <Text key={i} style={{ fontSize: 14, color: "#e5e7eb" }}>
            {line || " "}
          </Text>
        ))}
      </View>
      <View
        style={{
          flexDirection: "row",
          height: 36,
          alignItems: "center",
          paddingLeft: 8,
          paddingRight: 8,
          paddingBottom: 8,
        }}
      >
        <Text style={{ fontSize: 15, color: "#9ca3af" }}>sevyn&gt; </Text>
        <TextInput
          value={input}
          onChangeText={setInput}
          onSubmitEditing={submit}
          placeholder="type a sevyn command"
          autoFocus
          style={{
            flex: 1,
            height: 28,
            backgroundColor: "#1f2937",
            fontSize: 15,
            color: "#e5e7eb",
          }}
        />
      </View>
    </View>
  );
}
