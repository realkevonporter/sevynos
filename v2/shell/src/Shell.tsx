// SevynOS v2 M2 — the shell.
//
// Layout (1024x768):
//   top bar (48px): "SevynOS" wordmark + live status tray
//   main area (flex 1): welcome view, or "Starting <app>…" after a launch
//   dock (96px): app launcher (see Dock.tsx)
//
// Launching is M3's app runtime. M2 records the attempt via
// Sevyn.launchApp (the host logs "LAUNCH <appId>") and shows the
// "Starting…" state so the click is visible on screen.

import * as React from "react";
import { View, Text } from "./host";
import { Dock } from "./Dock";
import { APPS } from "./apps";
import { StatusTray } from "./StatusTray";

export function Shell(): React.ReactElement {
  const [launching, setLaunching] = React.useState<string | null>(null);

  const onLaunch = (appId: string) => {
    Sevyn.launchApp(appId);
    setLaunching(appId);
  };

  const app = launching ? APPS.find((a) => a.id === launching) : undefined;

  return (
    <View
      style={{
        width: 1024,
        height: 768,
        flexDirection: "column",
        backgroundColor: "#0b0b0f",
      }}
    >
      <View
        style={{
          flexDirection: "row",
          height: 48,
          backgroundColor: "#15151c",
          alignItems: "center",
          paddingLeft: 16,
          paddingRight: 16,
        }}
      >
        <Text style={{ fontSize: 16, fontWeight: "bold", color: "#ffffff" }}>
          SevynOS
        </Text>
        <View style={{ flex: 1 }} />
        <StatusTray />
      </View>
      <View
        style={{
          flex: 1,
          justifyContent: "center",
          alignItems: "center",
          backgroundColor: "#0b0b0f",
        }}
      >
        {app ? (
          <Text style={{ fontSize: 22, color: "#ffffff", textAlign: "center" }}>
            {"Starting " + app.name + "…"}
          </Text>
        ) : (
          <Text style={{ fontSize: 22, color: "#ffffff", textAlign: "center" }}>
            Welcome to SevynOS
          </Text>
        )}
        <Text
          style={{ fontSize: 14, color: "#9ca3af", textAlign: "center", marginTop: 12 }}
        >
          {app
            ? "Apps open in their own window in M3."
            : "Pick an app from the dock to begin."}
        </Text>
      </View>
      <Dock onLaunch={onLaunch} />
    </View>
  );
}
