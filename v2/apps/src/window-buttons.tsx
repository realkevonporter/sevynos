// SevynOS window fix — the title-bar window controls, shared by the
// template (App.tsx) and the four apps with their own title bars
// (Browser, Files, Settings, Terminal).
//
// Minimize hides the window (a dock click restores it through the
// focus path); maximize asks the compositor to fill the screen and
// the button becomes restore (❐) while maximized. The maximized
// state comes from the renderer's window-state store, which the host
// updates from the compositor's configure states — so a title-bar
// drag that restores a maximized window updates the glyph too.
//
// Layout (must match the host's kCloseZoneWidth = 100): three 28px
// buttons at the right end of the 44px title bar, inside the 12px
// right padding. The host excludes that zone from the move region,
// so presses here reach the Pressables instead of starting a drag.

import * as React from "react";
import { View, Text, Pressable } from "./host";
import {
  subscribeWindowState,
  getWindowStateSnapshot,
} from "../../rn/renderer/sevyn-renderer";

const BTN_STYLE = {
  width: 28,
  height: 28,
  borderRadius: 6,
  justifyContent: "center",
  alignItems: "center",
};

export function WindowButtons(): React.ReactElement {
  const snap = React.useSyncExternalStore(subscribeWindowState, getWindowStateSnapshot);
  const maximized = snap.maximized;
  return (
    <View style={{ flexDirection: "row", alignItems: "center" }}>
      <Pressable
        onPress={() => {
          Sevyn.minimizeApp();
        }}
        style={BTN_STYLE}
      >
        <Text style={{ fontSize: 16, color: "#ffffff", textAlign: "center" }}>—</Text>
      </Pressable>
      <Pressable
        onPress={() => {
          if (maximized) Sevyn.unmaximizeApp();
          else Sevyn.maximizeApp();
        }}
        style={BTN_STYLE}
      >
        <Text style={{ fontSize: 14, color: "#ffffff", textAlign: "center" }}>
          {maximized ? "❐" : "▢"}
        </Text>
      </Pressable>
    </View>
  );
}
