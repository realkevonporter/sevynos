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
//   - no magnification: tiles stay flat at their resting size, even
//     under the pointer — the hover grow effect was removed;
//   - a white dot under each running app;
//   - icons come from /usr/share/sevyn/shell/icons/<id>.png (the icons
//     PR's contract), stacked over the monogram tile — a missing file
//     draws nothing, so the monogram shows. The icon PNGs carry their
//     own rounded corners (transparent corners); the Image op draws
//     them square.
//
// No separator: macOS separates apps from Trash / minimized windows,
// but SevynOS has neither yet — when minimize lands, minimized
// windows go right of a separator in this pill.

import * as React from "react";
import { View, Text, Pressable, Image } from "./host";
import { type ShellApp } from "./apps";
import {
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

// Resting tile size for n apps on a surface of width surfaceWidth: as
// large as possible up to DOCK_MAX_TILE, shrinking so the whole pill
// fits between the side margins. (Tiles never grow — there is no
// magnification — so no headroom is reserved for a magnified dock.)
export function restingTileSize(n: number, surfaceWidth: number): number {
  if (n <= 0) return DOCK_MAX_TILE;
  const cap = surfaceWidth - 2 * DOCK_SIDE_MARGIN;
  const fixed = 2 * DOCK_PAD_X + (n - 1) * DOCK_GAP;
  return Math.max(DOCK_MIN_TILE, Math.min(DOCK_MAX_TILE, Math.floor((cap - fixed) / n)));
}

export function restingPillWidth(n: number, tile: number): number {
  if (n <= 0) return 2 * DOCK_PAD_X;
  return 2 * DOCK_PAD_X + n * tile + (n - 1) * DOCK_GAP;
}

export function restingPillHeight(tile: number): number {
  return 2 * DOCK_PAD_Y + tile + DOCK_DOT_GAP + DOCK_DOT;
}

export function Dock(props: DockProps): React.ReactElement {
  const size = React.useSyncExternalStore(subscribeSurfaceSize, getSurfaceSizeSnapshot);
  const surfaceWidth = size.width;
  const n = props.apps.length;
  const tile = restingTileSize(n, surfaceWidth);

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
            const ts = tile;
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
