/**
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import { useEffect, useRef, useState, type JSX } from "react";
import { StyleSheet, Text, View } from "react-native";
import { SevynIcon } from "@sevynos/react-native";
import { SevynShellTheme } from "../theme.js";
import type { DesktopShellDisplay } from "../desktop.js";
import { computeFilledSegments } from "./volume-osd-math.js";

const OSD_WIDTH = 220;
const OSD_HEIGHT = 76;
const SEGMENTS = 16;

export interface VolumeOsdProps {
  /** Master volume, 0..100. */
  readonly volume: number;
  readonly muted: boolean;
  readonly label?: string | undefined;
}

/**
 * macOS-style volume on-screen display: a centered glass pill with a speaker
 * glyph, the level as text, and a segmented level bar. Purely presentational —
 * parents control when it is mounted/visible. No emoji; uses the shared
 * SevynIcon glyph set.
 */
export function VolumeOsd({
  volume,
  muted,
  label = "Volume",
}: VolumeOsdProps): JSX.Element {
  const clamped = Math.min(100, Math.max(0, Math.round(volume)));
  const filled = computeFilledSegments(volume, muted);
  return (
    <View
      accessibilityRole="alert"
      accessibilityLabel={
        muted ? `${label} muted` : `${label} ${String(clamped)} percent`
      }
      style={styles.osd}
    >
      <View style={styles.iconColumn}>
        <SevynIcon
          name={muted || clamped === 0 ? "x" : "volume"}
          size={30}
          color={SevynShellTheme.colors.primary}
        />
      </View>
      <View style={styles.meterColumn}>
        <Text style={styles.levelText}>{muted ? "Muted" : `${String(clamped)}%`}</Text>
        <View style={styles.segments} accessibilityElementsHidden={true}>
          {Array.from({ length: SEGMENTS }, (_, index) => (
            <View
              key={index}
              style={[
                styles.segment,
                index < filled ? styles.segmentFilled : styles.segmentEmpty,
              ]}
            />
          ))}
        </View>
      </View>
    </View>
  );
}

export interface VolumeOsdOverlayProps {
  readonly display: DesktopShellDisplay;
  /** Current master volume (0..100) as reported by the audio service. */
  readonly audioVolume?: number | undefined;
  readonly audioMuted?: boolean | undefined;
  readonly label?: string | undefined;
  readonly visibleDurationMs?: number | undefined;
}

/**
 * Self-managing OSD host: watches the audio level props and shows the OSD
 * briefly whenever the volume or mute state *changes* (any source — keyboard,
 * quick settings, Settings app). Centered on the given display.
 */
export function VolumeOsdOverlay({
  display,
  audioVolume,
  audioMuted,
  label,
  visibleDurationMs = 1600,
}: VolumeOsdOverlayProps): JSX.Element | null {
  const [visible, setVisible] = useState(false);
  const previous = useRef<{ volume: number | undefined; muted: boolean | undefined }>({
    volume: undefined,
    muted: undefined,
  });
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const prev = previous.current;
    previous.current = { volume: audioVolume, muted: audioMuted };
    // Don't flash on first mount — only on actual changes.
    if (prev.volume === undefined && prev.muted === undefined) return;
    if (prev.volume !== audioVolume || prev.muted !== audioMuted) {
      setVisible(true);
      if (hideTimer.current !== undefined) clearTimeout(hideTimer.current);
      hideTimer.current = setTimeout(() => {
        setVisible(false);
      }, visibleDurationMs);
    }
  }, [audioVolume, audioMuted, visibleDurationMs]);

  useEffect(
    () => () => {
      if (hideTimer.current !== undefined) clearTimeout(hideTimer.current);
    },
    [],
  );

  if (!visible) return null;
  return (
    <View
      style={[
        styles.overlay,
        {
          left: display.bounds.x + display.bounds.width / 2 - OSD_WIDTH / 2,
          top: display.bounds.y + display.bounds.height * 0.38 - OSD_HEIGHT / 2,
          width: OSD_WIDTH,
          height: OSD_HEIGHT,
        },
      ]}
      pointerEvents="none"
    >
      <VolumeOsd volume={audioVolume ?? 0} muted={audioMuted === true} label={label} />
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: "absolute",
  },
  osd: {
    width: OSD_WIDTH,
    height: OSD_HEIGHT,
    borderRadius: SevynShellTheme.radius.lg,
    backgroundColor: SevynShellTheme.colors.glassStrong,
    borderWidth: 1,
    borderColor: SevynShellTheme.colors.borderStrong,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: SevynShellTheme.spacing.md,
    gap: SevynShellTheme.spacing.sm,
    // Soft drop shadow for depth over wallpaper content.
    shadowColor: "#000000",
    shadowOpacity: 0.45,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 6 },
  },
  iconColumn: {
    width: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  meterColumn: {
    flex: 1,
    justifyContent: "center",
    gap: 8,
  },
  levelText: {
    color: SevynShellTheme.colors.primary,
    fontSize: SevynShellTheme.typography.title,
    fontWeight: "600",
  },
  segments: {
    flexDirection: "row",
    gap: 3,
  },
  segment: {
    flex: 1,
    height: 6,
    borderRadius: 3,
  },
  segmentFilled: {
    backgroundColor: SevynShellTheme.colors.gold,
  },
  segmentEmpty: {
    backgroundColor: "rgba(255, 255, 255, 0.18)",
  },
});
