// SevynOS v2 M3 — the dock.
//
// A horizontal ScrollView of app tiles. The dock never overflows: the
// tray clips to the viewport and scrolls (chevron buttons scroll by one
// tile). Chevrons only appear when the content is wider than the tray.
// Overflow is computed deterministically from the app count and the
// fixed 1024px surface — no measurement effect, so the chevrons are
// correct on the very first frame.
//
// At M3 sizes (80px tiles, 8px gaps) 12 apps need 1056px in a 1008px
// tray, so the chevrons are always up with the full app set — which is
// the point of the M2 check. Fewer apps fit and the chevrons hide.
//
// Tiles render from the apps prop (appd's list via the shell, or the
// built-in fallback). A white dot under a tile marks a running app.
//
// Icons (direction C): each tile renders its staged app icon
// (/usr/share/sevyn/shell/icons/<id>.png, 80x80) on top of the
// monogram glyph. The icon is opaque, so it covers the letter when
// present; when the file is absent the painter skips it and the
// monogram shows through — third-party apps keep working with no icon.

import * as React from "react";
import { View, Text, Image, Pressable, ScrollView } from "./host";
import { type ShellApp } from "./apps";
import { appIconPath, symbolPath } from "./icons";
import { scrollBy } from "../../rn/renderer/sevyn-renderer";

const SURFACE_WIDTH = 1024;
const DOCK_H_PADDING = 16;
const TILE = 80;
const GAP = 8;
const CHEVRON = 28;

export interface DockProps {
  apps: ShellApp[];
  running: Set<string>;
  onLaunch(appId: string): void;
}

export function Dock(props: DockProps): React.ReactElement {
  const trayRef = React.useRef<any>(null);

  const contentWidth = props.apps.length * (TILE + GAP);
  const trayWidth = SURFACE_WIDTH - DOCK_H_PADDING;
  const overflow = contentWidth > trayWidth;

  const scroll = (dir: number) => {
    const inst = trayRef.current;
    if (inst) scrollBy(inst, dir * (TILE + GAP), 0);
  };

  const chevronStyle = {
    width: CHEVRON,
    height: TILE,
    backgroundColor: "#1f2937",
    borderRadius: 8,
    justifyContent: "center",
    alignItems: "center",
  };

  return (
    <View
      style={{
        flexDirection: "row",
        height: 96,
        backgroundColor: "#101014",
        alignItems: "center",
        paddingLeft: 8,
        paddingRight: 8,
      }}
    >
      {overflow ? (
        <Pressable onPress={() => scroll(-1)} style={chevronStyle}>
          <Image source={symbolPath("chevron-left")} style={{ width: 16, height: 24 }} />
        </Pressable>
      ) : null}
      <ScrollView
        ref={trayRef}
        style={{ flex: 1, flexDirection: "row", height: 96, alignItems: "center" }}
      >
        {props.apps.map((app) => (
          <View
            key={app.id}
            style={{
              width: TILE,
              marginLeft: GAP,
              flexDirection: "column",
              alignItems: "center",
            }}
          >
            <Pressable
              onPress={() => props.onLaunch(app.id)}
              style={{
                width: TILE,
                height: TILE,
                backgroundColor: app.color,
                borderRadius: 12,
                justifyContent: "center",
                alignItems: "center",
              }}
            >
              <Text
                style={{
                  fontSize: 28,
                  fontWeight: "bold",
                  color: "#ffffff",
                  textAlign: "center",
                }}
              >
                {app.glyph}
              </Text>
              <Image
                source={appIconPath(app.id)}
                style={{
                  width: TILE,
                  height: TILE,
                  position: "absolute",
                  left: 0,
                  top: 0,
                }}
              />
            </Pressable>
            {props.running.has(app.id) ? (
              <View
                style={{
                  width: 6,
                  height: 6,
                  marginTop: 4,
                  borderRadius: 3,
                  backgroundColor: "#ffffff",
                }}
              />
            ) : null}
          </View>
        ))}
      </ScrollView>
      {overflow ? (
        <Pressable onPress={() => scroll(1)} style={chevronStyle}>
          <Image source={symbolPath("chevron-right")} style={{ width: 16, height: 24 }} />
        </Pressable>
      ) : null}
    </View>
  );
}
