import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import {
  NativeImage,
  NativeModules,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  sevynTokens,
  type CameraPreviewFrame,
  type CameraRecordResult,
  type CameraService,
  type CameraStatus,
  type CameraVideoPlaybackInfo,
  type MediaService,
  type MediaTrack,
  type SevynApplicationManifest,
  type SevynFileSystem,
} from "@sevynos/react-native";

export interface CameraBitmapSource {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
}

export const cameraManifest: SevynApplicationManifest = {
  manifestVersion: 1,
  id: "org.sevynos.camera",
  name: "Camera",
  version: "1.0.0",
  runtime: "react-native",
  applicationKey: "Camera",
  developer: "SevynOS",
  icon: "icons/camera.svg",
  entrypoint: "dist/index.js",
  minimumSevynOSVersion: "0.1.0",
  permissions: ["camera", "filesystem.read", "filesystem.write"],
  services: [],
  windowModes: ["standard"],
  instanceMode: "single",
};

export type CameraMode = "photo" | "video";

export interface CameraItem {
  readonly id: string;
  readonly type: "photo" | "video";
  readonly path: string;
  readonly timestamp: number;
  readonly durationMs?: number | undefined;
  readonly width?: number | undefined;
  readonly height?: number | undefined;
}

export interface CameraApplicationProps {
  readonly camera?: CameraService | undefined;
  readonly media?: MediaService | undefined;
  readonly filesystem?: SevynFileSystem | undefined;
  readonly permissions?:
    | {
        readonly has: (permission: string) => boolean;
        readonly request: (permission: string) => Promise<boolean>;
      }
    | undefined;
  readonly initialPermissionGranted?: boolean | undefined;
  readonly onCapture?: ((item: CameraItem) => void) | undefined;
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function formatTimestamp(timeMs: number): string {
  const date = new Date(timeMs);
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function resolveCamera(propsCamera?: CameraService): CameraService {
  if (propsCamera !== undefined) return propsCamera;
  const hw = (NativeModules as { HardwareModules?: { camera?: CameraService } })
    .HardwareModules;
  if (hw?.camera !== undefined) return hw.camera;
  return {
    status: () =>
      Promise.resolve({
        available: false,
        message: "No camera hardware detected.",
      }),
    capture: () => Promise.reject(new Error("No camera hardware detected.")),
    preview: () =>
      Promise.resolve({
        width: 640,
        height: 360,
        available: false,
        timestamp: Date.now(),
      }),
    recordStart: () => Promise.reject(new Error("No camera hardware detected.")),
    recordStop: () => Promise.reject(new Error("No camera hardware detected.")),
    playVideo: () =>
      Promise.reject(new Error("Video playback is not available on this device.")),
    videoFrame: () =>
      Promise.resolve({
        width: 0,
        height: 0,
        available: false,
      }),
    stopVideo: () => Promise.resolve(),
  };
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#090b11",
    padding: 16,
    justifyContent: "space-between",
  },
  permissionCenter: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  permissionCard: {
    width: 440,
    backgroundColor: "#141721",
    borderRadius: sevynTokens.radius.md,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.08)",
    padding: 24,
    alignItems: "center",
  },
  permissionIconBadge: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: "rgba(215, 172, 87, 0.12)",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 16,
  },
  permissionIconText: {
    fontSize: 28,
  },
  permissionTitle: {
    fontSize: 18,
    color: "#f0f2f8",
    marginBottom: 8,
    textAlign: "center",
  },
  permissionBody: {
    fontSize: 14,
    color: "#8b949e",
    textAlign: "center",
    lineHeight: 20,
    marginBottom: 24,
  },
  permissionButtonRow: {
    flexDirection: "row",
    gap: 12,
    width: "100%",
  },
  actionButton: {
    flex: 1,
    height: 40,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  primaryButton: {
    backgroundColor: "#D7AC57",
  },
  primaryButtonText: {
    color: "#090b11",
    fontSize: 14,
  },
  secondaryButton: {
    backgroundColor: "rgba(255, 255, 255, 0.06)",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.12)",
  },
  secondaryButtonText: {
    color: "#f0f2f8",
    fontSize: 14,
  },
  emptyCard: {
    width: 460,
    backgroundColor: "#141721",
    borderRadius: sevynTokens.radius.md,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.08)",
    padding: 32,
    alignItems: "center",
  },
  emptyIcon: {
    fontSize: 48,
    marginBottom: 16,
  },
  emptyTitle: {
    fontSize: 18,
    color: "#f0f2f8",
    marginBottom: 8,
    textAlign: "center",
  },
  emptyBody: {
    fontSize: 14,
    color: "#8b949e",
    textAlign: "center",
    lineHeight: 20,
  },
  topHud: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 12,
  },
  hudBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: "rgba(255, 255, 255, 0.08)",
  },
  hudBadgeText: {
    fontSize: 12,
    color: "#f0f2f8",
  },
  recordingBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: "rgba(239, 68, 68, 0.2)",
    borderWidth: 1,
    borderColor: "#ef4444",
  },
  recordingDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#ef4444",
  },
  recordingText: {
    fontSize: 12,
    color: "#ef4444",
  },
  modeSelector: {
    flexDirection: "row",
    backgroundColor: "rgba(255, 255, 255, 0.06)",
    borderRadius: 20,
    padding: 2,
  },
  modeTab: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 18,
  },
  modeTabActive: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 18,
    backgroundColor: "#D7AC57",
  },
  modeTabText: {
    fontSize: 12,
    color: "#8b949e",
  },
  modeTabTextActive: {
    fontSize: 12,
    color: "#090b11",
  },
  viewfinderContainer: {
    flex: 1,
    backgroundColor: "#0d1017",
    borderRadius: sevynTokens.radius.md,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.08)",
    overflow: "hidden",
    position: "relative",
    justifyContent: "center",
    alignItems: "center",
  },
  viewfinderImage: {
    width: "100%",
    height: "100%",
  },
  viewfinderSimulated: {
    alignItems: "center",
    justifyContent: "center",
  },
  simulatedGlyph: {
    fontSize: 56,
    marginBottom: 12,
    opacity: 0.8,
  },
  simulatedText: {
    fontSize: 16,
    color: "#f0f2f8",
    marginBottom: 4,
  },
  simulatedSubtext: {
    fontSize: 13,
    color: "#8b949e",
  },
  centerReticle: {
    position: "absolute",
    width: 96,
    height: 96,
  },
  reticleCornerTL: {
    position: "absolute",
    top: 0,
    left: 0,
    width: 16,
    height: 16,
    borderTopWidth: 2,
    borderLeftWidth: 2,
    borderColor: "rgba(215, 172, 87, 0.6)",
  },
  reticleCornerTR: {
    position: "absolute",
    top: 0,
    right: 0,
    width: 16,
    height: 16,
    borderTopWidth: 2,
    borderRightWidth: 2,
    borderColor: "rgba(215, 172, 87, 0.6)",
  },
  reticleCornerBL: {
    position: "absolute",
    bottom: 0,
    left: 0,
    width: 16,
    height: 16,
    borderBottomWidth: 2,
    borderLeftWidth: 2,
    borderColor: "rgba(215, 172, 87, 0.6)",
  },
  reticleCornerBR: {
    position: "absolute",
    bottom: 0,
    right: 0,
    width: 16,
    height: 16,
    borderBottomWidth: 2,
    borderRightWidth: 2,
    borderColor: "rgba(215, 172, 87, 0.6)",
  },
  shutterFlashOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "#ffffff",
    opacity: 0.85,
  },
  bottomControls: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 16,
    paddingHorizontal: 8,
  },
  galleryButton: {
    width: 52,
    height: 52,
    borderRadius: 12,
    backgroundColor: "rgba(255, 255, 255, 0.06)",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.12)",
    alignItems: "center",
    justifyContent: "center",
  },
  galleryPreviewThumb: {
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
    width: "100%",
    height: "100%",
  },
  galleryEmptyThumb: {
    alignItems: "center",
    justifyContent: "center",
  },
  galleryThumbIcon: {
    fontSize: 22,
  },
  galleryCountBadge: {
    position: "absolute",
    top: -4,
    right: -4,
    backgroundColor: "#D7AC57",
    borderRadius: 9,
    width: 18,
    height: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  galleryCountText: {
    fontSize: 10,
    color: "#090b11",
  },
  shutterContainer: {
    alignItems: "center",
    justifyContent: "center",
  },
  photoShutterOuter: {
    width: 68,
    height: 68,
    borderRadius: 34,
    borderWidth: 4,
    borderColor: "#D7AC57",
    padding: 3,
    alignItems: "center",
    justifyContent: "center",
  },
  photoShutterInner: {
    width: 54,
    height: 54,
    borderRadius: 27,
    backgroundColor: "#D7AC57",
  },
  videoShutterOuter: {
    width: 68,
    height: 68,
    borderRadius: 34,
    borderWidth: 4,
    borderColor: "#ef4444",
    padding: 3,
    alignItems: "center",
    justifyContent: "center",
  },
  videoShutterOuterRecording: {
    width: 68,
    height: 68,
    borderRadius: 34,
    borderWidth: 4,
    borderColor: "#f87171",
    padding: 3,
    alignItems: "center",
    justifyContent: "center",
  },
  videoShutterInner: {
    width: 54,
    height: 54,
    borderRadius: 27,
    backgroundColor: "#ef4444",
  },
  videoShutterInnerRecording: {
    width: 28,
    height: 28,
    borderRadius: 6,
    backgroundColor: "#ef4444",
  },
  statusIndicator: {
    width: 60,
    alignItems: "flex-end",
  },
  statusCountText: {
    fontSize: 12,
    color: "#8b949e",
  },
  modalBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0, 0, 0, 0.75)",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    zIndex: 100,
  },
  galleryModal: {
    width: 520,
    maxHeight: 520,
    backgroundColor: "#141721",
    borderRadius: sevynTokens.radius.md,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.1)",
    padding: 20,
  },
  galleryHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 16,
  },
  galleryTitle: {
    fontSize: 18,
    color: "#f0f2f8",
  },
  closeButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: "rgba(255, 255, 255, 0.08)",
    alignItems: "center",
    justifyContent: "center",
  },
  closeButtonText: {
    color: "#f0f2f8",
    fontSize: 14,
  },
  emptyGallery: {
    padding: 32,
    alignItems: "center",
  },
  emptyGalleryText: {
    color: "#8b949e",
    fontSize: 14,
  },
  galleryList: {
    maxHeight: 380,
  },
  galleryItemRow: {
    flexDirection: "row",
    alignItems: "center",
    padding: 12,
    borderRadius: 8,
    backgroundColor: "rgba(255, 255, 255, 0.03)",
    marginBottom: 8,
    gap: 12,
  },
  galleryItemIconContainer: {
    width: 44,
    height: 44,
    borderRadius: 8,
    backgroundColor: "rgba(255, 255, 255, 0.06)",
    alignItems: "center",
    justifyContent: "center",
  },
  galleryItemIcon: {
    fontSize: 22,
  },
  galleryItemMeta: {
    flex: 1,
  },
  galleryItemTitle: {
    fontSize: 14,
    color: "#f0f2f8",
  },
  galleryItemSubtitle: {
    fontSize: 12,
    color: "#8b949e",
    marginTop: 2,
  },
  galleryItemPath: {
    fontSize: 11,
    color: "#6b7280",
    marginTop: 2,
  },
  deleteButton: {
    padding: 8,
  },
  deleteButtonText: {
    fontSize: 16,
  },
  viewerModal: {
    width: 580,
    backgroundColor: "#141721",
    borderRadius: sevynTokens.radius.md,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.1)",
    padding: 20,
  },
  viewerHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 16,
  },
  viewerTitle: {
    fontSize: 18,
    color: "#f0f2f8",
  },
  viewerBody: {
    gap: 16,
  },
  videoPlayerContainer: {
    gap: 12,
  },
  videoCanvas: {
    height: 220,
    backgroundColor: "#0d1017",
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.06)",
    gap: 8,
  },
  videoCanvasIcon: {
    fontSize: 44,
  },
  videoCanvasState: {
    fontSize: 15,
    color: "#f0f2f8",
  },
  videoCanvasTimer: {
    fontSize: 13,
    color: "#8b949e",
  },
  videoErrorBadge: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: "rgba(239, 68, 68, 0.12)",
    borderWidth: 1,
    borderColor: "rgba(239, 68, 68, 0.4)",
    alignItems: "center",
    justifyContent: "center",
  },
  videoErrorBadgeText: {
    fontSize: 24,
    color: "#EF4444",
    fontWeight: "700",
  },
  videoProgressRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  videoTimeText: {
    fontSize: 12,
    color: "#8b949e",
    width: 44,
    textAlign: "center",
  },
  videoProgressTrack: {
    flex: 1,
    height: 6,
    borderRadius: 3,
    backgroundColor: "rgba(255, 255, 255, 0.1)",
    overflow: "hidden",
  },
  videoProgressFill: {
    height: 6,
    backgroundColor: "#D7AC57",
  },
  videoTransportRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
  },
  videoTransportBtn: {
    minWidth: 64,
    height: 40,
    borderRadius: 8,
    backgroundColor: "rgba(255, 255, 255, 0.06)",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.12)",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 12,
  },
  videoTransportBtnText: {
    fontSize: 14,
    color: "#f0f2f8",
    fontWeight: "600",
  },
  videoTransportBtnPrimary: {
    minWidth: 96,
    height: 48,
    borderRadius: 24,
    backgroundColor: "#D7AC57",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  videoTransportBtnPrimaryText: {
    fontSize: 15,
    fontWeight: "700",
    color: "#090b11",
  },
  videoReplayBtn: {
    alignSelf: "center",
    paddingHorizontal: 20,
    height: 40,
    borderRadius: 8,
    backgroundColor: "rgba(215, 172, 87, 0.12)",
    borderWidth: 1,
    borderColor: "rgba(215, 172, 87, 0.4)",
    alignItems: "center",
    justifyContent: "center",
  },
  videoReplayBtnText: {
    fontSize: 14,
    color: "#D7AC57",
    fontWeight: "600",
  },
  scrubberTrack: {
    width: 360,
    height: 6,
    borderRadius: 3,
    backgroundColor: "rgba(255, 255, 255, 0.1)",
    overflow: "hidden",
    alignSelf: "center",
  },
  scrubberProgress: {
    height: 6,
    backgroundColor: "#D7AC57",
  },
  playerControlsRow: {
    flexDirection: "row",
    gap: 12,
  },
  photoViewerContainer: {
    alignItems: "center",
  },
  photoViewerImage: {
    width: "100%",
    height: 220,
    borderRadius: 8,
  },
  photoCanvas: {
    width: "100%",
    height: 220,
    backgroundColor: "#0d1017",
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.06)",
    gap: 8,
  },
  photoCanvasIcon: {
    fontSize: 48,
  },
  photoCanvasText: {
    fontSize: 14,
    color: "#8b949e",
  },
  mediaMetadata: {
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: "rgba(255, 255, 255, 0.08)",
    gap: 4,
  },
  metadataText: {
    fontSize: 12,
    color: "#8b949e",
  },
  errorBanner: {
    backgroundColor: "rgba(239, 68, 68, 0.12)",
    borderWidth: 1,
    borderColor: "rgba(239, 68, 68, 0.45)",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginBottom: 10,
  },
  errorText: {
    color: "#fca5a5",
    fontSize: 12,
  },
});

