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
//                               shift: bool}
//     shift is the state of either Shift key at the moment of the
//     event (tracked by keycode in the host — it reads no xkb keymap).
//   Sevyn.onStatus(ev)   ev = {key, value} — statusd push.
//   Sevyn.onAppEvent(line) line = "EVENT LAUNCHED files" — appd push.
//   Sevyn.listApps()     -> [{id, name, version, color, glyph,
//                          system, protected, permissions}] — appd LIST.
//   Sevyn.launchApp(id)  -> bool — appd LAUNCH.
//   Sevyn.exec(cmdline)  -> "<exit-code>\n<output>" — one-shot run of
//                          /usr/local/bin/sevyn only; gated by the
//                          cli.exec permission (ERR string otherwise).
//
// TextInput (M4, caret + multiline in the GF65 fixes): a controlled
// input, single-line by default. Props: value, onChangeText,
// onSubmitEditing, placeholder, autoFocus, multiline, secureTextEntry.
// The focused input eats printable keys (US keycode map below,
// Shift-aware), Backspace, Delete, and Enter (submit — or a newline
// when multiline); Tab moves focus, Escape blurs. The caret moves
// with Left/Right/Home/End and, when multiline, Up/Down between
// wrapped lines; it is drawn from the value (masked when secure),
// never the placeholder. No selection — still M4 scope.
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

// TextInput caret state. The caret offset (character index into the
// value) lives on the instance; it is (re)set to the end of the value
// on focus and clamped lazily to [0, value.length], so an external
// value change (e.g. Terminal clearing the input on submit) can never
// leave it out of range. No click-to-place: a tap focuses the input,
// arrows move the caret.
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
  inst.caretOffset = Math.max(0, Math.min(textInputValue(inst).length, n));
}

function focusInstance(inst) {
  focusedInstance = inst;
  if (inst && inst.type === "TextInput") {
    inst.caretOffset = textInputValue(inst).length;
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
// edit at the caret offset; Left/Right/Home/End move it; Up/Down move
// between visual lines when multiline (single-line: swallowed, never
// a focus move — the M4 behaviour, kept).
function handleTextInputKey(inst, ev) {
  const props = inst.props || {};
  const value = textInputValue(inst);
  const multiline = !!props.multiline;
  const offset = caretOffsetFor(inst);
  const change = (next, nextOffset) => {
    if (typeof props.onChangeText === "function") props.onChangeText(next);
    // Clamp against the NEW value's length: props.value is still the
    // old value until the state update flushes.
    inst.caretOffset = Math.max(0, Math.min(next.length, nextOffset));
  };
  switch (ev.key) {
    case 15: // Tab — move focus.
    case 1: // Escape — blur.
      return false;
    case 28: // Enter — submit, or a newline when multiline.
      if (multiline) {
        change(value.slice(0, offset) + "\n" + value.slice(offset), offset + 1);
      } else if (typeof props.onSubmitEditing === "function") {
        props.onSubmitEditing();
      }
      return true;
    case 14: // Backspace — delete the char before the caret.
      if (offset > 0) {
        change(value.slice(0, offset - 1) + value.slice(offset), offset - 1);
      }
      return true;
    case 111: // Delete — delete the char at the caret.
      if (offset < value.length) {
        change(value.slice(0, offset) + value.slice(offset + 1), offset);
      }
      return true;
    case 105: // Left
      setCaretOffset(inst, offset - 1);
      return true;
    case 106: // Right
      setCaretOffset(inst, offset + 1);
      return true;
    case 102: // Home
      setCaretOffset(inst, 0);
      return true;
    case 107: // End
      setCaretOffset(inst, value.length);
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
          setCaretOffset(inst, Math.min(target.start + col, target.end));
        }
      }
      return true;
    default: {
      const pair = KEYMAP[ev.key];
      if (pair && typeof props.onChangeText === "function") {
        // Insert at the caret, not at the end.
        change(
          value.slice(0, offset) + (ev.shift ? pair[1] : pair[0]) + value.slice(offset),
          offset + 1,
        );
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

function handlePointer(ev) {
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
  if (!inst) return;
  focusInstance(inst);
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
function getAppsSnapshot() {
  if (!appsSnapshot) {
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
    appsSnapshot = { apps, running: [], lastEvent: null, seq: 0 };
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
  } else {
    return; // Unknown event: no re-render.
  }
  appsSnapshot = {
    apps,
    running,
    lastEvent: { kind, id },
    seq: prev.seq + 1,
  };
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
      if (rootContainer) {
        Sevyn.yogaSetStyle(rootContainer.yogaId, {
          width: rootWidth,
          height: rootHeight,
          flexDirection: "column",
        });
      }
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
  // Exposed for tests: the live instance map and present pass.
  _instancesByYogaId: instancesByYogaId,
  _presentRoot: presentRoot,
};
