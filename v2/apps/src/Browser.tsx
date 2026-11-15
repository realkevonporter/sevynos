// SevynOS v2 M13 — the Browser system app.
//
// The RN shell on top of Chromium: tabs + address bar in this window,
// the page itself renders in Chromium's own Wayland window, launched
// chromeless with --app=<url> as a content window paired with this
// one (800x348 under this window's 152px of chrome) — SevynOS chrome
// is the only chrome. Chromium runs as a real Wayland client
// (--ozone-platform=wayland); GPU is attempted first, with a software
// fallback when CDP stays silent. Everything here goes through
// `sevyn browser ...` (cli.exec permission) over CDP — the app never
// touches Chromium directly. Closing the app runs
// `sevyn browser quit` so Chromium dies with it. The app logs
// markers the harness reads off the serial:
//   BROWSER tabs <n>                    (after every refresh)
//   BROWSER open title=<t> url=<u>      (after `browser open`)
//   BROWSER activate id=<id>            (after `browser activate`)
//   BROWSER gpu=yes|fallback            (after every refresh, from `browser status`)
// The page rendering itself is proven by the harness screendump
// (Chromium's window shows the page), not by this app.
//
// Live resize sync is out of scope: the content window keeps its
// launch size (tracking this window's size would need a CDP
// WebSocket in the C CLI — not built yet).

import * as React from "react";
import { View, Text, Image, Pressable, TextInput } from "./host";
import { WindowButtons } from "./window-buttons";
import { runCli, parseField } from "./cli";
import { appIconTitlePath, symbolPath } from "./icons";

type Tab = { id: string; title: string; url: string };

function parseTabs(out: string): Tab[] {
  const tabs: Tab[] = [];
  for (const line of out.split("\n")) {
    if (!line.startsWith("TAB ")) continue;
    const parts = line.slice(4).split("\t");
    if (parts.length >= 3) tabs.push({ id: parts[0], title: parts[1], url: parts[2] });
  }
  return tabs;
}

function parseTabLine(out: string): Tab | null {
  for (const line of out.split("\n")) {
    if (!line.startsWith("tab: ")) continue;
    const parts = line.slice(5).split("\t");
    if (parts.length >= 3) return { id: parts[0], title: parts[1], url: parts[2] };
  }
  return null;
}

function normalizeUrl(raw: string): string {
  const url = raw.trim();
  if (url === "") return "";
  if (url.includes("://")) return url;
  return "https://" + url;
}

function shortTitle(title: string): string {
  if (title === "") return "(untitled)";
  return title.length > 18 ? title.slice(0, 17) + "…" : title;
}

// Settle poll after `browser open`: 20 steps of 500 ms ≈ 10 s max.
const SETTLE_ATTEMPTS = 20;
const SETTLE_STEP_MS = 500;

