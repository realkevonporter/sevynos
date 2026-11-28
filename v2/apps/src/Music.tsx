// SevynOS v2 — the Music system app.
//
// Thin UI over audiod, the native audio daemon, through the RN
// audio module (SevynAudio — v2/rn/renderer/sevyn-audio.js), NOT
// the `sevyn music` CLI: the adapter speaks the daemon's protocol
// directly, off the JS thread, so the daemon is the source of truth
// for position, duration, and volume. No Chromium anywhere in this
// path: decode and ALSA output both live in audiod. The CLI survives
// in exactly one place — the library fallback below, which lists
// /data with `sevyn files` when the scan fails (daemon down).
//
//   library    — SevynAudio.scan("/data") on mount (real durations
//                from the daemon). When the scan fails (daemon down)
//                the library falls back to `sevyn files list /data`
//                filtered to audio files — those tracks list with an
//                unknown duration, and the screen says so.
//   transport  — play / pause / resume / stop, seek ±10 s, volume
//                ±10, next / previous (wraps around the library).
//                NOTE: the daemon reports playing:true AND paused:true
//                while paused (playing means "a track is loaded"),
//                so paused always wins over playing here — in the
//                state label, the Play/Pause button, and togglePlay.
//                Checking playing first would leave the button stuck
//                on "Pause" after pausing.
//   position   — polled from SevynAudio.status() once a second
//                while a track is playing or paused (the shell has
//                no push channel for playback state, so the app
//                polls; the interval is created in useEffect and
//                cleared on unmount — the same pattern as the
//                camera preview poll).
//
// The old volume-up bug is impossible by construction here: EVERY
// control goes through `callAudio`, which never throws — a bad call
// (daemon down, undecodable file, seek past the end) is a rejected
// promise carrying an AudiodError with a stable code, and it lands
// as an error line on screen. Nothing in this file throws into
// Genesis, and no handler awaits without a catch.
//
// Deliberately out of v1 (follow-ups, see the PR): playlists,
// shuffle/repeat, metadata tags/artwork, search, auto-advance.
//
// The adapter needs no manifest permission — the host's Sevyn.audio*
// functions are ungated — so there is no permission gate here.
// cli.exec stays in the manifest only for the files-list fallback.

import * as React from "react";
import { View, Text, Image, Pressable, ScrollView } from "./host";
import { WindowButtons, useWindowActive } from "./window-buttons";
import { tokens } from "../../rn/renderer/tokens";
import { runCli } from "./cli";
import { appIconTitlePath, symbolPath } from "./icons";
import { AudiodError, SevynAudio } from "../../rn/renderer/sevyn-audio";
import type { AudiodStatus, AudiodTrack } from "../../rn/renderer/sevyn-audio";

const MUSIC_DIR = "/data";
const STATUS_POLL_MS = 1000;
const VOLUME_STEP = 10;
const SEEK_STEP = 10;

const AUDIO_EXTENSIONS = new Set([".wav", ".mp3", ".flac", ".ogg"]);

type Track = AudiodTrack;

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

/** The adapter's status shape, mapped to the app's PlaybackStatus. */
function statusFromAdapter(st: AudiodStatus): PlaybackStatus {
  return {
    playing: st.playing,
    paused: st.paused,
    positionSec: st.currentPositionSec,
    durationSec: st.durationSec,
    volume: st.volume,
    trackPath: st.track !== null ? st.track.path : null,
  };
}

/**
 * Library from the daemon scan, falling back to a files listing.
 * The scan is async (the adapter never blocks the JS thread); the
 * fallback is the one `sevyn` CLI call left in this file.
 */
