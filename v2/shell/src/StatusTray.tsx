// SevynOS v2 M2 — live status tray (top bar, right side).
//
// Reads the statusd snapshot through the renderer's status store
// (useSyncExternalStore). The store refreshes on every statusd push, so
// the tray re-renders exactly when status changes. The shell never
// calls Sevyn.onStatus itself — the host exposes a single onStatus
// handler, owned by the renderer.

import * as React from "react";
import { Text, Pressable } from "./host";
import { subscribeStatus, getStatusSnapshot } from "../../rn/renderer/sevyn-renderer";

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

const itemStyle = {
  fontSize: 13,
  color: "#d1d5db",
  marginLeft: 16,
};

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
      <Text style={itemStyle}>{wifiLabel(status.wifi)}</Text>
      <Text style={itemStyle}>{"🔋 " + batteryLabel(status.battery)}</Text>
      <Text style={itemStyle}>{volumeLabel(status.volume)}</Text>
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
