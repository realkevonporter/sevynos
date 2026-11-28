// SevynOS v2 — file drag between folders/apps (gap build unit 15,
// audit #18).
//
// One drag gesture, two paths. While the pointer stays inside the
// source window the renderer owns the drag (like the marquee, and
// node-testable): the row's onPress arms it, moves past the
// threshold show a drag chip, and release commits the move into
// the folder under the pointer. When the pointer leaves the source
// window mid-drag, the session hands off to a Wayland DnD drag
// owned by the compositor (Sevyn.startFileDrag, text/uri-list,
// MOVE|COPY, no icon in v1) and the target client performs the
// move. The target performs the move in both paths; the source
// never deletes — on drag end it just refreshes.
//
// The hook also owns the INCOMING side: while another client's
// drag hovers this window, drag-drop enter/motion/leave/drop
// events arrive through subscribeDragDrop; the hook resolves the
// hover target (via the caller's targetAt) and commits the drop
// through the same onDrop the local path uses.
//
// A press that never crosses the threshold is a click: the row's
// click behaviour runs at release time through onClick, so a
// drag-source row never selects-again-to-open a directory by
// accident. A drag cannot start while a context menu is open
// (canDrag) — a drag must not start under a menu.
//
// Pure helpers (the MIME, the threshold, the hover fill) are
// exported for the node tests; the hook itself is exercised by the
// Files app's node tests through the mock host.
import * as React from "react";
import {
  subscribeDragDrop,
  subscribePointerMove,
  subscribePointerUp,
  startFileDrag,
  type DragDropEvent,
  type PressEvent,
} from "./sevyn-renderer";
import { baseName, dirName, joinPath } from "./file-ops";

/** The MIME a file drag offers (and accepts on drop). */
export const FILE_DRAG_MIME = "text/uri-list";
/** A press becomes a drag after moving this far (px), so a click
 *  that jitters a pixel does not start one. */
export const DRAG_THRESHOLD_PX = 4;
/** Hover fill for the drop target under the pointer (violet 15%
 *  — the same accent tint the selection uses in the manifest). */
export const DRAG_HOVER_FILL = "#5B5BD626";

/** One dragged entry: its name, its kind, and the directory it
 *  came from (each entry carries its own source dir — an incoming
 *  drop's paths may come from different folders). */
export interface FileDragEntry {
  name: string;
  kind: "directory" | "file";
  sourceDir: string;
}

/** A drop target: the absolute directory a drop lands in, the
 *  label for the status line, and whether it is a folder or a
 *  volume (the status reads "into <folder>" / "to <volume>"). */
export interface FileDragTarget {
  dir: string;
  label: string;
  kind: "folder" | "volume";
}

export interface FileDragOptions {
  // The drag payload for the pressed row: the selection when the
  // pressed row is in it, else the pressed row alone. Null when
  // no drag may start from this row.
  payloadForPress: (name: string) => FileDragEntry[] | null;
  // Where a drop at window position (x, y) would land, or null
  // when the position is not a drop target.
  targetAt: (x: number, y: number) => FileDragTarget | null;
  // Commit a drop: move the session's entries into the target's
  // directory, and set the status line. The target performs the
  // move in both paths.
  onDrop: (entries: FileDragEntry[], target: FileDragTarget) => void;
  // The row's click behaviour, run at release time when the press
  // never became a drag. Receives the press event (for its
  // modifiers) and the pressed row's name.
  onClick: (ev: PressEvent, name: string) => void;
  // A drag this client started ended: dropped is true when it
  // landed on an accepting target. The source just refreshes.
  onDragEnd?: (dropped: boolean) => void;
  // Whether a drag may start at all (false while a menu is open).
  canDrag?: () => boolean;
}

export interface FileDragChip {
  label: string;
  x: number;
  y: number;
}

export interface FileDragHandle {
  // The onPress a drag-source row installs: arms the drag and
  // returns true when the press is a drag start (the row's click
  // then moves to onClick at release time); false when no drag
  // started, so the row's onPress runs as before.
  beginDrag: (ev: PressEvent, name: string) => boolean;
  // The drag chip to draw at the root level while a local drag is
  // active (null after the handoff — the compositor owns the drag
  // then, and the target's hover highlight is the feedback).
  dragChip: FileDragChip | null;
  // The drop target currently hovered, or null.
  hoverTarget: FileDragTarget | null;
  // The display name of the active drag session ("photo.png" or
  // "3 items"), or null when no drag is active. The status line
  // reads "Dragging <label>" from this, and "Drop to move …"
  // from hoverTarget.
  dragLabel: string | null;
}

interface DragSession {
  entries: FileDragEntry[];
  pressEv: PressEvent;
  name: string;
  pressX: number;
  pressY: number;
  // False until the pointer crosses the threshold (a click until
  // then); true once the chip is showing.
  dragging: boolean;
  // True once the drag handed off to the compositor.
  handedOff: boolean;
}

function displayNameFor(entries: FileDragEntry[]): string {
  return entries.length === 1 ? entries[0].name : entries.length + " items";
}

function pathsFor(entries: FileDragEntry[]): string[] {
  return entries.map((e) => joinPath(e.sourceDir, e.name));
}

/**
 * Build a drag session from dropped paths (the incoming side):
 * each path becomes one entry, its name from the path, its source
 * dir from the path's parent. The kind is "file" — the move
 * resolution uses only the name and the path, and the CLI move
 * handles directories either way.
 */
