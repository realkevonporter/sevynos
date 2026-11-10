// SevynOS v2 M5 — the Browser system app.
//
// The RN shell on top of Chromium: tabs + address bar in this window,
// the page itself renders in Chromium's own Wayland window (launched
// as a real Wayland client, --ozone-platform=wayland). Everything
// here goes through `sevyn browser ...` (cli.exec permission) over
// CDP — the app never touches Chromium directly. The app logs
// markers the harness reads off the serial:
//   BROWSER tabs <n>                    (after every refresh)
//   BROWSER open title=<t> url=<u>      (after `browser open`)
//   BROWSER activate id=<id>            (after `browser activate`)
// The page rendering itself is proven by the harness screendump
// (Chromium's window shows the page), not by this app.

import * as React from "react";
import { View, Text, Pressable, TextInput } from "./host";
import { runCli, parseField } from "./cli";

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
    }
    return found;
  }

  function go(): void {
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
        <Text style={{ fontSize: 16, fontWeight: "bold", color: "#ffffff", flex: 1 }}>
          Browser
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
              <Text style={{ fontSize: 12, color: "#0c4a6e", textAlign: "center" }}>
                ✕
              </Text>
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
          <Text style={{ fontSize: 16, color: "#0c4a6e", textAlign: "center" }}>+</Text>
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
        </Text>
      </View>
      <View style={{ flex: 1, paddingLeft: 16, paddingRight: 16, paddingTop: 16 }}>
        <Text style={{ fontSize: 15, color: "#0f172a" }}>
          {active ? active.title : "Browse the web."}
        </Text>
        <Text style={{ fontSize: 14, color: "#475569", marginTop: 8 }}>
          The page renders in the Chromium window. Use the address bar above to open a
          page, and the tabs to switch between pages.
        </Text>
        {error ? (
          <Text style={{ fontSize: 14, color: "#dc2626", marginTop: 8 }}>{error}</Text>
        ) : null}
      </View>
    </View>
  );
}
