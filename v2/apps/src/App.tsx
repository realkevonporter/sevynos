// SevynOS v2 M3 — the generic stock-app screen.
//
// One template serves every stock app: the host passes the app's
// identity (Sevyn.appId / appName / appColor, from the manifest via
// appd) and the app renders its own window — header with the app
// name and a close X, body with real content for that app.
//
// M9 gives each stock app a real first screen instead of the empty
// glyph tile: a working calculator, a real month calendar, notes
// backed by /data/notes via `sevyn files`, the store listing the
// actually installed apps, and honest designed states (no fake
// content) for music, photos, camera, and messages.
//
// The close X calls Sevyn.closeApp(): the host exits 0 and appd
// reports STOPPED. (The compositor's window close button does the
// same through the host's close handler.)

import * as React from "react";
import { View, Text, Pressable, ScrollView, TextInput } from "./host";
import { WindowButtons } from "./window-buttons";
import {
  subscribeStatus,
  getStatusSnapshot,
  subscribeApps,
  getAppsSnapshot,
} from "../../rn/renderer/sevyn-renderer";
import { runCli } from "./cli";

function statusText(status: { [key: string]: string }): string {
  const battery = status.battery ?? "—";
  const volume = status.volume ?? "—";
  const wifi = status.wifi === "on" ? "Wi-Fi" : "offline";
  return `Status: ${wifi} · ${battery}% · Vol ${volume}`;
}

// Shared polish tokens (2026-09-28 directive): 16px outer padding,
// 12px gaps, section titles 16 bold, body 14, muted #6b7280, cards
// white with 12px radius on #f9fafb.
function Card(props: { children: React.ReactNode }): React.ReactElement {
  return (
    <View
      style={{
        backgroundColor: "#ffffff",
        borderRadius: 12,
        paddingLeft: 16,
        paddingRight: 16,
        paddingTop: 12,
        paddingBottom: 12,
      }}
    >
      {props.children}
    </View>
  );
}

function EmptyState(props: {
  glyph: string;
  color: string;
  title: string;
  body: string;
  footer?: string;
}): React.ReactElement {
  return (
    <View
      style={{
        flex: 1,
        justifyContent: "center",
        alignItems: "center",
        paddingLeft: 24,
        paddingRight: 24,
      }}
    >
      <View
        style={{
          width: 72,
          height: 72,
          backgroundColor: props.color,
          borderRadius: 18,
          justifyContent: "center",
          alignItems: "center",
        }}
      >
        <Text
          style={{
            fontSize: 36,
            fontWeight: "bold",
            color: "#ffffff",
            textAlign: "center",
          }}
        >
          {props.glyph}
        </Text>
      </View>
      <Text
        style={{
          fontSize: 18,
          fontWeight: "bold",
          color: "#111827",
          textAlign: "center",
          marginTop: 16,
        }}
      >
        {props.title}
      </Text>
      <Text style={{ fontSize: 14, color: "#6b7280", textAlign: "center", marginTop: 8 }}>
        {props.body}
      </Text>
      {props.footer ? (
        <Text
          style={{ fontSize: 14, color: "#6b7280", textAlign: "center", marginTop: 16 }}
        >
          {props.footer}
        </Text>
      ) : null}
    </View>
  );
}

// --- Calculator: real arithmetic in React state. -------------------
function applyOp(acc: number, input: number, op: string): number | null {
  if (op === "+") return acc + input;
  if (op === "−") return acc - input;
  if (op === "×") return acc * input;
  if (op === "÷") return input === 0 ? null : acc / input;
  return null;
}

function formatNum(n: number): string {
  if (!Number.isFinite(n)) return "Error";
  const s = String(Math.round(n * 1e10) / 1e10);
  return s;
}

