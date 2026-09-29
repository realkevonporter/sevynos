import { useCallback, useEffect, useState, type JSX } from "react";
import {
  NativeModules,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  sevynTokens,
  type MediaPlaybackStatus,
  type MediaPlaylist,
  type MediaService,
  type MediaTrack,
  type SevynApplicationManifest,
  type SevynFileSystem,
} from "@sevynos/react-native";

export const musicManifest: SevynApplicationManifest = {
  manifestVersion: 1,
  id: "org.sevynos.music",
  name: "Music",
  version: "1.0.0",
  runtime: "react-native",
  applicationKey: "Music",
  developer: "SevynOS",
  icon: "icons/music.svg",
  entrypoint: "dist/index.js",
  minimumSevynOSVersion: "0.1.0",
  permissions: ["media", "filesystem.read", "filesystem.write"],
  services: [],
  windowModes: ["standard"],
  instanceMode: "single",
};

export type MusicNavigationTab = "library" | "playlists" | "now-playing";
export type MusicRepeatMode = "off" | "all" | "one";

export const DEFAULT_TRACKS: readonly MediaTrack[] = Object.freeze([
  {
    id: "track-1",
    title: "Genesis Horizon",
    artist: "SevynOS Sound Team",
    album: "Genesis",
    durationSec: 28,
    path: "/usr/share/sevyn/music/genesis-horizon.flac",
    format: "flac",
    year: 2026,
    genre: "Ambient Electronic",
  },
  {
    id: "track-2",
    title: "Silicon Pulse",
    artist: "SevynOS Sound Team",
    album: "Genesis",
    durationSec: 28,
    path: "/usr/share/sevyn/music/silicon-pulse.mp3",
    format: "mp3",
    year: 2026,
    genre: "Synthwave",
  },
  {
    id: "track-3",
    title: "Nebula Drift",
    artist: "Kevon Porter",
    album: "Constellations",
    durationSec: 28,
    path: "/usr/share/sevyn/music/nebula-drift.ogg",
    format: "ogg",
    year: 2026,
    genre: "Deep Ambient",
  },
  {
    id: "track-4",
    title: "Digital Dawn",
    artist: "Aura Laboratory",
    album: "Signals",
    durationSec: 28,
    path: "/usr/share/sevyn/music/digital-dawn.wav",
    format: "wav",
    year: 2026,
    genre: "Chillout",
  },
  {
    id: "track-5",
    title: "Midnight Terminal",
    artist: "Sevyn Core",
    album: "System Sounds",
    durationSec: 28,
    path: "/usr/share/sevyn/music/midnight-terminal.m4a",
    format: "m4a",
    year: 2026,
    genre: "Lo-Fi",
  },
]);

export const DEFAULT_PLAYLISTS: readonly MediaPlaylist[] = Object.freeze([
  {
    id: "playlist-favorites",
    name: "Favorites",
    trackIds: ["track-1", "track-3"],
    createdAt: 1773000000000,
  },
  {
    id: "playlist-focus",
    name: "Focus & Flow",
    trackIds: ["track-2", "track-4", "track-5"],
    createdAt: 1773000000000,
  },
]);

export function formatTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const remainingS = s % 60;
  return `${String(m).padStart(2, "0")}:${String(remainingS).padStart(2, "0")}`;
}

