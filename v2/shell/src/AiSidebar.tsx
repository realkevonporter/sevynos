// SevynOS v2 — the AI sidebar (DESIGN.md §2.8, phase 1).
//
// Tap the corner button and the conversation opens as a right
// sidebar: the desktop stays visible on the left, and the header
// offers full screen. The sidebar is a shell surface, not an app
// window — it paints under app windows (same limit as the power
// menu today; the overlay surface that floats it above windows is
// a phase-4 follow-up).
//
// Phase 1 is one-shot: each turn sends `sevyn ai ask` through the
// existing ASK path (same backend, same grant as Terminal — the
// daemon enforces the grant, not the shell), and shows the action
// receipt. No prose answer and no memory across turns yet: the
// daemon's reply carries counts only, and the model keeps no
// history. Both arrive with the conversation transport (phase 3,
// CHAT verb). The receipt parser is tolerant of the future
// `error=` field the ERR-surfacing fix adds — absent today, shown
// when present.
//
// The ask runs through Sevyn.execAsync (never sync: a muse-ai call
// can take 300 s, and a sync exec would freeze the whole shell),
// and through the host's 300 s carve-out for `ai ask` / `ai session`
// (sevyn-rn-host.cc — the 10 s default would SIGKILL slow asks).

import * as React from "react";
import { View, Text, Pressable, ScrollView, TextInput } from "./host";
import {
  scrollTo,
  subscribeStatus,
  getStatusSnapshot,
  subscribeSurfaceSize,
  getSurfaceSizeSnapshot,
} from "../../rn/renderer/sevyn-renderer";

// Sidebar width (the sketch's panel is ~a quarter of the screen).
export const AI_SIDEBAR_WIDTH = 360;
// The host tokenizer caps a command at 64 tokens (`sevyn ai ask`
// leaves ~61 words for the task), so the input caps first and says
// so — a longer question's tail would otherwise be dropped silently.
const MAX_INPUT_CHARS = 300;
// Render cap, mirroring Terminal's RENDERED_LINES: the buffer keeps
// 100 messages, only the last 100 render.
const MAX_MESSAGES = 100;

type ChatMessage = { role: "user" | "ai"; text: string };

interface AiStatusSnapshot {
  "ai.god_mode"?: string;
}

// One `sevyn ai ask` round trip, off the JS thread. Returns the
// CLI's "<exit-code>\n<output>" shape, parsed like the apps' runCli.
async function runAiAsk(text: string): Promise<{ code: number; out: string }> {
  const raw = await Sevyn.execAsync("sevyn ai ask " + text);
  const nl = raw.indexOf("\n");
  if (nl < 0) return { code: -1, out: raw };
  const code = parseInt(raw.slice(0, nl), 10);
  return { code: Number.isNaN(code) ? -1 : code, out: raw.slice(nl + 1) };
}

function parseCounts(out: string): {
  allowed: number;
  denied: number;
  failed: number;
  error: string | null;
} {
  const num = (key: string): number => {
    const m = out.match(new RegExp(key + "=(\\d+)"));
    return m ? parseInt(m[1], 10) : 0;
  };
  const em = out.match(/error=(.*)$/);
  return {
    allowed: num("allowed"),
    denied: num("denied"),
    failed: num("failed"),
    error: em ? em[1].trim() : null,
  };
}

// The receipt line for a finished ask, plus the counts for the
// harness marker. Code 124 is the host exec timeout (the carve-out
// makes it unreachable for `ai ask` in practice — the daemon times
// out first — but a hung CLI still reports it honestly).
function receiptFor(
  code: number,
  out: string,
): {
  text: string;
  allowed: number;
  denied: number;
  failed: number;
} {
  if (code === 124)
    return {
      text: "The AI took too long — try a shorter task.",
      allowed: 0,
      denied: 0,
      failed: 0,
    };
  if (code !== 0) {
    const first = out
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l !== "");
    return {
      text: first ? "Error: " + first : "The AI could not be reached.",
      allowed: 0,
      denied: 0,
      failed: 0,
    };
  }
  const p = parseCounts(out);
  if (p.error) return { text: "Error: " + p.error, ...p };
  if (p.allowed === 0 && p.denied === 0 && p.failed === 0)
    return { text: "The AI took no actions.", ...p };
  return {
    text: `Done — ${p.allowed} allowed, ${p.denied} denied, ${p.failed} failed.`,
    ...p,
  };
}

