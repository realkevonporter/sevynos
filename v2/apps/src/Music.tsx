// SevynOS Music v1 — the Music system app.
//
// Library: the device's local audio files under /data and
// /data/music, listed through `sevyn files list` (the same source
// Files.tsx reads). Playback: `sevyn music ...` over musicd —
// Chromium's <audio> element is the engine (v2/music/musicd.mjs).
// Position polls every second through `sevyn music status`
// (runCliAsync, off the JS thread) and the track auto-advances on
// "ended".
//
// Guarding (the pre-restart bug: one bad volume call killed Genesis
// through an unhandled rejection): EVERY playback call goes through
// safeMusic(), which catches everything — a bad exec, a non-JSON
// reply, a daemon ok:false — and turns it into an on-screen error
// string. No playback path throws, ever. Volume clamps 0–100, seek
// clamps to the track, next/previous wrap the library.

import * as React from "react";
import { View, Text, Image, Pressable, ScrollView } from "./host";
import { WindowButtons } from "./window-buttons";
import { runCli, runCliAsync } from "./cli";
import { appIconTitlePath, symbolPath } from "./icons";

export const AUDIO_EXTS = [
  ".wav",
  ".mp3",
  ".ogg",
  ".oga",
  ".flac",
  ".m4a",
  ".aac",
  ".opus",
  ".webm",
];

export function isAudioFile(name: string): boolean {
  const lower = name.toLowerCase();
  return AUDIO_EXTS.some((ext) => lower.endsWith(ext));
}

export function displayName(filePath: string): string {
  const i = filePath.lastIndexOf("/");
  const base = i >= 0 ? filePath.slice(i + 1) : filePath;
  return base.replace(/\.[^.]+$/, "");
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m + ":" + (s < 10 ? "0" + s : String(s));
}

export type PlaybackStatus = {
  state: string;
  path: string;
  position: number;
  duration: number;
  volume: number;
  media: string;
  error: string;
};

export function parseStatus(out: string): PlaybackStatus | null {
  try {
    const parsed = JSON.parse(out.trim()) as Record<string, unknown>;
    if (parsed.ok !== true || typeof parsed.state !== "string") return null;
    return {
      state: parsed.state,
      path: typeof parsed.path === "string" ? parsed.path : "",
      position: typeof parsed.position === "number" ? parsed.position : 0,
      duration: typeof parsed.duration === "number" ? parsed.duration : 0,
      volume: typeof parsed.volume === "number" ? parsed.volume : 80,
      media: typeof parsed.media === "string" ? parsed.media : "",
      error: typeof parsed.error === "string" ? parsed.error : "",
    };
  } catch {
    return null;
  }
}

// List the audio files in one directory. A failed listing is an
// empty library, never an exception.
function listAudioIn(dir: string): string[] {
  const { code, out } = runCli("sevyn files list " + dir);
  if (code !== 0) return [];
  const found: string[] = [];
  for (const line of out.split("\n")) {
    if (!line.startsWith("f ")) continue;
    const name = line.slice(2);
    if (isAudioFile(name)) {
      found.push(dir === "/" ? "/" + name : dir + "/" + name);
    }
  }
  return found;
}

export function listLibrary(): string[] {
  const seen = new Set<string>();
  const tracks: string[] = [];
  for (const dir of ["/data", "/data/music"]) {
    for (const p of listAudioIn(dir)) {
      if (!seen.has(p)) {
        seen.add(p);
        tracks.push(p);
      }
    }
  }
  return tracks.sort();
}

// One guarded playback call. Returns the parsed status, or null
// (and the caller's error string) when anything goes wrong — the
// daemon answers ok:false, the exec fails, the reply is not JSON.
// Never throws.
export async function safeMusic(
  cmdline: string,
): Promise<{ status: PlaybackStatus | null; error: string | null }> {
  try {
    const { code, out } = await runCliAsync(cmdline);
    if (code !== 0) {
      return { status: null, error: out.trim() || "music service unavailable" };
    }
    const status = parseStatus(out);
    if (!status) {
      // A daemon ok:false carries its own error string — surface
      // that, not a generic parse complaint.
      try {
        const parsed = JSON.parse(out.trim()) as Record<string, unknown>;
        if (parsed.ok === false && typeof parsed.error === "string") {
          return { status: null, error: parsed.error };
        }
      } catch {
        /* fall through to the generic error */
      }
      return { status: null, error: "music service gave an unreadable reply" };
    }
    if (status.error) {
      return { status, error: status.error };
    }
    return { status, error: null };
  } catch (e) {
    return {
      status: null,
      error: "music call failed: " + String((e as Error)?.message || e),
    };
  }
}

