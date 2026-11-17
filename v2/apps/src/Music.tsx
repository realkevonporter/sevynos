// SevynOS v2 — the Music system app.
//
// Thin UI over audiod, the native audio daemon (PR 1), through
// `sevyn music` (cli.exec permission) — the same protocol the host
// media/audio adapters speak (PR 2), so the daemon is the source of
// truth for position, duration, and volume. No Chromium anywhere in
// this path: decode and ALSA output both live in audiod.
//
//   library    — `sevyn music scan /data` on mount (real durations
//                from the daemon). When the scan fails (daemon down)
//                the library falls back to `sevyn files list /data`
//                filtered to audio files — those tracks list with an
//                unknown duration, and the screen says so.
//   transport  — play / pause / resume / stop, seek ±10 s, volume
//                ±10, next / previous (wraps around the library).
//   position   — polled from `sevyn music status` once a second
//                while a track is playing or paused (the shell has
//                no push channel for playback state, so the app
//                polls; the interval is created in useEffect and
//                cleared on unmount — the same pattern as the
//                camera preview poll).
//
// The old volume-up bug is impossible by construction here: EVERY
// control goes through `callMusic`, which never throws — a bad call
// (daemon down, undecodable file, seek past the end) is a rejected
// promise or an `{ok:false}` reply with a stable code, and it lands
// as an error line on screen. Nothing in this file throws into
// Genesis, and no handler awaits without a catch.
//
// Deliberately out of v1 (follow-ups, see the PR): playlists,
// shuffle/repeat, metadata tags/artwork, search, auto-advance.

import * as React from "react";
import { View, Text, Image, Pressable, ScrollView } from "./host";
import { WindowButtons } from "./window-buttons";
import { runCli, runCliAsync } from "./cli";
import { appIconTitlePath, symbolPath } from "./icons";

const MUSIC_DIR = "/data";
const STATUS_POLL_MS = 1000;
const VOLUME_STEP = 10;
const SEEK_STEP = 10;

const AUDIO_EXTENSIONS = new Set([".wav", ".mp3", ".flac", ".ogg"]);

type Track = {
  id: string;
  title: string;
  artist: string;
  album: string;
  durationSec: number;
  path: string;
  format: string;
};

type PlaybackStatus = {
  playing: boolean;
  paused: boolean;
  positionSec: number;
  durationSec: number;
  volume: number;
  trackPath: string | null;
};

type LibraryResult = {
  tracks: Track[];
  /** "scan" = daemon scan (real durations); "files" = files-list fallback. */
  source: "scan" | "files";
  error: string;
};

function parseJson(out: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(out);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
      return parsed as Record<string, unknown>;
    return null;
  } catch {
    return null;
  }
}

function isAudioName(name: string): boolean {
  const lower = name.toLowerCase();
  for (const ext of AUDIO_EXTENSIONS) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

function formatOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot >= 0 ? path.slice(dot + 1).toLowerCase() : "wav";
}

function titleOf(path: string): string {
  const slash = path.lastIndexOf("/");
  const base = (slash >= 0 ? path.slice(slash + 1) : path).replace(/\.[^.]+$/, "");
  return base;
}

function trackFromRecord(rec: Record<string, unknown>): Track | null {
  const path = typeof rec["path"] === "string" ? rec["path"] : "";
  if (path.length === 0) return null;
  const durationSec =
    typeof rec["durationSec"] === "number" && Number.isFinite(rec["durationSec"])
      ? rec["durationSec"]
      : 0;
  return {
    id: typeof rec["id"] === "string" ? rec["id"] : path,
    title: typeof rec["title"] === "string" ? rec["title"] : titleOf(path),
    artist: typeof rec["artist"] === "string" ? rec["artist"] : "Unknown Artist",
    album: typeof rec["album"] === "string" ? rec["album"] : "Local Library",
    durationSec,
    path,
    format: typeof rec["format"] === "string" ? rec["format"] : formatOf(path),
  };
}