export interface MusicApplicationProps {
  readonly media?: MediaService | undefined;
  readonly filesystem?: Partial<SevynFileSystem> | undefined;
  readonly permissions?:
    | {
        readonly has: (permission: string) => boolean;
        readonly request: (permission: string) => Promise<boolean>;
      }
    | undefined;
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#0B0C10",
  },
  header: {
    height: 60,
    backgroundColor: "#17181D",
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255, 255, 255, 0.08)",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: sevynTokens.spacing.md,
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: sevynTokens.spacing.sm,
  },
  headerTitle: {
    fontSize: sevynTokens.typography.title.size,
    fontWeight: "600",
    color: "#F4F4F6",
  },
  tabRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: sevynTokens.spacing.xs,
    marginLeft: sevynTokens.spacing.lg,
  },
  tabButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: sevynTokens.radius.xs,
    backgroundColor: "transparent",
  },
  tabButtonActive: {
    backgroundColor: "rgba(215, 172, 87, 0.16)",
    borderWidth: 1,
    borderColor: "rgba(215, 172, 87, 0.4)",
  },
  tabButtonText: {
    fontSize: sevynTokens.typography.body.size,
    fontWeight: "500",
    color: "#858A94",
  },
  tabButtonTextActive: {
    color: "#D7AC57",
  },
  headerRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: sevynTokens.spacing.sm,
  },
  searchBox: {
    height: 32,
    width: 180,
    backgroundColor: "#202127",
    borderRadius: sevynTokens.radius.xs,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.08)",
    justifyContent: "center",
    paddingHorizontal: 10,
  },
  searchPlaceholder: {
    fontSize: sevynTokens.typography.caption.size,
    color: "#5C6069",
  },
  playbackError: {
    minHeight: 32,
    backgroundColor: "rgba(255, 107, 107, 0.12)",
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255, 107, 107, 0.35)",
    paddingHorizontal: sevynTokens.spacing.md,
    paddingVertical: 7,
    color: "#FFB4B4",
    fontSize: sevynTokens.typography.caption.size,
  },
  scanButton: {
    height: 32,
    paddingHorizontal: 12,
    backgroundColor: "#202127",
    borderRadius: sevynTokens.radius.xs,
    borderWidth: 1,
    borderColor: "rgba(215, 172, 87, 0.25)",
    justifyContent: "center",
    alignItems: "center",
  },
  scanButtonText: {
    fontSize: sevynTokens.typography.caption.size,
    fontWeight: "500",
    color: "#D7AC57",
  },
  contentArea: {
    flex: 1,
  },
  // Library View
  libraryContainer: {
    flex: 1,
    padding: sevynTokens.spacing.md,
  },
  sectionHeadingRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: sevynTokens.spacing.sm,
  },
  sectionHeading: {
    fontSize: sevynTokens.typography.label.size,
    fontWeight: "600",
    color: "#F4F4F6",
  },
  sectionSubtext: {
    fontSize: sevynTokens.typography.caption.size,
    color: "#858A94",
  },
  tableHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255, 255, 255, 0.08)",
  },
  tableHeaderCell: {
    fontSize: sevynTokens.typography.micro.size,
    fontWeight: "600",
    color: "#5C6069",
    textTransform: "uppercase",
  },
  trackRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: sevynTokens.radius.xs,
    marginVertical: 2,
    backgroundColor: "transparent",
  },
  trackRowActive: {
    backgroundColor: "rgba(215, 172, 87, 0.08)",
    borderWidth: 1,
    borderColor: "rgba(215, 172, 87, 0.25)",
  },
  trackIndexText: {
    width: 32,
    fontSize: sevynTokens.typography.caption.size,
    color: "#5C6069",
  },
  trackTitleCol: {
    flex: 3,
    justifyContent: "center",
  },
  trackTitleText: {
    fontSize: sevynTokens.typography.body.size,
    fontWeight: "500",
    color: "#F4F4F6",
  },
  trackTitleTextActive: {
    color: "#D7AC57",
  },
  trackArtistText: {
    fontSize: sevynTokens.typography.caption.size,
    color: "#858A94",
    marginTop: 2,
  },
  trackAlbumCol: {
    flex: 2,
    justifyContent: "center",
  },
  trackAlbumText: {
    fontSize: sevynTokens.typography.caption.size,
    color: "#858A94",
  },
  trackFormatCol: {
    width: 60,
    justifyContent: "center",
    alignItems: "flex-start",
  },
  formatBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    backgroundColor: "#202127",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.12)",
  },
  formatBadgeText: {
    fontSize: 10,
    fontWeight: "600",
    color: "#C0C1C7",
    textTransform: "uppercase",
  },
  trackDurationCol: {
    width: 60,
    justifyContent: "center",
    alignItems: "flex-end",
  },
  trackDurationText: {
    fontSize: sevynTokens.typography.caption.size,
    color: "#858A94",
  },
  trackActionCol: {
    width: 70,
    flexDirection: "row",
    justifyContent: "flex-end",
    alignItems: "center",
    gap: 6,
  },
  playIconBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: "rgba(215, 172, 87, 0.15)",
    justifyContent: "center",
    alignItems: "center",
  },
  playIconBtnText: {
    fontSize: 12,
    color: "#D7AC57",
  },
  favIconBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: "#202127",
    justifyContent: "center",
    alignItems: "center",
  },
  favIconBtnActive: {
    backgroundColor: "rgba(215, 117, 152, 0.2)",
  },
  favIconBtnText: {
    fontSize: 12,
    color: "#858A94",
  },
  favIconBtnTextActive: {
    color: "#D77598",
  },
  // Playlists View
  playlistsContainer: {
    flex: 1,
    flexDirection: "row",
    padding: sevynTokens.spacing.md,
    gap: sevynTokens.spacing.md,
  },
  playlistsSidebar: {
    width: 220,
    borderRightWidth: 1,
    borderRightColor: "rgba(255, 255, 255, 0.08)",
    paddingRight: sevynTokens.spacing.md,
  },
  playlistItem: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: sevynTokens.radius.xs,
    marginBottom: 4,
  },
  playlistItemActive: {
    backgroundColor: "rgba(215, 172, 87, 0.12)",
    borderWidth: 1,
    borderColor: "rgba(215, 172, 87, 0.3)",
  },
  playlistItemName: {
    fontSize: sevynTokens.typography.body.size,
    fontWeight: "500",
    color: "#C0C1C7",
  },
  playlistItemNameActive: {
    color: "#D7AC57",
  },
  playlistItemCount: {
    fontSize: sevynTokens.typography.caption.size,
    color: "#5C6069",
    marginTop: 2,
  },
  newPlaylistCard: {
    marginTop: sevynTokens.spacing.md,
    padding: 10,
    borderRadius: sevynTokens.radius.xs,
    backgroundColor: "#17181D",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.08)",
    alignItems: "center",
  },
  newPlaylistBtnText: {
    fontSize: sevynTokens.typography.caption.size,
    fontWeight: "500",
    color: "#D7AC57",
  },
  playlistMain: {
    flex: 1,
  },
  // Now Playing Full View
  nowPlayingContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: sevynTokens.spacing.lg,
  },
  albumCard: {
    width: 240,
    height: 240,
    borderRadius: sevynTokens.radius.md,
    backgroundColor: "#17181D",
    borderWidth: 2,
    borderColor: "rgba(215, 172, 87, 0.35)",
    justifyContent: "center",
    alignItems: "center",
    marginBottom: sevynTokens.spacing.lg,
  },
  vinylDisc: {
    width: 190,
    height: 190,
    borderRadius: 95,
    backgroundColor: "#0B0C10",
    borderWidth: 4,
    borderColor: "#202127",
    justifyContent: "center",
    alignItems: "center",
  },
  vinylInnerDisc: {
    width: 70,
    height: 70,
    borderRadius: 35,
    backgroundColor: "#D7AC57",
    justifyContent: "center",
    alignItems: "center",
  },
  vinylCenterHole: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: "#0B0C10",
  },
  trackMetaBlock: {
    alignItems: "center",
    marginBottom: sevynTokens.spacing.md,
  },
  nowPlayingTitle: {
    fontSize: sevynTokens.typography.title.size,
    fontWeight: "600",
    color: "#F4F4F6",
    marginBottom: 4,
  },
  nowPlayingArtist: {
    fontSize: sevynTokens.typography.body.size,
    color: "#D7AC57",
    marginBottom: 2,
  },
  nowPlayingAlbum: {
    fontSize: sevynTokens.typography.caption.size,
    color: "#858A94",
  },
  formatBadgeLarge: {
    marginTop: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
    backgroundColor: "#202127",
    borderWidth: 1,
    borderColor: "rgba(215, 172, 87, 0.3)",
  },
  formatBadgeTextLarge: {
    fontSize: 11,
    fontWeight: "600",
    color: "#D7AC57",
    textTransform: "uppercase",
  },
  scrubberContainer: {
    width: 360,
    marginBottom: sevynTokens.spacing.md,
  },
  scrubberTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: "#202127",
    overflow: "hidden",
  },
  scrubberFill: {
    height: 6,
    borderRadius: 3,
    backgroundColor: "#D7AC57",
  },
  scrubberTimeRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 6,
  },
  scrubberTimeText: {
    fontSize: sevynTokens.typography.micro.size,
    color: "#858A94",
  },
  seekJumpRow: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 8,
    marginTop: 6,
  },
  seekJumpBtn: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
    backgroundColor: "#17181D",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.08)",
  },
  seekJumpBtnText: {
    fontSize: 10,
    color: "#858A94",
  },
  transportRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: sevynTokens.spacing.md,
    marginBottom: sevynTokens.spacing.lg,
  },
  transportBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "#17181D",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.08)",
    justifyContent: "center",
    alignItems: "center",
  },
  transportBtnActive: {
    borderColor: "#D7AC57",
    backgroundColor: "rgba(215, 172, 87, 0.15)",
  },
  transportBtnText: {
    fontSize: 14,
    color: "#F4F4F6",
  },
  transportBtnPlayPause: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: "#D7AC57",
    justifyContent: "center",
    alignItems: "center",
  },
  transportBtnPlayPauseText: {
    fontSize: 20,
    fontWeight: "700",
    color: "#19140A",
  },
  volumeRow: {
    flexDirection: "row",
    alignItems: "center",
    width: 260,
    gap: 10,
  },
  volumeIcon: {
    fontSize: 12,
    color: "#858A94",
  },
  volumeTrack: {
    flex: 1,
    height: 4,
    borderRadius: 2,
    backgroundColor: "#202127",
    overflow: "hidden",
  },
  volumeFill: {
    height: 4,
    borderRadius: 2,
    backgroundColor: "#858A94",
  },
  volumePercentText: {
    fontSize: sevynTokens.typography.micro.size,
    color: "#858A94",
    width: 32,
    textAlign: "right",
  },
  // Persistent Mini-Player
  miniPlayer: {
    height: 64,
    backgroundColor: "#17181D",
    borderTopWidth: 1,
    borderTopColor: "rgba(255, 255, 255, 0.08)",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: sevynTokens.spacing.md,
  },
  miniPlayerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    flex: 1,
  },
  miniAlbumArt: {
    width: 44,
    height: 44,
    borderRadius: 6,
    backgroundColor: "#202127",
    borderWidth: 1,
    borderColor: "rgba(215, 172, 87, 0.3)",
    justifyContent: "center",
    alignItems: "center",
  },
  miniAlbumArtIcon: {
    fontSize: 16,
    color: "#D7AC57",
  },
  miniTrackInfo: {
    flex: 1,
  },
  miniTrackTitle: {
    fontSize: sevynTokens.typography.body.size,
    fontWeight: "500",
    color: "#F4F4F6",
  },
  miniTrackArtist: {
    fontSize: sevynTokens.typography.caption.size,
    color: "#858A94",
  },
  miniPlayerCenter: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  miniPlayPauseBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: "#D7AC57",
    justifyContent: "center",
    alignItems: "center",
  },
  miniPlayPauseBtnText: {
    fontSize: 16,
    fontWeight: "700",
    color: "#19140A",
  },
  miniSkipBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: "#202127",
    justifyContent: "center",
    alignItems: "center",
  },
  miniSkipBtnText: {
    fontSize: 12,
    color: "#F4F4F6",
  },
  miniPlayerRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  expandBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: sevynTokens.radius.xs,
    backgroundColor: "#202127",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.08)",
  },
  expandBtnText: {
    fontSize: sevynTokens.typography.caption.size,
    color: "#C0C1C7",
  },
  // Permission Prompt
  permissionPromptCard: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: sevynTokens.spacing.xl,
  },
  permissionIcon: {
    fontSize: 48,
    marginBottom: sevynTokens.spacing.md,
  },
  permissionTitle: {
    fontSize: sevynTokens.typography.title.size,
    fontWeight: "600",
    color: "#F4F4F6",
    marginBottom: sevynTokens.spacing.xs,
    textAlign: "center",
  },
  permissionDescription: {
    fontSize: sevynTokens.typography.body.size,
    color: "#858A94",
    textAlign: "center",
    maxWidth: 400,
    lineHeight: 20,
    marginBottom: sevynTokens.spacing.lg,
  },
  permissionBtnRow: {
    flexDirection: "row",
    gap: sevynTokens.spacing.sm,
  },
  grantBtn: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: sevynTokens.radius.sm,
    backgroundColor: "#D7AC57",
  },
  grantBtnText: {
    fontSize: sevynTokens.typography.body.size,
    fontWeight: "600",
    color: "#19140A",
  },
  denyBtn: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: sevynTokens.radius.sm,
    backgroundColor: "#202127",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.1)",
  },
  denyBtnText: {
    fontSize: sevynTokens.typography.body.size,
    fontWeight: "500",
    color: "#858A94",
  },
});

