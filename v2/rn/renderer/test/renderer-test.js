"use strict";
// Node smoke test for the Sevyn renderer (mock Sevyn host).
// Run: node test/renderer-test.js   (from v2/rn/renderer, with
// react + react-reconciler resolvable — see v2/rn/renderer/package.json)
const assert = require("node:assert/strict");

global.Sevyn = require("./mock-sevyn");
const React = require("react");
const renderer = require("../sevyn-renderer");

const { createElement: h } = React;

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log("ok - " + name);
}

// --- a small shell-like tree -------------------------------------------
const clicks = [];
function App() {
  return h(
    "View",
    {
      style: {
        width: 1024,
        height: 768,
        flexDirection: "column",
        backgroundColor: "#0b0b0f",
      },
    },
    h(
      "View",
      { style: { flexDirection: "row", height: 48, backgroundColor: "#15151c" } },
      h("Text", { style: { fontSize: 16, color: "#ffffff" } }, "SevynOS"),
      h("Text", { style: { fontSize: 14, color: "#9ca3af" } }, "wifi on"),
    ),
    h(
      "ScrollView",
      { style: { flexDirection: "row", height: 64, backgroundColor: "#101014" } },
      h(
        "Pressable",
        {
          onPress: () => clicks.push("files"),
          style: { width: 56, height: 56, backgroundColor: "#1f2937" },
        },
        h("Text", { style: { fontSize: 12, color: "#fff" } }, "Files"),
      ),
      h(
        "Pressable",
        {
          onPress: () => clicks.push("terminal"),
          style: { width: 56, height: 56, backgroundColor: "#1f2937" },
        },
        h("Text", { style: { fontSize: 12, color: "#fff" } }, "Terminal"),
      ),
    ),
    h(
      "View",
      { style: { flex: 1, backgroundColor: "#0b0b0f" } },
      h("Text", { style: { fontSize: 20, color: "#fff" } }, "Welcome to SevynOS"),
    ),
  );
}

renderer.render(h(App), { width: 1024, height: 768 });

check("present called with ops after mount", () => {
  assert.ok(Sevyn._presents.length >= 1);
  const last = Sevyn._presents[Sevyn._presents.length - 1];
  assert.ok(Array.isArray(last.ops));
  assert.ok(last.ops.length > 0);
});

check("ops include dock rect + title text + welcome text", () => {
  const last = Sevyn._presents[Sevyn._presents.length - 1];
  const rects = last.ops.filter((o) => o.type === "rect");
  const texts = last.ops.filter((o) => o.type === "text");
  assert.ok(
    rects.some((o) => o.color === "#15151c"),
    "top bar rect",
  );
  assert.ok(
    rects.some((o) => o.color === "#101014"),
    "dock rect",
  );
  assert.ok(
    texts.some((o) => o.text === "SevynOS"),
    "title text",
  );
  assert.ok(
    texts.some((o) => o.text === "Welcome to SevynOS"),
    "welcome text",
  );
  assert.ok(
    texts.some((o) => o.text === "Files"),
    "dock label",
  );
});

check("pressable rects carry nodeId for hit-testing", () => {
  const last = Sevyn._presents[Sevyn._presents.length - 1];
  const hits = last.ops.filter((o) => o.nodeId != null && o.nodeId >= 0);
  assert.equal(hits.length, 2, "two pressables");
});

check("pointer press on a dock icon fires onPress", () => {
  const last = Sevyn._presents[Sevyn._presents.length - 1];
  const hit = last.ops.find((o) => o.nodeId != null && o.nodeId >= 0);
  assert.ok(hit, "hit op exists");
  Sevyn._handlers.pointer({
    type: "button",
    x: hit.x + 1,
    y: hit.y + 1,
    button: 1,
    pressed: true,
    nodeId: hit.nodeId,
  });
  assert.equal(clicks.length, 1);
});

check("keyboard: Tab moves focus, Enter activates", () => {
  clicks.length = 0;
  Sevyn._handlers.key({ key: 15, pressed: true }); // Tab
  Sevyn._handlers.key({ key: 28, pressed: true }); // Enter
  assert.equal(clicks.length, 1, "focused pressable activated");
  // Focus ring drawn on the next present.
  const last = Sevyn._presents[Sevyn._presents.length - 1];
  assert.ok(
    last.ops.some((o) => o.type === "rect" && o.color === "#f5c518"),
    "focus ring",
  );
});