function Calculator(): React.ReactElement {
  const [display, setDisplay] = React.useState<string>("0");
  const [acc, setAcc] = React.useState<number | null>(null);
  const [op, setOp] = React.useState<string | null>(null);
  const [fresh, setFresh] = React.useState<boolean>(true);

  function digit(d: string): void {
    if (fresh) {
      setDisplay(d);
      setFresh(false);
    } else {
      setDisplay(display === "0" ? d : display + d);
    }
  }
  function dot(): void {
    if (fresh) {
      setDisplay("0.");
      setFresh(false);
    } else if (!display.includes(".")) {
      setDisplay(display + ".");
    }
  }
  function clearAll(): void {
    setDisplay("0");
    setAcc(null);
    setOp(null);
    setFresh(true);
  }
  function backspace(): void {
    if (fresh) return;
    const next = display.slice(0, -1);
    setDisplay(next === "" || next === "-" ? "0" : next);
  }
  function percent(): void {
    const v = parseFloat(display);
    if (Number.isNaN(v)) return;
    setDisplay(formatNum(v / 100));
    setFresh(true);
  }
  function operator(nextOp: string): void {
    const input = parseFloat(display);
    if (acc !== null && op !== null && !fresh) {
      const result = applyOp(acc, input, op);
      if (result === null) {
        setDisplay("Error");
        setAcc(null);
        setOp(null);
        setFresh(true);
        return;
      }
      setAcc(result);
      setDisplay(formatNum(result));
    } else if (!Number.isNaN(input)) {
      setAcc(input);
    }
    setOp(nextOp);
    setFresh(true);
  }
  function equals(): void {
    if (acc === null || op === null) return;
    const input = parseFloat(display);
    const result = applyOp(acc, input, op);
    setDisplay(result === null ? "Error" : formatNum(result));
    setAcc(null);
    setOp(null);
    setFresh(true);
  }

  function key(
    label: string,
    onPress: () => void,
    flex = 1,
    dark = false,
  ): React.ReactElement {
    return (
      <Pressable
        key={label + String(flex)}
        onPress={onPress}
        style={{
          flex,
          height: 52,
          borderRadius: 8,
          backgroundColor: dark ? "#111827" : "#ffffff",
          justifyContent: "center",
          alignItems: "center",
          margin: 4,
        }}
      >
        <Text
          style={{
            fontSize: 20,
            color: dark ? "#ffffff" : "#111827",
            textAlign: "center",
          }}
        >
          {label}
        </Text>
      </Pressable>
    );
  }

  return (
    <View style={{ flex: 1, padding: 16 }}>
      <View
        style={{
          backgroundColor: "#ffffff",
          borderRadius: 12,
          paddingLeft: 16,
          paddingRight: 16,
          paddingTop: 16,
          paddingBottom: 16,
          alignItems: "flex-end",
        }}
      >
        <Text style={{ fontSize: 32, color: "#111827", textAlign: "right" }}>
          {display}
        </Text>
      </View>
      <View style={{ flexDirection: "row", marginTop: 12 }}>
        {key("C", clearAll)}
        {key("⌫", backspace)}
        {key("%", percent)}
        {key("÷", () => operator("÷"), 1, true)}
      </View>
      <View style={{ flexDirection: "row" }}>
        {key("7", () => digit("7"))}
        {key("8", () => digit("8"))}
        {key("9", () => digit("9"))}
        {key("×", () => operator("×"), 1, true)}
      </View>
      <View style={{ flexDirection: "row" }}>
        {key("4", () => digit("4"))}
        {key("5", () => digit("5"))}
        {key("6", () => digit("6"))}
        {key("−", () => operator("−"), 1, true)}
      </View>
      <View style={{ flexDirection: "row" }}>
        {key("1", () => digit("1"))}
        {key("2", () => digit("2"))}
        {key("3", () => digit("3"))}
        {key("+", () => operator("+"), 1, true)}
      </View>
      <View style={{ flexDirection: "row" }}>
        {key("0", () => digit("0"), 2)}
        {key(".", dot)}
        {key("=", equals, 1, true)}
      </View>
    </View>
  );
}

// --- Calendar: the real current month from Date. -------------------
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];

