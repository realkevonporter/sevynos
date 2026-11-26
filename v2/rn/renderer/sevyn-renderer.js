"use strict";
// SevynOS v2 M2 — React Native renderer for the Sevyn host.
//
// A react-reconciler host config (mutation mode, no hydration, no
// Suspense support) that turns a React tree into:
//   1. a Yoga layout tree (via the Sevyn.yoga* host functions), then
//   2. a flat draw-op list per commit (via Sevyn.present).
//
// Host component types: View, Text, Image, Pressable, ScrollView,
// TextInput (M4 — single-line text entry; see below).
// The shell app is written against these; nothing else exists yet.
//
// Event flow (host -> JS):
//   Sevyn.onPointer(ev)  ev = {type:'move'|'button'|'axis', x, y,
//                               button, pressed, nodeId?}
//     nodeId is set on button-press only: the yoga id of the topmost
//     hit op (host hit-tests the last presented ops).
//   Sevyn.onKey(ev)      ev = {key: <linux keycode>, pressed: bool,
//                               shift: bool, ctrl: bool, alt: bool,
//                               super: bool, meta: bool}
//     shift/ctrl/alt/super/meta are the modifier states at the moment
//     of the event (tracked by keycode in the host — it reads no xkb
//     keymap; unit 1 added ctrl/alt/super/meta next to shift).
//   Sevyn.onStatus(ev)   ev = {key, value} — statusd push.
//   Sevyn.onAppEvent(line) line = "EVENT LAUNCHED files" — appd push.
//   Sevyn.listApps()     -> [{id, name, version, color, glyph,
//                          system, protected, permissions}] — appd LIST.
//   Sevyn.launchApp(id)  -> bool — appd LAUNCH.
//   Sevyn.exec(cmdline)  -> "<exit-code>\n<output>" — one-shot run of
//                          /usr/local/bin/sevyn only; gated by the
//                          cli.exec permission (ERR string otherwise).
//
// TextInput (M4, caret + multiline in the GF65 fixes; selection model
// in gap unit 3, audit #9/#24): a controlled input, single-line by
// default. Props: value, onChangeText, onSubmitEditing, placeholder,
// autoFocus, multiline, secureTextEntry, onSelectionChange. The focused
// input eats printable keys (US keycode map below, Shift-aware),
// Backspace, Delete, and Enter (submit — or a newline when multiline);
// Tab moves focus, Escape blurs. The caret moves with
// Left/Right/Home/End and, when multiline, Up/Down between wrapped
// lines; it is drawn from the value (masked when secure), never the
// placeholder. Selection: Shift+arrows/Home/End extend it from an
// anchor, Ctrl+arrows jump by word (Shift+Ctrl extends by word), and a
// left-button drag selects the text under the pointer; the range is
// drawn as a highlight and reported via onSelectionChange, and
// Backspace/Delete/typing replace it. Copy/paste/cut (gap unit 2):
// Ctrl+C/X/V through the host clipboard (Sevyn.clipboardRead/Write),
// operating on the selection — a collapsed selection copies/cuts the
// whole value. A Ctrl+letter that is not C/X/V is swallowed, never typed.
//
// The renderer keeps a yoga-id -> instance map for hit routing and a
// focus list for keyboard activation. ScrollView scrolls via
// scrollBy/scrollTo, driven by wheel/trackpad axis events from the
// host (Wayland onPointerAxis -> dispatchScroll -> scrollAt) and by
// the headless `scroll` input lines.

const Reconciler = require("react-reconciler");

// SyncLane in this reconciler build (lanes are shifted one bit from
// the React 18 layout: Sync=2, InputContinuous=8, Default=32).
// The shell is a sync renderer: every update (press, key, status) is
// requested at SyncLane so flushSyncWork() below can force it out
// before the next present. No transitions exist in the shell.
const DEFAULT_PRIORITY = 2;

let currentUpdatePriority = DEFAULT_PRIORITY;

// ---------------------------------------------------------------- styles
function flattenStyle(style) {
  if (style == null) return {};
  if (Array.isArray(style)) {
    const out = {};
    for (const s of style) Object.assign(out, flattenStyle(s));
    return out;
  }
  return style;
}

// ---------------------------------------------------------------- instances
// Instance: {type, props, yogaId, children, parent, text, hidden,
//            scrollX, scrollY, contentWidth, contentHeight}
const instancesByYogaId = new Map();

function makeInstance(type, props) {
  const yogaId = Sevyn.yogaCreateNode();
  const inst = {
    type,
    props,
    yogaId,
    children: [],
    parent: null,
    text: "",
    hidden: false,
    scrollX: 0,
    scrollY: 0,
    contentWidth: 0,
    contentHeight: 0,
  };
  instancesByYogaId.set(yogaId, inst);
  // RN host-component measurement API (UIManager.measure et al.).
  // expo-router's useFrameSize and several navigation/layout hooks call
  // ref.measure() in an effect after mount; without it the frame never
  // sizes and the navigator renders blank. Layout is computed in
  // presentRoot() at commit, so by effect time the box is real.
  inst.measure = (cb) => {
    const b = measureBox(inst);
    if (cb) cb(b.x, b.y, b.width, b.height, b.pageX, b.pageY);
  };
  inst.measureInWindow = (cb) => {
    const b = measureBox(inst);
    if (cb) cb(b.pageX, b.pageY, b.width, b.height);
  };
  inst.measureLayout = (relativeTo, onSuccess, onFail) => {
    let node = inst;
    let x = 0;
    let y = 0;
    while (node && node !== relativeTo) {
      const l = Sevyn.yogaGetLayout(node.yogaId);
      x += l.x;
      y += l.y;
      node = node.parent;
    }
    if (node !== relativeTo) {
      if (onFail) onFail();
      return;
    }
    const l = Sevyn.yogaGetLayout(inst.yogaId);
    if (onSuccess) onSuccess(x, y, l.width, l.height);
  };
  return inst;
}

// Layout box of an instance: parent-relative (x, y) plus root-relative
// (pageX, pageY), matching RN's measure() callback order.
function measureBox(inst) {
  const l = Sevyn.yogaGetLayout(inst.yogaId);
  let pageX = 0;
  let pageY = 0;
  let n = inst;
  while (n) {
    const a = Sevyn.yogaGetLayout(n.yogaId);
    pageX += a.x;
    pageY += a.y;
    n = n.parent;
  }
  return { x: l.x, y: l.y, width: l.width, height: l.height, pageX, pageY };
}

function textContent(inst) {
  // Concatenated string children of a Text node (or a text leaf itself).
  if (inst.type === "#text") return inst.text;
  let s = "";
  for (const c of inst.children) s += textContent(c);
  return s;
}

function fontOf(inst) {
  // Font for a text leaf: nearest ancestor Text (or View) style.
  let n = inst;
  while (n) {
    const st = flattenStyle(n.props && n.props.style);
    if (st.fontSize != null || st.fontWeight != null || st.color != null) {
      return {
        size: st.fontSize != null ? Number(st.fontSize) : 14,
        bold:
          st.fontWeight != null &&
          (st.fontWeight === "bold" || Number(st.fontWeight) >= 600),
        color: st.color || "#ffffff",
        align: st.textAlign || "left",
      };
    }
    n = n.parent;
  }
  return { size: 14, bold: false, color: "#ffffff", align: "left" };
}

function applyStyleToNode(inst) {
  const st = flattenStyle(inst.props && inst.props.style);
  Sevyn.yogaSetStyle(inst.yogaId, st);
}

// Install the Yoga measure function for a Text node (or a text leaf).
// Yoga calls it with (width, widthMode, height, heightMode); the host
// expects {width, height} back. measureText wraps for us.
function installTextMeasure(inst) {
  Sevyn.yogaSetMeasureFunc(inst.yogaId, (w, wm, h, hm) => {
    const font = fontOf(inst);
    const text = textContent(inst);
    // widthMode: 0 undefined, 1 exactly, 2 at-most (matches Yoga).
    const maxW = wm === 2 ? w : 0;
    const m = Sevyn.measureText(text, font.size, font.bold, maxW);
    // Exactly-constrained width wins; otherwise the measured width.
    const width = wm === 1 ? w : m.width;
    return { width, height: m.height };
  });
}

function installImageMeasure(inst) {
  // Images have no intrinsic size in M2: they must carry width/height
  // in style. Without them the node measures 0x0.
  Sevyn.yogaSetMeasureFunc(inst.yogaId, () => ({ width: 0, height: 0 }));
}

// Install the Yoga measure function for a TextInput: one line, sized
// to the displayed text (value, or the placeholder when empty).
// Multiline grows with its wrapped lines instead.
function installTextInputMeasure(inst) {
  Sevyn.yogaSetMeasureFunc(inst.yogaId, (w, wm, h, hm) => {
    const font = fontOf(inst);
    const value =
      inst.props && typeof inst.props.value === "string" ? inst.props.value : "";
    const display =
      value ||
      (inst.props && typeof inst.props.placeholder === "string"
        ? inst.props.placeholder
        : "");
    const multiline = !!(inst.props && inst.props.multiline);
    const maxW = wm === 2 || wm === 1 ? w : 0;
    const wrapped = multiline
      ? wrapMultiline(display, font.size, font.bold, maxW)
      : display;
    const lines = multiline ? wrapped.split("\n").length : 1;
    const m = Sevyn.measureText(display, font.size, font.bold, 0);
    const width = wm === 1 ? w : m.width;
    return { width, height: font.size * 1.25 * lines };
  });
}

