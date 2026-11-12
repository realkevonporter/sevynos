// SevynOS v2 — the dock, macOS 27 "Golden Gate" Liquid Glass style.
//
// A floating, centered glass pill at the bottom of the screen — not a
// full-width bar. Translucent white over the dark desktop reads as
// frosted glass; a 1px edge ring, top highlight, and bottom shade give
// it the Liquid Glass edge. True backdrop blur is NOT possible here:
// the host painter only sees its own opaque XRGB surface (app windows
// are separate Wayland surfaces the compositor draws), so there is
// nothing behind the dock to blur — the glass is a tint over the
// desktop, and the PR says so plainly.
//
// Behaviour (macOS 27):
//   - icons shrink to fit the surface (no chevron scrolling);
//   - magnification on hover: the icon under the pointer grows to
//     1.6x with a smooth falloff over its neighbours;
//   - a white dot under each running app;
//   - icons come from /usr/share/sevyn/shell/icons/<id>.png (the icons
//     PR's contract), stacked over the monogram tile — a missing file
//     draws nothing, so the monogram shows. The icon PNGs carry their
//     own rounded corners (transparent corners); the Image op draws
//     them square.
//
// Pointer motion reaches the shell through the renderer's
// subscribePointerMove; magnification scales are quantized to 0.05
// steps and the dock only re-renders when the profile changes, so a
// pointer sweep costs a handful of presents, not one per motion event.
//
// No separator: macOS separates apps from Trash / minimized windows,
// but SevynOS has neither yet — when minimize lands, minimized
// windows go right of a separator in this pill.

import * as React from "react";
import { View, Text, Pressable, Image } from "./host";
import { type ShellApp } from "./apps";
import {
  subscribePointerMove,
  subscribeSurfaceSize,
  getSurfaceSizeSnapshot,
} from "../../rn/renderer/sevyn-renderer";

export interface DockProps {
  apps: ShellApp[];
  running: Set<string>;
  onLaunch(appId: string): void;
}

// --- geometry (pure; exercised by the shell e2e test) ---

export const DOCK_MAX_TILE = 64;
export const DOCK_MIN_TILE = 40;
export const DOCK_GAP = 8;
export const DOCK_PAD_X = 8;
export const DOCK_PAD_Y = 8;
export const DOCK_BOTTOM_MARGIN = 8;
export const DOCK_SIDE_MARGIN = 24;
export const DOCK_DOT = 6;
export const DOCK_DOT_GAP = 4;
export const DOCK_RADIUS = 24;
export const DOCK_MAX_SCALE = 1.6;
export const DOCK_FALLOFF_TILES = 2.2;
export const DOCK_SCALE_STEP = 0.05;

// Glass: the pill's #ffffff1f fill composites over the #0b0b0f
// desktop — but the edge ring is a slightly larger View BEHIND the
// pill, so its #ffffff14 fill paints under the pill too and tints
// the interior a second time. The interior therefore reads
// (57,57,59): ring 8% over #0b0b0f is (30,30,33), then fill 12%
// over that is (57,57,59). The ring edge alone reads (30,30,33);
// the top highlight white at 25% reads (106,106,108); the bottom
// shade black at 20% reads (45,45,47). (Measured from a real
// 1920x1080 frame; the m-checks assert the (57,57,59) interior.)
export const DOCK_GLASS = "#ffffff1f";
export const DOCK_GLASS_EDGE = "#ffffff14";
export const DOCK_GLASS_HIGHLIGHT = "#ffffff40";
export const DOCK_GLASS_SHADE = "#00000033";

export function iconPath(appId: string): string {
  return "/usr/share/sevyn/shell/icons/" + appId + ".png";
}

// Magnification falloff at a distance of d tile pitches from the
// pointer: 1 at the pointer, 0 past DOCK_FALLOFF_TILES, smoothstep
// between. Quantized so the dock only re-renders when a tile's scale
// bucket actually changes.
function scaleAtDistance(d: number): number {
  if (d >= DOCK_FALLOFF_TILES) return 1;
  const t = 1 - d / DOCK_FALLOFF_TILES;
  const f = t * t * (3 - 2 * t);
  const s = 1 + (DOCK_MAX_SCALE - 1) * f;
  return Math.round(s / DOCK_SCALE_STEP) * DOCK_SCALE_STEP;
}

