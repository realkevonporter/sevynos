// SevynOS v2 M3 — the generic stock-app screen.
//
// One template serves every stock app: the host passes the app's
// identity (Sevyn.appId / appName / appColor, from the manifest via
// appd) and the app renders its own window (800x500) — header with
// the app name and a close X, body with the glyph tile, name, and a
// status line. The status line proves the permission gate: an app
// with status.read shows live values; one without it shows
// "not permitted" (the host never starts its status subscriber and
// getStatus() returns {}).
//
// The close X calls Sevyn.closeApp(): the host exits 0 and appd
// reports STOPPED. (The compositor's window close button does the
// same through the host's close handler.)

import * as React from "react";
import { View, Text, Pressable } from "./host";
import { subscribeStatus, getStatusSnapshot } from "../../rn/renderer/sevyn-renderer";

function statusText(status: { [key: string]: string }): string {
  const battery = status.battery ?? "—";
  const volume = status.volume ?? "—";
  const wifi = status.wifi === "on" ? "Wi-Fi" : "offline";
  return `Status: ${wifi} · ${battery}% · Vol ${volume}`;
}

export function App(): React.ReactElement {
  const permitted = Sevyn.hasPermission("status.read");
  const status = React.useSyncExternalStore(subscribeStatus, getStatusSnapshot);
  const name = Sevyn.appName;
  const color = Sevyn.appColor;

  return (
    <View
      style={{
        width: 800,
        height: 500,
        flexDirection: "column",
        backgroundColor: "#f9fafb",
      }}
    >
      <View
        style={{
          flexDirection: "row",
          height: 44,
          backgroundColor: color,
          alignItems: "center",
          paddingLeft: 16,
          paddingRight: 12,
        }}
      >
        <Text style={{ fontSize: 16, fontWeight: "bold", color: "#ffffff", flex: 1 }}>
          {name}
        </Text>
        <Pressable
          onPress={() => {
            Sevyn.closeApp();
          }}
          style={{
            width: 28,
            height: 28,
            borderRadius: 6,
            justifyContent: "center",
            alignItems: "center",
          }}
        >
          <Text style={{ fontSize: 16, color: "#ffffff", textAlign: "center" }}>✕</Text>
        </Pressable>
      </View>
      <View
        style={{
          flex: 1,
          justifyContent: "center",
          alignItems: "center",
          backgroundColor: "#f9fafb",
        }}
      >
        <View
          style={{
            width: 96,
            height: 96,
            backgroundColor: color,
            borderRadius: 20,
            justifyContent: "center",
            alignItems: "center",
          }}
        >
          <Text
            style={{
              fontSize: 48,
              fontWeight: "bold",
              color: "#ffffff",
              textAlign: "center",
            }}
          >
            {Sevyn.appGlyph}
          </Text>
        </View>
        <Text
          style={{
            fontSize: 24,
            fontWeight: "bold",
            color: "#111827",
            textAlign: "center",
            marginTop: 16,
          }}
        >
          {name}
        </Text>
        <Text
          style={{ fontSize: 14, color: "#6b7280", textAlign: "center", marginTop: 8 }}
        >
          Running sandboxed in its own window.
        </Text>
        <Text
          style={{ fontSize: 14, color: "#6b7280", textAlign: "center", marginTop: 16 }}
        >
          {permitted ? statusText(status) : "Status: not permitted"}
        </Text>
      </View>
    </View>
  );
}
