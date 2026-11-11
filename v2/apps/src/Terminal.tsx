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
//   TERMINAL browser-open title=<t> url=<u>
//                                        (after `browser open <url>`)
//   TERMINAL browser-tabs n=<n> titles=<t1|t2|...> ids=<id1|id2|...>
//                                        (after `browser tabs`)
//   TERMINAL browser-status running=<y/n> tabs=<n>
//                                        (after `browser status`)
//   TERMINAL net-status interface=<i> wifi=<w>
//                                        (after `net status`)
//   TERMINAL net-dns host=<h> ip=<ip>    (after `net dns <host>`)
// The host logs every exec itself (EXEC <cmd> -> <code>); these
// markers carry the parsed fields the harness asserts on.

import * as React from "react";
import { View, Text, Pressable, ScrollView, TextInput } from "./host";
import { scrollTo } from "../../rn/renderer/sevyn-renderer";
import { WindowButtons } from "./window-buttons";
import { runCli, parseField } from "./cli";

const MAX_LINES = 500;

// Render cap: the scrollback buffer keeps 500 lines, but only the
// last RENDERED_LINES render. A full 500-line render makes every
// keystroke present ~12x costlier (measured in the mock renderer:
// 15.6ms vs 1.35ms at 21 lines) and the M7 headless phases timed out
// typing into the Terminal at max accumulation under TCG (PR #98).
// 100 lines is still ~5 screens of scrollable history.
const RENDERED_LINES = 100;

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
  "  sevyn browser open [url]    open a page in Chromium",
  "  sevyn browser tabs          list open tabs",
  "  sevyn browser status        Chromium + CDP + tab count",
  "  sevyn net status            link, address, gateway, DNS",
  "  sevyn net dns <host>        resolve a name",
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
  } else if (cmd === "browser open" || cmd.startsWith("browser open ")) {
    const tabLine = out.split("\n").find((l) => l.startsWith("tab: "));
    const parts = tabLine ? tabLine.slice(5).split("\t") : [];
    Sevyn.log(
      "TERMINAL browser-open title=" +
        (parts[1] ?? "unknown") +
        " url=" +
        (parts[2] ?? "unknown"),
    );
  } else if (cmd === "browser tabs" || cmd.startsWith("browser tabs ")) {
    const titles: string[] = [];
    const ids: string[] = [];
    for (const line of out.split("\n")) {
      if (!line.startsWith("TAB ")) continue;
      const parts = line.slice(4).split("\t");
      if (parts.length >= 2) {
        ids.push(parts[0]);
        titles.push(parts[1]);
      }
    }
    Sevyn.log(
      "TERMINAL browser-tabs n=" +
        titles.length +
        " titles=" +
        titles.join("|") +
        " ids=" +
        ids.join("|"),
    );
  } else if (cmd === "browser status" || cmd.startsWith("browser status ")) {
    Sevyn.log(
      "TERMINAL browser-status running=" +
        (parseField(out, "running") ?? "unknown") +
        " tabs=" +
        (parseField(out, "tabs") ?? "?"),
    );
  } else if (cmd === "net status" || cmd.startsWith("net status ")) {
    Sevyn.log(
      "TERMINAL net-status interface=" +
        (parseField(out, "interface") ?? "unknown") +
        " wifi=" +
        (parseField(out, "wifi") ?? "unknown"),
    );
  } else if (cmd === "net dns" || cmd.startsWith("net dns ")) {
    const bits = out.trim().split(/\s+/);
    Sevyn.log(
      "TERMINAL net-dns host=" + (bits[0] ?? "unknown") + " ip=" + (bits[1] ?? "unknown"),
    );
  }
}

export function Terminal(): React.ReactElement {
  const [lines, setLines] = React.useState<string[]>(HELP_LINES);
  const [input, setInput] = React.useState("");
  const color = Sevyn.appColor;
  const scrollRef = React.useRef<any>(null);

  function append(more: string[]): void {
    setLines((prev) => [...prev, ...more].slice(-MAX_LINES));
  }

  function run(cmd: string): void {
    const trimmed = cmd.trim();
    append(["sevyn> " + trimmed]);
    // GF65 scroll fix: keep the tail visible. The timer fires on
    // the next host tick, after the state flush + present, so the
    // scroll clamps against the fresh content height (a same-tick
    // scrollTo would clamp against the stale one). scrollTo clamps,
    // so a huge Y lands exactly at the bottom. Scheduled here so
    // even an empty command (echo only) scrolls.
    setTimeout(() => {
      const inst = scrollRef.current;
      if (inst) scrollTo(inst, 0, 1000000);
    }, 0);
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

  return (
    <View
      style={{
        flex: 1,
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
      {/* GF65 scroll fix: the scrollback renders in a ScrollView
          (was: only the last 21 lines, earlier output unreachable).
          Only the last RENDERED_LINES render (see the cap above) —
          the buffer still keeps 500. The input row stays pinned
          below it. */}
      <ScrollView
        ref={scrollRef}
        style={{ flex: 1, paddingLeft: 8, paddingRight: 8, paddingTop: 8 }}
      >
        {lines.slice(-RENDERED_LINES).map((line, i) => (
          <Text key={i} style={{ fontSize: 14, color: "#e5e7eb" }}>
            {line || " "}
          </Text>
        ))}
      </ScrollView>
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