// Worst-case total of the magnification scales: pointer centered on
// a middle tile. The falloff is pitch-normalized, so this sum depends
// only on the app count, not on the tile size.
function maxScaleSum(n: number): number {
  if (n <= 0) return 0;
  const mid = (n - 1) / 2;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += scaleAtDistance(Math.abs(i - mid));
  return sum;
}

// Resting tile size for n apps on a surface of width surfaceWidth: as
// large as possible up to DOCK_MAX_TILE, shrinking so the whole pill
// fits between the side margins — AND so a fully magnified dock still
// fits (macOS shrinks a crowded dock the same way; without the
// headroom the magnification cap would crush every hover to ~1.0).
export function restingTileSize(n: number, surfaceWidth: number): number {
  if (n <= 0) return DOCK_MAX_TILE;
  const cap = surfaceWidth - 2 * DOCK_SIDE_MARGIN;
  const fixed = 2 * DOCK_PAD_X + (n - 1) * DOCK_GAP;
  return Math.max(
    DOCK_MIN_TILE,
    Math.min(DOCK_MAX_TILE, Math.floor((cap - fixed) / maxScaleSum(n))),
  );
}

export function restingPillWidth(n: number, tile: number): number {
  if (n <= 0) return 2 * DOCK_PAD_X;
  return 2 * DOCK_PAD_X + n * tile + (n - 1) * DOCK_GAP;
}

export function restingPillHeight(tile: number): number {
  return 2 * DOCK_PAD_Y + tile + DOCK_DOT_GAP + DOCK_DOT;
}

// Magnification profile for pointer (x, y): per-tile scale, quantized.
// Resting geometry: the pill is centered, tiles sit on the pill's
// bottom padding with the running dot below. Outside the hover band
// (above the magnified growth, or horizontally clear of the pill) the
// profile is flat 1.0. The total magnified width is capped to the
// side margins by shrinking the excess uniformly.
export function magnificationProfile(
  x: number,
  y: number,
  n: number,
  tile: number,
  surfaceWidth: number,
  surfaceHeight: number,
): number[] {
  const flat = new Array<number>(n).fill(1);
  if (n <= 0) return flat;
  const pillW = restingPillWidth(n, tile);
  const pillH = restingPillHeight(tile);
  const pillX = (surfaceWidth - pillW) / 2;
  const pillTop = surfaceHeight - DOCK_BOTTOM_MARGIN - pillH;
  const maxGrowth = tile * (DOCK_MAX_SCALE - 1);
  const inBand =
    y >= pillTop - maxGrowth &&
    y <= surfaceHeight &&
    x >= pillX - tile &&
    x <= pillX + pillW + tile;
  if (!inBand) return flat;
  const pitch = tile + DOCK_GAP;
  const scales: number[] = [];
  for (let i = 0; i < n; i++) {
    const cx = pillX + DOCK_PAD_X + i * pitch + tile / 2;
    const d = Math.abs(x - cx) / pitch;
    scales.push(scaleAtDistance(d));
  }
  // Cap the magnified width to the side margins.
  const magW =
    2 * DOCK_PAD_X + scales.reduce((a, s) => a + tile * s, 0) + (n - 1) * DOCK_GAP;
  const cap = surfaceWidth - 2 * DOCK_SIDE_MARGIN;
  if (magW > cap) {
    const baseW = restingPillWidth(n, tile);
    const k = Math.max(0, (cap - baseW) / (magW - baseW));
    for (let i = 0; i < n; i++) {
      scales[i] =
        Math.round((1 + (scales[i] - 1) * k) / DOCK_SCALE_STEP) * DOCK_SCALE_STEP;
    }
  }
  return scales;
}

