// SevynOS window fix — the title-bar window controls, shared by the
// template (App.tsx) and the four apps with their own title bars
// (Browser, Files, Settings, Terminal).
//
// Minimize hides the window (a dock click restores it through the
// focus path); the middle button toggles fullscreen (the compositor
// confirms it through the configure states) and shows ❐ while the
// window is fullscreen OR maximized — either expanded state. A
// title-bar double-click toggles maximize (host, 500ms threshold).
// The expanded state comes from the renderer's window-state store,
// which the host updates from the compositor's configure states —
// so a title-bar drag that restores a maximized window updates the
// glyph too.
//
// The window's active state (keyboard focus) for title bars: a
// title bar dims its title + controls when the window loses focus
// (a click on the desktop gives the shell focus). The store is
// shared with WindowButtons below, so the title text and the
// buttons always agree. All title bars are dark today (white title
// on the app color), so the dim colour is the dark secondary text
// token; a light title bar would use color.light.textSecondary.
//
// Layout (must match the host's kCloseZoneWidth = 100): three 28px
// buttons at the right end of the 40px title bar, inside the 12px
// right padding. The host excludes that zone from the move region,
// so presses here reach the Pressables instead of starting a drag.

import * as React from "react";
import { View, Text, Pressable } from "./host";
import {
  subscribeWindowState,
  getWindowStateSnapshot,
} from "../../rn/renderer/sevyn-renderer";
import { tokens } from "../../rn/renderer/tokens";

export function useWindowActive(): boolean {
  const snap = React.useSyncExternalStore(subscribeWindowState, getWindowStateSnapshot);
  return snap.active;
}

const BTN_STYLE = {
  width: 28,
  height: 28,
  borderRadius: 6,
  justifyContent: "center",
  alignItems: "center",
};

export function WindowButtons(): React.ReactElement {
  const snap = React.useSyncExternalStore(subscribeWindowState, getWindowStateSnapshot);
  const expanded = snap.maximized || snap.fullscreen;
  const glyphColor = snap.active ? "#ffffff" : tokens.color.dark.textSecondary;
  return (
    <View style={{ flexDirection: "row", alignItems: "center" }}>
      <Pressable
        onPress={() => {
          Sevyn.minimizeApp();
        }}
        style={BTN_STYLE}
      >
        <Text style={{ fontSize: 16, color: glyphColor, textAlign: "center" }}>—</Text>
      </Pressable>
      <Pressable
        onPress={() => {
          if (snap.fullscreen) Sevyn.unfullscreenApp();
          else Sevyn.fullscreenApp();
        }}
        style={BTN_STYLE}
      >
        <Text style={{ fontSize: 14, color: glyphColor, textAlign: "center" }}>
          {expanded ? "❐" : "▢"}
        </Text>
      </Pressable>
    </View>
  );
}