check("text measure flows through Sevyn.measureText", () => {
  const m = Sevyn.measureText("hello", 14, false, 0);
  assert.ok(m.width > 0 && m.height > 0);
});

check("style update re-presents with the new colour", () => {
  const before = Sevyn._presents.length;
  function App2() {
    return h(
      "View",
      { style: { width: 1024, height: 768, backgroundColor: "#111111" } },
      h("Text", { style: { fontSize: 16, color: "#ffffff" } }, "Updated"),
    );
  }
  renderer.update(h(App2));
  assert.ok(Sevyn._presents.length > before, "re-presented after update");
  const last = Sevyn._presents[Sevyn._presents.length - 1];
  assert.ok(last.ops.some((o) => o.type === "text" && o.text === "Updated"));
  assert.ok(
    !last.ops.some((o) => o.type === "text" && o.text === "SevynOS"),
    "old tree gone",
  );
  // Restore the shell tree for the remaining checks.
  renderer.update(h(App));
});

check("unmount frees yoga nodes", () => {
  const before = Sevyn._nodes.size;
  assert.ok(before > 0, "nodes exist before unmount");
  renderer.unmount();
  assert.equal(Sevyn._nodes.size, 0, "all yoga nodes freed");
  // Re-mount for a clean end state.
  renderer.render(h(App), { width: 1024, height: 768 });
  assert.ok(Sevyn._nodes.size > 0, "nodes recreated on remount");
});

// --- TextInput (M4) -----------------------------------------------------
const submitted = [];
const inputClicks = [];
let inputValue = "";
let noteValue = "";
function InputApp() {
  const [value, setValue] = React.useState("");
  inputValue = value;
  const [note, setNote] = React.useState("");
  noteValue = note;
  return h(
    "View",
    { style: { width: 800, height: 500, backgroundColor: "#111827" } },
    h("TextInput", {
      value,
      onChangeText: setValue,
      onSubmitEditing: () => submitted.push(value),
      placeholder: "type a command",
      autoFocus: true,
      style: {
        height: 32,
        backgroundColor: "#1f2937",
        fontSize: 16,
        color: "#ffffff",
      },
    }),
    h(
      "Pressable",
      {
        onPress: () => inputClicks.push("go"),
        style: { width: 80, height: 32, backgroundColor: "#3b82f6" },
      },
      h("Text", { style: { fontSize: 14, color: "#fff" } }, "Go"),
    ),
    h("TextInput", {
      value: note,
      onChangeText: setNote,
      placeholder: "type a note",
      multiline: true,
      style: {
        width: 120,
        height: 64,
        backgroundColor: "#312e81",
        fontSize: 16,
        color: "#ffffff",
      },
    }),
  );
}

function lastPresent() {
  return Sevyn._presents[Sevyn._presents.length - 1];
}
function lastTexts() {
  return lastPresent()
    .ops.filter((o) => o.type === "text")
    .map((o) => o.text);
}
function key(code, shift) {
  Sevyn._handlers.key({ key: code, pressed: true, shift: !!shift });
}
function caret() {
  // The caret is the only 2-wide WHITE rect; the focus ring is gold.
  return lastPresent().ops.find(
    (o) => o.type === "rect" && o.w === 2 && o.color === "#ffffff",
  );
}

renderer.update(h(InputApp));

check("TextInput: autoFocus + placeholder + caret on mount", () => {
  const texts = lastPresent().ops.filter((o) => o.type === "text");
  const ph = texts.find((o) => o.text === "type a command");
  assert.ok(ph, "placeholder shown");
  assert.equal(ph.color, "#6b7280", "placeholder is dimmed");
  assert.ok(caret(), "caret drawn for the focused input");
  assert.equal(
    caret().x,
    ph.x + 1,
    "caret at the left edge of the empty input, not after the placeholder",
  );
});