export function entriesForDroppedPaths(paths: readonly string[]): FileDragEntry[] {
  return paths.map((p) => ({
    name: baseName(p),
    kind: "file" as const,
    sourceDir: dirName(p),
  }));
}

export function useFileDrag(options: FileDragOptions): FileDragHandle {
  const [chip, setChip] = React.useState<FileDragChip | null>(null);
  const [hover, setHover] = React.useState<FileDragTarget | null>(null);
  const [label, setLabel] = React.useState<string | null>(null);
  const sessionRef = React.useRef<DragSession | null>(null);
  const optionsRef = React.useRef(options);
  optionsRef.current = options;

  // Clear the local drag visuals (chip + hover), keeping the
  // session itself — the dragend event ends the session.
  function clearVisuals(): void {
    setChip(null);
    setHover(null);
  }

  function endSession(): void {
    sessionRef.current = null;
    clearVisuals();
    setLabel(null);
  }

  React.useEffect(() => {
    const unsubMove = subscribePointerMove((ev) => {
      const s = sessionRef.current;
      if (!s || s.handedOff) return false;
      const dx = ev.x - s.pressX;
      const dy = ev.y - s.pressY;
      if (!s.dragging) {
        if (Math.abs(dx) <= DRAG_THRESHOLD_PX && Math.abs(dy) <= DRAG_THRESHOLD_PX)
          return false;
        s.dragging = true;
        setLabel(displayNameFor(s.entries));
      }
      const nextHover = optionsRef.current.targetAt(ev.x, ev.y);
      setChip({ label: displayNameFor(s.entries), x: ev.x, y: ev.y });
      setHover(nextHover);
      return true;
    });
    const unsubUp = subscribePointerUp((ev) => {
      const s = sessionRef.current;
      if (!s || s.handedOff) return false;
      // A leave is not a release — the pointer left the surface
      // mid-drag, so hand the drag to the compositor (when it
      // started) instead of committing a drop at the last known
      // position. A press that never crossed the threshold just
      // ends: it was never a drag.
      if (ev.left) {
        if (!s.dragging) {
          sessionRef.current = null;
          return false;
        }
        const started = startFileDrag(pathsFor(s.entries));
        s.handedOff = true;
        clearVisuals();
        if (!started) endSession();
        return true;
      }
      // A release: a drag commits into the folder under the
      // pointer (or cancels over empty space — a cancelled drag
      // is not a refusal, so no status); a press that never
      // crossed the threshold is the row's click, at release time.
      if (!s.dragging) {
        sessionRef.current = null;
        optionsRef.current.onClick(s.pressEv, s.name);
        // The click changed state (selection + status), so the
        // renderer must re-present — the marquee's up handler
        // returns true on its click path for the same reason.
        return true;
      }
      const target = optionsRef.current.targetAt(ev.x, ev.y);
      sessionRef.current = null;
      clearVisuals();
      setLabel(null);
      if (target) optionsRef.current.onDrop(s.entries, target);
      return true;
    });
    const unsubDrop = subscribeDragDrop((ev: DragDropEvent) => {
      const opts = optionsRef.current;
      const s = sessionRef.current;
      // The end of a drag this client started: the compositor
      // owns the drag now, so the session ends here. Dropped
      // means it landed on an accepting target — the source just
      // refreshes (the target performed the move).
      if (ev.type === "dragend") {
        if (!s) return false;
        const dropped = ev.dropped === true;
        endSession();
        if (opts.onDragEnd) opts.onDragEnd(dropped);
        return true;
      }
      // Our own handed-off drag re-entering this window: the
      // drop commits through the same onDrop as a local drag.
      // Any other client's drag hovers here the same way.
      if (ev.type === "enter" || ev.type === "motion") {
        if (ev.type === "enter" && ev.mimes && !ev.mimes.includes(FILE_DRAG_MIME))
          return false;
        const target = opts.targetAt(ev.x, ev.y);
        setHover(target);
        return true;
      }
      if (ev.type === "leave") {
        setHover(null);
        return true;
      }
      if (ev.type === "drop") {
        const paths = ev.paths ?? [];
        setHover(null);
        if (paths.length === 0) return true;
        const target = opts.targetAt(ev.x, ev.y);
        if (!target) return true;
        const entries = s && s.handedOff ? s.entries : entriesForDroppedPaths(paths);
        opts.onDrop(entries, target);
        return true;
      }
      return false;
    });
    return () => {
      unsubMove();
      unsubUp();
      unsubDrop();
    };
  }, []);

  function beginDrag(ev: PressEvent, name: string): boolean {
    // Keyboard activation has no position (see pressEventFrom in
    // the renderer): a drag needs a pointer, so a keyboard press is
    // never a drag start — the row's onPress runs as before.
    if (typeof ev.nativeEvent.x !== "number" || typeof ev.nativeEvent.y !== "number")
      return false;
    if (optionsRef.current.canDrag && !optionsRef.current.canDrag()) return false;
    const entries = optionsRef.current.payloadForPress(name);
    if (!entries || entries.length === 0) return false;
    sessionRef.current = {
      entries,
      pressEv: ev,
      name,
      pressX: ev.nativeEvent.x,
      pressY: ev.nativeEvent.y,
      dragging: false,
      handedOff: false,
    };
    return true;
  }

  return { beginDrag, dragChip: chip, hoverTarget: hover, dragLabel: label };
}