export function AiSidebar(props: { onClose(): void }): React.ReactElement {
  const [fullScreen, setFullScreen] = React.useState(false);
  const [input, setInput] = React.useState("");
  const [messages, setMessages] = React.useState<ChatMessage[]>([]);
  const [busy, setBusy] = React.useState(false);
  const size = React.useSyncExternalStore(subscribeSurfaceSize, getSurfaceSizeSnapshot);
  const status = React.useSyncExternalStore(
    subscribeStatus,
    getStatusSnapshot,
  ) as AiStatusSnapshot;
  const scrollRef = React.useRef<any>(null);

  const width = fullScreen ? size.width : AI_SIDEBAR_WIDTH;
  const godMode = status["ai.god_mode"] === "on";

  // Keep the tail visible (Terminal's GF65 scroll fix: the timer
  // fires on the next host tick, after the state flush + present).
  const scrollToBottom = (): void => {
    setTimeout(() => {
      const inst = scrollRef.current;
      if (inst) scrollTo(inst, 0, 1000000);
    }, 0);
  };

  const submit = (): void => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setBusy(true);
    const userMsg: ChatMessage = { role: "user", text };
    setMessages((prev) => [...prev, userMsg].slice(-MAX_MESSAGES));
    scrollToBottom();
    void runAiAsk(text).then(({ code, out }) => {
      const r = receiptFor(code, out);
      const aiMsg: ChatMessage = { role: "ai", text: r.text };
      setMessages((prev) => [...prev, aiMsg].slice(-MAX_MESSAGES));
      // Harness marker, mirroring Terminal's TERMINAL ai-ask line.
      if (code === 0) {
        Sevyn.log(
          "AI-SIDEBAR ask allowed=" +
            r.allowed +
            " denied=" +
            r.denied +
            " failed=" +
            r.failed,
        );
      } else {
        Sevyn.log("AI-SIDEBAR ask failed code=" + code);
      }
      setBusy(false);
      scrollToBottom();
    });
  };

  return (
    <View
      testID="ai-sidebar"
      style={{
        position: "absolute",
        top: 48,
        right: 0,
        bottom: 0,
        width,
        backgroundColor: "#111827",
        flexDirection: "column",
      }}
    >
      <View
        style={{
          flexDirection: "row",
          height: 48,
          backgroundColor: "#1f2937",
          alignItems: "center",
          paddingLeft: 16,
          paddingRight: 12,
        }}
      >
        <Text
          style={{
            fontSize: 16,
            fontWeight: "bold",
            color: "#ffffff",
            flex: 1,
          }}
        >
          AI
        </Text>
        {/* Mode indicator (§2.8): the mode is always visible — the
            amber GOD mark when god mode is on, a plain Standard
            label when off. Same statusd key as the tray GOD pill. */}
        {godMode ? (
          <View
            style={{
              height: 28,
              marginRight: 12,
              paddingHorizontal: 8,
              borderRadius: 6,
              backgroundColor: "#b45309",
              justifyContent: "center",
              alignItems: "center",
            }}
          >
            <Text style={{ fontSize: 12, color: "#fef3c7", fontWeight: "bold" }}>
              GOD
            </Text>
          </View>
        ) : (
          <Text style={{ fontSize: 12, color: "#9ca3af", marginRight: 12 }}>
            Standard
          </Text>
        )}
        <Pressable
          testID="ai-sidebar-fullscreen"
          onPress={() => setFullScreen(!fullScreen)}
          style={{
            height: 32,
            marginRight: 12,
            justifyContent: "center",
            alignItems: "center",
          }}
        >
          <Text style={{ fontSize: 13, color: "#d1d5db" }}>
            {fullScreen ? "Exit full screen" : "Full screen"}
          </Text>
        </Pressable>
        <Pressable
          testID="ai-sidebar-close"
          onPress={props.onClose}
          style={{
            height: 32,
            justifyContent: "center",
            alignItems: "center",
          }}
        >
          <Text style={{ fontSize: 13, color: "#d1d5db" }}>Close</Text>
        </Pressable>
      </View>
      <ScrollView
        ref={scrollRef}
        style={{ flex: 1, paddingLeft: 12, paddingRight: 12, paddingTop: 8 }}
      >
        {messages.length === 0 ? (
          <Text style={{ fontSize: 14, color: "#9ca3af" }}>
            Ask the AI to do something — launch an app, change a setting, find a file.
          </Text>
        ) : (
          messages.slice(-MAX_MESSAGES).map((m, i) => (
            <Text
              key={i}
              style={{
                fontSize: 14,
                color: m.role === "user" ? "#ffffff" : "#e5e7eb",
                marginBottom: 8,
              }}
            >
              {(m.role === "user" ? "You: " : "AI: ") + m.text}
            </Text>
          ))
        )}
        {busy ? <Text style={{ fontSize: 14, color: "#9ca3af" }}>Thinking…</Text> : null}
      </ScrollView>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingLeft: 8,
          paddingRight: 8,
          paddingBottom: 8,
        }}
      >
        <TextInput
          testID="ai-sidebar-input"
          value={input}
          onChangeText={(t: string) => setInput(t.slice(0, MAX_INPUT_CHARS))}
          onSubmitEditing={submit}
          placeholder="Ask the AI…"
          autoFocus
          style={{
            flex: 1,
            height: 36,
            backgroundColor: "#1f2937",
            fontSize: 15,
            color: "#e5e7eb",
            paddingLeft: 8,
            paddingRight: 8,
          }}
        />
        <Pressable
          testID="ai-sidebar-send"
          onPress={submit}
          style={{
            marginLeft: 8,
            height: 36,
            paddingLeft: 12,
            paddingRight: 12,
            borderRadius: 6,
            backgroundColor: "#5B5BD6",
            justifyContent: "center",
            alignItems: "center",
          }}
        >
          <Text style={{ fontSize: 14, color: "#ffffff" }}>Send</Text>
        </Pressable>
      </View>
    </View>
  );
}