function Calendar(): React.ReactElement {
  const now = new Date();
  const [cursor, setCursor] = React.useState({ y: now.getFullYear(), m: now.getMonth() });
  const first = new Date(cursor.y, cursor.m, 1);
  const startDay = first.getDay();
  const daysInMonth = new Date(cursor.y, cursor.m + 1, 0).getDate();
  const isThisMonth = cursor.y === now.getFullYear() && cursor.m === now.getMonth();
  const cells: (number | null)[] = [];
  for (let i = 0; i < startDay; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  const weeks: (number | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));

  function step(delta: number): void {
    let m = cursor.m + delta;
    let y = cursor.y;
    if (m < 0) {
      m = 11;
      y -= 1;
    } else if (m > 11) {
      m = 0;
      y += 1;
    }
    setCursor({ y, m });
  }

  return (
    <View style={{ flex: 1, padding: 16 }}>
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        <Pressable
          onPress={() => step(-1)}
          style={{
            width: 36,
            height: 36,
            borderRadius: 8,
            backgroundColor: "#ffffff",
            justifyContent: "center",
            alignItems: "center",
          }}
        >
          <Text style={{ fontSize: 18, color: "#111827", textAlign: "center" }}>
            {"<"}
          </Text>
        </Pressable>
        <Text
          style={{
            fontSize: 18,
            fontWeight: "bold",
            color: "#111827",
            flex: 1,
            textAlign: "center",
          }}
        >
          {MONTHS[cursor.m]} {cursor.y}
        </Text>
        <Pressable
          onPress={() => step(1)}
          style={{
            width: 36,
            height: 36,
            borderRadius: 8,
            backgroundColor: "#ffffff",
            justifyContent: "center",
            alignItems: "center",
          }}
        >
          <Text style={{ fontSize: 18, color: "#111827", textAlign: "center" }}>
            {">"}
          </Text>
        </Pressable>
      </View>
      <View style={{ flexDirection: "row", marginTop: 16 }}>
        {WEEKDAYS.map((d, i) => (
          <Text
            key={i}
            style={{
              flex: 1,
              fontSize: 13,
              fontWeight: "bold",
              color: "#6b7280",
              textAlign: "center",
            }}
          >
            {d}
          </Text>
        ))}
      </View>
      {weeks.map((week, wi) => (
        <View key={wi} style={{ flexDirection: "row", marginTop: 4 }}>
          {week.map((d, di) => {
            const isToday = isThisMonth && d === now.getDate();
            return (
              <View key={di} style={{ flex: 1, alignItems: "center" }}>
                {d === null ? null : (
                  <View
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: 16,
                      backgroundColor: isToday ? "#111827" : "#00000000",
                      justifyContent: "center",
                      alignItems: "center",
                    }}
                  >
                    <Text
                      style={{
                        fontSize: 15,
                        fontWeight: isToday ? "bold" : "normal",
                        color: isToday ? "#ffffff" : "#111827",
                        textAlign: "center",
                      }}
                    >
                      {String(d)}
                    </Text>
                  </View>
                )}
              </View>
            );
          })}
        </View>
      ))}
    </View>
  );
}

// --- Notes: real notes in /data/notes via `sevyn files`. -----------
function listNotes(): string[] {
  const { code, out } = runCli("sevyn files list /data/notes");
  if (code !== 0) return [];
  const names: string[] = [];
  for (const line of out.split("\n")) {
    if (line.startsWith("f ")) names.push(line.slice(2));
  }
  return names;
}

