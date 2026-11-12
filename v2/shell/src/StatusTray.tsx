// SevynOS v2 M2 — live status tray (top bar, right side).
//
// Reads the statusd snapshot through the renderer's status store
// (useSyncExternalStore). The store refreshes on every statusd push, so
// the tray re-renders exactly when status changes. The shell never
// calls Sevyn.onStatus itself — the host exposes a single onStatus
// handler, owned by the renderer.
//
// Icons: each item is a drawn symbol next to its text label (the
// labels stay — they carry the state: "offline", the percentage, the
// volume number). The battery used to be a 🔋 emoji; the painter's
// font is DejaVu Sans, which has no color emoji, so it rendered
// unreliably — it is now a drawn outline whose fill is a View sized
// by the percentage.

import * as React from "react";
import { View, Text, Image, Pressable } from "./host";
import { subscribeStatus, getStatusSnapshot } from "../../rn/renderer/sevyn-renderer";
import { symbolPath } from "./icons";

export interface StatusSnapshot {
  battery?: string;
  wifi?: string;
  volume?: string;
}

function batteryLabel(v?: string): string {
  if (v == null || v === "" || v === "unknown") return "—";
  return v + "%";
}

function wifiLabel(v?: string): string {
  if (v == null || v === "" || v === "unknown") return "offline";
  return v === "on" ? "Wi-Fi" : "offline";
}

function volumeLabel(v?: string): string {
  if (v == null || v === "" || v === "unknown") return "—";
  return "Vol " + v;
}

// Battery symbol geometry (v2/shell/icons/build_icons.py): the
// battery.png outline is 28x14; the clear area inside is x 2..22,
// y 2..11, so the fill is a 9px-high View starting at left 2.
const BATTERY_W = 28;
const BATTERY_H = 14;
const BATTERY_FILL_LEFT = 2;
const BATTERY_FILL_TOP = 2;
const BATTERY_FILL_H = 9;
const BATTERY_FILL_MAX_W = 20;

function batteryFillWidth(v?: string): number {
  const n = v == null ? NaN : parseFloat(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(
    0,
    Math.min(BATTERY_FILL_MAX_W, Math.round((n / 100) * BATTERY_FILL_MAX_W)),
  );
}

const itemStyle = {
  flexDirection: "row",
  alignItems: "center",
  marginLeft: 16,
} as const;

const labelStyle = {
  fontSize: 13,
  color: "#d1d5db",
  marginLeft: 6,
} as const;

export interface StatusTrayProps {
  onPowerPress(): void;
}

export function StatusTray(props: StatusTrayProps): React.ReactElement {
  const status = React.useSyncExternalStore(
    subscribeStatus,
    getStatusSnapshot,
  ) as StatusSnapshot;
  return (
    <React.Fragment>
      <View style={itemStyle}>
        <Image source={symbolPath("wifi")} style={{ width: 20, height: 14 }} />
        <Text style={labelStyle}>{wifiLabel(status.wifi)}</Text>
      </View>
      <View style={itemStyle}>
        <View style={{ width: BATTERY_W, height: BATTERY_H }}>
          <Image
            source={symbolPath("battery")}
            style={{ width: BATTERY_W, height: BATTERY_H }}
          />
          <View
            style={{
              position: "absolute",
              left: BATTERY_FILL_LEFT,
              top: BATTERY_FILL_TOP,
              width: batteryFillWidth(status.battery),
              height: BATTERY_FILL_H,
              backgroundColor: "#ffffff",
            }}
          />
        </View>
        <Text style={labelStyle}>{batteryLabel(status.battery)}</Text>
      </View>
      <View style={itemStyle}>
        <Image source={symbolPath("volume")} style={{ width: 20, height: 16 }} />
        <Text style={labelStyle}>{volumeLabel(status.volume)}</Text>
      </View>
      {/* Power button: the tray's only pressable. A text label, not a
          symbol — the tray font (DejaVu Sans) has no power glyph
          (U+23FB), so a symbol would render as tofu. Fixed 64px wide
          so its screen position is deterministic (right edge pinned
          to the bar's 16px padding — the m9-check taps it by
          coordinate). */}
      <Pressable
        testID="tray-power"
        onPress={props.onPowerPress}
        style={{
          width: 64,
          height: 36,
          marginLeft: 16,
          borderRadius: 6,
          backgroundColor: "#26262e",
          justifyContent: "center",
          alignItems: "center",
        }}
      >
        <Text style={{ fontSize: 13, color: "#d1d5db", textAlign: "center" }}>Power</Text>
      </Pressable>
    </React.Fragment>
  );
}
