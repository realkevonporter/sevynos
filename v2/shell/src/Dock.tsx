// SevynOS v2 M2 — the dock.
//
// A horizontal ScrollView of app tiles. The dock never overflows: the
// tray clips to the viewport and scrolls (chevron buttons scroll by one
// tile). Chevrons only appear when the content is wider than the tray.
// Overflow is computed deterministically from the app count and the
// fixed 1024px surface — no measurement effect, so the chevrons are
// correct on the very first frame.
//
// At M2 sizes (80px tiles, 8px gaps) 12 apps need 1056px in a 1008px
// tray, so the chevrons are always up with the full app set — which is
// the point of the M2 check. Fewer apps fit and the chevrons hide.

import * as React from "react";
import { View, Text, Pressable, ScrollView } from "./host";
import { APPS } from "./apps";
import { scrollBy } from "../../rn/renderer/sevyn-renderer";

const SURFACE_WIDTH = 1024;
const DOCK_H_PADDING = 16;
const TILE = 80;
const GAP = 8;
const CHEVRON = 28;

export interface DockProps {
  onLaunch(appId: string): void;
}

export function Dock(props: DockProps): React.ReactElement {
  const trayRef = React.useRef<any>(null);

  const contentWidth = APPS.length * (TILE + GAP);
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
          <Text style={{ fontSize: 18, color: "#ffffff", textAlign: "center" }}>‹</Text>
        </Pressable>
      ) : null}
      <ScrollView
        ref={trayRef}
        style={{ flex: 1, flexDirection: "row", height: 96, alignItems: "center" }}
      >
        {APPS.map((app) => (
          <Pressable
            key={app.id}
            onPress={() => props.onLaunch(app.id)}
            style={{
              width: TILE,
              height: TILE,
              marginLeft: GAP,
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
          </Pressable>
        ))}
      </ScrollView>
      {overflow ? (
        <Pressable onPress={() => scroll(1)} style={chevronStyle}>
          <Text style={{ fontSize: 18, color: "#ffffff", textAlign: "center" }}>›</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