function Notes(): React.ReactElement {
  const [names, setNames] = React.useState<string[]>(() => listNotes());
  const [open, setOpen] = React.useState<string | null>(null);
  const [body, setBody] = React.useState<string>("");
  const [saved, setSaved] = React.useState<string>("");

  function openNote(name: string): void {
    const { code, out } = runCli("sevyn files cat /data/notes/" + name);
    setOpen(name);
    setBody(code === 0 ? out : "");
    setSaved("");
  }

  function newNote(): void {
    const name = "Note " + (names.length + 1);
    setOpen(name);
    setBody("");
    setSaved("");
  }

  function saveNote(): void {
    if (!open) return;
    runCli("sevyn files mkdir /data/notes");
    // `files write` joins its arguments with spaces; quote the
    // path so a name with a space stays one argument. Long notes
    // hit the host's 64-token CLI cap — v1 keeps notes short.
    const quoted = '"' + open.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
    const { code } = runCli("sevyn files write /data/notes/" + quoted + " " + body);
    if (code !== 0) {
      setSaved("Could not save.");
      return;
    }
    setNames(listNotes());
    setSaved("Saved.");
    Sevyn.log("NOTES saved=" + open);
  }

  if (open !== null) {
    return (
      <View style={{ flex: 1, padding: 16 }}>
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <Pressable
            onPress={() => {
              setOpen(null);
              setNames(listNotes());
            }}
            style={{
              height: 36,
              borderRadius: 8,
              backgroundColor: "#e5e7eb",
              justifyContent: "center",
              alignItems: "center",
              paddingLeft: 12,
              paddingRight: 12,
              marginRight: 12,
            }}
          >
            <Text style={{ fontSize: 15, color: "#111827" }}>{"< Notes"}</Text>
          </Pressable>
          <Text style={{ fontSize: 16, fontWeight: "bold", color: "#111827", flex: 1 }}>
            {open}
          </Text>
          <Pressable
            onPress={saveNote}
            style={{
              height: 36,
              borderRadius: 8,
              backgroundColor: "#111827",
              justifyContent: "center",
              alignItems: "center",
              paddingLeft: 16,
              paddingRight: 16,
            }}
          >
            <Text style={{ fontSize: 15, fontWeight: "bold", color: "#ffffff" }}>
              Save
            </Text>
          </Pressable>
        </View>
        <TextInput
          value={body}
          onChangeText={setBody}
          placeholder="Write a note…"
          multiline
          style={{
            flex: 1,
            backgroundColor: "#ffffff",
            borderRadius: 12,
            paddingLeft: 16,
            paddingRight: 16,
            paddingTop: 12,
            marginTop: 12,
            fontSize: 15,
            color: "#111827",
          }}
        />
        {saved ? (
          <Text style={{ fontSize: 14, color: "#6b7280", marginTop: 8 }}>{saved}</Text>
        ) : null}
      </View>
    );
  }

  return (
    <View style={{ flex: 1, padding: 16 }}>
      <Pressable
        onPress={newNote}
        style={{
          height: 40,
          borderRadius: 8,
          backgroundColor: "#111827",
          justifyContent: "center",
          alignItems: "center",
        }}
      >
        <Text style={{ fontSize: 15, fontWeight: "bold", color: "#ffffff" }}>
          New note
        </Text>
      </Pressable>
      {names.length === 0 ? (
        <Text
          style={{ fontSize: 14, color: "#6b7280", marginTop: 16, textAlign: "center" }}
        >
          No notes yet. Tap New note to write one.
        </Text>
      ) : (
        names.map((n) => (
          <Pressable
            key={n}
            onPress={() => openNote(n)}
            style={{
              backgroundColor: "#ffffff",
              borderRadius: 8,
              paddingLeft: 12,
              paddingRight: 12,
              paddingTop: 12,
              paddingBottom: 12,
              marginTop: 8,
            }}
          >
            <Text style={{ fontSize: 15, color: "#111827" }}>{n}</Text>
          </Pressable>
        ))
      )}
    </View>
  );
}

