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
// Right-click (gap unit 10, audit #13) opens the unit-9 context
// menu on the hit row — Cut / Copy / Paste / Delete, the toolbar's
// actions, operating on the right-clicked entry (it is selected
// first when it isn't already); Paste is disabled with an empty
// file clipboard. Right-click on empty list space offers Paste
// alone when the clipboard holds an item, and nothing when it
// doesn't. A right-click never fires the row's onPress, so it never
// selects-again-to-open a directory. No Open / Rename / Trash —
// those are later gap units.
//
// Multi-select (gap unit 13, audit #22): plain click selects one
// item; Ctrl/Cmd-click toggles one item in/out (the anchor moves to
// it); Shift-click adds the contiguous range from the anchor to the
// clicked item. Clicking empty list space clears the selection.
// The toolbar and the context menu act on the WHOLE selection.
// Cut/copy/delete run one `sevyn files` command per selected file
// through the existing single-entry file clipboard (see cutOrCopy /
// paste): the clipboard file ends up holding the last entry, so a
// paste after an app restart pastes that one file, exactly like a
// single-file cut/copy; a multi-file paste pastes every entry while
// the app is still running.
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
import { ContextMenu } from "../../rn/renderer/context-menu";
import type { ContextMenuEvent, PressEvent } from "../../rn/renderer/sevyn-renderer";
import { runCli } from "./cli";
import { appIconTitlePath, symbolPath } from "./icons";
import {
  applyPressSelection,
  clearSelection,
  resolveMultiPasteTargets,
  type SelectionState,
} from "./selection";
import {
  isCrossVolumeMove,
  isCutPasteNoop,
  isPasteIntoSelfOrDescendant,
  joinPath,
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
  // Multi-selection (gap unit 13): the selected entry names, in
  // listing order, plus the anchor index a Shift-click ranges from.
  const [selection, setSelection] = React.useState<SelectionState>({
    selected: [],
    anchor: null,
  });
  // The in-memory multi-file clipboard: every entry a multi cut/copy
  // staged, in selection order. The file clipboard above holds only
  // the last one (single-entry protocol — see cutOrCopy), so a paste
  // after an app restart falls back to that one entry.
  const [clipboardItems, setClipboardItems] = React.useState<ClipboardEntry[] | null>(
    null,
  );
  const [status, setStatus] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  // Open context menu: {x, y} is the pointer position it anchors on;
  // target is the right-clicked entry, or null for empty list space.
  const [menu, setMenu] = React.useState<{
    x: number;
    y: number;
    target: string | null;
  } | null>(null);
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
    setSelection(clearSelection());
    Sevyn.log("FILES listed " + next + " (" + r.entries.length + ")");
    refreshVolumes(next);
  }

  function selectedEntries(): Entry[] {
    const picked = new Set(selection.selected);
    return entries.filter((e) => picked.has(e.name));
  }

  function namesOf(es: Entry[]): string[] {
    return es.map((e) => e.name);
  }

  // Plain click selects one item; Ctrl/Cmd-click toggles it (the
  // anchor moves to it); Shift-click adds the range from the anchor.
  // The select-again-to-open rule is unchanged for the single case:
  // a plain click on the SOLE selected directory navigates into it.
  // A plain click on a directory that is one of several selected
  // only collapses the selection to it — otherwise a multi-selection
  // could never be collapsed by clicking one of its members.
  function pressEntry(e: Entry, ev?: PressEvent): void {
    const index = entries.findIndex((entry) => entry.name === e.name);
    if (index < 0) return;
    const modifiers = ev
      ? ev.nativeEvent
      : { shiftKey: false, ctrlKey: false, metaKey: false };
    if (
      !modifiers.shiftKey &&
      !modifiers.ctrlKey &&
      !modifiers.metaKey &&
      selection.selected.length === 1 &&
      selection.selected[0] === e.name &&
      e.type === "d"
    ) {
      navigate(joinPath(path, e.name));
      return;
    }
    const next = applyPressSelection(namesOf(entries), selection, index, modifiers);
    setSelection(next);
    setStatus(
      next.selected.length === 0
        ? "Selection cleared."
        : next.selected.length === 1
          ? "Selected " + next.selected[0]
          : "Selected " + next.selected.length + " items",
    );
  }

  // Clicking empty list space clears the selection. The ScrollView's
  // background is hit-testable (its onPress), and rows are emitted
  // after it, so a row still wins the hit-test where it overlaps
  // the surface — only a genuinely empty click reaches here.
  function pressEmptySpace(): void {
    if (selection.selected.length === 0) return;
    setSelection(clearSelection());
    setStatus("Selection cleared.");
  }

  // Right-click on a row: when the entry is already in the
  // selection the whole selection stays (the menu actions operate on
  // all of it); when it isn't, it becomes the sole selection. This
  // never navigates: a right-click dispatches onContextMenu, not
  // onPress, so the select-again-to-open rule in pressEntry cannot
  // fire.
  function contextMenuForEntry(e: Entry, ev: ContextMenuEvent): void {
    const index = entries.findIndex((entry) => entry.name === e.name);
    if (!selection.selected.includes(e.name)) {
      const next = { selected: [e.name], anchor: index < 0 ? null : index };
      setSelection(next);
      setStatus("Selected " + e.name);
    }
    setMenu({ x: ev.nativeEvent.x, y: ev.nativeEvent.y, target: e.name });
  }

  // Right-click on empty list space: only Paste makes sense here, and
  // only when the file clipboard holds an item. With an empty
  // clipboard there is nothing to offer, so no menu opens at all.
  function contextMenuForEmptySpace(ev: ContextMenuEvent): void {
    if (pasteEntries().length === 0) return;
    setMenu({ x: ev.nativeEvent.x, y: ev.nativeEvent.y, target: null });
  }

  function cutOrCopy(kind: "cut" | "copy"): void {
    const picked = selectedEntries();
    if (picked.length === 0) {
      setStatus(kind === "cut" ? "Select an item to cut." : "Select an item to copy.");
      return;
    }
    // One `clipboard set` per file through the existing single-entry
    // protocol: the file ends up holding the last entry, so a paste
    // after an app restart pastes that one file, exactly like a
    // single-file cut/copy. The full list lives in clipboardItems
    // for a paste while the app is still running.
    const items: ClipboardEntry[] = [];
    for (const e of picked) {
      const srcKind = e.type === "d" ? "directory" : "file";
      const srcPath = joinPath(path, e.name);
      const { code, out } = runCli(
        "sevyn files clipboard set " +
          kind +
          " " +
          srcPath +
          " " +
          e.name +
          " " +
          srcKind,
      );
      if (code !== 0) {
        setError(out.trim() || "could not set the clipboard");
        return;
      }
      items.push({ kind, sourcePath: srcPath, sourceName: e.name, sourceKind: srcKind });
    }
    const last = items[items.length - 1];
    setClipboard(last);
    setClipboardItems(items);
    setStatus(
      (kind === "cut" ? "Cut " : "Copied ") +
        (items.length === 1 ? items[0].sourceName : items.length + " items"),
    );
  }

  // The entries a paste draws on: the in-memory multi list when the
  // cut/copy happened in this run, else the single file-backed entry.
  function pasteEntries(): ClipboardEntry[] {
    if (clipboardItems !== null) return clipboardItems;
    return clipboard !== null ? [clipboard] : [];
  }

  function paste(): void {
    const items = pasteEntries();
    if (items.length === 0) {
      setStatus("Clipboard is empty.");
      return;
    }
    const kind = items[0].kind;
    if (kind === "cut" && items.every((entry) => isCutPasteNoop(entry, path))) {
      setStatus("Already here.");
      return;
    }
    const existing = new Set(entries.map((e) => e.name));
    const targets = resolveMultiPasteTargets(items, path, existing);
    if (!targets) {
      const refused = items.find((entry) =>
        isPasteIntoSelfOrDescendant(entry.sourcePath, path),
      );
      setStatus("Cannot paste " + (refused ? refused.sourceName : "here") + " here.");
      return;
    }
    // Resolve every target BEFORE moving anything: a paste is
    // all-or-nothing on resolution, so a refused entry aborts the
    // whole paste instead of leaving half of it done.
    const verb = kind === "cut" ? "move" : "copy";
    const vols = volumes.map((v) => ({ mountPoint: v.mountPoint }));
    const cross = items.some((entry) => isCrossVolumeMove(entry.sourcePath, path, vols));
    let pasted = 0;
    for (const target of targets) {
      const { code, out } = runCli(
        "sevyn files " + verb + " " + target.entry.sourcePath + " " + target.targetPath,
      );
      if (code !== 0) {
        setError(out.trim() || "could not paste " + target.entry.sourceName);
        if (pasted > 0)
          setStatus("Pasted " + pasted + " of " + targets.length + " items");
        return;
      }
      pasted += 1;
    }
    if (kind === "cut") {
      runCli("sevyn files clipboard clear");
      setClipboard(null);
      setClipboardItems(null);
    }
    setStatus(
      "Pasted " +
        (targets.length === 1 ? targets[0].targetName : targets.length + " items") +
        (cross ? " (copied across devices)" : ""),
    );
    navigate(path);
  }

  function deleteSelected(): void {
    const picked = selectedEntries();
    if (picked.length === 0) {
      setStatus("Select an item to delete.");
      return;
    }
    let deleted = 0;
    for (const e of picked) {
      const target = joinPath(path, e.name);
      const { code, out } = runCli("sevyn files delete " + target);
      if (code !== 0) {
        setError(out.trim() || "could not delete " + e.name);
        if (deleted > 0)
          setStatus("Deleted " + deleted + " of " + picked.length + " items");
        navigate(path);
        return;
      }
      deleted += 1;
    }
    setStatus("Deleted " + (deleted === 1 ? picked[0].name : deleted + " items"));
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

  const hasClipboard = pasteEntries().length > 0;
  const clipboardLabel =
    clipboardItems !== null && clipboardItems.length > 1
      ? "Clipboard: " + clipboardItems[0].kind + " " + clipboardItems.length + " items"
      : clipboard
        ? "Clipboard: " + clipboard.kind + " " + clipboard.sourceName
        : "Clipboard empty";

  // The open menu's items: the toolbar's actions on the selection
  // (Paste disabled with an empty file clipboard), Paste alone on
  // empty space. Labels count the selection when it holds more than
  // one item. No Open / Rename / Trash — those are later gap units.
  const selectionCount = selection.selected.length;
  const countSuffix = selectionCount > 1 ? " (" + selectionCount + " items)" : "";
  const menuItems =
    menu === null
      ? []
      : menu.target !== null
        ? [
            {
              id: "cut",
              label: "Cut" + countSuffix,
              onSelect: () => cutOrCopy("cut"),
            },
            {
              id: "copy",
              label: "Copy" + countSuffix,
              onSelect: () => cutOrCopy("copy"),
            },
            {
              id: "paste",
              label: "Paste",
              disabled: !hasClipboard,
              onSelect: paste,
            },
            {
              id: "delete",
              label: "Delete" + countSuffix,
              onSelect: deleteSelected,
            },
          ]
        : [{ id: "paste", label: "Paste", onSelect: paste }];

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
        {toolbarButton("Cut", () => cutOrCopy("cut"), selection.selected.length > 0)}
        {toolbarButton("Copy", () => cutOrCopy("copy"), selection.selected.length > 0)}
        {toolbarButton("Paste", paste, hasClipboard)}
        {toolbarButton("Delete", deleteSelected, selection.selected.length > 0)}
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
            window. Header + path bar stay fixed; only entries scroll.
            The list surface carries the background color so the
            renderer's hit-test sees it (a ScrollView with
            onContextMenu is hit-testable through its background rect)
            — right-click on empty list space opens the Paste menu,
            and a left-click there clears the selection (gap unit 13:
            the ScrollView's onPress is hit-testable the same way). */}
        <ScrollView
          onPress={() => pressEmptySpace()}
          onContextMenu={(ev: ContextMenuEvent) => contextMenuForEmptySpace(ev)}
          style={{
            flex: 1,
            backgroundColor: "#f9fafb",
            paddingLeft: 12,
            paddingRight: 12,
            paddingTop: 8,
          }}
        >
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
            const isSelected = selection.selected.includes(e.name);
            return (
              <Pressable
                key={e.name}
                onPress={(ev: PressEvent) => pressEntry(e, ev)}
                onContextMenu={(ev: ContextMenuEvent) => contextMenuForEntry(e, ev)}
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
      {/* Context menu (gap unit 10): last child so it draws and
          hit-tests above everything else. */}
      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onDismiss={() => setMenu(null)}
        />
      ) : null}
    </View>
  );
}
