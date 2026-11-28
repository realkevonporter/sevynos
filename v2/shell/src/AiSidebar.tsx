// SevynOS v2 — the AI sidebar (DESIGN.md §2.8, phase 3).
//
// Tap the corner button and the conversation opens as a right
// sidebar: the desktop stays visible on the left, and the header
// offers full screen. The sidebar is a shell surface, not an app
// window — it paints under app windows (same limit as the power
// menu today; the overlay surface that floats it above windows is
// a phase-4 follow-up).
//
// Phase 3 is a conversation: the first send opens one with
// `sevyn ai chat new`, later sends reuse its id (`sevyn ai chat
// <id> <message>`), and closing ends it (`sevyn ai chat end <id>`,
// fire-and-forget — the shell unmounts on close). The daemon holds
// the history and passes it to muse-ai each turn, and muse-ai's
// prose answer comes back as a TEXT line the daemon carries in the
// reply. The sidebar shows the model's text turns and keeps the
// action receipts (phase 1's one-shot `sevyn ai ask` is gone).
//
// Design: the layout-manifest AI chat mockup
// (sevynos-layout-manifest/mockups/build_ai_chat_mockup.py —
// "Perfect", Kevon 2026-11-28). 360px sidebar, top = top-bar
// height, surface fill; header 48px (AI title + Standard/GOD mark
// + Full screen + Close); user turns as right-aligned bubbles in
// the accent tint; AI turns as rows with the violet AI monogram,
// prose, and a receipt with a violet check when an action ran.
// Values come from the shared tokens (v2/rn/renderer/tokens.js);
// the mockup-only geometry with no token yet lives in named
// constants below, citing the mockup builder, awaiting a `chat`
// manifest section.
//
// The ask runs through Sevyn.execAsync (never sync: a muse-ai call
// can take 300 s, and a sync exec would freeze the whole shell),
// and through the host's 300 s carve-out for `ai ask` / `ai session`
// / `ai chat` (sevyn-rn-host.cc — the 10 s default would SIGKILL
// slow turns).

import * as React from "react";
import { View, Text, Pressable, ScrollView, TextInput } from "./host";
import { tokens } from "../../rn/renderer/tokens";
import {
  scrollTo,
  subscribeStatus,
  getStatusSnapshot,
  subscribeSurfaceSize,
  getSurfaceSizeSnapshot,
} from "../../rn/renderer/sevyn-renderer";

// Dark-first: no light/dark mode state exists in code yet (no
// appearance setting; Settings → Appearance is wallpaper-only
// today), so the sidebar reads the dark tokens. One alias at the
// top flips the whole sidebar when the mode switch lands.
const C = tokens.color.dark;
const ACCENT_FILL = tokens.accent.accents.violet.dark;
const ACCENT_ON_FILL = tokens.accent.accents.violet.onFill.dark;

// Append an alpha byte to a #RRGGBB token (the manifest's accent
// tint). 0.20 * 255 = 51 = 0x33; 0.15 * 255 = 38 = 0x26.
function withAlpha(hex: string, alpha: number): string {
  const n = Math.round(alpha * 255);
  return hex + n.toString(16).padStart(2, "0");
}

// The user bubble's accent tint: 15% light / 20% dark violet —
// dark-first, so 20% here. 8-digit hex flows through the ops to
// the painter end to end.
const BUBBLE_TINT = withAlpha(ACCENT_FILL, 0.2);

// Sidebar width (the sketch's panel is ~a quarter of the screen).
export const AI_SIDEBAR_WIDTH = 360;
// The host tokenizer caps a command at 64 tokens (`sevyn ai chat`
// leaves ~60 words for the message), so the input caps first and
// says so — a longer question's tail would otherwise be dropped
// silently.
const MAX_INPUT_CHARS = 300;
// Render cap, mirroring Terminal's RENDERED_LINES: the buffer keeps
// 100 messages, only the last 100 render.
const MAX_MESSAGES = 100;

