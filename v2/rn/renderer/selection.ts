/**
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Multi-selection (gap unit 13, audit #22; shared with the desktop
 * by gap unit 14, audit #23 — this module moved from v2/apps/src to
 * the renderer dir so Files and the shell import the same model).
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
 *
 * A marquee (gap unit 14) applies the same modifiers to a set of
 * indices instead of one click: plain replaces the selection with
 * the touched items (anchor = first touched index, in listing
 * order); Shift adds them, anchor unchanged; Ctrl/Cmd toggles each,
 * anchor = first touched index. A marquee over nothing behaves like
 * a click on empty space for plain (clears) and changes nothing for
 * Shift/Ctrl.
 */

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
 * The selection after a marquee drag touches the entries at `indices`
 * (in `names`, in listing order — the caller sorts them; the drag
 * direction does not matter) with `modifiers` held. The rules mirror
 * applyPressSelection for one item: plain replaces, Shift adds with
 * the anchor unchanged, Ctrl/Cmd toggles each. A plain marquee over
 * nothing clears, exactly like a click on empty space; a Shift/Ctrl
 * marquee over nothing changes nothing.
 */
export function applyMarqueeSelection(
  names: readonly string[],
  prev: SelectionState,
  indices: readonly number[],
  modifiers: PressModifiers,
): SelectionState {
  const touched = [...indices]
    .filter((i) => i >= 0 && i < names.length)
    .sort((a, b) => a - b);
  if (modifiers.ctrlKey || modifiers.metaKey) {
    if (touched.length === 0) return prev;
    const picked = new Set(prev.selected);
    for (const i of touched) {
      const name = names[i];
      if (picked.has(name)) picked.delete(name);
      else picked.add(name);
    }
    return { selected: inListingOrder(names, picked), anchor: touched[0] };
  }
  if (modifiers.shiftKey) {
    if (touched.length === 0) return prev;
    const picked = new Set(prev.selected);
    for (const i of touched) picked.add(names[i]);
    return { selected: inListingOrder(names, picked), anchor: prev.anchor };
  }
  if (touched.length === 0) return EMPTY_SELECTION;
  return { selected: touched.map((i) => names[i]), anchor: touched[0] };
}