export interface VideoPlayerProps {
  readonly item: CameraItem;
  readonly camera: CameraService;
  readonly media: MediaService | undefined;
  readonly onClose: () => void;
}

const VIDEO_FRAME_POLL_MS = 100;
const VIDEO_POSITION_POLL_MS = 250;

/** Awaits an optional native call, swallowing rejections and undefined. */
async function ignoreRejection(promise: Promise<unknown> | undefined): Promise<void> {
  try {
    await promise;
  } catch {
    // Best-effort teardown/audio calls must never break playback state.
  }
}

/**
 * Real video playback for recorded videos. Video frames are decoded natively
 * (ffmpeg, via `camera.playVideo`/`camera.videoFrame`/`camera.stopVideo`) and
 * rendered through the same RGBA bitmap path as the camera preview; the audio
 * track plays through the media service.
 */
export function VideoPlayer({
  item,
  camera,
  media,
  onClose,
}: VideoPlayerProps): JSX.Element {
  const [info, setInfo] = useState<CameraVideoPlaybackInfo | undefined>(undefined);
  const [frame, setFrame] = useState<CameraBitmapSource | undefined>(undefined);
  const [playing, setPlaying] = useState<boolean>(false);
  const [positionSec, setPositionSec] = useState<number>(0);
  const [error, setError] = useState<string | undefined>(undefined);
  const [ended, setEnded] = useState<boolean>(false);

  const sessionSeqRef = useRef(0);
  const lastFrameIndexRef = useRef(-1);
  const timingRef = useRef({ startPositionSec: 0, startWallMs: 0 });
  const durationSec = info?.durationSec ?? 0;

  const startPlayback = useCallback(
    async (fromSec: number): Promise<void> => {
      const mySession = sessionSeqRef.current + 1;
      sessionSeqRef.current = mySession;
      setError(undefined);
      setEnded(false);
      lastFrameIndexRef.current = -1;
      try {
        if (!camera.playVideo) {
          throw new Error("Video playback is not supported on this device.");
        }
        await ignoreRejection(camera.stopVideo?.());
        const playback = await camera.playVideo(item.path, { startSec: fromSec });
        if (mySession !== sessionSeqRef.current) {
          await ignoreRejection(camera.stopVideo?.());
          return;
        }
        if (!playback.available) {
          throw new Error("This video could not be decoded for playback.");
        }
        setInfo(playback);
        timingRef.current = { startPositionSec: fromSec, startWallMs: Date.now() };
        setPositionSec(fromSec);
        setPlaying(true);
        if (media !== undefined) {
          try {
            const track: MediaTrack = {
              id: item.id,
              title: item.id,
              artist: "Camera",
              durationSec:
                playback.durationSec > 0
                  ? playback.durationSec
                  : Math.max(1, Math.round((item.durationMs ?? 0) / 1000)),
              path: item.path,
              format: "mp4",
            };
            await media.play({ path: item.path, track });
            if (mySession !== sessionSeqRef.current) {
              await ignoreRejection(media.stop());
              return;
            }
            if (fromSec > 0.5) {
              await ignoreRejection(media.seek(fromSec));
            }
          } catch {
            // Audio is best-effort; video continues without sound.
          }
        }
      } catch (err) {
        if (mySession !== sessionSeqRef.current) return;
        setPlaying(false);
        setError(err instanceof Error ? err.message : "Video playback failed.");
      }
    },
    [camera, item.id, item.path, item.durationMs, media],
  );

  // Start playback when the player opens; tear down on unmount.
  useEffect(() => {
    void startPlayback(0);
    return () => {
      sessionSeqRef.current += 1;
      void ignoreRejection(camera.stopVideo?.());
      void ignoreRejection(media?.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll decoded frames while playing.
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const videoFrame = await camera.videoFrame?.();
          if (!videoFrame) return;
          if (videoFrame.ended === true) {
            const mySession = sessionSeqRef.current + 1;
            sessionSeqRef.current = mySession;
            setPlaying(false);
            setEnded(true);
            setPositionSec(durationSec > 0 ? durationSec : positionSec);
            await ignoreRejection(camera.stopVideo?.());
            await ignoreRejection(media?.stop());
            return;
          }
          const frameIndex = videoFrame.frameIndex ?? 0;
          if (
            videoFrame.available !== false &&
            videoFrame.pixels &&
            frameIndex !== lastFrameIndexRef.current
          ) {
            lastFrameIndexRef.current = frameIndex;
            setFrame({
              width: videoFrame.width,
              height: videoFrame.height,
              pixels: videoFrame.pixels,
            });
          }
        } catch {
          // Transient frame fetch failure; the next poll retries.
        }
      })();
    }, VIDEO_FRAME_POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [playing, camera, media, durationSec, positionSec]);

  // Track playback position while playing.
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => {
      const { startPositionSec, startWallMs } = timingRef.current;
      setPositionSec(startPositionSec + (Date.now() - startWallMs) / 1000);
    }, VIDEO_POSITION_POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [playing]);

  const togglePlayPause = useCallback(() => {
    if (playing) {
      const { startPositionSec, startWallMs } = timingRef.current;
      const frozen = startPositionSec + (Date.now() - startWallMs) / 1000;
      sessionSeqRef.current += 1;
      setPlaying(false);
      setPositionSec(frozen);
      timingRef.current = { startPositionSec: frozen, startWallMs: Date.now() };
      void ignoreRejection(camera.stopVideo?.());
      void ignoreRejection(media?.pause());
    } else if (!ended) {
      const { startPositionSec } = timingRef.current;
      void (async () => {
        try {
          if (!camera.playVideo) {
            throw new Error("Video playback is not supported on this device.");
          }
          const mySession = sessionSeqRef.current + 1;
          sessionSeqRef.current = mySession;
          const playback = await camera.playVideo(item.path, {
            startSec: startPositionSec,
          });
          if (mySession !== sessionSeqRef.current) {
            await ignoreRejection(camera.stopVideo?.());
            return;
          }
          if (playback.available) {
            timingRef.current = {
              startPositionSec,
              startWallMs: Date.now(),
            };
            setPlaying(true);
            await ignoreRejection(media?.resume());
          }
        } catch (err) {
          setError(err instanceof Error ? err.message : "Could not resume playback.");
        }
      })();
    }
  }, [playing, ended, camera, media, item.path]);

  const seekBy = useCallback(
    (deltaSec: number) => {
      const target = Math.max(
        0,
        Math.min(
          durationSec > 0 ? durationSec : Number.POSITIVE_INFINITY,
          positionSec + deltaSec,
        ),
      );
      void startPlayback(target);
    },
    [durationSec, positionSec, startPlayback],
  );

  const progressPct =
    durationSec > 0 ? Math.min(100, Math.max(0, (positionSec / durationSec) * 100)) : 0;
  const progressWidth: `${number}%` = `${Math.round(progressPct)}%`;

  return (
    <View style={styles.videoPlayerContainer}>
      {frame !== undefined ? (
        <NativeImage
          key={`video-playback-${item.id}`}
          style={styles.photoViewerImage}
          source={frame}
        />
      ) : error !== undefined ? (
        <View style={styles.videoCanvas}>
          <View style={styles.videoErrorBadge}>
            <Text style={styles.videoErrorBadgeText}>!</Text>
          </View>
          <Text style={styles.videoCanvasState}>{error}</Text>
        </View>
      ) : (
        <View style={styles.videoCanvas}>
          <Text style={styles.videoCanvasState}>Loading video…</Text>
        </View>
      )}

      <View style={styles.videoProgressRow}>
        <Text style={styles.videoTimeText}>
          {formatDuration(Math.floor(positionSec))}
        </Text>
        <View style={styles.videoProgressTrack}>
          <View
            style={StyleSheet.flatten([
              styles.videoProgressFill,
              { width: progressWidth },
            ])}
          />
        </View>
        <Text style={styles.videoTimeText}>
          {formatDuration(Math.floor(durationSec))}
        </Text>
      </View>

      <View style={styles.videoTransportRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back 10 seconds"
          style={styles.videoTransportBtn}
          onPress={() => {
            seekBy(-10);
          }}
        >
          <Text style={styles.videoTransportBtnText}>-10s</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={playing ? "Pause video" : "Play video"}
          style={styles.videoTransportBtnPrimary}
          onPress={togglePlayPause}
        >
          <Text style={styles.videoTransportBtnPrimaryText}>
            {playing ? "Pause" : "Play"}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Forward 10 seconds"
          style={styles.videoTransportBtn}
          onPress={() => {
            seekBy(10);
          }}
        >
          <Text style={styles.videoTransportBtnText}>+10s</Text>
        </Pressable>
      </View>

      {ended && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Replay video"
          style={styles.videoReplayBtn}
          onPress={() => {
            void startPlayback(0);
          }}
        >
          <Text style={styles.videoReplayBtnText}>Replay</Text>
        </Pressable>
      )}

      {error !== undefined && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close video player"
          style={styles.videoReplayBtn}
          onPress={onClose}
        >
          <Text style={styles.videoReplayBtnText}>Close</Text>
        </Pressable>
      )}
    </View>
  );
}