/** The daemon's status shape, or null when it cannot be read. */
function statusFromRecord(data: Record<string, unknown> | null): PlaybackStatus | null {
  if (data === null || data["ok"] !== true) return null;
  const rawTrack = data["track"];
  const trackPath =
    typeof rawTrack === "object" && rawTrack !== null && !Array.isArray(rawTrack)
      ? typeof (rawTrack as Record<string, unknown>)["path"] === "string"
        ? ((rawTrack as Record<string, unknown>)["path"] as string)
        : null
      : null;
  return {
    playing: data["playing"] === true,
    paused: data["paused"] === true,
    positionSec: typeof data["positionSec"] === "number" ? data["positionSec"] : 0,
    durationSec: typeof data["durationSec"] === "number" ? data["durationSec"] : 0,
    volume: typeof data["volume"] === "number" ? data["volume"] : 100,
    trackPath,
  };
}

/** Library from the daemon scan, falling back to a files listing. */
function readLibrary(): LibraryResult {
  const { code, out } = runCli("sevyn music scan " + MUSIC_DIR);
  if (code === 0) {
    const data = parseJson(out);
    if (data !== null && data["ok"] === true && Array.isArray(data["tracks"])) {
      const tracks: Track[] = [];
      for (const entry of data["tracks"] as unknown[]) {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
        const track = trackFromRecord(entry as Record<string, unknown>);
        if (track !== null) tracks.push(track);
      }
      return { tracks, source: "scan", error: "" };
    }
  }
  // The scan failed (daemon down, or a bad reply): list the files
  // directly so the library still shows. Durations are unknown
  // here — the screen says so.
  const listed = runCli("sevyn files list " + MUSIC_DIR);
  if (listed.code === 0) {
    const tracks: Track[] = [];
    for (const line of listed.out.split("\n")) {
      if (!line.startsWith("f ")) continue;
      const name = line.slice(2);
      if (!isAudioName(name)) continue;
      const path = MUSIC_DIR + "/" + name;
      tracks.push({
        id: path,
        title: titleOf(path),
        artist: "Unknown Artist",
        album: "Local Library",
        durationSec: 0,
        path,
        format: formatOf(path),
      });
    }
    return { tracks, source: "files", error: "" };
  }
  return { tracks: [], source: "files", error: "Could not reach the audio service." };
}

function readStatus(): PlaybackStatus | null {
  const { code, out } = runCli("sevyn music status");
  if (code !== 0) return null;
  return statusFromRecord(parseJson(out));
}

function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "–:––";
  const total = Math.floor(sec);
  return String(Math.floor(total / 60)) + ":" + String(total % 60).padStart(2, "0");
}

const IDLE_STATUS: PlaybackStatus = {
  playing: false,
  paused: false,
  positionSec: 0,
  durationSec: 0,
  volume: 100,
  trackPath: null,
};

