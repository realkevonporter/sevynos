// SevynOS v2 M13 — the Browser system app.
//
// The RN shell on top of Chromium: tabs + address bar in this window,
// the page itself renders in Chromium's own Wayland window, launched
// chromeless with --app=<url> as a content window paired with this
// one — SevynOS chrome is the only chrome. Chromium runs as a real
// Wayland client (--ozone-platform=wayland); GPU is attempted first,
// with a software fallback when CDP stays silent. Everything here
// goes through `sevyn browser ...` (cli.exec permission) over CDP —
// the app never touches Chromium directly. Closing the app runs
// `sevyn browser quit` so Chromium dies with it. The app logs
// markers the harness reads off the serial:
//   BROWSER tabs <n>                    (after every refresh)
//   BROWSER open title=<t> url=<u>      (after `browser open`)
//   BROWSER activate id=<id>            (after `browser activate`)
//   BROWSER gpu=yes|fallback            (after every refresh, from `browser status`)
//   BROWSER embedded yes <x>,<y>,<w>x<h> (after a confirmed embed)
//   BROWSER embed failed <msg>          (when adoption is refused)
//   BROWSER embedded died               (a refresh found embedded: no
//                                        after a confirmed embed —
//                                        Chromium died, the content
//                                        area empties)
// The page rendering itself is proven by the harness screendump
// (Chromium's window shows the page), not by this app.
//
// Stage 5 (embedding): after `browser open` the app reports its
// content rect to the Browser host — `sevyn browser embed 0 148 <W>
// <H-148>` — and the host adopts Chromium into that rect through
// the Genesis compositor (bridge v1). The chrome is 148 px total
// (title 40 + tabs 36 + address 44 + status 28), so the content
// rect is (0, 148, W, H−148) with W/H from Sevyn.width/height
// (published by the host, M9). On resize the host re-lays out the
// root, the app re-renders, and the size effect re-reports the
// rect (the verb is idempotent: adopt, move for the same size,
// resize for a new size). Until adoption confirms, the content
// area shows a placeholder; on failure it shows the failure (not
// a blank area) and the page stays drivable over CDP.

import * as React from "react";
import { View, Text, Image, Pressable, TextInput } from "./host";
import { WindowButtons, useWindowActive } from "./window-buttons";
import { tokens } from "../../rn/renderer/tokens";
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

// The Browser window's chrome, in pixels: title 40 + tabs 36 +
// address 44 + status 28. The content rect is (0, 148, W, H−148).
// The title bar is tokens.window.titleBarHeight (40, polish
// surface (b)); the tabs/address/status rows keep their heights.
const CHROME_HEIGHT = 148;