// Mockup-locked geometry with no token yet (build_ai_chat_mockup.py):
// the manifest has no `chat` section; these become tokens when it
// gains one. 6/10/14 are off the 4pt scale — the mockup uses them.
const HEADER_HEIGHT = 48;
const BUBBLE_MAX_WIDTH = 280;
const WELL_HEIGHT = 40;
const SEND_HEIGHT = 32;
const BUBBLE_PAD_Y = 10;
const SEND_PAD_X = 14;
const RECEIPT_GAP = 6;
const AI_GAP = 10;

type ChatMessage =
  | { role: "user"; text: string }
  | { role: "ai"; text: string | null; receipt: string | null };

interface AiStatusSnapshot {
  "ai.god_mode"?: string;
}

// One `sevyn ...` round trip, off the JS thread. Returns the CLI's
// "<exit-code>\n<output>" shape, parsed like the apps' runCli.
async function runCli(cmd: string): Promise<{ code: number; out: string }> {
  const raw = await Sevyn.execAsync(cmd);
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
  // [^\n]*, not (.*)$: the CLI output ends with a newline, and $ does
  // not match before it — the phase-1 (.*)$ never matched, so the
  // error never displayed. Same shape as parseText below.
  const em = out.match(/error=([^\n]*)/);
  return {
    allowed: num("allowed"),
    denied: num("denied"),
    failed: num("failed"),
    error: em ? em[1].trim() : null,
  };
}

// The daemon's reply carries the TEXT escaped on one line (\n for a
// newline, \\ for a backslash, \t for a tab — the WRITE escaping);
// the sidebar shows the real characters. A lone trailing backslash
// (which the backend never emits — it never splits an escape) stays.
function unescapeText(s: string): string {
  return s.replace(/\\(\\|n|t)/g, (_m, e: string) =>
    e === "n" ? "\n" : e === "t" ? "\t" : "\\",
  );
}

function parseText(out: string): string | null {
  const m = out.match(/text=([^\n]*)/);
  if (!m) return null;
  const text = unescapeText(m[1].trim());
  return text === "" ? null : text;
}

// The AI turn for a finished chat turn: the model's prose (null when
// it acted without answering) plus the receipt line (only when an
// action ran — the mockup's third turn has prose and no receipt).
// Code 124 is the host exec timeout (the carve-out makes it
// unreachable for `ai chat` in practice — the daemon times out
// first — but a hung CLI still reports it honestly).
function aiTurnFor(
  code: number,
  out: string,
): {
  text: string | null;
  receipt: string | null;
  allowed: number;
  denied: number;
  failed: number;
} {
  if (code === 124)
    return {
      text: "The AI took too long — try a shorter task.",
      receipt: null,
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
      receipt: null,
      allowed: 0,
      denied: 0,
      failed: 0,
    };
  }
  const p = parseCounts(out);
  if (p.error) return { text: "Error: " + p.error, receipt: null, ...p };
  const prose = parseText(out);
  const acted = p.allowed + p.denied + p.failed > 0;
  if (!prose && !acted) return { text: "The AI took no actions.", receipt: null, ...p };
  return {
    text: prose,
    receipt: acted
      ? `Done — ${p.allowed} allowed, ${p.denied} denied, ${p.failed} failed.`
      : null,
    ...p,
  };
}