check("TextInput: typing appends, Shift uppercases", () => {
  key(30); // a
  assert.equal(inputValue, "a");
  key(30, true); // A
  assert.equal(inputValue, "aA");
  key(53); // /
  key(32); // d
  assert.equal(inputValue, "aA/d");
  assert.ok(lastTexts().includes("aA/d"), "typed text is presented");
  assert.ok(caret(), "caret still drawn after typing");
});

check("TextInput: Space types a space, Backspace deletes", () => {
  key(57); // space
  assert.equal(inputValue, "aA/d ");
  key(14); // Backspace
  assert.equal(inputValue, "aA/d");
  key(14);
  assert.equal(inputValue, "aA/");
});

check("TextInput: caret moves with arrows, Home/End, insert/delete in the middle", () => {
  // Value is "aA/" from the earlier checks; caret starts at the end.
  const endX = caret().x;
  key(105); // Left
  assert.ok(caret().x < endX, "Left moves the caret back");
  const midX = caret().x;
  key(45, true); // X — inserts at the caret, not at the end
  assert.equal(inputValue, "aAX/", "typed char inserted mid-value");
  assert.ok(caret().x > midX, "caret advances past the insert");
  key(14); // Backspace — deletes the char before the caret (the X)
  assert.equal(inputValue, "aA/", "Backspace deleted the inserted char");
  key(102); // Home — caret to the start
  const hit = lastPresent().ops.find(
    (o) => o.type === "rect" && o.h === 32 && o.color === "#1f2937",
  );
  assert.ok(hit, "input hit rect exists");
  assert.equal(caret().x, hit.x + 1, "Home puts the caret at the left edge");
  key(107); // End — caret back to the end
  assert.equal(caret().x, endX, "End restores the caret to the end");
  key(111); // Delete at the end — no-op
  assert.equal(inputValue, "aA/", "Delete at the end changes nothing");
  key(106); // Right at the end — clamped, no move
  assert.equal(caret().x, endX, "Right at the end is clamped");
  key(28); // Enter
  assert.deepEqual(submitted, ["aA/"], "submitted the current value");
  assert.ok(caret(), "still focused after submit");
});

check("TextInput: Tab moves focus to the button, Enter activates it", () => {
  key(15); // Tab
  assert.equal(caret(), undefined, "caret gone once focus leaves");
  key(28); // Enter
  assert.deepEqual(inputClicks, ["go"], "button activated");
});

check("TextInput: clicking the input focuses it again", () => {
  const hit = lastPresent().ops.find(
    (o) =>
      o.type === "rect" &&
      o.nodeId != null &&
      o.nodeId >= 0 &&
      o.h === 32 &&
      o.color === "#1f2937",
  );
  assert.ok(hit, "input hit rect exists");
  Sevyn._handlers.pointer({
    type: "button",
    x: hit.x + 1,
    y: hit.y + 1,
    button: 1,
    pressed: true,
    nodeId: hit.nodeId,
  });
  assert.ok(caret(), "caret back after click-focus");
  assert.equal(inputClicks.length, 1, "click did not fire the button");
});

// --- TextInput multiline (GF65 fix) ------------------------------------
check("TextInput multiline: Tab reaches the note input", () => {
  key(15); // Tab — input -> button
  key(15); // Tab — button -> multiline note input
  assert.ok(caret(), "caret drawn for the multiline input");
  assert.equal(noteValue, "", "note starts empty");
});

check("TextInput multiline: typing wraps, Up/Down move between rows", () => {
  // "aaaa bbbb cccc dddd" at 8.8px/char in a 120px box: "aaaa bbbb"
  // (79.2px) fits row 0, "cccc dddd" wraps to row 1.
  const codes = [
    30, 30, 30, 30, 57, 48, 48, 48, 48, 57, 46, 46, 46, 46, 57, 32, 32, 32, 32,
  ];
  for (const c of codes) key(c);
  assert.equal(noteValue, "aaaa bbbb cccc dddd", "typed the full note");
  const hit = lastPresent().ops.find(
    (o) => o.type === "rect" && o.h === 64 && o.color === "#312e81",
  );
  assert.ok(hit, "note hit rect exists");
  // Caret is on row 1 (after "dddd"): y = input y + one line (20px) + 1.
  assert.equal(caret().y, hit.y + 21, "caret on the wrapped second row");
  key(103); // Up — same column (9) on row 0
  assert.equal(caret().y, hit.y + 1, "Up moves the caret to row 0");
  key(108); // Down — back to row 1
  assert.equal(caret().y, hit.y + 21, "Down moves the caret back to row 1");
});