export function Music(): React.ReactElement {
  const color = Sevyn.appColor;
  const permitted = Sevyn.hasPermission("cli.exec");
  const [library, setLibrary] = React.useState<LibraryResult>(() => readLibrary());
  const [status, setStatus] = React.useState<PlaybackStatus>(() => {
    const found = readStatus();
    return found === null ? IDLE_STATUS : found;
  });
  const [currentPath, setCurrentPath] = React.useState<string | null>(
    () => status.trackPath,
  );
  const [error, setError] = React.useState<string>("");
  const pollRef = React.useRef<boolean>(false);

  const tracks = library.tracks;
  const currentIndex = tracks.findIndex((t) => t.path === currentPath);
  const current = currentIndex >= 0 ? tracks[currentIndex] : null;
  const durationSec =
    current !== null && current.durationSec > 0
      ? current.durationSec
      : status.durationSec;
  const stateLabel = status.playing
    ? "Playing"
    : status.paused
      ? "Paused"
      : currentPath !== null && status.positionSec >= durationSec && durationSec > 0
        ? "Finished"
        : "Stopped";

  /**
   * One guarded `sevyn music` call. Never throws: a refused exec, a
   * non-zero exit, a bad reply, or a daemon `{ok:false}` all become
   * an on-screen error (with the daemon's stable code) and a null
   * status. A success clears the error. This is the guard the old
   * volume-up bug needed — the caller never sees a rejection.
   */
  async function callMusic(cmdline: string): Promise<PlaybackStatus | null> {
    let code = -1;
    let out = "";
    try {
      const result = await runCliAsync(cmdline);
      code = result.code;
      out = result.out;
    } catch (caught) {
      setError(
        caught instanceof Error
          ? "Audio service failed: " + caught.message
          : "Audio service failed.",
      );
      return null;
    }
    const data = parseJson(out);
    if (code !== 0 || data === null || data["ok"] !== true) {
      const detail =
        data !== null && typeof data["error"] === "string"
          ? data["error"]
          : "Could not reach the audio service.";
      const daemonCode =
        data !== null && typeof data["code"] === "string" ? data["code"] : "";
      setError(daemonCode !== "" ? detail + " (" + daemonCode + ")" : detail);
      return null;
    }
    const next = statusFromRecord(data);
    if (next === null) {
      setError("Audio service sent an invalid reply.");
      return null;
    }
    setError("");
    return next;
  }

  async function pollStatus(): Promise<void> {
    if (pollRef.current) return;
    pollRef.current = true;
    try {
      const next = await callMusic("sevyn music status");
      if (next !== null) setStatus(next);
    } finally {
      pollRef.current = false;
    }
  }

  // Real playback position, polled from the daemon while a track is
  // playing or paused (the shell has no push channel for playback
  // state). The interval is cleared on unmount / state change.
  React.useEffect(() => {
    if (!permitted || currentPath === null || (!status.playing && !status.paused))
      return undefined;
    const timer = setInterval(() => {
      void pollStatus();
    }, STATUS_POLL_MS);
    return () => {
      clearInterval(timer);
    };
    // pollStatus is stable by construction (no deps); the effect
    // re-runs only when the playing/paused state changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [permitted, currentPath, status.playing, status.paused]);

  async function playTrack(track: Track): Promise<void> {
    const next = await callMusic("sevyn music play " + track.path);
    if (next === null) return;
    setCurrentPath(track.path);
    setStatus(next);
    Sevyn.log("MUSIC play " + track.path);
  }

  async function togglePlay(): Promise<void> {
    if (status.playing) {
      const next = await callMusic("sevyn music pause");
      if (next !== null) setStatus(next);
      return;
    }
    if (status.paused) {
      const next = await callMusic("sevyn music resume");
      if (next !== null) setStatus(next);
      return;
    }
    const track = current ?? tracks[0];
    if (track !== undefined) await playTrack(track);
  }

  async function playNext(): Promise<void> {
    if (tracks.length === 0) return;
    const next = tracks[(currentIndex + 1) % tracks.length];
    if (next !== undefined) await playTrack(next);
  }

  async function playPrevious(): Promise<void> {
    if (tracks.length === 0) return;
    const prev = tracks[(currentIndex - 1 + tracks.length) % tracks.length];
    if (prev !== undefined) await playTrack(prev);
  }

  async function stopPlayback(): Promise<void> {
    const next = await callMusic("sevyn music stop");
    if (next !== null) setStatus(next);
  }

  async function seekBy(deltaSec: number): Promise<void> {
    if (durationSec <= 0) {
      setError("Seek needs a track with a known length.");
      return;
    }
    const target = Math.min(Math.max(0, status.positionSec + deltaSec), durationSec);
    if (!Number.isFinite(target)) {
      setError("Seek needs a finite position.");
      return;
    }
    const next = await callMusic("sevyn music seek " + String(Math.floor(target)));
    if (next !== null) setStatus(next);
  }

  async function changeVolume(delta: number): Promise<void> {
    const target = Math.min(100, Math.max(0, status.volume + delta));
    if (!Number.isFinite(target)) {
      setError("Volume needs a finite level.");
      return;
    }
    const next = await callMusic("sevyn music volume " + String(target));
    if (next !== null) setStatus(next);
  }

  function rescan(): void {
    setLibrary(readLibrary());
    const found = readStatus();
    setStatus(found === null ? IDLE_STATUS : found);
    setError("");
    Sevyn.log("MUSIC rescan");
  }

  function header(title: string): React.ReactElement {
    return (
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
          source={appIconTitlePath("music")}
          style={{ width: 20, height: 20, marginRight: 8 }}
        />
        <Text style={{ fontSize: 16, fontWeight: "bold", color: "#ffffff", flex: 1 }}>
          {title}
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
    );
  }

  function button(
    label: string,
    onPress: () => void,
    opts?: { primary?: boolean; disabled?: boolean },
  ): React.ReactElement {
    return (
      <Pressable
        onPress={opts?.disabled ? undefined : onPress}
        style={{
          backgroundColor: opts?.primary ? color : "#e5e7eb",
          borderRadius: 10,
          paddingLeft: 16,
          paddingRight: 16,
          paddingTop: 10,
          paddingBottom: 10,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text
          style={{
            color: opts?.primary ? "#ffffff" : "#111827",
            fontSize: 15,
            fontWeight: "600",
          }}
        >
          {label}
        </Text>
      </Pressable>
    );
  }

  function transportButton(
    label: string,
    icon: string | null,
    onPress: () => void,
    opts?: { primary?: boolean; disabled?: boolean },
  ): React.ReactElement {
    return (
      <Pressable
        onPress={opts?.disabled ? undefined : onPress}
        style={{
          backgroundColor: opts?.primary ? color : "#e5e7eb",
          borderRadius: 10,
          paddingLeft: 12,
          paddingRight: 12,
          paddingTop: 10,
          paddingBottom: 10,
          alignItems: "center",
          justifyContent: "center",
          flexDirection: "row",
        }}
      >
        {icon !== null ? (
          <Image
            source={symbolPath(icon)}
            style={{ width: 16, height: 16, marginRight: 6 }}
          />
        ) : null}
        <Text
          style={{
            color: opts?.primary ? "#ffffff" : "#111827",
            fontSize: 15,
            fontWeight: "600",
          }}
        >
          {label}
        </Text>
      </Pressable>
    );
  }

  function centeredNote(title: string, body: string): React.ReactElement {
    return (
      <View
        style={{
          flex: 1,
          justifyContent: "center",
          alignItems: "center",
          paddingLeft: 24,
          paddingRight: 24,
        }}
      >
        <Text
          style={{
            fontSize: 18,
            fontWeight: "bold",
            color: "#111827",
            textAlign: "center",
          }}
        >
          {title}
        </Text>
        <Text
          style={{
            fontSize: 14,
            color: "#6b7280",
            textAlign: "center",
            marginTop: 8,
          }}
        >
          {body}
        </Text>
      </View>
    );
  }

  if (!permitted) {
    return (
      <View style={{ flex: 1, backgroundColor: "#f9fafb" }}>
        {header("Music")}
        {centeredNote(
          "Music permission is not granted",
          "This app needs the cli.exec permission in its manifest to talk to the audio service.",
        )}
      </View>
    );
  }

  const positionText =
    formatTime(status.positionSec) +
    " / " +
    (durationSec > 0 ? formatTime(durationSec) : "–:––");

  return (
    <View style={{ flex: 1, backgroundColor: "#f9fafb" }}>
      {header("Music")}
      <ScrollView style={{ flex: 1, paddingLeft: 16, paddingRight: 16, paddingTop: 12 }}>
        {library.error !== "" ? (
          <Text style={{ fontSize: 14, color: "#dc2626", marginBottom: 8 }}>
            {library.error}
          </Text>
        ) : null}
        {tracks.length === 0 ? (
          <View style={{ marginTop: 24 }}>
            <Text style={{ fontSize: 18, fontWeight: "bold", color: "#111827" }}>
              No music yet
            </Text>
            <Text style={{ fontSize: 14, color: "#6b7280", marginTop: 8 }}>
              Audio files you add to this device will appear here.
            </Text>
            <View style={{ flexDirection: "row", marginTop: 20 }}>
              {button("Retry", rescan, { primary: true })}
            </View>
          </View>
        ) : (
          <View>
            <Text style={{ fontSize: 14, color: "#6b7280", marginBottom: 8 }}>
              {String(tracks.length) + (tracks.length === 1 ? " track" : " tracks")}
              {library.source === "files"
                ? " · durations unknown — audio service unreachable"
                : ""}
            </Text>
            {tracks.map((track) => {
              const isCurrent = track.path === currentPath;
              return (
                <Pressable
                  key={track.path}
                  onPress={() => {
                    void playTrack(track);
                  }}
                  style={{
                    backgroundColor: isCurrent ? "#fce7f3" : "#ffffff",
                    borderRadius: 12,
                    paddingLeft: 16,
                    paddingRight: 16,
                    paddingTop: 12,
                    paddingBottom: 12,
                    marginBottom: 8,
                  }}
                >
                  <Text style={{ fontSize: 15, color: "#111827" }}>{track.title}</Text>
                  <Text style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>
                    {track.artist +
                      (track.durationSec > 0
                        ? " · " + formatTime(track.durationSec)
                        : "")}
                  </Text>
                  {isCurrent ? (
                    <Text style={{ fontSize: 12, color: "#be185d", marginTop: 2 }}>
                      {stateLabel}
                    </Text>
                  ) : null}
                </Pressable>
              );
            })}
          </View>
        )}
      </ScrollView>
      {tracks.length > 0 ? (
        <View
          style={{
            backgroundColor: "#ffffff",
            paddingLeft: 16,
            paddingRight: 16,
            paddingTop: 12,
            paddingBottom: 16,
          }}
        >
          <Text style={{ fontSize: 15, fontWeight: "bold", color: "#111827" }}>
            {current !== null ? current.title : "Nothing playing"}
          </Text>
          <Text style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>
            {current !== null
              ? current.artist + " · " + positionText + " · " + stateLabel
              : "Tap a track to play it."}
          </Text>
          {error !== "" ? (
            <Text style={{ fontSize: 13, color: "#dc2626", marginTop: 8 }}>{error}</Text>
          ) : null}
          <View
            style={{
              flexDirection: "row",
              justifyContent: "center",
              marginTop: 12,
            }}
          >
            <View style={{ marginRight: 8 }}>
              {transportButton("Previous", "chevron-left", () => {
                void playPrevious();
              })}
            </View>
            <View style={{ marginRight: 8 }}>
              {transportButton("−10s", null, () => {
                void seekBy(-SEEK_STEP);
              })}
            </View>
            <View style={{ marginRight: 8 }}>
              {button(
                status.playing ? "Pause" : status.paused ? "Resume" : "Play",
                () => {
                  void togglePlay();
                },
                { primary: true },
              )}
            </View>
            <View style={{ marginRight: 8 }}>
              {transportButton("+10s", null, () => {
                void seekBy(SEEK_STEP);
              })}
            </View>
            {transportButton("Next", "chevron-right", () => {
              void playNext();
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
            <Image
              source={symbolPath("volume")}
              style={{ width: 16, height: 16, marginRight: 8 }}
            />
            <View style={{ marginRight: 8 }}>
              {button("Volume −", () => {
                void changeVolume(-VOLUME_STEP);
              })}
            </View>
            <Text
              style={{
                fontSize: 15,
                color: "#111827",
                marginRight: 8,
              }}
            >
              {"Volume " + String(status.volume) + "%"}
            </Text>
            <View style={{ marginRight: 8 }}>
              {button("Volume +", () => {
                void changeVolume(VOLUME_STEP);
              })}
            </View>
            {button("Stop", () => {
              void stopPlayback();
            })}
          </View>
        </View>
      ) : null}
    </View>
  );
}