// --- Store: the actually installed apps, from the same source as
// the dock (Sevyn.listApps via appd). -------------------------------
function Store(): React.ReactElement {
  const snap = React.useSyncExternalStore(subscribeApps, getAppsSnapshot);
  return (
    <View style={{ flex: 1, padding: 16 }}>
      <Text style={{ fontSize: 16, fontWeight: "bold", color: "#111827" }}>
        Installed apps
      </Text>
      <Text style={{ fontSize: 14, color: "#6b7280", marginTop: 4 }}>
        {snap.apps.length} apps on this system
      </Text>
      {snap.apps.map((a) => (
        <View
          key={a.id}
          style={{
            flexDirection: "row",
            alignItems: "center",
            backgroundColor: "#ffffff",
            borderRadius: 8,
            paddingLeft: 12,
            paddingRight: 12,
            paddingTop: 10,
            paddingBottom: 10,
            marginTop: 8,
          }}
        >
          <View
            style={{
              width: 40,
              height: 40,
              backgroundColor: a.color,
              borderRadius: 8,
              justifyContent: "center",
              alignItems: "center",
              marginRight: 12,
            }}
          >
            <Text
              style={{
                fontSize: 20,
                fontWeight: "bold",
                color: "#ffffff",
                textAlign: "center",
              }}
            >
              {a.glyph}
            </Text>
          </View>
          <Text style={{ fontSize: 15, color: "#111827", flex: 1 }}>{a.name}</Text>
          <Text style={{ fontSize: 13, color: "#6b7280", marginRight: 8 }}>
            {a.version}
          </Text>
          {snap.running.includes(a.id) ? (
            <Text style={{ fontSize: 13, color: "#059669" }}>Running</Text>
          ) : null}
        </View>
      ))}
    </View>
  );
}

function countPhotos(): number {
  const { code, out } = runCli("sevyn files list /data");
  if (code !== 0) return 0;
  let n = 0;
  for (const line of out.split("\n")) {
    if (!line.startsWith("f ")) continue;
    const name = line.slice(2).toLowerCase();
    if (
      name.endsWith(".png") ||
      name.endsWith(".jpg") ||
      name.endsWith(".jpeg") ||
      name.endsWith(".webp")
    )
      n++;
  }
  return n;
}

export function App(): React.ReactElement {
  const permitted = Sevyn.hasPermission("status.read");
  const status = React.useSyncExternalStore(subscribeStatus, getStatusSnapshot);
  const name = Sevyn.appName;
  const color = Sevyn.appColor;
  const id = Sevyn.appId;

  let body: React.ReactElement;
  if (id === "calculator") {
    body = <Calculator />;
  } else if (id === "calendar") {
    body = <Calendar />;
  } else if (id === "notes") {
    body = <Notes />;
  } else if (id === "store") {
    body = <Store />;
  } else if (id === "music") {
    body = (
      <EmptyState
        glyph={Sevyn.appGlyph}
        color={color}
        title="No music yet"
        body="Audio files you add to this device will appear here."
        footer={permitted ? statusText(status) : "Status: not permitted"}
      />
    );
  } else if (id === "photos") {
    const n = countPhotos();
    body = (
      <EmptyState
        glyph={Sevyn.appGlyph}
        color={color}
        title={n === 0 ? "No photos yet" : n + (n === 1 ? " photo" : " photos")}
        body={
          n === 0
            ? "Photos saved on this device will appear here."
            : "Photos found on this device."
        }
      />
    );
  } else if (id === "camera") {
    body = (
      <EmptyState
        glyph={Sevyn.appGlyph}
        color={color}
        title="No camera yet"
        body="This device has no camera adapter connected."
      />
    );
  } else if (id === "messages") {
    body = (
      <EmptyState
        glyph={Sevyn.appGlyph}
        color={color}
        title="No conversations yet"
        body="Direct messages aren't available yet."
      />
    );
  } else {
    body = (
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
    );
  }

  return (
    <View
      style={{
        flex: 1,
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
        <WindowButtons />
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
      {/* GF65 scroll fix: the stock-app body scrolls when its content
          outgrows the window (notes list, store list). One wrap here
          serves every stock app; a flex:1 child fills the viewport
          inside a ScrollView, so fitting screens render unchanged. */}
      <ScrollView style={{ flex: 1 }}>{body}</ScrollView>
    </View>
  );
}