check("TextInput multiline: Enter inserts a newline instead of submitting", () => {
  const before = submitted.length;
  key(28); // Enter
  assert.equal(noteValue, "aaaa bbbb cccc dddd\n", "newline inserted at the caret");
  assert.equal(submitted.length, before, "Enter did not submit a multiline input");
  assert.ok(
    lastTexts().some((t) => t.includes("cccc dddd\n")),
    "wrapped display shows the newline",
  );
});

// Restore the shell tree for a clean end state.
renderer.update(h(App));

// --- ScrollView wheel scrolling (GF65 fix) ---------------------------
// A vertical ScrollView whose content (20 rows x 40px = 800) is taller
// than its 500px viewport. Wheel events arrive as onScroll({x, y, dx,
// dy}) — the same shape the host's dispatchScroll produces from
// Wayland axis events — with the sign convention the host relies on:
// positive dy scrolls DOWN (content moves up, scrollY grows).
function ScrollApp() {
  const rows = [];
  for (let i = 0; i < 20; i++) {
    rows.push(
      h(
        "View",
        { key: i, style: { height: 40, backgroundColor: "#ffffff" } },
        h("Text", { style: { fontSize: 14, color: "#111827" } }, "Row " + i),
      ),
    );
  }
  return h(
    "View",
    { style: { width: 800, height: 500, backgroundColor: "#f9fafb" } },
    h("ScrollView", { style: { flex: 1 } }, ...rows),
  );
}

function scrollViewInstance() {
  for (const inst of renderer._instancesByYogaId.values()) {
    if (inst.type === "ScrollView") return inst;
  }
  return null;
}

function wheel(dx, dy) {
  Sevyn._handlers.scroll({ x: 400, y: 250, dx, dy });
}

renderer.update(h(ScrollApp));

check("ScrollView: content taller than viewport, starts at top", () => {
  const sv = scrollViewInstance();
  assert.ok(sv, "ScrollView instance exists");
  assert.equal(sv.scrollY, 0);
  assert.equal(sv.contentHeight, 800, "20 rows x 40px");
});

check("ScrollView: wheel down (positive dy) scrolls down", () => {
  wheel(0, 120);
  assert.equal(scrollViewInstance().scrollY, 120);
});

check("ScrollView: wheel down clamps at the content edge", () => {
  wheel(0, 10000);
  const sv = scrollViewInstance();
  assert.equal(sv.scrollY, sv.contentHeight - 500, "max scroll");
});

check("ScrollView: wheel up (negative dy) scrolls back, clamps at 0", () => {
  wheel(0, -10000);
  assert.equal(scrollViewInstance().scrollY, 0);
});

check("ScrollView: scrolled content shifts in the presented ops", () => {
  const before = lastPresent().ops.find((o) => o.type === "text" && o.text === "Row 19");
  assert.ok(before, "Row 19 drawn");
  wheel(0, 120);
  const after = lastPresent().ops.find((o) => o.type === "text" && o.text === "Row 19");
  assert.ok(after, "Row 19 drawn after scroll");
  assert.equal(after.y, before.y - 120, "row moved up by the scroll delta");
  assert.equal(scrollViewInstance().scrollY, 120);
});

check("ScrollView: a point outside it does not scroll it", () => {
  // (799, 499) is inside the 800x500 root but the ScrollView spans
  // the whole root here — so scroll a point on the (nonexistent)
  // outside by rendering the shell tree back and scrolling it: the
  // dock is horizontal, so a vertical wheel there scrolls nothing.
  renderer.update(h(App));
  const dock = scrollViewInstance();
  assert.ok(dock, "dock ScrollView exists");
  const beforeY = dock.scrollY;
  wheel(0, 120);
  assert.equal(
    dock.scrollY,
    beforeY,
    "vertical wheel on a horizontal scroller is a no-op",
  );
  renderer.update(h(ScrollApp));
});

// Restore the shell tree for a clean end state.
renderer.update(h(App));

console.log(`\n${passed} renderer checks passed`);