async function loadLibrary(): Promise<LibraryResult> {
  try {
    const tracks = await SevynAudio.scan(MUSIC_DIR);
    return { tracks, source: "scan", error: "" };
  } catch {
    // The scan failed (daemon down): list the files directly so the
    // library still shows. Durations are unknown here — the screen
    // says so.
  }
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

const EMPTY_LIBRARY: LibraryResult = { tracks: [], source: "files", error: "" };

export function Music(): React.ReactElement {
  const color = Sevyn.appColor;
  // Polish surface (b): the title bar dims when the window loses
  // keyboard focus. header() below closes over this.
  const windowActive = useWindowActive();
  const [library, setLibrary] = React.useState<LibraryResult>(EMPTY_LIBRARY);
  const [loading, setLoading] = React.useState<boolean>(true);
  const [status, setStatus] = React.useState<PlaybackStatus>(IDLE_STATUS);
  const [currentPath, setCurrentPath] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string>("");
  const pollRef = React.useRef<boolean>(false);

  const tracks = library.tracks;
  const currentIndex = tracks.findIndex((t) => t.path === currentPath);
  const current = currentIndex >= 0 ? tracks[currentIndex] : null;
  const durationSec =
    current !== null && current.durationSec > 0
      ? current.durationSec
      : status.durationSec;
  const stateLabel = status.paused
    ? "Paused"
    : status.playing
      ? "Playing"
      : currentPath !== null && status.positionSec >= durationSec && durationSec > 0
        ? "Finished"
        : "Stopped";

  // Library + playback state load once on mount (the scan is
  // async — the adapter never blocks the JS thread). The status
  // read picks up a track already playing from an earlier session.
  React.useEffect(() => {
    let cancelled = false;
    void loadLibrary().then((next) => {
      if (!cancelled) {
        setLibrary(next);
        setLoading(false);
      }
    });
    void SevynAudio.status().then(
      (found) => {
        if (cancelled) return;
        setStatus(statusFromAdapter(found));
        setCurrentPath(found.track !== null ? found.track.path : null);
      },
      () => {
        // Daemon down on mount: stay idle; the library fallback
        // already says so on screen.
      },
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * One guarded adapter call. Never throws: a rejected promise
   * (daemon down, undecodable file, seek past the end) carries an
   * AudiodError with a stable code, and it lands as an on-screen
   * error (with the code) and a null status. A success clears the
   * error. This is the guard the old volume-up bug needed — the
   * caller never sees a rejection.
   */
  async function callAudio(
    fn: () => Promise<AudiodStatus>,
  ): Promise<PlaybackStatus | null> {
    try {
      const next = statusFromAdapter(await fn());
      setError("");
      return next;
    } catch (caught) {
      const detail = caught instanceof Error ? caught.message : "Audio service failed.";
      const code = caught instanceof AudiodError ? caught.code : "";
      setError(code !== "" ? detail + " (" + code + ")" : detail);
      return null;
    }
  }

  async function pollStatus(): Promise<void> {
    if (pollRef.current) return;
    pollRef.current = true;
    try {
      const next = await callAudio(() => SevynAudio.status());
      if (next !== null) setStatus(next);
    } finally {
      pollRef.current = false;
    }
  }

  // Real playback position, polled from the daemon while a track is
  // playing or paused (the shell has no push channel for playback
  // state). The interval is cleared on unmount / state change.
  React.useEffect(() => {
    if (currentPath === null || (!status.playing && !status.paused)) return undefined;
    const timer = setInterval(() => {
      void pollStatus();
    }, STATUS_POLL_MS);
    return () => {
      clearInterval(timer);
    };
    // pollStatus is stable by construction (no deps); the effect
    // re-runs only when the playing/paused state changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPath, status.playing, status.paused]);

  async function playTrack(track: Track): Promise<void> {
    const next = await callAudio(() => SevynAudio.play({ path: track.path, track }));
    if (next === null) return;
    setCurrentPath(track.path);
    setStatus(next);
    Sevyn.log("MUSIC play " + track.path);
  }

  async function togglePlay(): Promise<void> {
    if (status.paused) {
      const next = await callAudio(() => SevynAudio.resume());
      if (next !== null) setStatus(next);
      return;
    }
    if (status.playing) {
      const next = await callAudio(() => SevynAudio.pause());
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
    const next = await callAudio(() => SevynAudio.stop());
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
    const next = await callAudio(() => SevynAudio.seek(Math.floor(target)));
    if (next !== null) setStatus(next);
  }

  async function changeVolume(delta: number): Promise<void> {
    const target = Math.min(100, Math.max(0, status.volume + delta));
    if (!Number.isFinite(target)) {
      setError("Volume needs a finite level.");
      return;
    }
    const next = await callAudio(() => SevynAudio.setVolume(target));
    if (next !== null) setStatus(next);
  }

  async function rescan(): Promise<void> {
    setLoading(true);
    setError("");
    Sevyn.log("MUSIC rescan");
    const next = await loadLibrary();
    setLibrary(next);
    setLoading(false);
    try {
      const found = await SevynAudio.status();
      setStatus(statusFromAdapter(found));
      setCurrentPath(found.track !== null ? found.track.path : null);
    } catch {
      setStatus(IDLE_STATUS);
    }
  }

  function header(title: string): React.ReactElement {
    return (
      <View
        style={{
          flexDirection: "row",
          height: tokens.window.titleBarHeight,
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
        <Text
          style={{
            fontSize: 16,
            fontWeight: "bold",
            color: windowActive ? "#ffffff" : tokens.color.dark.textSecondary,
            flex: 1,
          }}
        >
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
        {loading ? (
          <View style={{ marginTop: 24 }}>
            <Text style={{ fontSize: 18, fontWeight: "bold", color: "#111827" }}>
              Loading your music…
            </Text>
          </View>
        ) : tracks.length === 0 ? (
          <View style={{ marginTop: 24 }}>
            <Text style={{ fontSize: 18, fontWeight: "bold", color: "#111827" }}>
              No music yet
            </Text>
            <Text style={{ fontSize: 14, color: "#6b7280", marginTop: 8 }}>
              Audio files you add to this device will appear here.
            </Text>
            <View style={{ flexDirection: "row", marginTop: 20 }}>
              {button(
                "Retry",
                () => {
                  void rescan();
                },
                { primary: true },
              )}
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
                status.paused ? "Resume" : status.playing ? "Pause" : "Play",
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