// One host tick, off the render path (Terminal.tsx uses the same
// setTimeout shape for its post-flush scroll).
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function Browser(): React.ReactElement {
  const [tabs, setTabs] = React.useState<Tab[]>(() => {
    const { code, out } = runCli("sevyn browser tabs");
    const found = code === 0 ? parseTabs(out) : [];
    Sevyn.log("BROWSER tabs " + found.length);
    return found;
  });
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const [address, setAddress] = React.useState("");
  const [version, setVersion] = React.useState("");
  const [gpu, setGpu] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const color = Sevyn.appColor;

  function refresh(): Tab[] {
    const { code, out } = runCli("sevyn browser tabs");
    const found = code === 0 ? parseTabs(out) : [];
    setTabs(found);
    Sevyn.log("BROWSER tabs " + found.length);
    const st = runCli("sevyn browser status");
    if (st.code === 0) {
      const v = parseField(st.out, "version");
      if (v) setVersion(v);
      const g = parseField(st.out, "gpu");
      if (g) {
        setGpu(g);
        Sevyn.log("BROWSER gpu=" + g);
      }
    }
    return found;
  }

  // Re-refresh until the tab opened by go() appears in the tab list
  // with a non-empty title. The refresh right after `browser open`
  // samples a transient list — cold start: CDP still down, list empty;
  // warm open: the old tab still closing, list shows both — and the
  // tab reads "(untitled)" until the page loads, so a single refresh
  // leaves the strip wrong until the user's next action. Bounded:
  // SETTLE_ATTEMPTS steps of SETTLE_STEP_MS (~10 s max), and stops
  // early if the tab disappears again (the user closed it mid-poll).
  // Returns the settled tab, the tab found by URL only when its title
  // never arrives within the bound, or null.
  async function settleOpenedTab(url: string): Promise<Tab | null> {
    let byUrl: Tab | null = null;
    let seen = false;
    for (let i = 0; i < SETTLE_ATTEMPTS; i++) {
      await sleep(SETTLE_STEP_MS);
      const found = refresh();
      byUrl = found.find((t) => t.url === url) ?? null;
      if (byUrl) {
        seen = true;
        if (byUrl.title !== "") return byUrl;
      } else if (seen) {
        return null;
      }
    }
    return byUrl;
  }

  async function go(): Promise<void> {
    const url = normalizeUrl(address);
    if (url === "") return;
    setError(null);
    const { code, out } = runCli("sevyn browser open " + url);
    if (code !== 0) {
      setError(out.trim() || "could not open " + url);
      return;
    }
    const tab = parseTabLine(out);
    const found = refresh();
    const opened = tab ?? found.find((t) => t.url === url) ?? null;
    if (opened) {
      setActiveId(opened.id);
      Sevyn.log("BROWSER open title=" + opened.title + " url=" + opened.url);
    }
    setAddress(url);
    // Already settled: the first refresh found the tab with a real
    // title, so the strip is right and there is nothing to re-poll.
    const listed = found.find((t) => t.url === url) ?? null;
    if (listed && listed.title !== "") return;
    const settled = await settleOpenedTab(url);
    if (settled) {
      setActiveId(settled.id);
      // Cold start: `browser open` returned no tab line, so no
      // BROWSER open was logged above — log it now that the tab
      // exists. (When one was already logged, do not log a second.)
      if (!opened) {
        Sevyn.log("BROWSER open title=" + settled.title + " url=" + settled.url);
      }
    }
  }

  function activate(tab: Tab): void {
    setError(null);
    const { code } = runCli("sevyn browser activate " + tab.id);
    if (code !== 0) {
      setError("could not activate " + tab.title);
      return;
    }
    setActiveId(tab.id);
    setAddress(tab.url);
    Sevyn.log("BROWSER activate id=" + tab.id);
  }

  function closeTab(tab: Tab): void {
    const { code } = runCli("sevyn browser close " + tab.id);
    if (code !== 0) {
      setError("could not close " + tab.title);
      return;
    }
    const found = refresh();
    if (activeId === tab.id) {
      setActiveId(found.length > 0 ? found[0].id : null);
      setAddress(found.length > 0 ? found[0].url : "");
    }
  }

  const active = tabs.find((t) => t.id === activeId) ?? tabs[0] ?? null;

  return (
    <View
      style={{
        flex: 1,
        flexDirection: "column",
        backgroundColor: "#f0f9ff",
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
        <Image
          source={appIconTitlePath("browser")}
          style={{ width: 20, height: 20, marginRight: 8 }}
        />
        <Text style={{ fontSize: 16, fontWeight: "bold", color: "#ffffff", flex: 1 }}>
          Browser
        </Text>
        <WindowButtons />
        <Pressable
          onPress={() => {
            // Quit Chromium first; the result is ignored — the app
            // closes regardless.
            runCli("sevyn browser quit");
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
          <Image source={symbolPath("close")} style={{ width: 16, height: 16 }} />
        </Pressable>
      </View>
      <View
        style={{
          flexDirection: "row",
          height: 36,
          backgroundColor: "#e0f2fe",
          alignItems: "center",
          paddingLeft: 8,
          paddingRight: 8,
        }}
      >
        {tabs.map((t) => (
          <Pressable
            key={t.id}
            onPress={() => activate(t)}
            style={{
              height: 28,
              maxWidth: 150,
              backgroundColor: t.id === (active && active.id) ? "#ffffff" : "#bae6fd",
              borderRadius: 6,
              flexDirection: "row",
              alignItems: "center",
              paddingLeft: 8,
              paddingRight: 4,
              marginRight: 6,
            }}
          >
            <Text style={{ fontSize: 13, color: "#0c4a6e" }}>{shortTitle(t.title)}</Text>
            <Pressable
              onPress={() => closeTab(t)}
              style={{
                width: 20,
                height: 20,
                justifyContent: "center",
                alignItems: "center",
                marginLeft: 4,
              }}
            >
              <Image source={symbolPath("close")} style={{ width: 16, height: 16 }} />
            </Pressable>
          </Pressable>
        ))}
        <Pressable
          onPress={() => {
            setAddress("");
          }}
          style={{
            width: 28,
            height: 28,
            borderRadius: 6,
            backgroundColor: "#bae6fd",
            justifyContent: "center",
            alignItems: "center",
          }}
        >
          <Image source={symbolPath("plus")} style={{ width: 16, height: 16 }} />
        </Pressable>
      </View>
      <View
        style={{
          flexDirection: "row",
          height: 44,
          alignItems: "center",
          paddingLeft: 8,
          paddingRight: 8,
          backgroundColor: "#ffffff",
        }}
      >
        <TextInput
          value={address}
          onChangeText={setAddress}
          onSubmitEditing={go}
          placeholder="Search or type a URL"
          autoFocus
          style={{
            flex: 1,
            height: 30,
            backgroundColor: "#f1f5f9",
            fontSize: 14,
            color: "#0f172a",
            paddingLeft: 8,
          }}
        />
        <Pressable
          onPress={go}
          style={{
            width: 52,
            height: 30,
            borderRadius: 6,
            backgroundColor: color,
            justifyContent: "center",
            alignItems: "center",
            marginLeft: 8,
          }}
        >
          <Text style={{ fontSize: 14, fontWeight: "bold", color: "#ffffff" }}>Go</Text>
        </Pressable>
      </View>
      <View
        style={{
          height: 28,
          backgroundColor: "#e5e7eb",
          justifyContent: "center",
          paddingLeft: 12,
        }}
      >
        <Text style={{ fontSize: 13, color: "#374151" }}>
          {active ? active.url : "No tab open yet."}
          {version ? "  ·  " + version : ""}
          {gpu ? "  ·  gpu: " + gpu : ""}
        </Text>
      </View>
      <View style={{ flex: 1, paddingLeft: 16, paddingRight: 16, paddingTop: 16 }}>
        <Text style={{ fontSize: 15, color: "#0f172a" }}>
          {active ? active.title : "Browse the web."}
        </Text>
        <Text style={{ fontSize: 14, color: "#475569", marginTop: 8 }}>
          The page renders in the paired Chromium content window (chromeless — SevynOS
          chrome only). Use the address bar above to open a page, and the tabs to switch
          between pages.
        </Text>
        {error ? (
          <Text style={{ fontSize: 14, color: "#dc2626", marginTop: 8 }}>{error}</Text>
        ) : null}
      </View>
    </View>
  );
}
