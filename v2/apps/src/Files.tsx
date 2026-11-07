// SevynOS v2 M4 — the Files system app.
//
// Opens a real directory: every listing comes from `sevyn files
// list <path>` through the host's Sevyn.exec bridge (cli.exec
// permission). Directories are pressables — tap (or Tab + Enter) to
// navigate in; ".." goes up. The app logs FILES listed <path> (<n>)
// after every successful listing, which is what the harness asserts
// on. Files are shown, not opened — opening is a later milestone.

import * as React from "react";
import { View, Text, Pressable } from "./host";
import { runCli } from "./cli";

type Entry = { type: string; name: string };

function listDir(path: string): { entries: Entry[]; error: string | null } {
  const { code, out } = runCli("sevyn files list " + path);
  if (code !== 0) return { entries: [], error: out.trim() || "could not list " + path };
  const entries: Entry[] = [];
  for (const line of out.split("\n")) {
    if (!line) continue;
    const type = line[0];
    const name = line.slice(2);
    if (type === "d" || type === "f" || type === "l") entries.push({ type, name });
  }
  return { entries, error: null };
}

function parentOf(p: string): string {
  if (p === "/") return "/";
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}

export function Files(): React.ReactElement {
  const [path, setPath] = React.useState("/data");
  const [entries, setEntries] = React.useState<Entry[]>(() => {
    const r = listDir("/data");
    if (!r.error) Sevyn.log("FILES listed /data (" + r.entries.length + ")");
    return r.entries;
  });
  const [error, setError] = React.useState<string | null>(null);
  const color = Sevyn.appColor;

  function navigate(next: string): void {
    const r = listDir(next);
    if (r.error) {
      setError(r.error);
      return;
    }
    setError(null);
    setPath(next);
    setEntries(r.entries);
    Sevyn.log("FILES listed " + next + " (" + r.entries.length + ")");
  }

  function join(base: string, name: string): string {
    return base === "/" ? "/" + name : base + "/" + name;
  }

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
          Files
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
          height: 32,
          backgroundColor: "#e5e7eb",
          justifyContent: "center",
          paddingLeft: 12,
        }}
      >
        <Text style={{ fontSize: 14, color: "#374151" }}>{path}</Text>
      </View>
      <View style={{ flex: 1, paddingLeft: 12, paddingRight: 12, paddingTop: 8 }}>
        {path !== "/" ? (
          <Pressable
            onPress={() => navigate(parentOf(path))}
            style={{ height: 36, justifyContent: "center" }}
          >
            <Text style={{ fontSize: 14, color: "#111827" }}>↑ ..</Text>
          </Pressable>
        ) : null}
        {entries.map((e) =>
          e.type === "d" ? (
            <Pressable
              key={e.name}
              onPress={() => navigate(join(path, e.name))}
              style={{ height: 36, justifyContent: "center" }}
            >
              <Text style={{ fontSize: 14, color: "#111827" }}>▸ {e.name}</Text>
            </Pressable>
          ) : (
            <View key={e.name} style={{ height: 36, justifyContent: "center" }}>
              <Text style={{ fontSize: 14, color: "#6b7280" }}>{e.name}</Text>
            </View>
          ),
        )}
        {entries.length === 0 && !error ? (
          <Text style={{ fontSize: 14, color: "#6b7280", marginTop: 8 }}>
            Empty directory.
          </Text>
        ) : null}
        {error ? (
          <Text style={{ fontSize: 14, color: "#dc2626", marginTop: 8 }}>{error}</Text>
        ) : null}
      </View>
    </View>
  );
}