export function AiSidebar(props: { onClose(): void }): React.ReactElement {
  const [fullScreen, setFullScreen] = React.useState(false);
  const [input, setInput] = React.useState("");
  const [messages, setMessages] = React.useState<ChatMessage[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [chatId, setChatId] = React.useState<string | null>(null);
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
    // The first send opens the conversation (CHAT NEW); later sends
    // reuse its id. The id is set before the turn runs, so a retry
    // after a failed NEW opens a fresh conversation instead of
    // reusing a dead id.
    const open: Promise<string | null> =
      chatId !== null
        ? Promise.resolve(chatId)
        : runCli("sevyn ai chat new").then(({ code, out }) => {
            if (code !== 0) return null;
            const m = out.match(/chat=([^\s\n]+)/);
            return m ? m[1] : null;
          });
    void open.then((id) => {
      if (id === null) {
        const aiMsg: ChatMessage = {
          role: "ai",
          text: "The AI could not be reached.",
          receipt: null,
        };
        setMessages((prev) => [...prev, aiMsg].slice(-MAX_MESSAGES));
        Sevyn.log("AI-SIDEBAR chat open failed");
        setBusy(false);
        scrollToBottom();
        return;
      }
      if (chatId === null) setChatId(id);
      void runCli("sevyn ai chat " + id + " " + text).then(({ code, out }) => {
        const r = aiTurnFor(code, out);
        const aiMsg: ChatMessage = {
          role: "ai",
          text: r.text,
          receipt: r.receipt,
        };
        setMessages((prev) => [...prev, aiMsg].slice(-MAX_MESSAGES));
        // Harness marker, mirroring Terminal's TERMINAL ai-ask line.
        if (code === 0) {
          Sevyn.log(
            "AI-SIDEBAR chat allowed=" +
              r.allowed +
              " denied=" +
              r.denied +
              " failed=" +
              r.failed,
          );
        } else {
          Sevyn.log("AI-SIDEBAR chat failed code=" + code);
        }
        setBusy(false);
        scrollToBottom();
      });
    });
  };

  // End the conversation first (fire-and-forget: the shell unmounts
  // on close, so awaiting would never resolve) — the daemon drops
  // the history. Then close.
  const close = (): void => {
    if (chatId !== null) {
      void runCli("sevyn ai chat end " + chatId);
    }
    props.onClose();
  };

  return (
    <View
      testID="ai-sidebar"
      style={{
        position: "absolute",
        top: tokens.topbar.height,
        right: 0,
        bottom: 0,
        width,
        backgroundColor: C.surface,
        flexDirection: "column",
      }}
    >
      <View
        style={{
          flexDirection: "row",
          height: HEADER_HEIGHT,
          backgroundColor: C.surface,
          alignItems: "center",
          paddingLeft: tokens.topbar.padX,
          paddingRight: tokens.topbar.padX,
        }}
      >
        <Text
          style={{
            fontSize: tokens.type.windowTitle.size,
            fontWeight: "bold",
            color: C.textPrimary,
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
              borderRadius: tokens.radii.button,
              backgroundColor: tokens.color.fixed.godBackground,
              justifyContent: "center",
              alignItems: "center",
            }}
          >
            <Text
              style={{
                fontSize: tokens.type.caption.size,
                color: tokens.color.fixed.godText,
                fontWeight: "bold",
              }}
            >
              GOD
            </Text>
          </View>
        ) : (
          <Text
            style={{
              fontSize: tokens.type.secondary.size,
              color: C.textSecondary,
              marginLeft: 12,
            }}
          >
            Standard
          </Text>
        )}
        <Pressable
          testID="ai-sidebar-fullscreen"
          onPress={() => setFullScreen(!fullScreen)}
          style={{
            height: 32,
            marginRight: 16,
            justifyContent: "center",
            alignItems: "center",
          }}
        >
          <Text
            style={{
              fontSize: tokens.type.secondary.size,
              color: C.textSecondary,
            }}
          >
            {fullScreen ? "Exit full screen" : "Full screen"}
          </Text>
        </Pressable>
        <Pressable
          testID="ai-sidebar-close"
          onPress={close}
          style={{
            height: 32,
            justifyContent: "center",
            alignItems: "center",
          }}
        >
          <Text
            style={{
              fontSize: tokens.type.secondary.size,
              color: C.textSecondary,
            }}
          >
            Close
          </Text>
        </Pressable>
      </View>
      <ScrollView
        ref={scrollRef}
        style={{
          flex: 1,
          paddingLeft: tokens.topbar.padX,
          paddingRight: tokens.topbar.padX,
          paddingTop: tokens.topbar.padX,
          paddingBottom: tokens.topbar.padX,
        }}
      >
        {messages.length === 0 ? (
          <Text style={{ fontSize: tokens.type.body.size, color: C.textMuted }}>
            Ask the AI to do something — launch an app, change a setting, find a file.
          </Text>
        ) : (
          messages.slice(-MAX_MESSAGES).map((m, i) =>
            m.role === "user" ? (
              <View
                key={i}
                style={{
                  flexDirection: "row",
                  justifyContent: "flex-end",
                  marginBottom: tokens.topbar.padX,
                }}
              >
                <View
                  style={{
                    maxWidth: BUBBLE_MAX_WIDTH,
                    backgroundColor: BUBBLE_TINT,
                    borderRadius: tokens.radii.card,
                    paddingTop: BUBBLE_PAD_Y,
                    paddingBottom: BUBBLE_PAD_Y,
                    paddingLeft: 12,
                    paddingRight: 12,
                  }}
                >
                  <Text
                    style={{
                      fontSize: tokens.type.body.size,
                      color: C.textPrimary,
                    }}
                  >
                    {m.text}
                  </Text>
                </View>
              </View>
            ) : (
              <View
                key={i}
                style={{
                  flexDirection: "row",
                  marginBottom: tokens.topbar.padX,
                }}
              >
                <View
                  style={{
                    width: 24,
                    height: 24,
                    borderRadius: tokens.radii.button,
                    backgroundColor: ACCENT_FILL,
                    justifyContent: "center",
                    alignItems: "center",
                    marginRight: AI_GAP,
                  }}
                >
                  <Text
                    style={{
                      fontSize: tokens.type.minimum,
                      color: ACCENT_ON_FILL,
                      fontWeight: "bold",
                    }}
                  >
                    AI
                  </Text>
                </View>
                <View style={{ flex: 1 }}>
                  {m.text !== null ? (
                    <Text
                      style={{
                        fontSize: tokens.type.body.size,
                        color: C.textPrimary,
                      }}
                    >
                      {m.text}
                    </Text>
                  ) : null}
                  {m.receipt !== null ? (
                    <View
                      style={{
                        flexDirection: "row",
                        marginTop: RECEIPT_GAP,
                      }}
                    >
                      <Text
                        style={{
                          fontSize: tokens.type.caption.size,
                          color: ACCENT_FILL,
                        }}
                      >
                        ✓
                      </Text>
                      <Text
                        style={{
                          fontSize: tokens.type.caption.size,
                          color: C.textMuted,
                          marginLeft: 4,
                        }}
                      >
                        {m.receipt}
                      </Text>
                    </View>
                  ) : null}
                </View>
              </View>
            ),
          )
        )}
        {busy ? (
          <Text style={{ fontSize: tokens.type.body.size, color: C.textMuted }}>
            Thinking…
          </Text>
        ) : null}
      </ScrollView>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingLeft: tokens.topbar.padX,
          paddingRight: tokens.topbar.padX,
          paddingTop: tokens.spacing.buttonGap,
          paddingBottom: tokens.topbar.padX,
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
            height: WELL_HEIGHT,
            backgroundColor: C.sunken,
            borderRadius: tokens.radii.window,
            fontSize: tokens.type.body.size,
            color: C.textPrimary,
            paddingLeft: 12,
            paddingRight: 12,
          }}
        />
        <Pressable
          testID="ai-sidebar-send"
          onPress={submit}
          style={{
            marginLeft: tokens.spacing.controlGap,
            height: SEND_HEIGHT,
            paddingLeft: SEND_PAD_X,
            paddingRight: SEND_PAD_X,
            borderRadius: tokens.radii.menu,
            backgroundColor: ACCENT_FILL,
            justifyContent: "center",
            alignItems: "center",
          }}
        >
          <Text
            style={{
              fontSize: tokens.type.secondary.size,
              color: ACCENT_ON_FILL,
              fontWeight: "bold",
            }}
          >
            Send
          </Text>
        </Pressable>
      </View>
    </View>
  );
}