export function CameraApplication(props: CameraApplicationProps): JSX.Element {
  const camera = resolveCamera(props.camera);
  const media: MediaService | undefined =
    props.media ??
    (NativeModules.HardwareModules.media as unknown as MediaService | undefined);
  const [permissionGranted, setPermissionGranted] = useState<boolean>(
    () => props.initialPermissionGranted ?? props.permissions?.has("camera") ?? true,
  );
  const [permissionPromptVisible, setPermissionPromptVisible] = useState<boolean>(
    () => !(props.initialPermissionGranted ?? props.permissions?.has("camera") ?? true),
  );
  const [hardwareStatus, setHardwareStatus] = useState<CameraStatus | undefined>(
    undefined,
  );
  const [loadingHardware, setLoadingHardware] = useState<boolean>(true);
  const [mode, setMode] = useState<CameraMode>("photo");
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [recordingSeconds, setRecordingSeconds] = useState<number>(0);
  const [previewFrame, setPreviewFrame] = useState<CameraPreviewFrame | undefined>(
    undefined,
  );
  const [captures, setCaptures] = useState<readonly CameraItem[]>([]);
  const [selectedCapture, setSelectedCapture] = useState<CameraItem | undefined>(
    undefined,
  );

  // Load persisted photos/videos from disk on launch.
  useEffect(() => {
    const filesystem = props.filesystem;
    if (!filesystem) return;
    void (async () => {
      try {
        const items: CameraItem[] = [];
        // Photos are stored in <root>/photos, videos in <root>/videos
        // The filesystem root is the app's data directory.
        for (const dir of ["photos", "videos"]) {
          try {
            const entries = await filesystem.list(dir);
            for (const entry of entries) {
              const isVideo = dir === "videos";
              const name = entry.name.toLowerCase();
              if (isVideo && !name.endsWith(".mp4")) continue;
              if (!isVideo && !name.endsWith(".jpg") && !name.endsWith(".jpeg")) continue;
              items.push({
                id: `${dir}-${entry.name}`,
                type: isVideo ? "video" : "photo",
                path: entry.path,
                timestamp: entry.modified ?? Date.now(),
              });
            }
          } catch {
            // Directory may not exist yet; skip.
          }
        }
        // Sort by timestamp, newest first.
        items.sort((a, b) => b.timestamp - a.timestamp);
        setCaptures(items);
      } catch {
        // Gallery stays empty if we can't list.
      }
    })();
  }, [props.filesystem]);
  const [galleryOpen, setGalleryOpen] = useState<boolean>(false);
  const [shutterFlash, setShutterFlash] = useState<boolean>(false);
  const [photoBitmap, setPhotoBitmap] = useState<CameraBitmapSource | undefined>(
    undefined,
  );
  const [photoLoadError, setPhotoLoadError] = useState<string | undefined>(undefined);

  // Load the real JPEG when a photo is selected in the viewer.
  // Videos render through the VideoPlayer (native frame decode); the viewer
  // only needs a thumbnail for photos.
  useEffect(() => {
    if (selectedCapture?.type !== "photo") {
      setPhotoBitmap(undefined);
      setPhotoLoadError(undefined);
      return;
    }
    setPhotoBitmap(undefined);
    setPhotoLoadError(undefined);
    void (async () => {
      try {
        const camera = props.camera ?? NativeModules.HardwareModules.camera;
        if (!camera.readImage) {
          throw new Error("Image reading is not available.");
        }
        const frame = (await camera.readImage(selectedCapture.path)) as
          CameraPreviewFrame | undefined;
        if (!frame?.available || !frame.pixels) {
          throw new Error(
            selectedCapture.type === "video"
              ? "Could not load the video thumbnail."
              : "Could not load the photo.",
          );
        }
        setPhotoBitmap({
          width: frame.width,
          height: frame.height,
          pixels: frame.pixels,
        });
      } catch (error: unknown) {
        setPhotoLoadError(
          error instanceof Error ? error.message : "Could not load the media.",
        );
      }
    })();
  }, [selectedCapture, props.camera]);
  const [operationError, setOperationError] = useState<string | undefined>(undefined);

  const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const previewTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const checkHardware = useCallback(async (): Promise<void> => {
    setLoadingHardware(true);
    try {
      if (camera.status !== undefined) {
        const status = await camera.status();
        setHardwareStatus(status);
      } else {
        setHardwareStatus({ available: true });
      }
    } catch (error: unknown) {
      setHardwareStatus({
        available: false,
        message:
          error instanceof Error
            ? error.message
            : "Unable to query camera device status.",
      });
    } finally {
      setLoadingHardware(false);
    }
  }, [camera]);

  useEffect(() => {
    if (permissionGranted) {
      void checkHardware();
    }
  }, [permissionGranted, checkHardware]);

  // Live preview polling — paused while recording (v4l2 device is held by recorder).
  useEffect(() => {
    if (!permissionGranted || hardwareStatus?.available === false) return;
    if (isRecording) return;
    const fetchPreview = async (): Promise<void> => {
      try {
        if (camera.preview !== undefined) {
          const frame = await camera.preview();
          setPreviewFrame(frame);
          // Clear any stale error on success.
          setOperationError(undefined);
        }
      } catch {
        // Don't set a permanent error for transient preview failures;
        // the viewfinder will show the last good frame.
      }
    };
    void fetchPreview();
    previewTimerRef.current = setInterval(() => {
      void fetchPreview();
    }, 1000);
    return () => {
      if (previewTimerRef.current !== null) {
        clearInterval(previewTimerRef.current);
        previewTimerRef.current = null;
      }
    };
  }, [permissionGranted, hardwareStatus, camera, isRecording]);

  // Video recording timer
  useEffect(() => {
    if (isRecording) {
      setRecordingSeconds(0);
      recordingTimerRef.current = setInterval(() => {
        setRecordingSeconds((prev) => prev + 1);
      }, 1000);
    } else {
      if (recordingTimerRef.current !== null) {
        clearInterval(recordingTimerRef.current);
        recordingTimerRef.current = null;
      }
    }
    return () => {
      if (recordingTimerRef.current !== null) {
        clearInterval(recordingTimerRef.current);
        recordingTimerRef.current = null;
      }
    };
  }, [isRecording]);

  const handleGrantPermission = async (): Promise<void> => {
    if (props.permissions !== undefined) {
      const granted = await props.permissions.request("camera");
      if (granted) {
        setPermissionGranted(true);
        setPermissionPromptVisible(false);
      }
    } else {
      setPermissionGranted(true);
      setPermissionPromptVisible(false);
    }
  };

  const handleDenyPermission = (): void => {
    setPermissionGranted(false);
    setPermissionPromptVisible(false);
  };

  const handleCapturePhoto = async (): Promise<void> => {
    setOperationError(undefined);
    setShutterFlash(true);
    setTimeout(() => {
      setShutterFlash(false);
    }, 150);

    try {
      const res = await camera.capture();
      const path = typeof res === "string" ? res : res.path;
      const width = typeof res === "object" ? res.width : 1280;
      const height = typeof res === "object" ? res.height : 720;
      const newItem: CameraItem = {
        id: `photo-${String(Date.now())}`,
        type: "photo",
        path,
        timestamp: Date.now(),
        ...(width !== undefined ? { width } : {}),
        ...(height !== undefined ? { height } : {}),
      };
      setCaptures((prev) => [newItem, ...prev]);
      props.onCapture?.(newItem);
    } catch (error: unknown) {
      setOperationError(error instanceof Error ? error.message : "Photo capture failed.");
    }
  };

  const handleToggleRecord = async (): Promise<void> => {
    if (!isRecording) {
      setOperationError(undefined);
      try {
        if (camera.recordStart !== undefined) {
          await camera.recordStart();
        }
        setIsRecording(true);
      } catch (error: unknown) {
        setOperationError(
          error instanceof Error ? error.message : "Video recording could not start.",
        );
      }
    } else {
      try {
        let result: CameraRecordResult = {
          path: `/var/lib/sevynos/videos/video-${String(Date.now())}.mp4`,
          durationMs: recordingSeconds * 1000,
          format: "video/mp4",
          timestamp: Date.now(),
        };
        if (camera.recordStop !== undefined) {
          result = await camera.recordStop();
        }
        setIsRecording(false);
        const newItem: CameraItem = {
          id: `video-${String(Date.now())}`,
          type: "video",
          path: result.path,
          timestamp: result.timestamp ?? Date.now(),
          durationMs: result.durationMs ?? recordingSeconds * 1000,
          width: 1280,
          height: 720,
        };
        setCaptures((prev) => [newItem, ...prev]);
        props.onCapture?.(newItem);
      } catch (error: unknown) {
        setIsRecording(false);
        setOperationError(
          error instanceof Error ? error.message : "Video recording could not stop.",
        );
      }
    }
  };

  const handleDeleteCapture = (id: string): void => {
    setCaptures((prev) => prev.filter((c) => c.id !== id));
    if (selectedCapture?.id === id) {
      setSelectedCapture(undefined);
    }
  };

  // 1. Permission Prompt UI
  if (permissionPromptVisible) {
    return (
      <View style={styles.container}>
        <View style={styles.permissionCenter}>
          <View style={styles.permissionCard}>
            <View style={styles.permissionIconBadge}>
              <Text style={styles.permissionIconText}>📷</Text>
            </View>
            <Text style={styles.permissionTitle}>Camera Access Required</Text>
            <Text style={styles.permissionBody}>
              SevynOS Camera needs your permission to access connected camera devices for
              taking photos and recording video.
            </Text>
            <View style={styles.permissionButtonRow}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Grant camera access"
                style={StyleSheet.flatten([styles.actionButton, styles.primaryButton])}
                onPress={() => {
                  void handleGrantPermission();
                }}
              >
                <Text style={styles.primaryButtonText}>Grant Access</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Deny camera access"
                style={StyleSheet.flatten([styles.actionButton, styles.secondaryButton])}
                onPress={handleDenyPermission}
              >
                <Text style={styles.secondaryButtonText}>Deny</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </View>
    );
  }

  // 2. Permission Denied State
  if (!permissionGranted) {
    return (
      <View style={styles.container}>
        <View style={styles.permissionCenter}>
          <View style={styles.emptyCard}>
            <Text style={styles.emptyIcon}>🔒</Text>
            <Text style={styles.emptyTitle}>Camera Permission Denied</Text>
            <Text style={styles.emptyBody}>
              Access to the camera was denied. You can re-enable camera permissions in
              Settings → Applications.
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Request camera access again"
              style={StyleSheet.flatten([
                styles.actionButton,
                styles.primaryButton,
                { marginTop: 16 },
              ])}
              onPress={() => {
                setPermissionPromptVisible(true);
              }}
            >
              <Text style={styles.primaryButtonText}>Request Permission</Text>
            </Pressable>
          </View>
        </View>
      </View>
    );
  }

  // 3. Hardware Missing / Loading State
  if (loadingHardware) {
    return (
      <View style={styles.container}>
        <View style={styles.permissionCenter}>
          <View style={styles.emptyCard}>
            <Text style={styles.emptyTitle}>Detecting Camera Hardware...</Text>
            <Text style={styles.emptyBody}>
              Checking connected Video4Linux capture devices
            </Text>
          </View>
        </View>
      </View>
    );
  }

  if (hardwareStatus?.available === false) {
    return (
      <View style={styles.container}>
        <View style={styles.permissionCenter}>
          <View style={styles.emptyCard}>
            <Text style={styles.emptyIcon}>📷</Text>
            <Text style={styles.emptyTitle}>No Camera Detected</Text>
            <Text style={styles.emptyBody}>
              {hardwareStatus.message ??
                "Connect a USB webcam or verify hypervisor camera passthrough."}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Check for camera hardware again"
              style={StyleSheet.flatten([
                styles.actionButton,
                styles.primaryButton,
                { marginTop: 16 },
              ])}
              onPress={() => {
                void checkHardware();
              }}
            >
              <Text style={styles.primaryButtonText}>Check Again</Text>
            </Pressable>
          </View>
        </View>
      </View>
    );
  }

  // 4. Main Camera Viewfinder & Controls
  const bitmapSource: CameraBitmapSource | undefined =
    previewFrame?.pixels !== undefined
      ? {
          width: previewFrame.width,
          height: previewFrame.height,
          pixels: previewFrame.pixels,
        }
      : undefined;

  return (
    <View style={styles.container}>
      {operationError !== undefined && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>Camera error: {operationError}</Text>
        </View>
      )}
      {/* Top HUD Bar */}
      <View style={styles.topHud}>
        <View style={styles.hudBadge}>
          <Text style={styles.hudBadgeText}>1080p 30fps</Text>
        </View>

        {isRecording && (
          <View style={styles.recordingBadge}>
            <View style={styles.recordingDot} />
            <Text style={styles.recordingText}>
              REC {formatDuration(recordingSeconds)}
            </Text>
          </View>
        )}

        {/* Mode Selector Pill */}
        <View style={styles.modeSelector}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Switch to photo mode"
            disabled={isRecording}
            style={mode === "photo" ? styles.modeTabActive : styles.modeTab}
            onPress={() => {
              setMode("photo");
            }}
          >
            <Text
              style={mode === "photo" ? styles.modeTabTextActive : styles.modeTabText}
            >
              PHOTO
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Switch to video mode"
            disabled={isRecording}
            style={mode === "video" ? styles.modeTabActive : styles.modeTab}
            onPress={() => {
              setMode("video");
            }}
          >
            <Text
              style={mode === "video" ? styles.modeTabTextActive : styles.modeTabText}
            >
              VIDEO
            </Text>
          </Pressable>
        </View>
      </View>

      {/* Main Viewfinder Surface */}
      <View style={styles.viewfinderContainer}>
        {bitmapSource !== undefined ? (
          <NativeImage
            key="camera-viewfinder"
            style={styles.viewfinderImage}
            source={bitmapSource}
          />
        ) : (
          <View style={styles.viewfinderSimulated}>
            <Text style={styles.simulatedGlyph}>📷</Text>
            <Text style={styles.simulatedText}>SevynOS Live Viewfinder Active</Text>
            <Text style={styles.simulatedSubtext}>
              {mode === "photo"
                ? "Ready for Photo Capture"
                : isRecording
                  ? "Recording in progress..."
                  : "Ready for Video Recording"}
            </Text>
          </View>
        )}

        {/* Center reticle */}
        <View style={styles.centerReticle}>
          <View style={styles.reticleCornerTL} />
          <View style={styles.reticleCornerTR} />
          <View style={styles.reticleCornerBL} />
          <View style={styles.reticleCornerBR} />
        </View>

        {/* Shutter flash overlay */}
        {shutterFlash && <View style={styles.shutterFlashOverlay} />}
      </View>

      {/* Bottom Controls Bar */}
      <View style={styles.bottomControls}>
        {/* Left: Gallery Thumbnail */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open captures gallery"
          style={styles.galleryButton}
          onPress={() => {
            setGalleryOpen(true);
          }}
        >
          {captures.length > 0 ? (
            <View style={styles.galleryPreviewThumb}>
              <Text style={styles.galleryThumbIcon}>
                {captures[0]?.type === "video" ? "🎬" : "🖼️"}
              </Text>
              <View style={styles.galleryCountBadge}>
                <Text style={styles.galleryCountText}>{captures.length}</Text>
              </View>
            </View>
          ) : (
            <View style={styles.galleryEmptyThumb}>
              <Text style={styles.galleryThumbIcon}>🖼️</Text>
            </View>
          )}
        </Pressable>

        {/* Center: Shutter or Record Button */}
        <View style={styles.shutterContainer}>
          {mode === "photo" ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Take photo"
              style={styles.photoShutterOuter}
              onPress={() => {
                void handleCapturePhoto();
              }}
            >
              <View style={styles.photoShutterInner} />
            </Pressable>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={
                isRecording ? "Stop recording video" : "Start recording video"
              }
              style={
                isRecording ? styles.videoShutterOuterRecording : styles.videoShutterOuter
              }
              onPress={() => {
                void handleToggleRecord();
              }}
            >
              <View
                style={
                  isRecording
                    ? styles.videoShutterInnerRecording
                    : styles.videoShutterInner
                }
              />
            </Pressable>
          )}
        </View>

        {/* Right: Quick Capture Status */}
        <View style={styles.statusIndicator}>
          <Text style={styles.statusCountText}>
            {captures.length} {captures.length === 1 ? "item" : "items"}
          </Text>
        </View>
      </View>

      {/* 5. In-App Gallery Drawer / Modal */}
      {galleryOpen && (
        <View style={styles.modalBackdrop}>
          <View style={styles.galleryModal}>
            <View style={styles.galleryHeader}>
              <Text style={styles.galleryTitle}>Captures ({captures.length})</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close gallery"
                style={styles.closeButton}
                onPress={() => {
                  setGalleryOpen(false);
                }}
              >
                <Text style={styles.closeButtonText}>✕</Text>
              </Pressable>
            </View>

            {captures.length === 0 ? (
              <View style={styles.emptyGallery}>
                <Text style={styles.emptyGalleryText}>
                  No photos or videos captured yet.
                </Text>
              </View>
            ) : (
              <ScrollView style={styles.galleryList}>
                {captures.map((item) => (
                  <Pressable
                    key={item.id}
                    accessibilityRole="button"
                    accessibilityLabel={`View ${item.type} captured at ${formatTimestamp(item.timestamp)}`}
                    style={styles.galleryItemRow}
                    onPress={() => {
                      setSelectedCapture(item);
                    }}
                  >
                    <View style={styles.galleryItemIconContainer}>
                      <Text style={styles.galleryItemIcon}>
                        {item.type === "video" ? "🎬" : "🖼️"}
                      </Text>
                    </View>
                    <View style={styles.galleryItemMeta}>
                      <Text style={styles.galleryItemTitle}>
                        {item.type === "video" ? "Video Clip" : "Photo"}
                      </Text>
                      <Text style={styles.galleryItemSubtitle}>
                        {formatTimestamp(item.timestamp)}
                        {item.durationMs !== undefined &&
                          ` • ${formatDuration(Math.round(item.durationMs / 1000))}`}
                      </Text>
                      <Text style={styles.galleryItemPath}>{item.path}</Text>
                    </View>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Delete item"
                      style={styles.deleteButton}
                      onPress={() => {
                        handleDeleteCapture(item.id);
                      }}
                    >
                      <Text style={styles.deleteButtonText}>🗑️</Text>
                    </Pressable>
                  </Pressable>
                ))}
              </ScrollView>
            )}
          </View>
        </View>
      )}

      {/* 6. Media Viewer / Video Player Modal */}
      {selectedCapture !== undefined && (
        <View style={styles.modalBackdrop}>
          <View style={styles.viewerModal}>
            <View style={styles.viewerHeader}>
              <Text style={styles.viewerTitle}>
                {selectedCapture.type === "video" ? "Video Playback" : "Photo Viewer"}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close media viewer"
                style={styles.closeButton}
                onPress={() => {
                  setSelectedCapture(undefined);
                }}
              >
                <Text style={styles.closeButtonText}>✕</Text>
              </Pressable>
            </View>

            <View style={styles.viewerBody}>
              {selectedCapture.type === "video" ? (
                <VideoPlayer
                  key={`video-player-${selectedCapture.id}`}
                  item={selectedCapture}
                  camera={camera}
                  media={media}
                  onClose={() => {
                    setSelectedCapture(undefined);
                  }}
                />
              ) : (
                <View style={styles.photoViewerContainer}>
                  {photoBitmap !== undefined ? (
                    <NativeImage
                      key={`photo-${selectedCapture.id}`}
                      style={styles.photoViewerImage}
                      source={photoBitmap}
                    />
                  ) : photoLoadError !== undefined ? (
                    <View style={styles.photoCanvas}>
                      <Text style={styles.photoCanvasIcon}>⚠️</Text>
                      <Text style={styles.photoCanvasText}>{photoLoadError}</Text>
                    </View>
                  ) : (
                    <View style={styles.photoCanvas}>
                      <Text style={styles.photoCanvasIcon}>🖼️</Text>
                      <Text style={styles.photoCanvasText}>Loading photo…</Text>
                    </View>
                  )}
                </View>
              )}

              {/* Media details metadata */}
              <View style={styles.mediaMetadata}>
                <Text style={styles.metadataText}>File: {selectedCapture.path}</Text>
                <Text style={styles.metadataText}>
                  Captured: {new Date(selectedCapture.timestamp).toLocaleString()}
                </Text>
                {selectedCapture.durationMs !== undefined && (
                  <Text style={styles.metadataText}>
                    Duration:{" "}
                    {formatDuration(Math.round(selectedCapture.durationMs / 1000))}
                  </Text>
                )}
              </View>
            </View>
          </View>
        </View>
      )}
    </View>
  );
}