function sameProfile(a: number[] | null, b: number[]): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function Dock(props: DockProps): React.ReactElement {
  const size = React.useSyncExternalStore(subscribeSurfaceSize, getSurfaceSizeSnapshot);
  const surfaceWidth = size.width;
  const surfaceHeight = size.height;
  const n = props.apps.length;
  const tile = restingTileSize(n, surfaceWidth);

  const [profile, setProfile] = React.useState<number[] | null>(null);
  const profileRef = React.useRef<number[] | null>(null);
  const geomRef = React.useRef({ n, tile, surfaceWidth, surfaceHeight });
  geomRef.current = { n, tile, surfaceWidth, surfaceHeight };

  React.useEffect(() => {
    return subscribePointerMove((ev: { x: number; y: number }) => {
      const g = geomRef.current;
      const next = magnificationProfile(
        ev.x,
        ev.y,
        g.n,
        g.tile,
        g.surfaceWidth,
        g.surfaceHeight,
      );
      if (sameProfile(profileRef.current, next)) return false;
      profileRef.current = next;
      setProfile(next);
      return true;
    });
  }, []);

  const scales = profile && profile.length === n ? profile : new Array<number>(n).fill(1);

  return (
    <View
      style={{
        flexDirection: "row",
        justifyContent: "center",
        paddingBottom: DOCK_BOTTOM_MARGIN,
        // No background: the desktop shows through around the pill.
      }}
    >
      {/* Glass edge: a 1px ring behind the pill. */}
      <View
        style={{
          backgroundColor: DOCK_GLASS_EDGE,
          borderRadius: DOCK_RADIUS + 1,
          padding: 1,
        }}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "flex-end",
            backgroundColor: DOCK_GLASS,
            borderRadius: DOCK_RADIUS,
            paddingLeft: DOCK_PAD_X,
            paddingRight: DOCK_PAD_X,
            paddingTop: DOCK_PAD_Y,
            paddingBottom: DOCK_PAD_Y,
          }}
        >
          {props.apps.map((app, i) => {
            const ts = Math.round(tile * scales[i]);
            const radius = Math.max(8, Math.round(ts * 0.225));
            return (
              <View
                key={app.id}
                style={{
                  width: ts,
                  marginLeft: i === 0 ? 0 : DOCK_GAP,
                  flexDirection: "column",
                  alignItems: "center",
                }}
              >
                <Pressable
                  onPress={() => props.onLaunch(app.id)}
                  style={{
                    width: ts,
                    height: ts,
                    backgroundColor: app.color,
                    borderRadius: radius,
                    justifyContent: "center",
                    alignItems: "center",
                  }}
                >
                  <Text
                    style={{
                      fontSize: Math.max(16, Math.round(ts * 0.44)),
                      fontWeight: "bold",
                      color: "#ffffff",
                      textAlign: "center",
                    }}
                  >
                    {app.glyph}
                  </Text>
                  {/* Real icon over the monogram: a missing file
                      draws nothing, so the monogram shows. */}
                  <Image
                    source={iconPath(app.id)}
                    style={{
                      position: "absolute",
                      left: 0,
                      top: 0,
                      width: ts,
                      height: ts,
                    }}
                  />
                </Pressable>
                {/* The dot spacer keeps every column the same height
                    so tiles stay aligned whether or not the app is
                    running. */}
                <View
                  style={{
                    width: DOCK_DOT,
                    height: DOCK_DOT,
                    marginTop: DOCK_DOT_GAP,
                    borderRadius: DOCK_DOT / 2,
                    backgroundColor: props.running.has(app.id) ? "#ffffff" : "#00000000",
                  }}
                />
              </View>
            );
          })}
        </View>
        {/* Top highlight: a 1px strip whose rounded corners taper it
            to follow the pill's top curve (the painter's rounded-rect
            SDF cuts the strip where the edge curves away). */}
        <View
          style={{
            position: "absolute",
            left: 1,
            right: 1,
            top: 1,
            height: 1,
            backgroundColor: DOCK_GLASS_HIGHLIGHT,
            borderRadius: DOCK_RADIUS,
          }}
        />
        {/* Bottom shade, same shape, for depth. */}
        <View
          style={{
            position: "absolute",
            left: 1,
            right: 1,
            bottom: 1,
            height: 1,
            backgroundColor: DOCK_GLASS_SHADE,
            borderRadius: DOCK_RADIUS,
          }}
        />
      </View>
    </View>
  );
}