export function MusicApplication(props: MusicApplicationProps): JSX.Element {
  const [permissionState, setPermissionState] = useState<
    "pending" | "granted" | "denied"
  >(() => {
    if (props.permissions !== undefined) {
      return props.permissions.has("media") ? "granted" : "pending";
    }
    return "granted";
  });

  const [activeTab, setActiveTab] = useState<MusicNavigationTab>("library");
  const [tracks, setTracks] = useState<readonly MediaTrack[]>(DEFAULT_TRACKS);
  const [playlists, setPlaylists] = useState<readonly MediaPlaylist[]>(DEFAULT_PLAYLISTS);
  const [selectedPlaylistId, setSelectedPlaylistId] =
    useState<string>("playlist-favorites");
  const [currentTrackIndex, setCurrentTrackIndex] = useState<number>(0);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [isPaused, setIsPaused] = useState<boolean>(false);
  const [currentPositionSec, setCurrentPositionSec] = useState<number>(0);
  const [volume, setVolume] = useState<number>(100);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [isShuffled, setIsShuffled] = useState<boolean>(false);
  const [repeatMode, setRepeatMode] = useState<MusicRepeatMode>("off");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [scanStatus, setScanStatus] = useState<string | undefined>(undefined);
  const [playbackError, setPlaybackError] = useState<string | undefined>(undefined);

  const currentTrack = tracks[currentTrackIndex] ?? tracks[0] ?? DEFAULT_TRACKS[0];

  // Poll real playback status from the media service (replaces simulated timer).
  useEffect(() => {
    if (!isPlaying) return;
    const pollStatus = async (): Promise<void> => {
      try {
        const media = props.media ?? NativeModules.HardwareModules.media;
        const status = (await media.status()) as MediaPlaybackStatus | undefined;
        if (status) {
          setCurrentPositionSec(status.currentPositionSec);
          // Sync pause state with reality (e.g. ffplay died).
          if (!status.playing && !status.paused) {
            // Playback ended or failed; advance to next track or stop.
            const dur = currentTrack?.durationSec ?? 180;
            if (status.currentPositionSec >= dur - 1) {
              if (repeatMode === "one") {
                setCurrentPositionSec(0);
              } else if (currentTrackIndex + 1 < tracks.length || repeatMode === "all") {
                const nextIdx = (currentTrackIndex + 1) % tracks.length;
                setCurrentTrackIndex(nextIdx);
                setCurrentPositionSec(0);
              } else {
                setIsPlaying(false);
              }
            }
          }
        }
      } catch {
        // Status poll failed; keep last known position.
      }
    };
    void pollStatus();
    const interval = setInterval(() => {
      void pollStatus();
    }, 1000);
    return () => {
      clearInterval(interval);
    };
  }, [
    isPlaying,
    props.media,
    currentTrack,
    currentTrackIndex,
    tracks.length,
    repeatMode,
  ]);

  const handlePlayTrack = useCallback(
    async (track: MediaTrack, index: number) => {
      setCurrentTrackIndex(index);
      setCurrentPositionSec(0);
      setPlaybackError(undefined);

      try {
        if (props.media) {
          await props.media.play({ path: track.path, track });
        } else {
          const hardwareMedia = NativeModules.HardwareModules.media;
          await hardwareMedia.play(track.path);
        }
        setIsPlaying(true);
        setIsPaused(false);
      } catch (error: unknown) {
        setIsPlaying(false);
        setIsPaused(false);
        setPlaybackError(
          error instanceof Error
            ? error.message
            : "The selected audio output could not start playback.",
        );
      }
    },
    [props.media],
  );

  const handleTogglePlayPause = useCallback(async () => {
    if (!isPlaying) {
      if (currentTrack) {
        await handlePlayTrack(currentTrack, currentTrackIndex);
      }
      return;
    }

    if (isPaused) {
      setIsPaused(false);
      if (props.media) {
        try {
          await props.media.resume();
        } catch (error: unknown) {
          setPlaybackError(error instanceof Error ? error.message : "Resume failed.");
        }
      } else {
        try {
          await NativeModules.HardwareModules.media.resume();
        } catch (error: unknown) {
          setPlaybackError(error instanceof Error ? error.message : "Resume failed.");
        }
      }
    } else {
      setIsPaused(true);
      if (props.media) {
        try {
          await props.media.pause();
        } catch (error: unknown) {
          setPlaybackError(error instanceof Error ? error.message : "Pause failed.");
        }
      } else {
        try {
          await NativeModules.HardwareModules.media.pause();
        } catch (error: unknown) {
          setPlaybackError(error instanceof Error ? error.message : "Pause failed.");
        }
      }
    }
  }, [
    isPlaying,
    isPaused,
    currentTrack,
    currentTrackIndex,
    handlePlayTrack,
    props.media,
  ]);

  const handleNextTrack = useCallback(async () => {
    if (tracks.length === 0) return;
    let nextIdx: number;
    if (isShuffled) {
      nextIdx = Math.floor(Math.random() * tracks.length);
    } else {
      nextIdx = (currentTrackIndex + 1) % tracks.length;
    }
    const nextT = tracks[nextIdx];
    if (nextT) {
      await handlePlayTrack(nextT, nextIdx);
    }
  }, [tracks, isShuffled, currentTrackIndex, handlePlayTrack]);

  const handlePreviousTrack = useCallback(async () => {
    if (tracks.length === 0) return;
    if (currentPositionSec > 3) {
      // Restart track
      setCurrentPositionSec(0);
      if (props.media) {
        try {
          await props.media.seek(0);
        } catch (error: unknown) {
          setPlaybackError(error instanceof Error ? error.message : "Seek failed.");
        }
      } else {
        await NativeModules.HardwareModules.media.seek(0);
      }
      return;
    }
    const prevIdx = (currentTrackIndex - 1 + tracks.length) % tracks.length;
    const prevT = tracks[prevIdx];
    if (prevT) {
      await handlePlayTrack(prevT, prevIdx);
    }
  }, [tracks, currentPositionSec, currentTrackIndex, handlePlayTrack, props.media]);

  const handleSeek = useCallback(
    async (targetSec: number) => {
      const clamped = Math.max(0, Math.min(targetSec, currentTrack?.durationSec ?? 180));
      setCurrentPositionSec(clamped);
      if (props.media) {
        try {
          await props.media.seek(clamped);
        } catch (error: unknown) {
          setPlaybackError(error instanceof Error ? error.message : "Seek failed.");
        }
      } else {
        try {
          await NativeModules.HardwareModules.media.seek(clamped);
        } catch (error: unknown) {
          setPlaybackError(error instanceof Error ? error.message : "Seek failed.");
        }
      }
    },
    [currentTrack, props.media],
  );

  const handleVolumeChange = useCallback(
    async (newVol: number) => {
      const clamped = Math.max(0, Math.min(100, newVol));
      setVolume(clamped);
      if (props.media?.setVolume) {
        try {
          await props.media.setVolume(clamped);
        } catch (error: unknown) {
          setPlaybackError(error instanceof Error ? error.message : "Volume failed.");
        }
      } else {
        try {
          await NativeModules.HardwareModules.media.setVolume(clamped);
        } catch (error: unknown) {
          setPlaybackError(error instanceof Error ? error.message : "Volume failed.");
        }
      }
    },
    [props.media],
  );

  const handleToggleMute = useCallback(async () => {
    const nextMuted = !isMuted;
    setIsMuted(nextMuted);
    try {
      if (props.media?.setVolume) await props.media.setVolume(nextMuted ? 0 : volume);
      else await NativeModules.HardwareModules.media.setVolume(nextMuted ? 0 : volume);
    } catch (error: unknown) {
      setPlaybackError(error instanceof Error ? error.message : "Mute failed.");
    }
  }, [isMuted, props.media, volume]);

  const handleToggleShuffle = useCallback(() => {
    setIsShuffled((prev) => !prev);
  }, []);

  const handleCycleRepeat = useCallback(() => {
    setRepeatMode((prev) => {
      if (prev === "off") return "all";
      if (prev === "all") return "one";
      return "off";
    });
  }, []);

  const handleToggleFavorite = useCallback((trackId: string) => {
    setPlaylists((prev) =>
      prev.map((pl) => {
        if (pl.id !== "playlist-favorites") return pl;
        const exists = pl.trackIds.includes(trackId);
        const newTrackIds = exists
          ? pl.trackIds.filter((id) => id !== trackId)
          : [...pl.trackIds, trackId];
        return { ...pl, trackIds: newTrackIds };
      }),
    );
  }, []);

  const handleCreatePlaylist = useCallback(() => {
    const name = `Playlist ${String(playlists.length + 1)}`;
    const newPl: MediaPlaylist = {
      id: `playlist-${String(Date.now())}`,
      name,
      trackIds: currentTrack ? [currentTrack.id] : [],
      createdAt: Date.now(),
    };
    setPlaylists((prev) => [...prev, newPl]);
    setSelectedPlaylistId(newPl.id);
  }, [playlists.length, currentTrack]);

  const handleScanLibrary = useCallback(async () => {
    setScanStatus("Scanning your Music folder...");
    const scan =
      props.media?.scan?.bind(props.media) ?? NativeModules.HardwareModules.media.scan;
    try {
      const found = (await scan("/var/lib/sevynos/user/Music")) as readonly MediaTrack[];
      if (found.length > 0) {
        setTracks((prev) => {
          const existingIds = new Set(prev.map((t) => t.path));
          const fresh = found.filter((t) => !existingIds.has(t.path));
          return [...prev, ...fresh];
        });
        setScanStatus(`Discovered ${String(found.length)} new track(s).`);
      } else {
        setScanStatus("Scan complete. No new audio files found.");
      }
    } catch (error: unknown) {
      setScanStatus(
        error instanceof Error
          ? `Library scan unavailable: ${error.message}`
          : "Library scan unavailable.",
      );
    }
  }, [props.media]);

  const handleGrantPermission = useCallback(async () => {
    if (props.permissions) {
      const granted = await props.permissions.request("media");
      setPermissionState(granted ? "granted" : "denied");
    } else {
      setPermissionState("granted");
    }
  }, [props.permissions]);

  if (permissionState === "pending") {
    return (
      <View style={styles.root}>
        <View style={styles.permissionPromptCard}>
          <Text style={styles.permissionIcon}>🎵</Text>
          <Text style={styles.permissionTitle}>Music Access Request</Text>
          <Text style={styles.permissionDescription}>
            SevynOS Music requires access to the system media subsystem to play local
            audio files and manage your music library.
          </Text>
          <View style={styles.permissionBtnRow}>
            <Pressable
              style={styles.grantBtn}
              onPress={() => {
                void handleGrantPermission();
              }}
            >
              <Text style={styles.grantBtnText}>Grant Media Access</Text>
            </Pressable>
            <Pressable
              style={styles.denyBtn}
              onPress={() => {
                setPermissionState("denied");
              }}
            >
              <Text style={styles.denyBtnText}>Deny</Text>
            </Pressable>
          </View>
        </View>
      </View>
    );
  }

  if (permissionState === "denied") {
    return (
      <View style={styles.root}>
        <View style={styles.permissionPromptCard}>
          <Text style={styles.permissionIcon}>🔒</Text>
          <Text style={styles.permissionTitle}>Media Permission Denied</Text>
          <Text style={styles.permissionDescription}>
            Media playback capability was denied for the Music application. You can
            re-enable media access in System Settings under Applications.
          </Text>
          <Pressable
            style={styles.grantBtn}
            onPress={() => {
              setPermissionState("pending");
            }}
          >
            <Text style={styles.grantBtnText}>Review Permissions</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  const filteredTracks = tracks.filter((t) => {
    if (searchQuery.trim().length === 0) return true;
    const q = searchQuery.toLowerCase();
    return (
      t.title.toLowerCase().includes(q) ||
      t.artist.toLowerCase().includes(q) ||
      (t.album?.toLowerCase().includes(q) ?? false) ||
      t.format.toLowerCase().includes(q)
    );
  });

  const favoritesPlaylist = playlists.find((p) => p.id === "playlist-favorites");
  const selectedPlaylist =
    playlists.find((p) => p.id === selectedPlaylistId) ?? playlists[0];
  const selectedPlaylistTracks = tracks.filter((t) =>
    selectedPlaylist?.trackIds.includes(t.id),
  );

  return (
    <View style={styles.root}>
      {/* Top Header Navigation */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Text style={styles.headerTitle}>Music</Text>
          <View style={styles.tabRow}>
            <Pressable
              style={StyleSheet.flatten([
                styles.tabButton,
                activeTab === "library" ? styles.tabButtonActive : undefined,
              ])}
              onPress={() => {
                setActiveTab("library");
              }}
            >
              <Text
                style={StyleSheet.flatten([
                  styles.tabButtonText,
                  activeTab === "library" ? styles.tabButtonTextActive : undefined,
                ])}
              >
                Library
              </Text>
            </Pressable>

            <Pressable
              style={StyleSheet.flatten([
                styles.tabButton,
                activeTab === "playlists" ? styles.tabButtonActive : undefined,
              ])}
              onPress={() => {
                setActiveTab("playlists");
              }}
            >
              <Text
                style={StyleSheet.flatten([
                  styles.tabButtonText,
                  activeTab === "playlists" ? styles.tabButtonTextActive : undefined,
                ])}
              >
                Playlists
              </Text>
            </Pressable>

            <Pressable
              style={StyleSheet.flatten([
                styles.tabButton,
                activeTab === "now-playing" ? styles.tabButtonActive : undefined,
              ])}
              onPress={() => {
                setActiveTab("now-playing");
              }}
            >
              <Text
                style={StyleSheet.flatten([
                  styles.tabButtonText,
                  activeTab === "now-playing" ? styles.tabButtonTextActive : undefined,
                ])}
              >
                Now Playing
              </Text>
            </Pressable>
          </View>
        </View>

        <View style={styles.headerRight}>
          <TextInput
            accessibilityLabel="Search music library"
            placeholder="Search library…"
            placeholderTextColor="#5C6069"
            style={styles.searchBox}
            value={searchQuery}
            onChangeText={setSearchQuery}
          />

          <Pressable
            style={styles.scanButton}
            onPress={() => {
              void handleScanLibrary();
            }}
          >
            <Text style={styles.scanButtonText}>Scan Folder</Text>
          </Pressable>
        </View>
      </View>

      {playbackError && <Text style={styles.playbackError}>Audio: {playbackError}</Text>}

      {/* Main Tab Content */}
      <View style={styles.contentArea}>
        {activeTab === "library" && (
          <ScrollView style={styles.libraryContainer}>
            <View style={styles.sectionHeadingRow}>
              <Text style={styles.sectionHeading}>
                All Songs ({String(filteredTracks.length)})
              </Text>
              {scanStatus && <Text style={styles.sectionSubtext}>{scanStatus}</Text>}
            </View>

            <View style={styles.tableHeader}>
              <Text style={StyleSheet.flatten([styles.tableHeaderCell, { width: 32 }])}>
                #
              </Text>
              <Text style={StyleSheet.flatten([styles.tableHeaderCell, { flex: 3 }])}>
                Title
              </Text>
              <Text style={StyleSheet.flatten([styles.tableHeaderCell, { flex: 2 }])}>
                Album
              </Text>
              <Text style={StyleSheet.flatten([styles.tableHeaderCell, { width: 60 }])}>
                Format
              </Text>
              <Text
                style={StyleSheet.flatten([
                  styles.tableHeaderCell,
                  { width: 60, textAlign: "right" },
                ])}
              >
                Time
              </Text>
              <Text style={StyleSheet.flatten([styles.tableHeaderCell, { width: 70 }])} />
            </View>

            {filteredTracks.map((t, idx) => {
              const isActive = isPlaying && currentTrack?.id === t.id;
              const isFav = favoritesPlaylist?.trackIds.includes(t.id) ?? false;
              return (
                <View
                  key={t.id}
                  style={StyleSheet.flatten([
                    styles.trackRow,
                    isActive ? styles.trackRowActive : undefined,
                  ])}
                >
                  <Text
                    style={StyleSheet.flatten([
                      styles.trackIndexText,
                      isActive ? { color: "#D7AC57" } : undefined,
                    ])}
                  >
                    {isActive ? "▶" : String(idx + 1)}
                  </Text>
                  <View style={styles.trackTitleCol}>
                    <Text
                      style={StyleSheet.flatten([
                        styles.trackTitleText,
                        isActive ? styles.trackTitleTextActive : undefined,
                      ])}
                    >
                      {t.title}
                    </Text>
                    <Text style={styles.trackArtistText}>{t.artist}</Text>
                  </View>
                  <View style={styles.trackAlbumCol}>
                    <Text style={styles.trackAlbumText}>{t.album ?? "—"}</Text>
                  </View>
                  <View style={styles.trackFormatCol}>
                    <View style={styles.formatBadge}>
                      <Text style={styles.formatBadgeText}>{t.format}</Text>
                    </View>
                  </View>
                  <View style={styles.trackDurationCol}>
                    <Text style={styles.trackDurationText}>
                      {formatTime(t.durationSec)}
                    </Text>
                  </View>
                  <View style={styles.trackActionCol}>
                    <Pressable
                      style={StyleSheet.flatten([
                        styles.favIconBtn,
                        isFav ? styles.favIconBtnActive : undefined,
                      ])}
                      onPress={() => {
                        handleToggleFavorite(t.id);
                      }}
                    >
                      <Text
                        style={StyleSheet.flatten([
                          styles.favIconBtnText,
                          isFav ? styles.favIconBtnTextActive : undefined,
                        ])}
                      >
                        {isFav ? "♥" : "♡"}
                      </Text>
                    </Pressable>
                    <Pressable
                      style={styles.playIconBtn}
                      onPress={() => {
                        void handlePlayTrack(t, idx);
                      }}
                    >
                      <Text style={styles.playIconBtnText}>
                        {isActive && !isPaused ? "⏸" : "▶"}
                      </Text>
                    </Pressable>
                  </View>
                </View>
              );
            })}
          </ScrollView>
        )}

        {activeTab === "playlists" && (
          <View style={styles.playlistsContainer}>
            <View style={styles.playlistsSidebar}>
              <Text style={styles.sectionHeading}>Playlists</Text>
              <ScrollView style={{ marginTop: 10 }}>
                {playlists.map((pl) => {
                  const isSelected = selectedPlaylist?.id === pl.id;
                  return (
                    <Pressable
                      key={pl.id}
                      style={StyleSheet.flatten([
                        styles.playlistItem,
                        isSelected ? styles.playlistItemActive : undefined,
                      ])}
                      onPress={() => {
                        setSelectedPlaylistId(pl.id);
                      }}
                    >
                      <Text
                        style={StyleSheet.flatten([
                          styles.playlistItemName,
                          isSelected ? styles.playlistItemNameActive : undefined,
                        ])}
                      >
                        {pl.name}
                      </Text>
                      <Text style={styles.playlistItemCount}>
                        {String(pl.trackIds.length)} tracks
                      </Text>
                    </Pressable>
                  );
                })}
              </ScrollView>

              <Pressable
                style={styles.newPlaylistCard}
                onPress={() => {
                  handleCreatePlaylist();
                }}
              >
                <Text style={styles.newPlaylistBtnText}>+ New Playlist</Text>
              </Pressable>
            </View>

            <View style={styles.playlistMain}>
              <View style={styles.sectionHeadingRow}>
                <Text style={styles.sectionHeading}>
                  {selectedPlaylist?.name ?? "Playlist"}
                </Text>
                <Text style={styles.sectionSubtext}>
                  {String(selectedPlaylistTracks.length)} song(s)
                </Text>
              </View>

              <ScrollView>
                {selectedPlaylistTracks.map((t, idx) => {
                  const isActive = isPlaying && currentTrack?.id === t.id;
                  return (
                    <View
                      key={t.id}
                      style={StyleSheet.flatten([
                        styles.trackRow,
                        isActive ? styles.trackRowActive : undefined,
                      ])}
                    >
                      <Text style={styles.trackIndexText}>{String(idx + 1)}</Text>
                      <View style={styles.trackTitleCol}>
                        <Text style={styles.trackTitleText}>{t.title}</Text>
                        <Text style={styles.trackArtistText}>{t.artist}</Text>
                      </View>
                      <View style={styles.trackFormatCol}>
                        <View style={styles.formatBadge}>
                          <Text style={styles.formatBadgeText}>{t.format}</Text>
                        </View>
                      </View>
                      <View style={styles.trackDurationCol}>
                        <Text style={styles.trackDurationText}>
                          {formatTime(t.durationSec)}
                        </Text>
                      </View>
                      <View style={styles.trackActionCol}>
                        <Pressable
                          style={styles.playIconBtn}
                          onPress={() => {
                            void handlePlayTrack(t, idx);
                          }}
                        >
                          <Text style={styles.playIconBtnText}>▶</Text>
                        </Pressable>
                      </View>
                    </View>
                  );
                })}
              </ScrollView>
            </View>
          </View>
        )}

        {activeTab === "now-playing" && (
          <View style={styles.nowPlayingContainer}>
            {/* Vinyl artwork card */}
            <View style={styles.albumCard}>
              <View style={styles.vinylDisc}>
                <View style={styles.vinylInnerDisc}>
                  <View style={styles.vinylCenterHole} />
                </View>
              </View>
            </View>

            {/* Track Info */}
            <View style={styles.trackMetaBlock}>
              <Text style={styles.nowPlayingTitle}>
                {currentTrack?.title ?? "No Track Selected"}
              </Text>
              <Text style={styles.nowPlayingArtist}>
                {currentTrack?.artist ?? "Unknown Artist"}
              </Text>
              <Text style={styles.nowPlayingAlbum}>
                {currentTrack?.album ?? "SevynOS Music"}
              </Text>
              {currentTrack && (
                <View style={styles.formatBadgeLarge}>
                  <Text style={styles.formatBadgeTextLarge}>
                    {currentTrack.format.toUpperCase()} · HIGH DEFINITION
                  </Text>
                </View>
              )}
            </View>

            {/* Scrubber Seek Bar */}
            <View style={styles.scrubberContainer}>
              <Pressable
                style={styles.scrubberTrack}
                onPress={() => {
                  void handleSeek(currentPositionSec + 30);
                }}
              >
                <View
                  style={StyleSheet.flatten([
                    styles.scrubberFill,
                    {
                      width: currentTrack
                        ? Math.floor(
                            (currentPositionSec / Math.max(1, currentTrack.durationSec)) *
                              360,
                          )
                        : 0,
                    },
                  ])}
                />
              </Pressable>
              <View style={styles.scrubberTimeRow}>
                <Text style={styles.scrubberTimeText}>
                  {formatTime(currentPositionSec)}
                </Text>
                <Text style={styles.scrubberTimeText}>
                  {formatTime(currentTrack?.durationSec ?? 0)}
                </Text>
              </View>
              <View style={styles.seekJumpRow}>
                <Pressable
                  style={styles.seekJumpBtn}
                  onPress={() => {
                    void handleSeek(currentPositionSec - 15);
                  }}
                >
                  <Text style={styles.seekJumpBtnText}>-15s</Text>
                </Pressable>
                <Pressable
                  style={styles.seekJumpBtn}
                  onPress={() => {
                    void handleSeek(currentPositionSec + 15);
                  }}
                >
                  <Text style={styles.seekJumpBtnText}>+15s</Text>
                </Pressable>
                <Pressable
                  style={styles.seekJumpBtn}
                  onPress={() => {
                    void handleSeek(currentPositionSec + 30);
                  }}
                >
                  <Text style={styles.seekJumpBtnText}>+30s</Text>
                </Pressable>
              </View>
            </View>

            {/* Transport controls */}
            <View style={styles.transportRow}>
              <Pressable
                style={StyleSheet.flatten([
                  styles.transportBtn,
                  isShuffled ? styles.transportBtnActive : undefined,
                ])}
                onPress={handleToggleShuffle}
              >
                <Text
                  style={StyleSheet.flatten([
                    styles.transportBtnText,
                    isShuffled ? { color: "#D7AC57" } : undefined,
                  ])}
                >
                  ⇄
                </Text>
              </Pressable>

              <Pressable
                style={styles.transportBtn}
                onPress={() => void handlePreviousTrack()}
              >
                <Text style={styles.transportBtnText}>⏮</Text>
              </Pressable>

              <Pressable
                style={styles.transportBtnPlayPause}
                onPress={() => void handleTogglePlayPause()}
              >
                <Text style={styles.transportBtnPlayPauseText}>
                  {isPlaying && !isPaused ? "⏸" : "▶"}
                </Text>
              </Pressable>

              <Pressable
                style={styles.transportBtn}
                onPress={() => void handleNextTrack()}
              >
                <Text style={styles.transportBtnText}>⏭</Text>
              </Pressable>

              <Pressable
                style={StyleSheet.flatten([
                  styles.transportBtn,
                  repeatMode !== "off" ? styles.transportBtnActive : undefined,
                ])}
                onPress={handleCycleRepeat}
              >
                <Text
                  style={StyleSheet.flatten([
                    styles.transportBtnText,
                    repeatMode !== "off" ? { color: "#D7AC57" } : undefined,
                  ])}
                >
                  {repeatMode === "one" ? "🔂" : "🔁"}
                </Text>
              </Pressable>
            </View>

            {/* Volume row */}
            <View style={styles.volumeRow}>
              <Pressable onPress={() => void handleToggleMute()}>
                <Text style={styles.volumeIcon}>
                  {isMuted || volume === 0 ? "🔇" : "🔊"}
                </Text>
              </Pressable>
              <Pressable
                style={styles.volumeTrack}
                onPress={() => {
                  void handleVolumeChange(volume === 100 ? 50 : 100);
                }}
              >
                <View
                  style={StyleSheet.flatten([
                    styles.volumeFill,
                    { width: isMuted ? 0 : Math.floor((volume / 100) * 180) },
                  ])}
                />
              </Pressable>
              <Text style={styles.volumePercentText}>
                {isMuted ? "0%" : `${String(volume)}%`}
              </Text>
            </View>
          </View>
        )}
      </View>

      {/* Persistent Mini Player at bottom (visible when browsing library or playlists) */}
      {activeTab !== "now-playing" && currentTrack && (
        <View style={styles.miniPlayer}>
          <View style={styles.miniPlayerLeft}>
            <View style={styles.miniAlbumArt}>
              <Text style={styles.miniAlbumArtIcon}>♪</Text>
            </View>
            <View style={styles.miniTrackInfo}>
              <Text style={styles.miniTrackTitle}>{currentTrack.title}</Text>
              <Text style={styles.miniTrackArtist}>
                {currentTrack.artist} · {formatTime(currentPositionSec)} /{" "}
                {formatTime(currentTrack.durationSec)}
              </Text>
            </View>
          </View>

          <View style={styles.miniPlayerCenter}>
            <Pressable
              style={styles.miniPlayPauseBtn}
              onPress={() => {
                void handleTogglePlayPause();
              }}
            >
              <Text style={styles.miniPlayPauseBtnText}>
                {isPlaying && !isPaused ? "⏸" : "▶"}
              </Text>
            </Pressable>
            <Pressable
              style={styles.miniSkipBtn}
              onPress={() => {
                void handleNextTrack();
              }}
            >
              <Text style={styles.miniSkipBtnText}>⏭</Text>
            </Pressable>
          </View>

          <View style={styles.miniPlayerRight}>
            <Pressable
              style={styles.expandBtn}
              onPress={() => {
                setActiveTab("now-playing");
              }}
            >
              <Text style={styles.expandBtnText}>Now Playing ↗</Text>
            </Pressable>
          </View>
        </View>
      )}
    </View>
  );
}
