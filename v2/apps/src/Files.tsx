// SevynOS v2 — the Files system app (File Explorer port of #122).
//
// Opens a real directory: every listing comes from `sevyn files
// list <path>` through the host's Sevyn.exec bridge (cli.exec
// permission). Directories are pressables — tap to select, tap a
// selected directory again (or Tab + Enter on it) to navigate in;
// ".." goes up. The app logs FILES listed <path> (<n>) after every
// successful listing, which is what the harness asserts on. Files are
// shown, not opened — opening is a later milestone.
//
// Cut/copy/paste (no right-click in v2 — the renderer dispatches any
// pressed pointer button to onPress and there is no onContextMenu):
// tap an entry to select it, then Cut / Copy / Paste / Delete on the
// toolbar. The clipboard lives in /data/.files-clipboard.json via
// `sevyn files clipboard` so it survives an app restart. Paste
// resolves collisions to `name (1)` and a cross-device move falls
// back to copy + delete in the CLI. The Devices sidebar lists the
// volumes from `sevyn files volumes` (internal drive first); a
// removable volume offers Eject. Out of scope for this port: trash,
// archive extract, search, grid/list toggle, back/forward,
// breadcrumbs, Places.

import * as React from "react";
import { View, Text, Image, Pressable, ScrollView } from "./host";
import { WindowButtons } from "./window-buttons";
import { runCli } from "./cli";
import { appIconTitlePath, symbolPath } from "./icons";
import {
  isCrossVolumeMove,
  isCutPasteNoop,
  joinPath,
  resolvePasteTarget,
  type ClipboardEntry,
} from "./clipboard";
import {
  detectUnpluggedBrowsePath,
  formatBytes,
  formatVolumeCapacity,
  parseClipboardOutput,
  parseVolumesOutput,
  sortVolumesForSidebar,
  type Volume,
} from "./volumes";
import { driveTile, fileTileForEntry, glyphForIcon } from "./file-icons";

type Entry = { type: string; name: string };

function listDir(path: string): { entries: Entry[]; error: string | null } {
  const { code, out } = runCli("sevyn files list " + path);
  if (code !== 0) return { entries: [], error: out.trim() || "could not list " + path };
  const entries: Entry[] = [];
  for (const line of out.split("\n")) {
    if (!line) continue;
    const type = line[0];
    const name = line.slice(2);
    // Dotfiles stay hidden — including the clipboard state file
    // /data/.files-clipboard.json, which lives in /data.
    if (name.startsWith(".")) continue;
    if (type === "d" || type === "f" || type === "l") entries.push({ type, name });
  }
  return { entries, error: null };
}

function loadVolumes(): Volume[] {
  const { code, out } = runCli("sevyn files volumes");
  if (code !== 0) return [];
  return sortVolumesForSidebar(parseVolumesOutput(out));
}