// Parse an `embedded:` line from `browser status` / `browser
// embed` output: "embedded: yes 0,148,800x352" or "embedded: no".
// Null when the output carries no embedded line at all (an old
// CLI, or a status that never reached the host) — the caller
// leaves the state alone then, rather than inventing one.
function parseEmbedded(out: string): { state: "yes" | "no"; rect: string } | null {
  const m = out.match(/embedded: (yes|no)(?: ([0-9]+,[0-9]+,[0-9]+x[0-9]+))?/);
  if (!m) return null;
  return { state: m[1] as "yes" | "no", rect: m[2] ?? "" };
}

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
  // Stage 5 adoption state: "yes <rect>" once the host confirms
  // the embed, "no" when the host says nothing is adopted, null
  // before the first embed attempt. embedError carries the failure
  // to show in the content area (never a blank area).
  const [embedded, setEmbedded] = React.useState<string | null>(null);
  const [embedError, setEmbedError] = React.useState<string | null>(null);
  const color = Sevyn.appColor;
  // Polish surface (b): the title bar dims when the window loses
  // keyboard focus.
  const windowActive = useWindowActive();
  // The last embedded state, for the yes→no transition in
  // refresh() (Chromium died): state alone cannot tell a fresh
  // "no" from a death.
  const embeddedRef = React.useRef<string | null>(null);
  embeddedRef.current = embedded;
  const tabsRef = React.useRef<Tab[]>(tabs);
  tabsRef.current = tabs;

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
    // The embedded line is parsed regardless of the exit code:
    // when Chromium is dead `browser status` exits 1 and still
    // prints "running: no" + "embedded: no" — that is exactly the
    // chromium_died signal, and the content area must empty on
    // this refresh, not on the next user action.
    const emb = parseEmbedded(st.out);
    if (emb) {
      if (
        emb.state === "no" &&
        embeddedRef.current !== null &&
        embeddedRef.current.startsWith("yes")
      ) {
        setEmbedError("Chromium closed — the page is gone. Open a URL to start again.");
        Sevyn.log("BROWSER embedded died");
      }
      setEmbedded(emb.state === "yes" ? "yes " + emb.rect : "no");
    }
    return found;
  }

  // Stage 5: report this window's content rect to the Browser
  // host for adoption (`sevyn browser embed`). Only called when a
  // tab exists — before any page is opened there is nothing to
  // adopt, and an embed failure then would be noise, not news.
  // Synchronous: the round-trip is two local sockets and the
  // host's bridge op times out at 3 s, far under the exec kill.
  function reportEmbed(): void {
    const w = Sevyn.width;
    const h = Sevyn.height - CHROME_HEIGHT;
    if (w <= 0 || h <= 0) return;
    const { code, out } = runCli(
      "sevyn browser embed 0 " + CHROME_HEIGHT + " " + w + " " + h,
    );
    const emb = parseEmbedded(out);
    if (code === 0 && emb && emb.state === "yes") {
      setEmbedded("yes " + emb.rect);
      setEmbedError(null);
      Sevyn.log("BROWSER embedded yes " + emb.rect);
      return;
    }
    setEmbedded("no");
    const msg = out.trim() || "the embed was not confirmed";
    setEmbedError(msg);
    Sevyn.log("BROWSER embed failed " + msg);
  }

  // Mount + resize: the host re-lays out the root on resize and
  // the renderer re-renders, so this effect re-fires with the new
  // Sevyn.width/height and re-reports the rect (idempotent).
  React.useEffect(() => {
    if (tabsRef.current.length > 0) reportEmbed();
    // reportEmbed reads Sevyn.width/height at call time; the
    // effect re-runs only when the size changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Sevyn.width, Sevyn.height]);

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
    // Chromium is up, so report the content rect for adoption now.
    const listed = found.find((t) => t.url === url) ?? null;
    if (listed && listed.title !== "") {
      reportEmbed();
      return;
    }
    const settled = await settleOpenedTab(url);
    if (settled) {
      setActiveId(settled.id);
      // Cold start: `browser open` returned no tab line, so no
      // BROWSER open was logged above — log it now that the tab
      // exists. (When one was already logged, do not log a second.)
      if (!opened) {
        Sevyn.log("BROWSER open title=" + settled.title + " url=" + settled.url);
      }
      // The tab has a title, so Chromium has mapped — adopt now.
      reportEmbed();
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
          height: tokens.window.titleBarHeight,
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
        <Text
          style={{
            fontSize: 16,
            fontWeight: "bold",
            color: windowActive ? "#ffffff" : tokens.color.dark.textSecondary,
            flex: 1,
          }}
        >
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
          {embedded ? "  ·  embedded: " + embedded : ""}
        </Text>
      </View>
      <View style={{ flex: 1, paddingLeft: 16, paddingRight: 16, paddingTop: 16 }}>
        <Text style={{ fontSize: 15, color: "#0f172a" }}>
          {active ? active.title : "Browse the web."}
        </Text>
        {embedded !== null && embedded.startsWith("yes") ? (
          // Adopted: Chromium paints the page over this area, so
          // the text below is covered — it stays as the fallback
          // if the adoption ever drops.
          <Text style={{ fontSize: 14, color: "#475569", marginTop: 8 }}>
            The page renders in the adopted Chromium window inside this Browser window
            (chromeless — SevynOS chrome only).
          </Text>
        ) : active ? (
          <Text style={{ fontSize: 14, color: "#475569", marginTop: 8 }}>
            {embedded === null
              ? "Embedding the page into this window…"
              : "The page could not be embedded into this window" +
                (embedError ? ": " + embedError : "") +
                ". The tab is still open — use the address bar to retry."}
          </Text>
        ) : (
          <Text style={{ fontSize: 14, color: "#475569", marginTop: 8 }}>
            The page renders in the adopted Chromium window inside this Browser window
            (chromeless — SevynOS chrome only). Use the address bar above to open a page,
            and the tabs to switch between pages.
          </Text>
        )}
        {error ? (
          <Text style={{ fontSize: 14, color: "#dc2626", marginTop: 8 }}>{error}</Text>
        ) : null}
      </View>
    </View>
  );
}
