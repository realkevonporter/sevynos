// SevynOS v2 M3 — the shell.
//
// Layout (1024x768):
//   top bar (48px): "SevynOS" wordmark + live status tray
//   main area (flex 1): welcome view, or "Starting <app>…" after a launch
//   dock: floating Liquid Glass pill, centered, sized to its apps
//         (see Dock.tsx — macOS 27 style, no magnification)
//   right-clicking a dock tile opens that app's context menu
//         (gap unit 12, audit #15): Open / Show / Open New Window,
//         each backed by a real appd verb — no Close (no such verb
//         yet) and no pin/unpin (no pin concept).
//
// The dock renders from appd's app list (the renderer's app store,
// useSyncExternalStore): the installed stock apps, with a running dot
// under each running app. Launching asks appd to spawn a sandboxed
// host for the app in its own window; "Starting…" shows until the
// LAUNCHED event (or a STOPPED/CRASHED for the same id) arrives.

import * as React from "react";
import { View, Text, Pressable } from "./host";
import { Dock } from "./Dock";
import { AiButton } from "./AiButton";
import { AiSidebar } from "./AiSidebar";
import { APPS, type ShellApp } from "./apps";
import { StatusTray } from "./StatusTray";
import { Wallpaper } from "./Wallpaper";
import { DesktopIcons } from "./DesktopIcons";
import {
  normalizeWallpaperStyle,
  normalizeWallpaperColor,
  wallpaperVariantFor,
} from "./wallpaper-variants";
import { subscribeApps, getAppsSnapshot } from "../../rn/renderer/sevyn-renderer";
import type { ContextMenuEvent } from "../../rn/renderer/sevyn-renderer";
import { ContextMenu } from "../../rn/renderer/context-menu";
import type { ContextMenuItem } from "../../rn/renderer/context-menu";

// One `sevyn settings get` field: the CLI prints `key=value` (the
// same shape `sevyn update status` prints, read with parseField in
// the apps). Null when the call fails or the field is absent — the
// normalizers repair that to the default.
function readSetting(key: string): string | null {
  const raw = Sevyn.exec("sevyn settings get " + key);
  const nl = raw.indexOf("\n");
  if (nl < 0) return null;
  const m = raw.slice(nl + 1).match(new RegExp(key + "=([^\\s]+)"));
  return m ? m[1] : null;
}