function loadClipboard(): ClipboardEntry | null {
  const { code, out } = runCli("sevyn files clipboard");
  if (code !== 0) return null;
  return parseClipboardOutput(out);
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
  const [volumes, setVolumes] = React.useState<Volume[]>(() => loadVolumes());
  const [clipboard, setClipboard] = React.useState<ClipboardEntry | null>(() =>
    loadClipboard(),
  );
  const [selected, setSelected] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const seenMounts = React.useRef<Set<string>>(new Set(volumes.map((v) => v.mountPoint)));
  const color = Sevyn.appColor;

  function refreshVolumes(currentPath: string): void {
    const next = loadVolumes();
    for (const v of next) seenMounts.current.add(v.mountPoint);
    setVolumes(next);
    const unplugged = detectUnpluggedBrowsePath(currentPath, seenMounts.current, next);
    if (unplugged) {
      setStatus("Device unplugged: " + unplugged);
      navigate("/data");
    }
  }

  function navigate(next: string): void {
    const r = listDir(next);
    if (r.error) {
      setError(r.error);
      return;
    }
    setError(null);
    setPath(next);
    setEntries(r.entries);
    setSelected(null);
    Sevyn.log("FILES listed " + next + " (" + r.entries.length + ")");
    refreshVolumes(next);
  }

  function selectedEntry(): Entry | null {
    if (!selected) return null;
    for (const e of entries) if (e.name === selected) return e;
    return null;
  }

  function pressEntry(e: Entry): void {
    if (selected === e.name && e.type === "d") {
      navigate(joinPath(path, e.name));
      return;
    }
    setSelected(e.name);
    setStatus("Selected " + e.name);
  }

  function cutOrCopy(kind: "cut" | "copy"): void {
    const e = selectedEntry();
    if (!e) {
      setStatus(kind === "cut" ? "Select an item to cut." : "Select an item to copy.");
      return;
    }
    const srcKind = e.type === "d" ? "directory" : "file";
    const srcPath = joinPath(path, e.name);
    const { code, out } = runCli(
      "sevyn files clipboard set " + kind + " " + srcPath + " " + e.name + " " + srcKind,
    );
    if (code !== 0) {
      setError(out.trim() || "could not set the clipboard");
      return;
    }
    setClipboard({ kind, sourcePath: srcPath, sourceName: e.name, sourceKind: srcKind });
    setStatus((kind === "cut" ? "Cut " : "Copied ") + e.name);
  }

  function paste(): void {
    if (!clipboard) {
      setStatus("Clipboard is empty.");
      return;
    }
    if (isCutPasteNoop(clipboard, path)) {
      setStatus("Already here.");
      return;
    }
    const existing = new Set(entries.map((e) => e.name));
    const target = resolvePasteTarget(clipboard, path, existing);
    if (!target) {
      setStatus("Cannot paste " + clipboard.sourceName + " here.");
      return;
    }
    const verb = clipboard.kind === "cut" ? "move" : "copy";
    const cross = isCrossVolumeMove(
      clipboard.sourcePath,
      path,
      volumes.map((v) => ({ mountPoint: v.mountPoint })),
    );
    const { code, out } = runCli(
      "sevyn files " + verb + " " + clipboard.sourcePath + " " + target.targetPath,
    );
    if (code !== 0) {
      setError(out.trim() || "could not paste " + clipboard.sourceName);
      return;
    }
    if (clipboard.kind === "cut") {
      runCli("sevyn files clipboard clear");
      setClipboard(null);
    }
    setStatus("Pasted " + target.targetName + (cross ? " (copied across devices)" : ""));
    setSelected(null);
    navigate(path);
  }

  function deleteSelected(): void {
    const e = selectedEntry();
    if (!e) {
      setStatus("Select an item to delete.");
      return;
    }
    const target = joinPath(path, e.name);
    const { code, out } = runCli("sevyn files delete " + target);
    if (code !== 0) {
      setError(out.trim() || "could not delete " + e.name);
      return;
    }
    setStatus("Deleted " + e.name);
    setSelected(null);
    navigate(path);
  }

  function eject(mountPoint: string, label: string): void {
    const { code, out } = runCli("sevyn files eject " + mountPoint);
    if (code !== 0) {
      setError(out.trim() || "could not eject " + label);
      return;
    }
    setStatus("Ejected " + label);
    refreshVolumes(path);
  }

  const clipboardLabel = clipboard
    ? "Clipboard: " + clipboard.kind + " " + clipboard.sourceName
    : "Clipboard empty";

  function toolbarButton(label: string, onPress: () => void, active: boolean) {
    return (
      <Pressable
        onPress={onPress}
        style={{
          height: 28,
          paddingLeft: 12,
          paddingRight: 12,
          marginRight: 8,
          borderRadius: 6,
          backgroundColor: active ? "#ffffff" : "#e5e7eb",
          justifyContent: "center",
          alignItems: "center",
        }}
      >
        <Text style={{ fontSize: 13, color: active ? "#111827" : "#9ca3af" }}>
          {label}
        </Text>
      </Pressable>
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
        <Image
          source={appIconTitlePath("files")}
          style={{ width: 20, height: 20, marginRight: 8 }}
        />
        <Text style={{ fontSize: 16, fontWeight: "bold", color: "#ffffff", flex: 1 }}>
          Files
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
          <Image source={symbolPath("close")} style={{ width: 16, height: 16 }} />
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
      <View
        style={{
          flexDirection: "row",
          height: 36,
          backgroundColor: "#f3f4f6",
          alignItems: "center",
          paddingLeft: 12,
          paddingRight: 12,
        }}
      >
        {toolbarButton("Cut", () => cutOrCopy("cut"), selected !== null)}
        {toolbarButton("Copy", () => cutOrCopy("copy"), selected !== null)}
        {toolbarButton("Paste", paste, clipboard !== null)}
        {toolbarButton("Delete", deleteSelected, selected !== null)}
      </View>
      <View style={{ flex: 1, flexDirection: "row" }}>
        <View
          style={{
            width: 168,
            backgroundColor: "#f3f4f6",
            paddingLeft: 12,
            paddingRight: 8,
            paddingTop: 8,
          }}
        >
          <Text style={{ fontSize: 13, fontWeight: "bold", color: "#374151" }}>
            Devices
          </Text>
          {volumes.map((v) => {
            const tile = driveTile();
            return (
              <View key={v.mountPoint} style={{ marginTop: 8 }}>
                <Pressable
                  onPress={() => navigate(v.mountPoint)}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    backgroundColor: path === v.mountPoint ? "#dbeafe" : "#f3f4f6",
                    borderRadius: 6,
                    paddingTop: 4,
                    paddingBottom: 4,
                    paddingLeft: 4,
                    paddingRight: 4,
                  }}
                >
                  <View
                    style={{
                      width: 24,
                      height: 24,
                      borderRadius: 6,
                      backgroundColor: tile.tileColor,
                      justifyContent: "center",
                      alignItems: "center",
                      marginRight: 8,
                    }}
                  >
                    <Text style={{ fontSize: 14, color: "#ffffff" }}>
                      {glyphForIcon(tile.icon)}
                    </Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 13, color: "#111827" }}>{v.label}</Text>
                    <Text style={{ fontSize: 11, color: "#6b7280" }}>
                      {formatVolumeCapacity(v.sizeBytes, v.availableBytes, formatBytes)}
                    </Text>
                  </View>
                </Pressable>
                {v.removable ? (
                  <Pressable
                    onPress={() => eject(v.mountPoint, v.label)}
                    style={{
                      height: 24,
                      marginTop: 2,
                      marginLeft: 36,
                      justifyContent: "center",
                    }}
                  >
                    <Text style={{ fontSize: 12, color: "#2563eb" }}>Eject</Text>
                  </Pressable>
                ) : null}
              </View>
            );
          })}
        </View>
        {/* GF65 scroll fix: the listing scrolls when it outgrows the
            window. Header + path bar stay fixed; only entries scroll. */}
        <ScrollView style={{ flex: 1, paddingLeft: 12, paddingRight: 12, paddingTop: 8 }}>
          {path !== "/" ? (
            <Pressable
              onPress={() => navigate(parentOf(path))}
              style={{ height: 36, justifyContent: "center" }}
            >
              <View style={{ flexDirection: "row", alignItems: "center" }}>
                <Image
                  source={symbolPath("up")}
                  style={{ width: 16, height: 16, marginRight: 4 }}
                />
                <Text style={{ fontSize: 14, color: "#111827" }}>..</Text>
              </View>
            </Pressable>
          ) : null}
          {entries.map((e) => {
            const tile = fileTileForEntry(e.name, e.type === "d" ? "directory" : "file");
            const isSelected = selected === e.name;
            return (
              <Pressable
                key={e.name}
                onPress={() => pressEntry(e)}
                style={{
                  height: 36,
                  justifyContent: "center",
                  backgroundColor: isSelected ? "#dbeafe" : "#f9fafb",
                  borderRadius: 6,
                  paddingLeft: 4,
                }}
              >
                <View style={{ flexDirection: "row", alignItems: "center" }}>
                  <View
                    style={{
                      width: 24,
                      height: 24,
                      borderRadius: 6,
                      backgroundColor: tile.tileColor,
                      justifyContent: "center",
                      alignItems: "center",
                      marginRight: 8,
                    }}
                  >
                    <Text style={{ fontSize: 14, color: "#ffffff" }}>
                      {glyphForIcon(tile.icon)}
                    </Text>
                  </View>
                  <Text
                    style={{
                      fontSize: 14,
                      color: e.type === "d" ? "#111827" : "#6b7280",
                    }}
                  >
                    {e.name}
                  </Text>
                </View>
              </Pressable>
            );
          })}
          {entries.length === 0 && !error ? (
            <Text style={{ fontSize: 14, color: "#6b7280", marginTop: 8 }}>
              Empty directory.
            </Text>
          ) : null}
          {error ? (
            <Text style={{ fontSize: 14, color: "#dc2626", marginTop: 8 }}>{error}</Text>
          ) : null}
        </ScrollView>
      </View>
      <View
        style={{
          height: 28,
          backgroundColor: "#e5e7eb",
          justifyContent: "center",
          paddingLeft: 12,
          paddingRight: 12,
        }}
      >
        <Text style={{ fontSize: 12, color: "#374151" }}>
          {clipboardLabel}
          {status ? " — " + status : ""}
        </Text>
      </View>
    </View>
  );
}
