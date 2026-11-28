/**
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Multi-selection for the Files app (gap unit 13, audit #22).
 *
 * Pure selection math, unit-testable without filesystem access: the
 * component owns the state, this module owns the transitions. A
 * selection is the selected entry names (in listing order) plus the
 * anchor index a Shift-click ranges from.
 *
 *   plain click      — select exactly the clicked item, anchor moves to it.
 *   Ctrl/Cmd-click   — toggle the clicked item in/out; anchor moves to it.
 *   Shift-click      — add the contiguous range from the anchor to the
 *                      clicked item to the selection; the anchor does
 *                      NOT move, so repeated Shift-clicks re-range from
 *                      the same anchor. With no anchor yet, a Shift-click
 *                      behaves like a plain click.
 *
 * Shift-click never deselects: items picked with Ctrl-click outside
 * the range stay selected (Finder behaviour).
 */

import type { ClipboardEntry } from "./clipboard";
import { resolvePasteTarget } from "./clipboard";

export interface PressModifiers {
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
}

export interface SelectionState {
  readonly selected: string[];
  readonly anchor: number | null;
}

export const EMPTY_SELECTION: SelectionState = { selected: [], anchor: null };

function inListingOrder(names: readonly string[], picked: ReadonlySet<string>): string[] {
  return names.filter((n) => picked.has(n));
}

/**
 * The selection after pressing the entry at `index` in `names`
 * (the current listing, in order) with `modifiers` held.
 */
export function applyPressSelection(
  names: readonly string[],
  prev: SelectionState,
  index: number,
  modifiers: PressModifiers,
): SelectionState {
  const name = names[index];
  if (name === undefined) return prev;
  if (modifiers.ctrlKey || modifiers.metaKey) {
    const picked = new Set(prev.selected);
    if (picked.has(name)) picked.delete(name);
    else picked.add(name);
    return { selected: inListingOrder(names, picked), anchor: index };
  }
  if (modifiers.shiftKey) {
    if (prev.anchor === null || prev.anchor < 0 || prev.anchor >= names.length) {
      return { selected: [name], anchor: index };
    }
    const from = Math.min(prev.anchor, index);
    const to = Math.max(prev.anchor, index);
    const picked = new Set(prev.selected);
    for (let i = from; i <= to; i += 1) picked.add(names[i]);
    return { selected: inListingOrder(names, picked), anchor: prev.anchor };
  }
  return { selected: [name], anchor: index };
}

/** The selection after clicking empty list space: nothing selected. */
export function clearSelection(): SelectionState {
  return EMPTY_SELECTION;
}

/**
 * Resolve the paste targets for a multi-file paste, in entry order.
 *
 * Each target is resolved against the names already in the folder
 * PLUS the names the earlier entries in this paste will take, so two
 * same-named files pasted from different folders suffix apart
 * (`photo.png`, `photo (1).png`) instead of colliding with each
 * other. Returns undefined when ANY entry must be refused (a folder
 * pasted into itself or a descendant) — the paste is all-or-nothing,
 * so the caller aborts before moving anything.
 */
export function resolveMultiPasteTargets(
  entries: readonly ClipboardEntry[],
  destinationDir: string,
  existingNames: ReadonlySet<string>,
): { entry: ClipboardEntry; targetPath: string; targetName: string }[] | undefined {
  const taken = new Set(existingNames);
  const targets: { entry: ClipboardEntry; targetPath: string; targetName: string }[] = [];
  for (const entry of entries) {
    const target = resolvePasteTarget(entry, destinationDir, taken);
    if (!target) return undefined;
    taken.add(target.targetName);
    targets.push({ entry, ...target });
  }
  return targets;
}