export function Shell(): React.ReactElement {
  const [launching, setLaunching] = React.useState<string | null>(null);
  const [powerMenu, setPowerMenu] = React.useState(false);
  // Dock right-click menu (gap unit 12, audit #15): which app's
  // menu is open, and where the pointer was. Null when closed.
  const [dockMenu, setDockMenu] = React.useState<{
    app: ShellApp;
    x: number;
    y: number;
  } | null>(null);
  // AI sidebar (DESIGN.md §2.8, phase 1): the corner button opens
  // it; the sidebar closes itself. Opening it closes the power
  // menu — the two panels overlap in the top-right corner.
  const [aiOpen, setAiOpen] = React.useState(false);
  // Hourly time resync (#134 follow-up): the old time service
  // re-synced every hour (DEFAULT_RESYNC_INTERVAL_MS); the v2
  // image init only syncs once at boot, so the shell owns the
  // recurring sync. Fire-and-forget, best-effort — a failed sync
  // never touches the UI, and the next hour retries. Off the JS
  // thread (execAsync), so an NTP round trip never freezes the
  // shell. The boot sync already covers the first sync, so the
  // first tick is an hour out.
  //
  // A self-rescheduling setTimeout, not setInterval: the host
  // (v2/rn/host/sevyn-rn-host.cc) installs setTimeout /
  // clearTimeout only — there is no setInterval in the shell's
  // runtime. The timer is unref'd where the runtime offers it
  // (Node, in the e2e harness) so a pending hour-long timer
  // doesn't keep a test process alive; the real host runs
  // forever anyway. (Same guarded-unref shape as the old
  // linux-*-service timers.)
  React.useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unref = (t: ReturnType<typeof setTimeout> | undefined): void => {
      if (typeof t === "object" && t !== null && "unref" in t) {
        (t as { unref: () => void }).unref();
      }
    };
    const arm = (): void => {
      timer = setTimeout(tick, 60 * 60 * 1000);
      unref(timer);
    };
    const tick = (): void => {
      if (stopped) return;
      void Sevyn.execAsync("sevyn time sync").catch(() => undefined);
      arm();
    };
    arm();
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, []);
  const snap = React.useSyncExternalStore(subscribeApps, getAppsSnapshot);
  // appd's list is the source of truth; the built-in 12 are the
  // fallback when it is empty (appd down at first mount).
  const apps: ShellApp[] =
    snap.apps.length > 0
      ? snap.apps.map((a) => ({
          id: a.id,
          name: a.name,
          color: a.color,
          glyph: a.glyph,
          // Absent on old list lines: single-instance (the default).
          singleInstance: a.singleInstance !== false,
        }))
      : APPS;
  const running = new Set(snap.running);

  const onLaunch = (appId: string) => {
    const app = apps.find((a) => a.id === appId);
    if (running.has(appId)) {
      // Already running: a single-instance app is focused (its
      // window is raised above the shell); a multi-instance app
      // opens a new window. Focusing a running multi-instance app
      // is the dock menu's Show item (gap unit 12), not the click.
      if (app && app.singleInstance) {
        Sevyn.focusApp(appId);
      } else if (Sevyn.launchApp(appId)) {
        setLaunching(appId);
      }
      return;
    }
    // Only claim "Starting…" when appd accepted the launch.
    if (Sevyn.launchApp(appId)) setLaunching(appId);
  };

  // Dock right-click menu (gap unit 12, audit #15): the items are
  // only actions that exist today for the app, backed by real
  // appd verbs (LAUNCH / FOCUS via Sevyn.launchApp / focusApp).
  // There is no Close item: `sevyn app close <id>` does not exist
  // yet as a CLI verb (queued separately after Stage 5), and the
  // shell's Sevyn.closeApp() closes the shell itself, not another
  // app — so nothing here can close an app. There is no pin/unpin
  // either: the dock has no pin concept (every installed app is
  // always in the dock).
  //   - not running: Open — launches it (same as a dock click).
  //   - running, single-instance: Show — focuses its window.
  //     (A dock click does the same; the menu names the verb.)
  //   - running, multi-instance: Show — focuses the newest window
  //     — plus Open New Window, which launches another instance
  //     (the dock click's behaviour for a running multi-instance
  //     app, split out so both verbs are reachable).
  function dockMenuItems(app: ShellApp): ContextMenuItem[] {
    if (!running.has(app.id)) {
      return [
        {
          id: "open",
          label: "Open " + app.name,
          onSelect: () => onLaunch(app.id),
        },
      ];
    }
    const show: ContextMenuItem = {
      id: "show",
      label: "Show " + app.name,
      onSelect: () => {
        Sevyn.focusApp(app.id);
      },
    };
    if (app.singleInstance) return [show];
    return [
      show,
      {
        id: "new-window",
        label: "Open New Window",
        onSelect: () => onLaunch(app.id),
      },
    ];
  }

  function onDockTileContextMenu(appId: string, ev: ContextMenuEvent): void {
    const app = apps.find((a) => a.id === appId);
    if (!app) return;
    setDockMenu({ app, x: ev.nativeEvent.x, y: ev.nativeEvent.y });
  }

  const app = launching ? apps.find((a) => a.id === launching) : undefined;
  // "Starting…" is derived, not cleared: it shows while the launch
  // is outstanding — the app is neither running yet nor already
  // stopped/crashed for this id. Once LAUNCHED arrives the window is
  // up and the welcome text returns. (A second launch of an app that
  // just stopped shows no "Starting…" flash — the window opens
  // anyway; the running dot is the feedback.)
  const showStarting =
    !!app &&
    !running.has(launching as string) &&
    !(
      snap.lastEvent &&
      (snap.lastEvent.kind === "STOPPED" || snap.lastEvent.kind === "CRASHED") &&
      snap.lastEvent.id === launching
    );

  // Wallpaper: re-read on every render, so a style picked in
  // Settings applies when Settings closes (its STOPPED event
  // re-renders the shell). Not instant while Settings stays open —
  // the renderer has no proven effect/timer flush to poll on, and
  // no renderer settings store is in scope for this port.
  const wallpaperStyle = normalizeWallpaperStyle(readSetting("wallpaperStyle"));
  const wallpaperColor = normalizeWallpaperColor(readSetting("wallpaperColor"));
  const variant = wallpaperVariantFor(wallpaperStyle, wallpaperColor);

  return (
    <View
      style={{
        flex: 1,
        flexDirection: "column",
        backgroundColor: variant.background,
      }}
    >
      <Wallpaper style={wallpaperStyle} color={wallpaperColor} />
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
        <StatusTray onPowerPress={() => setPowerMenu(true)} />
      </View>
      <View
        style={{
          flex: 1,
          justifyContent: "center",
          alignItems: "center",
        }}
      >
        {/* Desktop icons paint over the wallpaper, under the
            centered welcome text. */}
        <DesktopIcons onLaunch={onLaunch} />
        {showStarting ? (
          <Text style={{ fontSize: 22, color: "#ffffff", textAlign: "center" }}>
            {"Starting " + (app as ShellApp).name + "…"}
          </Text>
        ) : (
          <Text style={{ fontSize: 22, color: "#ffffff", textAlign: "center" }}>
            Welcome to SevynOS
          </Text>
        )}
        <Text
          style={{ fontSize: 14, color: "#9ca3af", textAlign: "center", marginTop: 12 }}
        >
          {showStarting
            ? "Opening in its own window."
            : "Pick an app from the dock to begin."}
        </Text>
      </View>
      <Dock
        apps={apps}
        running={running}
        onLaunch={onLaunch}
        onTileContextMenu={onDockTileContextMenu}
      />
      {/* Power menu: last child, so it paints over the desktop. The
          backdrop closes it on a tap outside; the rows run `sevyn
          poweroff` / `sevyn reboot` through the shell's trusted exec
          (the shell always has every permission). Positions are
          deterministic at 1920x1080 — the m9-check taps them by
          coordinate (button centre 1872,24; Shut Down 1804,70;
          Restart 1804,114). */}
      {powerMenu ? (
        <React.Fragment>
          <Pressable
            testID="power-menu-backdrop"
            onPress={() => setPowerMenu(false)}
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              right: 0,
              bottom: 0,
            }}
          />
          <View
            style={{
              position: "absolute",
              top: 48,
              right: 16,
              width: 200,
              backgroundColor: "#1f2937",
              borderRadius: 12,
              paddingTop: 4,
              paddingBottom: 4,
            }}
          >
            <Pressable
              testID="power-shutdown"
              onPress={() => {
                Sevyn.exec("sevyn poweroff");
                setPowerMenu(false);
              }}
              style={{
                height: 44,
                justifyContent: "center",
                paddingLeft: 16,
              }}
            >
              <Text style={{ fontSize: 15, color: "#ffffff" }}>Shut Down</Text>
            </Pressable>
            <Pressable
              testID="power-restart"
              onPress={() => {
                Sevyn.exec("sevyn reboot");
                setPowerMenu(false);
              }}
              style={{
                height: 44,
                justifyContent: "center",
                paddingLeft: 16,
              }}
            >
              <Text style={{ fontSize: 15, color: "#ffffff" }}>Restart</Text>
            </Pressable>
          </View>
        </React.Fragment>
      ) : null}
      {/* AI button + sidebar: last children, so they paint over the
          desktop (and over the power menu, which they close on
          open). The button hides while the sidebar is open. */}
      {aiOpen ? null : (
        <AiButton
          onPress={() => {
            setPowerMenu(false);
            setAiOpen(true);
          }}
        />
      )}
      {aiOpen ? <AiSidebar onClose={() => setAiOpen(false)} /> : null}
      {/* Dock right-click menu (gap unit 12): last child, so it
          draws (and hit-tests) above everything else. A right-click
          on empty dock space offers nothing — only tiles forward
          onContextMenu — so there is no empty-space menu here. */}
      {dockMenu ? (
        <ContextMenu
          x={dockMenu.x}
          y={dockMenu.y}
          items={dockMenuItems(dockMenu.app)}
          onDismiss={() => setDockMenu(null)}
        />
      ) : null}
    </View>
  );
}