// ------------------------------------------------------------ draw emission
function wrapText(text, fontSize, bold, maxWidth) {
  // Greedy word wrap into \n-separated lines; the painter draws one
  // line per \n. Returns the wrapped string.
  if (maxWidth <= 0) return text;
  const words = text.split(" ");
  const lines = [];
  let line = "";
  for (const word of words) {
    const trial = line ? line + " " + word : word;
    if (Sevyn.measureText(trial, fontSize, bold, 0).width <= maxWidth) {
      line = trial;
    } else {
      if (line) lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.join("\n");
}

// Wrap a multiline value: each logical (\n-separated) line is wrapped
// with wrapText, and the lines are re-joined — the painter draws one
// line per \n, so explicit newlines survive the wrap.
function wrapMultiline(text, fontSize, bold, maxWidth) {
  return text
    .split("\n")
    .map((line) => wrapText(line, fontSize, bold, maxWidth))
    .join("\n");
}

// Greedy wrap of ONE logical line, mirroring wrapText's splits exactly
// but tracking each visual line's character span [start, end) in the
// original line. The caret and Up/Down use these spans so the caret
// row matches the rows the display actually draws. maxWidth <= 0
// returns the whole line as one span (single-line inputs).
function wrapLineSpans(line, fontSize, bold, maxWidth) {
  if (maxWidth <= 0) return [{ text: line, start: 0, end: line.length }];
  const words = line.split(" ");
  const spans = [];
  let cur = "";
  let curStart = 0;
  let pos = 0; // offset of the next word in `line`
  for (const word of words) {
    const wordStart = pos;
    const trial = cur ? cur + " " + word : word;
    if (Sevyn.measureText(trial, fontSize, bold, 0).width <= maxWidth) {
      if (!cur) curStart = wordStart;
      cur = trial;
    } else {
      if (cur) {
        spans.push({ text: cur, start: curStart, end: curStart + cur.length });
      }
      cur = word;
      curStart = wordStart;
    }
    pos = wordStart + word.length + 1; // +1 for the space after this word
  }
  if (cur || spans.length === 0) {
    spans.push({ text: cur, start: curStart, end: curStart + cur.length });
  }
  return spans;
}

// Visual (wrapped) lines of a multiline value, each with its character
// span [start, end) in the original text. \n boundaries are preserved
// (an empty logical line is one empty visual line), and the wrap space
// between two visual lines belongs to neither span — so a caret offset
// always belongs to exactly one visual line.
function visualLines(text, fontSize, bold, maxWidth) {
  const out = [];
  let base = 0; // offset of the current logical line in `text`
  for (const logical of text.split("\n")) {
    for (const s of wrapLineSpans(logical, fontSize, bold, maxWidth)) {
      out.push({ text: s.text, start: base + s.start, end: base + s.end });
    }
    base += logical.length + 1; // +1 for the \n
  }
  return out;
}

function emitInstance(inst, ox, oy, ops, clip) {
  if (inst.hidden) return;
  const l = Sevyn.yogaGetLayout(inst.yogaId);
  const x = ox + l.x;
  const y = oy + l.y;
  const w = l.width;
  const h = l.height;
  const st = flattenStyle(inst.props && inst.props.style);
  const pressable = inst.type === "Pressable" || !!(inst.props && inst.props.onPress);
  const nodeId = pressable ? inst.yogaId : -1;

  if (inst.type === "ScrollView") {
    // Clip to the viewport; children shift by the scroll offset.
    ops.push({ type: "pushClip", x, y, w, h });
    if (st.backgroundColor) {
      ops.push({
        type: "rect",
        x,
        y,
        w,
        h,
        color: st.backgroundColor,
        radius: st.borderRadius || 0,
        nodeId: -1,
      });
    }
    // Content size = max descendant extent (for scroll clamping).
    // Must walk ALL descendants, not just direct children: a
    // ScrollView often has a single wrapper child flex-constrained
    // to the viewport height, while the real content (grandchildren)
    // overflows it — Tokrah's Go Live screen's wrapper is 1200 tall
    // but its content reaches 1387, and the direct-children extent
    // clamped the scroll to 0. Stop at nested ScrollViews: their own
    // content is clipped by them and must not count toward this one.
    let cw = 0;
    let ch = 0;
    function contentExtent(node, oy2, ox2) {
      for (const c of node.children) {
        const cl = Sevyn.yogaGetLayout(c.yogaId);
        // Yoga returns NaN (YGUndefined) for unmeasured nodes; one
        // NaN would poison the whole extent via Math.max.
        const ex = ox2 + cl.x + cl.width;
        const ey = oy2 + cl.y + cl.height;
        if (Number.isFinite(ex)) cw = Math.max(cw, ex);
        if (Number.isFinite(ey)) ch = Math.max(ch, ey);
        if (c.type !== "ScrollView") contentExtent(c, oy2 + cl.y, ox2 + cl.x);
      }
    }
    contentExtent(inst, 0, 0);
    inst.contentWidth = cw;
    inst.contentHeight = ch;
    const horizontal = st.flexDirection === "row";
    const dx = horizontal ? -inst.scrollX : 0;
    const dy = horizontal ? 0 : -inst.scrollY;
    for (const c of inst.children) emitInstance(c, x + dx, y + dy, ops, true);
    ops.push({ type: "popClip" });
    return;
  }

  if (inst.type === "View" || inst.type === "Pressable") {
    if (st.backgroundColor) {
      ops.push({
        type: "rect",
        x,
        y,
        w,
        h,
        color: st.backgroundColor,
        radius: st.borderRadius || 0,
        nodeId,
      });
    } else if (pressable) {
      // Pressable with no background still needs a hit rect.
      ops.push({ type: "rect", x, y, w, h, color: "#00000000", nodeId });
    }
  } else if (inst.type === "Text") {
    const font = fontOf(inst);
    const raw = textContent(inst);
    if (raw) {
      const text = wrapText(raw, font.size, font.bold, w);
      ops.push({
        type: "text",
        x,
        y,
        w,
        h,
        text,
        fontSize: font.size,
        bold: font.bold,
        color: font.color,
        align: font.align,
        nodeId,
      });
    }
  } else if (inst.type === "Image") {
    const src = inst.props && inst.props.source;
    if (src) {
      ops.push({ type: "image", x, y, w, h, asset: String(src), nodeId });
    }
  } else if (inst.type === "TextInput") {
    const font = fontOf(inst);
    const value =
      inst.props && typeof inst.props.value === "string" ? inst.props.value : "";
    const showingPlaceholder =
      !value && inst.props && typeof inst.props.placeholder === "string";
    // secureTextEntry (M9 wifi password): the stored value stays
    // real — only the drawn text is masked. The caret measures the
    // masked text, so its position stays correct either way.
    const multiline = !!(inst.props && inst.props.multiline);
    // The drawn text: placeholder when empty, else the value (masked
    // when secure). Multiline wraps it at the box width, reusing the
    // Text branch's wrap; single-line draws un-wrapped, as before.
    const drawn = showingPlaceholder ? inst.props.placeholder : textInputValueText(inst);
    const display = multiline ? wrapMultiline(drawn, font.size, font.bold, w) : drawn;
    // Hit rect (background or transparent) so a click focuses the input.
    ops.push({
      type: "rect",
      x,
      y,
      w,
      h,
      color: st.backgroundColor || "#00000000",
      radius: st.borderRadius || 0,
      nodeId: inst.yogaId,
    });
    // Selection highlight (gap unit 3): the selected range, drawn
    // under the text so the glyphs stay readable — the painter
    // blends the alpha. One rect per visual line the range covers;
    // a range that ends exactly at a line break draws nothing on
    // the next line. The caret below still marks the focus end.
    if (focusedInstance === inst) {
      const { start, end } = selectionRangeFor(inst);
      if (start !== end) {
        const hlText = textInputValueText(inst);
        const hlLines = visualLines(hlText, font.size, font.bold, multiline ? w : 0);
        const lineH = font.size * 1.25;
        hlLines.forEach((line, row) => {
          const s = Math.max(start, line.start);
          const e = Math.min(end, line.end);
          if (e <= s) return;
          const x0 = Sevyn.measureText(
            hlText.slice(line.start, s),
            font.size,
            font.bold,
            0,
          ).width;
          const x1 = Sevyn.measureText(
            hlText.slice(line.start, e),
            font.size,
            font.bold,
            0,
          ).width;
          ops.push({
            type: "rect",
            x: x + x0,
            y: y + row * lineH + 1,
            w: Math.max(0, x1 - x0),
            h: Math.max(1, lineH - 2),
            color: "#3b82f680",
            nodeId: -1,
          });
        });
      }
    }
    if (display) {
      ops.push({
        type: "text",
        x,
        y,
        w,
        h,
        text: display,
        fontSize: font.size,
        bold: font.bold,
        color: showingPlaceholder ? "#6b7280" : font.color,
        align: font.align,
        nodeId: -1,
      });
    }
    // Caret: measured from the VALUE (masked when secure), never the
    // placeholder — an empty input's caret sits at the left edge, not
    // after the placeholder text. Multiline: the caret's visual row
    // and column come from the same wrapping the display uses.
    if (focusedInstance === inst) {
      const caretText = textInputValueText(inst);
      const offset = caretOffsetFor(inst);
      const lines = visualLines(caretText, font.size, font.bold, multiline ? w : 0);
      let line = lines.find((l) => offset >= l.start && offset <= l.end);
      if (!line) line = lines[lines.length - 1];
      const row = lines.indexOf(line);
      const colText = caretText.slice(line.start, offset);
      const colW = colText
        ? Sevyn.measureText(colText, font.size, font.bold, 0).width
        : 0;
      const lineH = font.size * 1.25;
      ops.push({
        type: "rect",
        x: x + colW + 1,
        y: y + row * lineH + 1,
        w: 2,
        h: Math.max(1, lineH - 2),
        color: font.color,
        nodeId: -1,
      });
    }
  }

  // Focus ring: a thin outline around the focused pressable / input.
  if (focusedInstance === inst && (pressable || inst.type === "TextInput")) {
    const c = "#f5c518";
    const t = 2;
    ops.push({
      type: "rect",
      x: x - t,
      y: y - t,
      w: w + 2 * t,
      h: t,
      color: c,
      nodeId: -1,
    });
    ops.push({
      type: "rect",
      x: x - t,
      y: y + h,
      w: w + 2 * t,
      h: t,
      color: c,
      nodeId: -1,
    });
    ops.push({ type: "rect", x: x - t, y, w: t, h, color: c, nodeId: -1 });
    ops.push({ type: "rect", x: x + w, y, w: t, h, color: c, nodeId: -1 });
  }

  for (const c of inst.children) emitInstance(c, x, y, ops, clip);
}

// Free a Yoga node and its whole subtree (host deletions only — moves
// go through insertBefore/appendChild, never through removeChild).
// Idempotent: yogaFreeNode no-ops on an unknown id, so this is also
// safe alongside detachDeletedInstance.
function freeSubtree(inst) {
  for (const c of inst.children) freeSubtree(c);
  inst.children = [];
  if (inst.yogaId != null) {
    Sevyn.yogaFreeNode(inst.yogaId);
    instancesByYogaId.delete(inst.yogaId);
  }
}

function detachFromParent(inst) {
  if (inst.parent) {
    const sibs = inst.parent.children;
    const i = sibs.indexOf(inst);
    if (i >= 0) sibs.splice(i, 1);
    inst.parent = null;
    return;
  }
  // Top-level children live on the root container (parent == null).
  if (rootContainer) {
    const i = rootContainer.children.indexOf(inst);
    if (i >= 0) rootContainer.children.splice(i, 1);
  }
}

// Rebuild the Yoga child lists from the instance tree, lay out, present.
let rootContainer = null;
let currentRoot = null;
let currentElement = null;
let rootWidth = 1024;
let rootHeight = 768;
let backgroundColor = "#0b0b0f";

function syncYogaChildren(inst) {
  // Text is a MEASURED LEAF in Yoga: its measure function reads the
  // concatenated descendant text (installTextMeasure). Yoga forbids
  // children on measured nodes ("Cannot add child: Nodes with measure
  // functions cannot have children"), so a Text's instance children
  // (nested Text / #text leaves) are draw data only — never Yoga
  // children. The parent Text draws the concatenated text itself in
  // emitInstance; the #text leaves draw nothing. Same for #text
  // leaves themselves (they never have children).
  if (inst.type === "Text" || inst.type === "#text") return;
  Sevyn.yogaSetChildren(
    inst.yogaId,
    inst.children.map((c) => c.yogaId),
  );
  for (const c of inst.children) syncYogaChildren(c);
}

function presentRoot() {
  if (!rootContainer) return;
  // autoFocus: with nothing focused, the first autoFocus input takes
  // focus (the Terminal prompt). Once the user focuses anything else,
  // this never steals it back; Escape blurs, and the next present
  // re-focuses the input — that is the Terminal's home state.
  if (!focusedInstance) {
    const auto = firstAutoFocusInput();
    if (auto) focusInstance(auto);
  }
  syncYogaChildren(rootContainer);
  Sevyn.yogaCalculateLayout(rootContainer.yogaId, rootWidth, rootHeight);
  const ops = [];
  for (const c of rootContainer.children) emitInstance(c, 0, 0, ops, false);
  Sevyn.present(ops, backgroundColor);
}

// ------------------------------------------------------------------- focus
let focusedInstance = null;

// TextInput caret + selection state (gap unit 3, audit #9/#24). The
// caret offset (character index into the value) lives on the instance;
// it is (re)set to the end of the value on focus and clamped lazily to
// [0, value.length], so an external value change (e.g. Terminal
// clearing the input on submit) can never leave it out of range. A
// left-button press places the caret at the char under the pointer
// (click-to-place) and a drag from there selects; arrows move the
// caret, Shift+arrows extend a selection from an anchor.
function textInputValueText(inst) {
  const props = inst.props || {};
  const value = typeof props.value === "string" ? props.value : "";
  return props.secureTextEntry ? "•".repeat(value.length) : value;
}

function textInputValue(inst) {
  return inst.props && typeof inst.props.value === "string" ? inst.props.value : "";
}

function caretOffsetFor(inst) {
  const value = textInputValue(inst);
  const n = typeof inst.caretOffset === "number" ? inst.caretOffset : value.length;
  return Math.max(0, Math.min(value.length, n));
}

function setCaretOffset(inst, n) {
  // A plain caret move collapses the selection to the caret.
  setSelectionState(inst, n, null);
}

// Selection range for copy/cut/paste/delete (gap units 2 + 3):
// [start, end) into the value, clamped, start <= end. The range lives
// on the instance as [min(anchor, caret), max(anchor, caret)] and is
// collapsed at the caret when there is no anchor.
function selectionRangeFor(inst) {
  const value = textInputValue(inst);
  const caret = caretOffsetFor(inst);
  const start = typeof inst.selectionStart === "number" ? inst.selectionStart : caret;
  const end = typeof inst.selectionEnd === "number" ? inst.selectionEnd : caret;
  const lo = Math.max(0, Math.min(value.length, start));
  const hi = Math.max(0, Math.min(value.length, end));
  return { start: Math.min(lo, hi), end: Math.max(lo, hi) };
}

// The single mutation point for caret + selection. anchor === null
// collapses the selection to the caret; otherwise the selection is
// [min(anchor, caret), max(anchor, caret)]. Fires onSelectionChange
// (the RN shape) when the normalized range actually changes — a
// collapsed range moving with the caret counts, so a plain arrow key
// reports it too.
function setSelectionState(inst, caret, anchor) {
  const value = textInputValue(inst);
  const prev = selectionRangeFor(inst);
  const c = Math.max(0, Math.min(value.length, caret));
  const a = anchor == null ? null : Math.max(0, Math.min(value.length, anchor));
  inst.caretOffset = c;
  inst.selectionAnchor = a;
  inst.selectionStart = a == null ? c : Math.min(a, c);
  inst.selectionEnd = a == null ? c : Math.max(a, c);
  notifySelectionChange(inst, prev);
}

function notifySelectionChange(inst, prev, next) {
  const range = next || selectionRangeFor(inst);
  if (prev && prev.start === range.start && prev.end === range.end) return;
  const props = inst.props || {};
  if (typeof props.onSelectionChange !== "function") return;
  try {
    props.onSelectionChange({
      nativeEvent: { selection: { start: range.start, end: range.end } },
    });
  } catch (e) {
    Sevyn.log("onSelectionChange failed: " + (e && e.message ? e.message : String(e)));
  }
}

// Move the caret, keeping (or starting) a selection: the anchor is
// the caret position where the selection started (Shift+arrows,
// Shift+Home/End, drag-select). When anchor and caret meet the range
// collapses but the anchor stays — it equals the caret then, so the
// next Shift+arrow re-opens the selection from the same place either
// way.
function extendCaretTo(inst, n) {
  const anchor =
    typeof inst.selectionAnchor === "number"
      ? inst.selectionAnchor
      : caretOffsetFor(inst);
  setSelectionState(inst, n, anchor);
}

// Undo/redo (gap unit 4, audit #4/#5): a per-input stack of
// pre-edit snapshots { value, caret, anchor }. Every edit through
// change() pushes the state before the edit and clears the redo
// stack; undo moves the current state onto the redo stack and
// applies the last snapshot, redo does the reverse. One entry per
// edit — each keystroke is its own step, no coalescing. Capped at
// UNDO_DEPTH entries; past the cap the oldest entry is dropped.
// Only edits made through the input itself are recorded (an
// external value change, e.g. Terminal clearing on submit, is not
// an undoable edit). Caret moves never touch the stacks.
const UNDO_DEPTH = 100;

function undoSnapshotFor(inst) {
  return {
    value: textInputValue(inst),
    caret: caretOffsetFor(inst),
    anchor: typeof inst.selectionAnchor === "number" ? inst.selectionAnchor : null,
  };
}

function pushUndo(inst) {
  if (!Array.isArray(inst.undoStack)) inst.undoStack = [];
  inst.undoStack.push(undoSnapshotFor(inst));
  if (inst.undoStack.length > UNDO_DEPTH) inst.undoStack.shift();
  inst.redoStack = [];
}

// Apply a snapshot without recording: like change() below, it
// notifies onChangeText and then sets caret/selection against the
// NEW value's length — props.value is still the old value until the
// state update flushes, so selectionRangeFor would clamp wrong.
function applyUndoSnapshot(inst, snap) {
  const prev = selectionRangeFor(inst);
  const props = inst.props || {};
  if (typeof props.onChangeText === "function") props.onChangeText(snap.value);
  const caret = Math.max(0, Math.min(snap.value.length, snap.caret));
  const anchor =
    snap.anchor == null ? null : Math.max(0, Math.min(snap.value.length, snap.anchor));
  inst.caretOffset = caret;
  inst.selectionAnchor = anchor;
  inst.selectionStart = anchor == null ? caret : Math.min(anchor, caret);
  inst.selectionEnd = anchor == null ? caret : Math.max(anchor, caret);
  notifySelectionChange(inst, prev, {
    start: inst.selectionStart,
    end: inst.selectionEnd,
  });
}

function undoEdit(inst) {
  if (!Array.isArray(inst.undoStack) || inst.undoStack.length === 0) return;
  if (!Array.isArray(inst.redoStack)) inst.redoStack = [];
  inst.redoStack.push(undoSnapshotFor(inst));
  applyUndoSnapshot(inst, inst.undoStack.pop());
}

function redoEdit(inst) {
  if (!Array.isArray(inst.redoStack) || inst.redoStack.length === 0) return;
  if (!Array.isArray(inst.undoStack)) inst.undoStack = [];
  inst.undoStack.push(undoSnapshotFor(inst));
  if (inst.undoStack.length > UNDO_DEPTH) inst.undoStack.shift();
  applyUndoSnapshot(inst, inst.redoStack.pop());
}

// Word jumps (Ctrl+Left/Right): a word is a run of word characters
// ([A-Za-z0-9_]) or a run of punctuation — spaces are skipped first,
// so the caret never gets stuck on a punctuation boundary. Ctrl+Left
// from mid-word lands at that word's start; from a word start it
// lands at the previous word's start. Ctrl+Right is the mirror.
function isWordChar(ch) {
  return (
    (ch >= "a" && ch <= "z") ||
    (ch >= "A" && ch <= "Z") ||
    (ch >= "0" && ch <= "9") ||
    ch === "_"
  );
}

function isSpaceChar(ch) {
  return ch === " " || ch === "\t" || ch === "\n";
}

function wordStartBefore(value, pos) {
  let i = pos;
  while (i > 0 && isSpaceChar(value[i - 1])) i--;
  if (i <= 0) return i;
  const word = isWordChar(value[i - 1]);
  while (i > 0 && !isSpaceChar(value[i - 1]) && isWordChar(value[i - 1]) === word) i--;
  return i;
}

function wordEndAfter(value, pos) {
  const n = value.length;
  let i = pos;
  while (i < n && isSpaceChar(value[i])) i++;
  if (i >= n) return i;
  const word = isWordChar(value[i]);
  while (i < n && !isSpaceChar(value[i]) && isWordChar(value[i]) === word) i++;
  return i;
}

// Absolute box of a TextInput in root coordinates, matching the
// positions emitInstance draws at: Yoga layouts summed up the parent
// chain, minus each ancestor ScrollView's scroll offset (the Yoga
// layout alone is pre-scroll). measureBox cannot do this — it has no
// scroll correction.
function inputBox(inst) {
  const l = Sevyn.yogaGetLayout(inst.yogaId);
  let pageX = 0;
  let pageY = 0;
  let n = inst;
  while (n) {
    const a = Sevyn.yogaGetLayout(n.yogaId);
    pageX += a.x;
    pageY += a.y;
    if (n.type === "ScrollView") {
      pageX -= n.scrollX || 0;
      pageY -= n.scrollY || 0;
    }
    n = n.parent;
  }
  return { x: pageX, y: pageY, width: l.width, height: l.height };
}

// Character offset under a pointer point, for click-to-place and
// drag-select. The row comes from the wrapped visual lines (the same
// wrapping the display uses); within the row the caret goes to the
// nearest char boundary. Points outside the box clamp to the nearest
// edge, so dragging past an end extends the selection to it.
// Left-aligned text is assumed, matching the caret math in
// emitInstance.
function offsetAtPoint(inst, px, py) {
  const box = inputBox(inst);
  const font = fontOf(inst);
  const multiline = !!(inst.props && inst.props.multiline);
  const text = textInputValueText(inst);
  const lines = visualLines(text, font.size, font.bold, multiline ? box.width : 0);
  const lineH = font.size * 1.25;
  let row = Math.floor((py - box.y) / lineH);
  row = Math.max(0, Math.min(lines.length - 1, row));
  const line = lines[row];
  const localX = px - box.x;
  let best = line.start;
  let bestDist = Infinity;
  for (let i = line.start; i <= line.end; i++) {
    const w =
      i === line.start
        ? 0
        : Sevyn.measureText(text.slice(line.start, i), font.size, font.bold, 0).width;
    const d = Math.abs(localX - w);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

// Text copy/cut read: the selection, or the whole field value when
// the selection is collapsed — with a selection model the range is
// what gets copied; with no selection, copying the whole field is
// the deliberate fallback (an API key field is copied whole, not
// left empty, when nothing is selected).
function selectionTextFor(inst) {
  const value = textInputValue(inst);
  const { start, end } = selectionRangeFor(inst);
  if (start === end) return value;
  return value.slice(start, end);
}

// Host clipboard (gap unit 2): Sevyn.clipboardRead/Write are the
// host functions (the Wayland selection in the real host, an
// in-memory string in the mock/headless host). Guarded: an older
// host without them pastes nothing instead of throwing.
function clipboardRead() {
  if (typeof Sevyn.clipboardRead === "function") {
    const text = Sevyn.clipboardRead();
    return typeof text === "string" ? text : "";
  }
  return "";
}

function clipboardWrite(text) {
  if (typeof Sevyn.clipboardWrite === "function") Sevyn.clipboardWrite(text);
}

function focusInstance(inst) {
  focusedInstance = inst;
  if (inst && inst.type === "TextInput") {
    // Focus puts the caret at the end of the value with no selection;
    // a pointer press on the input re-places it (click-to-place) right
    // after this, and a keyboard focus keeps the end position.
    setSelectionState(inst, textInputValue(inst).length, null);
  }
}

function focusables() {
  const out = [];
  function walk(inst) {
    if (inst.hidden) return;
    if (
      inst.type === "Pressable" ||
      inst.type === "TextInput" ||
      (inst.props && inst.props.onPress)
    ) {
      out.push(inst);
    }
    for (const c of inst.children) walk(c);
  }
  if (rootContainer) for (const c of rootContainer.children) walk(c);
  return out;
}

// First autoFocus TextInput in tree order, if any.
function firstAutoFocusInput() {
  let found = null;
  function walk(inst) {
    if (found || inst.hidden) return;
    if (inst.type === "TextInput" && inst.props && inst.props.autoFocus) {
      found = inst;
      return;
    }
    for (const c of inst.children) walk(c);
  }
  if (rootContainer) for (const c of rootContainer.children) walk(c);
  return found;
}

function moveFocus(dir) {
  const list = focusables();
  if (list.length === 0) return;
  const i = list.indexOf(focusedInstance);
  const next = list[(i + dir + list.length) % list.length];
  focusInstance(next);
  presentRoot();
}

function activateFocused() {
  if (focusedInstance && focusedInstance.props && focusedInstance.props.onPress) {
    focusedInstance.props.onPress();
  }
}

// US keycode map (evdev codes -> [plain, shift]). Space is 57.
// Letters, digits, and the punctuation row a terminal needs for paths
// and flags. Keypad / function / media keys are intentionally absent.
const KEYMAP = {
  2: ["1", "!"],
  3: ["2", "@"],
  4: ["3", "#"],
  5: ["4", "$"],
  6: ["5", "%"],
  7: ["6", "^"],
  8: ["7", "&"],
  9: ["8", "*"],
  10: ["9", "("],
  11: ["0", ")"],
  12: ["-", "_"],
  13: ["=", "+"],
  16: ["q", "Q"],
  17: ["w", "W"],
  18: ["e", "E"],
  19: ["r", "R"],
  20: ["t", "T"],
  21: ["y", "Y"],
  22: ["u", "U"],
  23: ["i", "I"],
  24: ["o", "O"],
  25: ["p", "P"],
  26: ["[", "{"],
  27: ["]", "}"],
  30: ["a", "A"],
  31: ["s", "S"],
  32: ["d", "D"],
  33: ["f", "F"],
  34: ["g", "G"],
  35: ["h", "H"],
  36: ["j", "J"],
  37: ["k", "K"],
  38: ["l", "L"],
  39: [";", ":"],
  40: ["'", '"'],
  41: ["`", "~"],
  43: ["\\", "|"],
  44: ["z", "Z"],
  45: ["x", "X"],
  46: ["c", "C"],
  47: ["v", "V"],
  48: ["b", "B"],
  49: ["n", "N"],
  50: ["m", "M"],
  51: [",", "<"],
  52: [".", ">"],
  53: ["/", "?"],
  57: [" ", " "],
};

// Keys for the focused TextInput. Returns true when the key is
// consumed (no focus movement), false for Tab/Escape, which fall
// through to the focus handling below. Typing, Backspace, and Delete
// edit at the caret offset, replacing the selection when one exists;
// Left/Right/Home/End move it (Shift extends the selection,
// Ctrl+Left/Right jump by word, Shift+Ctrl extends by word);
// Up/Down move between visual lines when multiline (single-line:
// swallowed, never a focus move — the M4 behaviour, kept). Ctrl+C/X/V
// copy, cut, and paste through the host clipboard (gap unit 2),
// operating on the selection; Ctrl+A selects the whole value and
// Ctrl+Z / Ctrl+Y undo and redo through the per-input stack
// (gap unit 4); any other Ctrl+printable is swallowed, never typed.
function handleTextInputKey(inst, ev) {
  const props = inst.props || {};
  const value = textInputValue(inst);
  const multiline = !!props.multiline;
  const offset = caretOffsetFor(inst);
  const change = (next, nextOffset) => {
    const prev = selectionRangeFor(inst);
    // Record the pre-edit state first: every edit through here is
    // one undo step, and a new edit clears the redo stack.
    pushUndo(inst);
    if (typeof props.onChangeText === "function") props.onChangeText(next);
    // Clamp against the NEW value's length: props.value is still the
    // old value until the state update flushes.
    const caret = Math.max(0, Math.min(next.length, nextOffset));
    // An edit collapses the selection to the new caret. The notified
    // range uses the new length explicitly — selectionRangeFor would
    // clamp against the still-old props.value.
    inst.caretOffset = caret;
    inst.selectionAnchor = null;
    inst.selectionStart = caret;
    inst.selectionEnd = caret;
    notifySelectionChange(inst, prev, { start: caret, end: caret });
  };
  // Copy/paste/cut (gap unit 2) and select-all / undo / redo
  // (gap unit 4): Ctrl+A/Z/Y, using the modifier state unit 1 puts
  // on the event. A Ctrl+letter that is not C/X/V/A/Z/Y is
  // swallowed — it is a shortcut, not text (without this Ctrl+C
  // would also type a 'c'). Other Ctrl keys (arrows, Home/End, ...)
  // fall through to the switch below, unchanged.
  if (ev.ctrl) {
    switch (ev.key) {
      case 30: // A — select all, through the unit-3 selection model.
        setSelectionState(inst, value.length, 0);
        return true;
      case 44: // Z — undo, or redo with Shift (Ctrl+Shift+Z).
        if (ev.shift) redoEdit(inst);
        else undoEdit(inst);
        return true;
      case 21: // Y — redo.
        redoEdit(inst);
        return true;
      case 46: // C — copy the selection (whole value when collapsed).
        clipboardWrite(selectionTextFor(inst));
        return true;
      case 45: {
        // X — cut: copy, then delete the selection (or the whole value).
        clipboardWrite(selectionTextFor(inst));
        const { start, end } = selectionRangeFor(inst);
        if (start !== end) {
          change(value.slice(0, start) + value.slice(end), start);
        } else if (value !== "") {
          change("", 0);
        }
        return true;
      }
      case 47: {
        // V — paste: replace the selection with the clipboard text.
        const text = clipboardRead();
        if (text !== "") {
          const { start, end } = selectionRangeFor(inst);
          // A single-line input cannot hold a newline: strip it (a
          // pasted key never has one; a pasted paragraph stays one
          // line). Multiline keeps newlines.
          const insert = multiline ? text : text.replace(/[\r\n]+/g, "");
          change(
            value.slice(0, start) + insert + value.slice(end),
            start + insert.length,
          );
        }
        return true;
      }
      default:
        if (KEYMAP[ev.key]) return true;
        break;
    }
  }
  switch (ev.key) {
    case 15: // Tab — move focus.
    case 1: // Escape — blur.
      return false;
    case 28: // Enter — submit, or a newline when multiline.
      if (multiline) {
        // A newline replaces the selection, like typed text.
        const { start, end } = selectionRangeFor(inst);
        change(value.slice(0, start) + "\n" + value.slice(end), start + 1);
      } else if (typeof props.onSubmitEditing === "function") {
        props.onSubmitEditing();
      }
      return true;
    case 14: {
      // Backspace — delete the selection, else the char
      // before the caret.
      const { start, end } = selectionRangeFor(inst);
      if (start !== end) {
        change(value.slice(0, start) + value.slice(end), start);
      } else if (offset > 0) {
        change(value.slice(0, offset - 1) + value.slice(offset), offset - 1);
      }
      return true;
    }
    case 111: {
      // Delete — delete the selection, else the char at the
      // caret.
      const { start, end } = selectionRangeFor(inst);
      if (start !== end) {
        change(value.slice(0, start) + value.slice(end), start);
      } else if (offset < value.length) {
        change(value.slice(0, offset) + value.slice(offset + 1), offset);
      }
      return true;
    }
    case 105: // Left — plain: move the caret; Shift: extend the
      // selection; Ctrl: jump by word (Shift+Ctrl extends by word).
      if (ev.ctrl) {
        const target = wordStartBefore(value, offset);
        if (ev.shift) extendCaretTo(inst, target);
        else setCaretOffset(inst, target);
      } else if (ev.shift) {
        extendCaretTo(inst, offset - 1);
      } else {
        setCaretOffset(inst, offset - 1);
      }
      return true;
    case 106: // Right — mirror of Left.
      if (ev.ctrl) {
        const target = wordEndAfter(value, offset);
        if (ev.shift) extendCaretTo(inst, target);
        else setCaretOffset(inst, target);
      } else if (ev.shift) {
        extendCaretTo(inst, offset + 1);
      } else {
        setCaretOffset(inst, offset + 1);
      }
      return true;
    case 102: // Home — start of the line (Ctrl: start of the value,
      // the same for a single line).
      if (ev.shift) extendCaretTo(inst, 0);
      else setCaretOffset(inst, 0);
      return true;
    case 107: // End — end of the line (Ctrl: end of the value).
      if (ev.shift) extendCaretTo(inst, value.length);
      else setCaretOffset(inst, value.length);
      return true;
    case 103: // Up
    case 108: // Down
      if (multiline) {
        const font = fontOf(inst);
        const box = measureBox(inst);
        const lines = visualLines(
          textInputValueText(inst),
          font.size,
          font.bold,
          box.width,
        );
        let i = lines.findIndex((l) => offset >= l.start && offset <= l.end);
        if (i < 0) i = lines.length - 1;
        const col = offset - lines[i].start;
        const j = ev.key === 103 ? i - 1 : i + 1;
        if (j >= 0 && j < lines.length) {
          const target = lines[j];
          const next = Math.min(target.start + col, target.end);
          if (ev.shift) extendCaretTo(inst, next);
          else setCaretOffset(inst, next);
        }
      }
      return true;
    default: {
      const pair = KEYMAP[ev.key];
      if (pair && typeof props.onChangeText === "function") {
        // Insert at the caret — replacing the selection when one
        // exists, like Backspace/Delete above.
        const { start, end } = selectionRangeFor(inst);
        const ch = ev.shift ? pair[1] : pair[0];
        if (start !== end) {
          change(value.slice(0, start) + ch + value.slice(end), start + 1);
        } else {
          change(value.slice(0, offset) + ch + value.slice(offset), offset + 1);
        }
      }
      return true;
    }
  }
}

// Linux keycodes (evdev): Enter 28, Space 57, Tab 15, Left 105,
// Right 106, Up 103, Down 108, Escape 1, Home 102, End 107,
// Delete 111.
function handleKey(ev) {
  if (!ev.pressed) return;
  // Typing into the focused TextInput takes precedence over the
  // focus keys below (Space types a space here; Enter submits).
  if (focusedInstance && focusedInstance.type === "TextInput") {
    if (handleTextInputKey(focusedInstance, ev)) {
      SevynReconciler.flushSyncWork();
      presentRoot();
      return;
    }
  }
  switch (ev.key) {
    case 28: // Enter
    case 57: // Space
      activateFocused();
      break;
    case 15: // Tab
    case 106: // Right
    case 108: // Down
      moveFocus(1);
      break;
    case 105: // Left
    case 103: // Up
      moveFocus(-1);
      break;
    case 1: // Escape
      focusedInstance = null;
      break;
    default:
      return;
  }
  // State updates from the handler are SyncLane; force them out now so
  // the focus ring / activation is visible on the next present.
  SevynReconciler.flushSyncWork();
  presentRoot();
}

// Drag-select state (gap unit 3): { inst, anchor } while a
// left-button drag on a TextInput is active, null otherwise.
let textDrag = null;

// Left button: the Wayland host forwards the Linux input code
// (0x110 left, 0x111 right — wayland.h); the headless event-file
// driver and the mock tests send 1. Anything else (right, middle)
// is not a drag-select button. An event with no button at all is
// treated as a left press, matching the old tap behaviour.
function isLeftButton(ev) {
  return ev.button === 0x110 || ev.button === 1 || ev.button === undefined;
}

function handlePointer(ev) {
  // Drag-select (gap unit 3): a left-button press on a TextInput
  // starts a drag; motion extends the selection from the press
  // anchor; release (or the pointer leaving the surface) ends it.
  // The host forwards motion whether or not a button is held, so
  // the drag flag — not the motion event — decides whether motion
  // selects. A "leave" arrives as a far-off motion below; ending
  // the drag here keeps it from dragging the selection to an edge.
  if (ev.type === "leave") textDrag = null;
  if (ev.type === "button" && !ev.pressed) textDrag = null;
  // Motion arrives under three type strings, and pointer-move
  // listeners need all of them. The real Wayland host forwards
  // pointer motion as "motion" (wayland.cc onPointerMotion) and the
  // headless event-file driver uses "move" (sevyn-rn-host.cc
  // loadHeadlessInput) — accepting only "move" silently dropped
  // every real hover.
  // The third string is "enter": the pointer's FIRST contact with
  // the surface arrives as wl_pointer.enter, not motion — the QMP
  // tablet's first abs move enters the surface at the target point
  // and Weston sends no motion for it (verified in QEMU: the hover
  // move to the Calculator tile produced only an enter). An enter
  // carries the real position, so it is a motion event for the
  // listeners. A "leave" is forwarded as a far-off motion so
  // listeners see the pointer leave the surface.
  let moveEv = null;
  if (ev.type === "move" || ev.type === "motion" || ev.type === "enter") {
    moveEv = ev;
  } else if (ev.type === "leave") {
    moveEv = { type: "motion", x: -10000, y: -10000 };
  }
  if (moveEv) {
    let changed = false;
    // Drag-select: motion while a TextInput drag is active extends
    // the selection from the press anchor to the char under the
    // pointer. Only a moved caret re-presents — motion that stays
    // inside the same char is a no-op.
    if (textDrag) {
      const off = offsetAtPoint(textDrag.inst, moveEv.x, moveEv.y);
      if (off !== caretOffsetFor(textDrag.inst)) {
        setSelectionState(textDrag.inst, off, textDrag.anchor);
        changed = true;
      }
    }
    for (const fn of Array.from(pointerMoveListeners)) {
      try {
        if (fn(moveEv) === true) changed = true;
      } catch (e) {
        Sevyn.log(
          "pointer-move listener failed: " + (e && e.message ? e.message : String(e)),
        );
      }
    }
    if (changed) {
      SevynReconciler.flushSyncWork();
      presentRoot();
    }
    return;
  }
  if (ev.type !== "button" || !ev.pressed) return;
  const inst = instancesByYogaId.get(ev.nodeId);
  // Pointer debug: which instance a tap resolved to (testID +
  // accessibilityLabel disambiguate overlapping pressables). Kept
  // permanently; one line per tap, headless runs only.
  Sevyn.log(
    "POINTER nodeId " +
      ev.nodeId +
      " inst " +
      (inst ? inst.type : "none") +
      " onPress " +
      !!(inst && inst.props && inst.props.onPress) +
      " testID " +
      (inst && inst.props ? inst.props.testID || "" : "") +
      " label " +
      (inst && inst.props ? inst.props.accessibilityLabel || "" : ""),
  );
  if (!inst) {
    textDrag = null;
    return;
  }
  focusInstance(inst);
  if (inst.type === "TextInput" && isLeftButton(ev)) {
    // Left press on a TextInput starts a drag-select: the anchor is
    // the char under the pointer (click-to-place — a press with no
    // motion leaves the caret there, replacing the old tap-focus
    // behaviour that always put the caret at the end).
    const off = offsetAtPoint(inst, ev.x, ev.y);
    textDrag = { inst, anchor: off };
    setSelectionState(inst, off, off);
  } else {
    textDrag = null;
  }
  if (inst.props && inst.props.onPress) {
    inst.props.onPress();
    // Pinpoint a stuck tap: if the loop wedges inside the navigation,
    // the "onPress returned" line never appears; if it wedges in the
    // flush (the go-live mount render), only that line appears.
    Sevyn.log("POINTER onPress returned nodeId " + ev.nodeId);
  }
  // Force the state update out now (see handleKey) and present, so the
  // press result is visible on the very next frame.
  SevynReconciler.flushSyncWork();
  Sevyn.log("POINTER flush returned nodeId " + ev.nodeId);
  presentRoot();
}

// Status store for useSyncExternalStore. The snapshot is cached and
// only replaced (new object identity) when a push arrives, so the
// tray re-renders exactly when status changes. Re-rendering the tree
// with the identical element would be a React no-op (bailout), so the
// store — not a whole-tree update — is the status trigger.
let statusSnapshot = null;
const statusListeners = new Set();
function getStatusSnapshot() {
  if (!statusSnapshot) statusSnapshot = Sevyn.getStatus();
  return statusSnapshot;
}
function subscribeStatus(fn) {
  statusListeners.add(fn);
  return () => statusListeners.delete(fn);
}

function handleStatus(ev) {
  // Status pushes arrive as {key, value}. Refresh the cached snapshot
  // (new identity) and notify subscribers; the tray re-renders through
  // useSyncExternalStore. (The host exposes a single onStatus handler,
  // owned by the renderer — the shell must not register its own.)
  statusSnapshot = Sevyn.getStatus();
  for (const fn of Array.from(statusListeners)) {
    try {
      fn();
    } catch (e) {
      Sevyn.log("status listener failed: " + (e && e.message ? e.message : String(e)));
    }
  }
  // Subscriber setStates are SyncLane; force them out now so the tray
  // shows the new status on the very next present.
  SevynReconciler.flushSyncWork();
  presentRoot();
}

// App store for useSyncExternalStore. The snapshot is {apps, running,
// lastEvent, seq} — replaced (new object identity) on every appd
// event, so the shell re-renders exactly when the app set or a
// running state changes. apps comes from Sevyn.listApps() (the host
// asks appd); running tracks LAUNCHED/STOPPED/CRASHED ids; lastEvent
// is the most recent parsed event, for the shell's "Starting…" logic.
let appsSnapshot = null;
const appsListeners = new Set();
// First-boot race (M9): appd seeds the registry before its socket is
// listening, so the shell's first listApps() can return [] while appd
// is still seeding. An empty snapshot must never be memoized —
// re-LIST on a short timer until appd answers with the real list,
// then replace the snapshot and notify so the shell re-renders with
// all apps. The shell mounts with the 15-app fallback meanwhile and
// corrects itself seconds later; first render is never blocked.
let appsRetryTimer = null;
function notifyAppsListeners() {
  for (const fn of Array.from(appsListeners)) {
    try {
      fn();
    } catch (e) {
      Sevyn.log("apps listener failed: " + (e && e.message ? e.message : String(e)));
    }
  }
  SevynReconciler.flushSyncWork();
  presentRoot();
}
// Re-LIST from appd and replace the snapshot, preserving the running
// set and last event. Returns true once the list is non-empty.
function refreshAppsSnapshot() {
  let apps = [];
  try {
    apps = Sevyn.listApps() || [];
  } catch (e) {
    apps = [];
  }
  // Diagnostic (icons PR #102): the dock showed 15 apps while
  // appd lists 16 — log what the shell's snapshot holds so the
  // next CI run pins the gap to the host, the bridge, or the shell.
  try {
    Sevyn.log(
      "apps snapshot " + apps.length + " apps: " + apps.map((a) => a.id).join(","),
    );
  } catch (e) {
    // Logging must never break the snapshot.
  }
  const prev = appsSnapshot;
  appsSnapshot = {
    apps,
    running: prev ? prev.running : [],
    lastEvent: prev ? prev.lastEvent : null,
    seq: prev ? prev.seq + 1 : 0,
  };
  if (!apps.length) return false;
  notifyAppsListeners();
  return true;
}
function scheduleAppsRetry() {
  if (appsRetryTimer) return;
  appsRetryTimer = setTimeout(() => {
    appsRetryTimer = null;
    // Another path (e.g. handleAppEvent's backstop) may already have
    // filled the snapshot — only keep retrying while it is empty.
    if (appsSnapshot && appsSnapshot.apps.length) return;
    if (!refreshAppsSnapshot()) scheduleAppsRetry();
  }, 1000);
}
function getAppsSnapshot() {
  if (!appsSnapshot) {
    appsSnapshot = { apps: [], running: [], lastEvent: null, seq: 0 };
    if (!refreshAppsSnapshot()) scheduleAppsRetry();
  }
  return appsSnapshot;
}
function subscribeApps(fn) {
  appsListeners.add(fn);
  return () => appsListeners.delete(fn);
}
function handleAppEvent(line) {
  // "EVENT <KIND> <id> [rest]" — the host owns the single onAppEvent
  // handler, like onStatus; the shell must not register its own.
  const parts = String(line).split(" ");
  const kind = parts[1] || "";
  const id = parts[2] || "";
  const prev = getAppsSnapshot();
  let { apps, running } = prev;
  // Backstop for the first-boot race (M9): if the snapshot is still
  // empty, appd was seeding when the shell first asked. Re-LIST on
  // any event kind — the first event after boot refreshes the dock
  // before the icons check runs.
  let backstopRefilled = false;
  if (!apps.length) {
    try {
      apps = Sevyn.listApps() || [];
      backstopRefilled = apps.length > 0;
    } catch (e) {
      apps = prev.apps;
    }
  }
  if (kind === "LAUNCHED") {
    if (!running.includes(id)) running = [...running, id];
  } else if (kind === "STOPPED" || kind === "CRASHED") {
    // "EVENT STOPPED <id> <exit> <remaining>" — remaining is the
    // instances of this id still running (multi-instance apps).
    // Keep the dock dot while any instance is alive; the field is
    // absent on old event lines, which behave as before (0). The
    // signal form carries an extra word ("EVENT STOPPED <id> signal
    // <n> <remaining>"), so the index depends on parts[3].
    const remIdx = parts[3] === "signal" ? 5 : 4;
    const remaining = parts.length > remIdx ? Number(parts[remIdx]) || 0 : 0;
    if (remaining <= 0) running = running.filter((r) => r !== id);
  } else if (kind === "INSTALLED" || kind === "UNINSTALLED") {
    try {
      apps = Sevyn.listApps() || [];
    } catch (e) {
      apps = prev.apps;
    }
  } else if (!backstopRefilled) {
    return; // Unknown event: no re-render (unless the backstop just filled the snapshot).
  }
  appsSnapshot = {
    apps,
    running,
    lastEvent: { kind, id },
    seq: prev.seq + 1,
  };
  notifyAppsListeners();
}

// Window state store for useSyncExternalStore. The snapshot is
// {maximized: boolean} — an app's title bar shows ▢ or ❐ from it.
// The host reports changes via Sevyn.onWindowState (maximize /
// unmaximize / a title-bar drag restoring a maximized window);
// Sevyn.windowState ("normal" | "maximized" | "minimized") is the
// initial value. Minimized never reaches this store (a minimized
// window is hidden; the dock restores it through the focus path).
let windowStateSnapshot = null;
const windowStateListeners = new Set();
function getWindowStateSnapshot() {
  if (!windowStateSnapshot) {
    windowStateSnapshot = { maximized: Sevyn.windowState === "maximized" };
  }
  return windowStateSnapshot;
}
function subscribeWindowState(fn) {
  windowStateListeners.add(fn);
  return () => windowStateListeners.delete(fn);
}
function handleWindowState(ev) {
  const maximized = !!(ev && ev.state === "maximized");
  const prev = getWindowStateSnapshot();
  if (prev.maximized === maximized) return;
  windowStateSnapshot = { maximized };
  for (const fn of Array.from(windowStateListeners)) {
    try {
      fn();
    } catch (e) {
      Sevyn.log(
        "window-state listener failed: " + (e && e.message ? e.message : String(e)),
      );
    }
  }
  SevynReconciler.flushSyncWork();
  presentRoot();
}
// Pointer-move subscribers. Move events
// arrive at pointer rate, so a listener must return true only when it
// changed state — the renderer re-presents only then, never once per
// motion event. The host forwards motion to the single onPointer
// handler (see handlePointer); the shell must not register its own.
const pointerMoveListeners = new Set();
function subscribePointerMove(fn) {
  pointerMoveListeners.add(fn);
  return () => pointerMoveListeners.delete(fn);
}

// Surface-size store for useSyncExternalStore. The snapshot is cached
// and only replaced (new object identity) when the host reports a
// resize — the resize handler re-presents but does not re-render
// React, so without this the dock would keep its old tile size after
// a resize. Refreshed on first mount in render().
let surfaceSizeSnapshot = { width: rootWidth, height: rootHeight };
const surfaceSizeListeners = new Set();
function getSurfaceSizeSnapshot() {
  return surfaceSizeSnapshot;
}
function subscribeSurfaceSize(fn) {
  surfaceSizeListeners.add(fn);
  return () => surfaceSizeListeners.delete(fn);
}

// ------------------------------------------------------------- host config
const hostConfig = {
  isPrimaryRenderer: true,
  supportsMutation: true,
  supportsPersistence: false,
  supportsHydration: false,

  // The reconciler reads these once at init; the host's own
  // default-lane value is 32 (see DEFAULT_PRIORITY above).
  getCurrentUpdatePriority() {
    return currentUpdatePriority;
  },
  setCurrentUpdatePriority(priority) {
    currentUpdatePriority = priority;
  },
  resolveUpdatePriority() {
    return currentUpdatePriority;
  },
  // Event time/type: no DOM event system; updates are stamped with the
  // wall clock. resolveEventType returns null (no event in flight).
  resolveEventTimeStamp() {
    return Date.now();
  },
  resolveEventType() {
    return null;
  },
  // Scheduler bookkeeping hooks; no-ops for this renderer.
  trackSchedulerEvent() {},
  shouldAttemptEagerTransition() {
    return false;
  },
  warnsIfNotActing: false,
  supportsMicrotasks: true,
  scheduleMicrotask(fn) {
    if (typeof queueMicrotask === "function") queueMicrotask(fn);
    else Promise.resolve().then(fn);
  },

  getRootHostContext() {
    return {};
  },
  getChildHostContext(parentHostContext) {
    return parentHostContext;
  },
  getPublicInstance(instance) {
    return instance;
  },
  getInstanceFromNode(node) {
    return node;
  },
  beforeActiveInstanceBlur() {},
  afterActiveInstanceBlur() {},
  preparePortalMount() {},

  prepareForCommit() {
    return null;
  },
  resetAfterCommit(container) {
    presentRoot();
  },

  createInstance(type, props, rootContainerInstance, hostContext, internalHandle) {
    const inst = makeInstance(type, props);
    applyStyleToNode(inst);
    if (type === "Text") installTextMeasure(inst);
    if (type === "Image") installImageMeasure(inst);
    if (type === "TextInput") installTextInputMeasure(inst);
    return inst;
  },
  createTextInstance(text, rootContainerInstance, hostContext, internalHandle) {
    const inst = makeInstance("#text", {});
    inst.text = text;
    installTextMeasure(inst);
    return inst;
  },
  appendInitialChild(parentInstance, child) {
    detachFromParent(child);
    parentInstance.children.push(child);
    child.parent = parentInstance;
  },
  finalizeInitialChildren(instance, type, props, hostContext) {
    return false;
  },
  // NOTE: react-reconciler 0.34 has NO prepareUpdate / updatePayload —
  // updateHostComponent marks a host fiber for update whenever
  // memoizedProps !== newProps (reference inequality), and commitUpdate
  // then receives (instance, type, oldProps, newProps, handle) with no
  // payload. A prepareUpdate entry here would simply never be called.
  // (This cost a real bug: the old 6-arg commitUpdate read the Fiber
  // as nextProps and wiped every style to {} on the first re-render.)
  shouldSetTextContent(type, props) {
    return false;
  },

  appendChild(parentInstance, child) {
    detachFromParent(child);
    parentInstance.children.push(child);
    child.parent = parentInstance;
  },
  appendChildToContainer(container, child) {
    detachFromParent(child);
    container.children.push(child);
    child.parent = null;
  },
  insertBefore(parentInstance, child, beforeChild) {
    detachFromParent(child);
    const i = parentInstance.children.indexOf(beforeChild);
    if (i >= 0) parentInstance.children.splice(i, 0, child);
    else parentInstance.children.push(child);
    child.parent = parentInstance;
  },
  insertInContainerBefore(container, child, beforeChild) {
    detachFromParent(child);
    const i = container.children.indexOf(beforeChild);
    if (i >= 0) container.children.splice(i, 0, child);
    else container.children.push(child);
    child.parent = null;
  },
  removeChild(parentInstance, child) {
    const i = parentInstance.children.indexOf(child);
    if (i >= 0) parentInstance.children.splice(i, 1);
    child.parent = null;
    freeSubtree(child);
  },
  removeChildFromContainer(container, child) {
    const i = container.children.indexOf(child);
    if (i >= 0) container.children.splice(i, 1);
    child.parent = null;
    freeSubtree(child);
  },

  commitTextUpdate(textInstance, oldText, newText) {
    textInstance.text = newText;
  },
  commitMount(instance, type, props, internalInstanceHandle) {},
  commitUpdate(instance, type, prevProps, nextProps, internalInstanceHandle) {
    instance.props = nextProps;
    applyStyleToNode(instance);
    // A value change must re-measure the input: re-installing the
    // measure function marks the Yoga node dirty, so the next layout
    // reads the new value (style re-application alone may not dirty
    // it when the style itself is unchanged).
    if (type === "TextInput") installTextInputMeasure(instance);
  },

  hideInstance(instance) {
    instance.hidden = true;
  },
  hideTextInstance(textInstance) {
    textInstance.hidden = true;
  },
  unhideInstance(instance, props) {
    instance.hidden = false;
  },
  unhideTextInstance(textInstance, text) {
    textInstance.hidden = false;
  },
  clearContainer(container) {
    for (const c of container.children) freeSubtree(c);
    container.children = [];
  },
  detachDeletedInstance(node) {
    if (node.yogaId != null) {
      Sevyn.yogaFreeNode(node.yogaId);
      instancesByYogaId.delete(node.yogaId);
    }
    // A deleted node cannot stay focused — otherwise a tree swap
    // leaves focus pointing at a dead instance and autoFocus never
    // engages for the new tree.
    if (focusedInstance === node) focusedInstance = null;
  },

  scheduleTimeout(fn, delay) {
    return setTimeout(fn, delay);
  },
  cancelTimeout(id) {
    clearTimeout(id);
  },
  noTimeout: -1,

  // React 19 reads these for the commit phase; a no-op is correct here
  // (the host presents synchronously in resetAfterCommit).
  requestPostPaintCallback() {},
};

const SevynReconciler = Reconciler(hostConfig);

// ------------------------------------------------------------------- API
// Render a React element into the host. The root is a Yoga node sized to
// the surface; the shell calls this once with <Shell />.
function render(element, options) {
  const opts = options || {};
  rootWidth = opts.width || 1024;
  rootHeight = opts.height || 768;
  backgroundColor = opts.backgroundColor || "#0b0b0f";
  surfaceSizeSnapshot = { width: rootWidth, height: rootHeight };

  rootContainer = {
    type: "#root",
    props: {},
    yogaId: Sevyn.yogaCreateNode(),
    children: [],
    parent: null,
    text: "",
    hidden: false,
    scrollX: 0,
    scrollY: 0,
    contentWidth: 0,
    contentHeight: 0,
  };
  instancesByYogaId.set(rootContainer.yogaId, rootContainer);
  Sevyn.yogaSetStyle(rootContainer.yogaId, {
    width: rootWidth,
    height: rootHeight,
    flexDirection: "column",
  });

  Sevyn.onPointer(handlePointer);
  Sevyn.onKey(handleKey);
  Sevyn.onStatus(handleStatus);
  if (typeof Sevyn.onScroll === "function") Sevyn.onScroll(scrollAt);
  if (typeof Sevyn.onAppEvent === "function") Sevyn.onAppEvent(handleAppEvent);
  if (typeof Sevyn.onWindowState === "function") Sevyn.onWindowState(handleWindowState);
  // M9 surface resize: the host resized the painters already; re-size
  // the root Yoga node and re-present at the new size. The event
  // carries the new size (Sevyn.width/height are updated too).
  if (typeof Sevyn.onWindowResize === "function") {
    Sevyn.onWindowResize((ev) => {
      const w = ev && ev.width ? ev.width : rootWidth;
      const h = ev && ev.height ? ev.height : rootHeight;
      if (w === rootWidth && h === rootHeight) return;
      rootWidth = w;
      rootHeight = h;
      surfaceSizeSnapshot = { width: w, height: h };
      for (const fn of Array.from(surfaceSizeListeners)) {
        try {
          fn();
        } catch (e) {
          Sevyn.log(
            "surface-size listener failed: " + (e && e.message ? e.message : String(e)),
          );
        }
      }
      if (rootContainer) {
        Sevyn.yogaSetStyle(rootContainer.yogaId, {
          width: rootWidth,
          height: rootHeight,
          flexDirection: "column",
        });
      }
      SevynReconciler.flushSyncWork();
      presentRoot();
    });
  }

  // NOTE: the onUncaughtError handler must log — a no-op here would
  // silently swallow render throws and mount an empty tree. Log the
  // stack too: on-device the message alone rarely names the thrower
  // (e.g. a missing native global referenced by a real-RN module).
  const onUncaughtError = (error) => {
    Sevyn.log(
      "render error: " +
        (error && error.message ? error.message : String(error)) +
        (error && error.stack ? "\n" + error.stack : ""),
    );
  };
  const root = SevynReconciler.createContainer(
    rootContainer,
    0,
    null,
    false,
    null,
    "",
    onUncaughtError,
    null,
  );
  currentRoot = root;
  currentElement = element;
  // updateContainerSync requests the Sync lane, but the reconciler
  // still flushes through the Scheduler (microtask) in this build — so
  // a mount would not present in the same tick. The shell is a sync
  // renderer: force the flush here. (State updates from event handlers
  // flush the same way via the host's drainMicrotasks after each event.)
  SevynReconciler.updateContainerSync(element, root, null, () => {
    Sevyn.log("shell mounted");
  });
  SevynReconciler.flushSyncWork();
  return root;
}

// Re-render into the existing root (shell updates / tests).
function update(element) {
  if (!currentRoot) return render(element);
  currentElement = element;
  SevynReconciler.updateContainerSync(element, currentRoot, null, null);
  SevynReconciler.flushSyncWork();
  return currentRoot;
}

// Unmount the tree (frees Yoga nodes via detachDeletedInstance).
function unmount() {
  if (!currentRoot) return;
  SevynReconciler.updateContainerSync(null, currentRoot, null, null);
  SevynReconciler.flushSyncWork();
  focusedInstance = null;
  if (rootContainer && rootContainer.yogaId != null) {
    Sevyn.yogaFreeNode(rootContainer.yogaId);
    instancesByYogaId.delete(rootContainer.yogaId);
  }
  currentRoot = null;
  rootContainer = null;
  currentElement = null;
}

// ScrollView imperative API (called through refs from the shell).
function scrollBy(instance, dx, dy) {
  if (!instance || instance.type !== "ScrollView") return;
  // Clamp against the viewport size from the last layout.
  const l = Sevyn.yogaGetLayout(instance.yogaId);
  const horizontal = flattenStyle(instance.props.style).flexDirection === "row";
  if (horizontal) {
    instance.scrollX = Math.max(
      0,
      Math.min(instance.contentWidth - l.width, instance.scrollX + dx),
    );
  } else {
    instance.scrollY = Math.max(
      0,
      Math.min(instance.contentHeight - l.height, instance.scrollY + dy),
    );
  }
  presentRoot();
}

function scrollTo(instance, x, y) {
  if (!instance || instance.type !== "ScrollView") return;
  const l = Sevyn.yogaGetLayout(instance.yogaId);
  const horizontal = flattenStyle(instance.props.style).flexDirection === "row";
  if (horizontal) {
    instance.scrollX = Math.max(0, Math.min(instance.contentWidth - l.width, x));
  } else {
    instance.scrollY = Math.max(0, Math.min(instance.contentHeight - l.height, y));
  }
  presentRoot();
}

// Scroll the topmost ScrollView containing (ev.x, ev.y) — the
// headless driver's way to reach below-the-fold controls (Tokrah's
// Go Live screen flexes its preview with the viewport, so its Start
// button is always below the fold). Walk mirrors emitInstance's
// coordinate math; the last (topmost) match wins.
function scrollAt(ev) {
  if (!rootContainer) return;
  // Collect every ScrollView containing the point, outermost first.
  // The gesture goes to the INNERMOST one that can actually scroll
  // in the requested direction: a nested scroller whose content fits
  // (Tokrah's Go Live screen has a 740x549 nested ScrollView under
  // the point) must not swallow the gesture — it bubbles to the
  // outer screen scroller (content 1387) that can scroll. If none
  // can scroll, the innermost still gets the (no-op) event.
  const candidates = [];
  function walk(inst, ox, oy) {
    if (inst.hidden) return;
    const l = Sevyn.yogaGetLayout(inst.yogaId);
    const x = ox + l.x;
    const y = oy + l.y;
    if (ev.x < x || ev.y < y || ev.x >= x + l.width || ev.y >= y + l.height) return;
    if (inst.type === "ScrollView") {
      candidates.push(inst);
      const horizontal = flattenStyle(inst.props.style).flexDirection === "row";
      const dx = horizontal ? -inst.scrollX : 0;
      const dy = horizontal ? 0 : -inst.scrollY;
      for (const c of inst.children) walk(c, x + dx, y + dy);
    } else {
      for (const c of inst.children) walk(c, x, y);
    }
  }
  for (const c of rootContainer.children) walk(c, 0, 0);
  if (!candidates.length) return;
  const dx = ev.dx || 0;
  const dy = ev.dy || 0;
  // Debug: which scrollers contain the point, and can they scroll?
  // (One line per scroll event; the Go Live screen has a nested
  // 740x549 scroller that must not swallow the outer gesture.)
  const candStr = candidates
    .map((inst) => {
      const l = Sevyn.yogaGetLayout(inst.yogaId);
      return (
        inst.contentWidth + "x" + inst.contentHeight + "/" + l.width + "x" + l.height
      );
    })
    .join(" ");
  Sevyn.log("SCROLL candidates (" + ev.x + "," + ev.y + "): " + candStr);
  let target = candidates[candidates.length - 1];
  for (let i = candidates.length - 1; i >= 0; i--) {
    const inst = candidates[i];
    const l = Sevyn.yogaGetLayout(inst.yogaId);
    const canScroll =
      (dy !== 0 && inst.contentHeight > l.height) ||
      (dx !== 0 && inst.contentWidth > l.width);
    if (canScroll) {
      target = inst;
      break;
    }
  }
  const before = target.scrollY;
  scrollBy(target, ev.dx || 0, ev.dy || 0);
  Sevyn.log(
    "SCROLL (" +
      ev.x +
      "," +
      ev.y +
      ") by (" +
      (ev.dx || 0) +
      "," +
      (ev.dy || 0) +
      ") -> scrollY " +
      before +
      " -> " +
      target.scrollY +
      " (content " +
      target.contentWidth +
      "x" +
      target.contentHeight +
      ")",
  );
}

module.exports = {
  render,
  update,
  unmount,
  scrollBy,
  scrollTo,
  subscribeStatus,
  getStatusSnapshot,
  subscribeApps,
  getAppsSnapshot,
  subscribeWindowState,
  getWindowStateSnapshot,
  subscribePointerMove,
  subscribeSurfaceSize,
  getSurfaceSizeSnapshot,
  // Exposed for tests: the live instance map and present pass.
  _instancesByYogaId: instancesByYogaId,
  _presentRoot: presentRoot,
};