const POLL_MS = 1000;

export function Music(): React.ReactElement {
  const [tracks, setTracks] = React.useState<string[]>(() => {
    const found = listLibrary();
    Sevyn.log("MUSIC listed library (" + found.length + ")");
    return found;
  });
  const [current, setCurrent] = React.useState<number>(-1);
  const [status, setStatus] = React.useState<PlaybackStatus | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [volume, setVolume] = React.useState<number>(80);
  const tracksRef = React.useRef(tracks);
  tracksRef.current = tracks;
  const currentRef = React.useRef(current);
  currentRef.current = current;
  const lastEndedRef = React.useRef<string>("");

  async function refresh(): Promise<void> {
    const { status: st, error: err } = await safeMusic("sevyn music status");
    if (st) {
      setStatus(st);
      setVolume(st.volume);
    }
    if (err) setError(err);
  }

  React.useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, POLL_MS);
    return () => clearInterval(timer);
    // Mount-only: refresh is stable enough through refs; re-running
    // on every render would reset the poll timer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function playTrack(index: number): Promise<void> {
    const list = tracksRef.current;
    if (index < 0 || index >= list.length) return;
    const filePath = list[index];
    setError(null);
    setCurrent(index);
    lastEndedRef.current = "";
    const { status: st, error: err } = await safeMusic("sevyn music play " + filePath);
    if (st) {
      setStatus(st);
      setVolume(st.volume);
    }
    if (err) {
      setError(err);
      return;
    }
    Sevyn.log("MUSIC play " + filePath);
  }

  async function togglePlay(): Promise<void> {
    if (current < 0) {
      if (tracks.length > 0) await playTrack(0);
      return;
    }
    if (status && status.state === "playing") {
      const { status: st, error: err } = await safeMusic("sevyn music pause");
      if (st) setStatus(st);
      if (err) setError(err);
    } else {
      const { status: st, error: err } = await safeMusic("sevyn music resume");
      if (st) setStatus(st);
      if (err) setError(err);
    }
  }

  async function step(next: boolean): Promise<void> {
    const list = tracksRef.current;
    if (list.length === 0) return;
    const base = currentRef.current < 0 ? (next ? -1 : 0) : currentRef.current;
    const index = next
      ? (base + 1) % list.length
      : (base - 1 + list.length) % list.length;
    await playTrack(index);
  }

  async function seekBy(delta: number): Promise<void> {
    if (!status || status.duration <= 0) return;
    const target = Math.max(0, Math.min(status.duration, status.position + delta));
    const { status: st, error: err } = await safeMusic(
      "sevyn music seek " + Math.round(target),
    );
    if (st) setStatus(st);
    if (err) setError(err);
  }

  async function volumeBy(delta: number): Promise<void> {
    const target = Math.max(0, Math.min(100, volume + delta));
    const { status: st, error: err } = await safeMusic("sevyn music volume " + target);
    if (st) {
      setStatus(st);
      setVolume(st.volume);
    } else {
      setVolume(target);
    }
    if (err) setError(err);
  }

  // Auto-advance once per finished track.
  React.useEffect(() => {
    if (!status || status.state !== "ended") return;
    if (!status.path || status.path === lastEndedRef.current) return;
    const list = tracksRef.current;
    const idx = list.indexOf(status.path);
    if (idx < 0) return;
    lastEndedRef.current = status.path;
    void playTrack((idx + 1) % list.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  const playing = status !== null && status.state === "playing";
  const currentPath = current >= 0 && current < tracks.length ? tracks[current] : "";
  const position = status && status.path === currentPath ? status.position : 0;
  const duration = status && status.path === currentPath ? status.duration : 0;
  const frac = duration > 0 ? Math.max(0, Math.min(1, position / duration)) : 0;

  function controlButton(label: string, onPress: () => void): React.ReactElement {
    return (
      <Pressable
        onPress={() => {
          void onPress();
        }}
        style={{
          height: 44,
          minWidth: 44,
          borderRadius: 22,
          backgroundColor: "#e5e7eb",
          justifyContent: "center",
          alignItems: "center",
          paddingLeft: 12,
          paddingRight: 12,
          marginLeft: 4,
          marginRight: 4,
        }}
      >
        <Text style={{ fontSize: 16, fontWeight: "bold", color: "#111827" }}>
          {label}
        </Text>
      </Pressable>
    );
  }

  return (
    <View style={{ flex: 1, flexDirection: "column", backgroundColor: "#f9fafb" }}>
      <View
        style={{
          flexDirection: "row",
          height: 44,
          backgroundColor: Sevyn.appColor,
          alignItems: "center",
          paddingLeft: 16,
          paddingRight: 12,
        }}
      >
        <Image
          source={appIconTitlePath("music")}
          style={{ width: 20, height: 20, marginRight: 8 }}
        />
        <Text style={{ fontSize: 16, fontWeight: "bold", color: "#ffffff", flex: 1 }}>
          Music
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

      {/* Now playing */}
      <View
        style={{
          backgroundColor: "#ffffff",
          marginLeft: 16,
          marginRight: 16,
          marginTop: 12,
          borderRadius: 12,
          paddingLeft: 16,
          paddingRight: 16,
          paddingTop: 12,
          paddingBottom: 12,
        }}
      >
        <Text style={{ fontSize: 16, fontWeight: "bold", color: "#111827" }}>
          {currentPath ? displayName(currentPath) : "Nothing playing"}
        </Text>
        <Text style={{ fontSize: 13, color: "#6b7280", marginTop: 2 }}>
          {status ? status.state : "idle"}
          {duration > 0
            ? " · " + formatTime(position) + " / " + formatTime(duration)
            : ""}
        </Text>
        {/* Progress bar (flex proportions — no percentage widths). */}
        <View
          style={{
            flexDirection: "row",
            height: 6,
            backgroundColor: "#e5e7eb",
            borderRadius: 3,
            marginTop: 10,
          }}
        >
          <View style={{ flex: frac, backgroundColor: "#ec4899", borderRadius: 3 }} />
          <View style={{ flex: 1 - frac }} />
        </View>
        <View
          style={{
            flexDirection: "row",
            justifyContent: "center",
            alignItems: "center",
            marginTop: 12,
          }}
        >
          {controlButton("⏮", () => {
            void step(false);
          })}
          {controlButton("−10s", () => {
            void seekBy(-10);
          })}
          <Pressable
            onPress={() => {
              void togglePlay();
            }}
            style={{
              height: 52,
              width: 52,
              borderRadius: 26,
              backgroundColor: "#111827",
              justifyContent: "center",
              alignItems: "center",
              marginLeft: 6,
              marginRight: 6,
            }}
          >
            <Text style={{ fontSize: 18, fontWeight: "bold", color: "#ffffff" }}>
              {playing ? "❚❚" : "▶"}
            </Text>
          </Pressable>
          {controlButton("+10s", () => {
            void seekBy(10);
          })}
          {controlButton("⏭", () => {
            void step(true);
          })}
        </View>
        <View
          style={{
            flexDirection: "row",
            justifyContent: "center",
            alignItems: "center",
            marginTop: 12,
          }}
        >
          {controlButton("−", () => {
            void volumeBy(-10);
          })}
          <Text style={{ fontSize: 14, color: "#111827", marginLeft: 8, marginRight: 8 }}>
            Volume {volume}%
          </Text>
          {controlButton("+", () => {
            void volumeBy(10);
          })}
        </View>
        {error ? (
          <Text style={{ fontSize: 13, color: "#b91c1c", marginTop: 8 }}>{error}</Text>
        ) : null}
      </View>

      {/* Library */}
      <ScrollView style={{ flex: 1, paddingLeft: 16, paddingRight: 16, paddingTop: 8 }}>
        <Text style={{ fontSize: 16, fontWeight: "bold", color: "#111827" }}>
          Library
        </Text>
        <Text style={{ fontSize: 13, color: "#6b7280", marginTop: 2 }}>
          {tracks.length === 0
            ? "Audio files in /data or /data/music will appear here."
            : tracks.length + (tracks.length === 1 ? " track" : " tracks")}
        </Text>
        {tracks.map((p, i) => (
          <Pressable
            key={p}
            onPress={() => {
              void playTrack(i);
            }}
            style={{
              backgroundColor: i === current ? "#fce7f3" : "#ffffff",
              borderRadius: 8,
              paddingLeft: 12,
              paddingRight: 12,
              paddingTop: 12,
              paddingBottom: 12,
              marginTop: 8,
            }}
          >
            <Text style={{ fontSize: 15, color: "#111827" }}>
              {i === current && playing ? "▶ " : i === current ? "❚❚ " : ""}
              {displayName(p)}
            </Text>
          </Pressable>
        ))}
        <Pressable
          onPress={() => {
            setTracks(listLibrary());
          }}
          style={{
            height: 40,
            borderRadius: 8,
            backgroundColor: "#e5e7eb",
            justifyContent: "center",
            alignItems: "center",
            marginTop: 12,
            marginBottom: 16,
          }}
        >
          <Text style={{ fontSize: 15, color: "#111827" }}>Refresh library</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}
