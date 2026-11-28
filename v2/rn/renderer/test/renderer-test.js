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
const selections = [];
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
      onSelectionChange: (e) => selections.push(e.nativeEvent.selection),
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
function keyCtrl(code) {
  Sevyn._handlers.key({ key: code, pressed: true, ctrl: true });
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

// --- TextInput clipboard (gap unit 2) ----------------------------------
// The mock clipboard stands in for the host's Wayland selection:
// copy writes it, paste reads it, and the round-trip proves the
// renderer's Ctrl+C/X/V wiring end to end.
check(
  "TextInput clipboard: Ctrl+C copies, Ctrl+V pastes at the caret, Ctrl+X cuts",
  () => {
    // Value is "aA/" from the earlier checks; the input is focused.
    assert.equal(inputValue, "aA/");
    keyCtrl(46); // Ctrl+C — copy
    assert.equal(Sevyn.clipboardRead(), "aA/", "copy wrote the whole value");
    assert.equal(inputValue, "aA/", "copy did not change the value");
    key(102); // Home — caret to the start
    keyCtrl(47); // Ctrl+V — paste at the caret
    assert.equal(inputValue, "aA/aA/", "paste inserted at the caret, not the end");
    keyCtrl(45); // Ctrl+X — cut
    assert.equal(Sevyn.clipboardRead(), "aA/aA/", "cut copied before deleting");
    assert.equal(inputValue, "", "cut cleared the value");
    keyCtrl(47); // Ctrl+V — paste it back
    assert.equal(inputValue, "aA/aA/", "paste restored the cut text");
  },
);

check(
  "TextInput clipboard: Ctrl+C types no 'c', other Ctrl+letters are swallowed, empty paste is a no-op",
  () => {
    assert.equal(inputValue, "aA/aA/");
    keyCtrl(46); // Ctrl+C again — copy, not a typed 'c'
    assert.equal(inputValue, "aA/aA/", "Ctrl+C typed nothing");
    assert.equal(Sevyn.clipboardRead(), "aA/aA/", "Ctrl+C still copied");
    keyCtrl(30); // Ctrl+A — select-all (gap unit 4): selects the
    // whole value, it is not typed and not swallowed
    assert.deepEqual(commandSelection(), { start: 0, end: 6, caret: 6 });
    assert.equal(inputValue, "aA/aA/", "Ctrl+A typed nothing");
    key(107); // End — collapse the selection so the paste below appends
    assert.deepEqual(commandSelection(), { start: 6, end: 6, caret: 6 });
    Sevyn.clipboardWrite("");
    keyCtrl(47); // Ctrl+V with an empty clipboard
    assert.equal(inputValue, "aA/aA/", "empty paste changed nothing");
  },
);

check("TextInput clipboard: paste strips newlines in a single-line input", () => {
  // Caret is at the end of "aA/aA/".
  Sevyn.clipboardWrite("ab\ncd\r\nef");
  keyCtrl(47); // Ctrl+V
  assert.equal(inputValue, "aA/aA/abcdef", "newlines stripped on single-line paste");
});

// --- TextInput selection (gap unit 3, audit #9/#24) -------------------
// The mock measures 0.55 * size per char, so at fontSize 16 a char
// boundary sits at hit.x + i * 8.8. The command input holds
// "aA/aA/abcdef" (12 chars) with the caret at the end from here on.
function keyShiftCtrl(code) {
  Sevyn._handlers.key({ key: code, pressed: true, ctrl: true, shift: true });
}
function inputInstByPlaceholder(ph) {
  for (const inst of renderer._instancesByYogaId.values()) {
    if (inst.type === "TextInput" && inst.props && inst.props.placeholder === ph)
      return inst;
  }
  return null;
}
function selectionOf(inst) {
  assert.ok(inst, "input instance exists");
  return {
    start: inst.selectionStart,
    end: inst.selectionEnd,
    caret: inst.caretOffset,
  };
}
function commandSelection() {
  return selectionOf(inputInstByPlaceholder("type a command"));
}
function hitRect(h, color) {
  const hit = lastPresent().ops.find(
    (o) => o.type === "rect" && o.h === h && o.color === color,
  );
  assert.ok(hit, "hit rect exists");
  return hit;
}
function pressAt(x, y, button, nodeId) {
  Sevyn._handlers.pointer({
    type: "button",
    x,
    y,
    button,
    pressed: true,
    nodeId,
  });
}
function releaseAt(x, y, button) {
  Sevyn._handlers.pointer({ type: "button", x, y, button, pressed: false });
}
function moveTo(x, y) {
  Sevyn._handlers.pointer({ type: "motion", x, y, button: 0, pressed: false });
}
function highlights() {
  return lastPresent().ops.filter((o) => o.type === "rect" && o.color === "#3b82f680");
}

check(
  "TextInput selection: Shift+Left/Right extends and shrinks, Backspace deletes the range",
  () => {
    assert.equal(inputValue, "aA/aA/abcdef");
    key(105, true);
    key(105, true);
    key(105, true); // Shift+Left x3 — caret 12 -> 9, anchor 12
    assert.deepEqual(commandSelection(), { start: 9, end: 12, caret: 9 });
    assert.equal(highlights().length, 1, "one highlight rect for the range");
    const hit = hitRect(32, "#1f2937");
    assert.equal(caret().x, hit.x + 9 * 8.8 + 1, "caret at the selection's focus end");
    key(106, true); // Shift+Right — shrink from the focus end
    assert.deepEqual(commandSelection(), { start: 10, end: 12, caret: 10 });
    key(14); // Backspace — deletes the "ef" selection
    assert.equal(inputValue, "aA/aA/abcd");
    assert.deepEqual(commandSelection(), { start: 10, end: 10, caret: 10 });
    assert.equal(highlights().length, 0, "no highlight once collapsed");
    key(18);
    key(33); // type "ef" back
    assert.equal(inputValue, "aA/aA/abcdef");
  },
);

check("TextInput selection: Ctrl+C/X copy and cut the selected range", () => {
  key(105, true);
  key(105, true);
  key(105, true); // Shift+Left x3 — select "def" [9,12]
  keyCtrl(46); // Ctrl+C
  assert.equal(
    Sevyn.clipboardRead(),
    "def",
    "copy wrote the selection, not the whole value",
  );
  assert.equal(inputValue, "aA/aA/abcdef", "copy did not change the value");
  keyCtrl(45); // Ctrl+X
  assert.equal(Sevyn.clipboardRead(), "def", "cut copied before deleting");
  assert.equal(inputValue, "aA/aA/abc", "cut deleted only the selection");
  assert.deepEqual(commandSelection(), { start: 9, end: 9, caret: 9 });
  keyCtrl(47); // Ctrl+V — paste it back
  assert.equal(inputValue, "aA/aA/abcdef", "paste restored the cut text");
  assert.deepEqual(commandSelection(), { start: 12, end: 12, caret: 12 });
});

check("TextInput selection: Shift+Home/End select to the line ends", () => {
  key(102, true); // Shift+Home
  assert.deepEqual(commandSelection(), { start: 0, end: 12, caret: 0 });
  key(107, true); // Shift+End — back to the end, collapsed
  assert.deepEqual(commandSelection(), { start: 12, end: 12, caret: 12 });
  key(102); // Home
  key(106);
  key(106);
  key(106);
  key(106); // Right x4 — caret 4
  key(107, true); // Shift+End
  assert.deepEqual(commandSelection(), { start: 4, end: 12, caret: 12 });
  key(107); // End — collapse
  assert.deepEqual(commandSelection(), { start: 12, end: 12, caret: 12 });
});

check(
  "TextInput selection: Ctrl+Left/Right jump by word, Shift+Ctrl extends by word",
  () => {
    // Value "aA/aA/abcdef": word runs are aA | / | aA | / | abcdef.
    keyCtrl(105); // Ctrl+Left: 12 -> 6
    assert.equal(commandSelection().caret, 6);
    keyCtrl(105); // 6 -> 5 (past the "/")
    assert.equal(commandSelection().caret, 5);
    keyCtrl(105); // 5 -> 3
    assert.equal(commandSelection().caret, 3);
    keyCtrl(106); // Ctrl+Right: 3 -> 5
    assert.equal(commandSelection().caret, 5);
    keyCtrl(106); // 5 -> 6
    assert.equal(commandSelection().caret, 6);
    keyShiftCtrl(106); // Ctrl+Shift+Right: [6,12]
    assert.deepEqual(commandSelection(), { start: 6, end: 12, caret: 12 });
    keyShiftCtrl(105); // Ctrl+Shift+Left: back to 6, collapsed
    assert.deepEqual(commandSelection(), { start: 6, end: 6, caret: 6 });
    keyShiftCtrl(106); // Ctrl+Shift+Right: [6,12] again
    assert.deepEqual(commandSelection(), { start: 6, end: 12, caret: 12 });
    key(106); // plain Right collapses to the caret
    assert.deepEqual(commandSelection(), { start: 12, end: 12, caret: 12 });
  },
);

check("TextInput selection: pointer drag selects the range, release ends it", () => {
  const hit = hitRect(32, "#1f2937");
  const charX = (i) => hit.x + i * 8.8;
  const midY = hit.y + 16;
  // 0x110 is the real host's left-button code (wayland.h).
  pressAt(charX(2), midY, 0x110, hit.nodeId);
  assert.deepEqual(commandSelection(), { start: 2, end: 2, caret: 2 });
  moveTo(charX(8), midY);
  assert.deepEqual(commandSelection(), { start: 2, end: 8, caret: 8 });
  moveTo(charX(5), midY);
  assert.deepEqual(commandSelection(), { start: 2, end: 5, caret: 5 });
  moveTo(charX(0), midY);
  assert.deepEqual(commandSelection(), { start: 0, end: 2, caret: 0 });
  releaseAt(charX(0), midY, 0x110);
  assert.deepEqual(commandSelection(), { start: 0, end: 2, caret: 0 });
  moveTo(charX(10), midY); // motion after release selects nothing
  assert.deepEqual(commandSelection(), { start: 0, end: 2, caret: 0 });
  keyCtrl(46); // copy the drag selection
  assert.equal(Sevyn.clipboardRead(), "aA", "copy wrote the drag selection");
});

check(
  "TextInput selection: click places the caret, right-button does not drag, onSelectionChange fires",
  () => {
    const hit = hitRect(32, "#1f2937");
    const charX = (i) => hit.x + i * 8.8;
    const midY = hit.y + 16;
    // Button 1 is the headless driver's left-button value.
    pressAt(charX(4), midY, 1, hit.nodeId);
    releaseAt(charX(4), midY, 1);
    assert.deepEqual(commandSelection(), { start: 4, end: 4, caret: 4 });
    // Right button (0x111): focuses (caret to the end) but starts
    // no drag — the motion after it selects nothing.
    pressAt(charX(8), midY, 0x111, hit.nodeId);
    moveTo(charX(2), midY);
    releaseAt(charX(2), midY, 0x111);
    assert.deepEqual(commandSelection(), { start: 12, end: 12, caret: 12 });
    // onSelectionChange: the last report matches the last change.
    const before = selections.length;
    key(105, true);
    key(105, true); // Shift+Left x2 from 12 -> [10,12]
    assert.deepEqual(commandSelection(), { start: 10, end: 12, caret: 10 });
    assert.ok(selections.length > before, "onSelectionChange fired");
    assert.deepEqual(selections[selections.length - 1], { start: 10, end: 12 });
  },
);

check("TextInput selection: typing replaces the selection", () => {
  // Selection [10,12] ("ef") from the check above.
  key(44, true); // Shift+Z — replaces "ef" with "Z"
  assert.equal(inputValue, "aA/aA/abcdZ", "typing replaced the selection");
  assert.deepEqual(commandSelection(), { start: 11, end: 11, caret: 11 });
  key(14); // Backspace removes the Z
  key(18);
  key(33); // type "ef" back
  assert.equal(inputValue, "aA/aA/abcdef", "value restored for the checks below");
});

// --- TextInput accelerators (gap unit 4, audit #4/#5) -----------------
// The command input holds "aA/aA/abcdef" (12 chars) with the caret
// at the end from here on; every check restores that state.

check("TextInput accelerators: Ctrl+A selects all and fires onSelectionChange", () => {
  const before = selections.length;
  keyCtrl(30); // Ctrl+A
  assert.deepEqual(commandSelection(), { start: 0, end: 12, caret: 12 });
  assert.equal(highlights().length, 1, "whole value highlighted");
  assert.ok(selections.length > before, "onSelectionChange fired");
  assert.deepEqual(selections[selections.length - 1], { start: 0, end: 12 });
  key(107); // End — collapse the selection for the checks below
  assert.deepEqual(commandSelection(), { start: 12, end: 12, caret: 12 });
});

check(
  "TextInput accelerators: typing then Ctrl+Z undoes, Ctrl+Y / Ctrl+Shift+Z redo",
  () => {
    key(45, true); // Shift+X — type "X" at the end
    assert.equal(inputValue, "aA/aA/abcdefX", "typed X");
    assert.deepEqual(commandSelection(), { start: 13, end: 13, caret: 13 });
    keyCtrl(44); // Ctrl+Z
    assert.equal(inputValue, "aA/aA/abcdef", "undo restored the prior value");
    assert.deepEqual(commandSelection(), { start: 12, end: 12, caret: 12 });
    keyCtrl(21); // Ctrl+Y
    assert.equal(inputValue, "aA/aA/abcdefX", "redo re-applied the typing");
    assert.deepEqual(commandSelection(), { start: 13, end: 13, caret: 13 });
    keyCtrl(44); // Ctrl+Z again
    assert.equal(inputValue, "aA/aA/abcdef", "undo restored the prior value again");
    keyShiftCtrl(44); // Ctrl+Shift+Z — redo through the Shift form
    assert.equal(inputValue, "aA/aA/abcdefX", "Ctrl+Shift+Z redid the typing");
    assert.deepEqual(commandSelection(), { start: 13, end: 13, caret: 13 });
    keyCtrl(44); // Ctrl+Z — back to the shared start state
    assert.equal(inputValue, "aA/aA/abcdef");
    assert.deepEqual(commandSelection(), { start: 12, end: 12, caret: 12 });
  },
);

check("TextInput accelerators: undo of a paste restores the prior value", () => {
  Sevyn.clipboardWrite("QQ");
  keyCtrl(47); // Ctrl+V — paste at the end
  assert.equal(inputValue, "aA/aA/abcdefQQ", "pasted QQ");
  assert.deepEqual(commandSelection(), { start: 14, end: 14, caret: 14 });
  keyCtrl(44); // Ctrl+Z — undo the paste
  assert.equal(inputValue, "aA/aA/abcdef", "undo removed the pasted text");
  assert.deepEqual(commandSelection(), { start: 12, end: 12, caret: 12 });
  keyCtrl(21); // Ctrl+Y — redo the paste
  assert.equal(inputValue, "aA/aA/abcdefQQ", "redo re-applied the paste");
  keyCtrl(44); // Ctrl+Z — back to the shared start state
  assert.equal(inputValue, "aA/aA/abcdef");
  assert.deepEqual(commandSelection(), { start: 12, end: 12, caret: 12 });
});

check(
  "TextInput accelerators: undo of a cut restores the prior value and selection",
  () => {
    key(105, true);
    key(105, true);
    key(105, true); // Shift+Left x3 — select "def" [9,12], caret 9
    assert.deepEqual(commandSelection(), { start: 9, end: 12, caret: 9 });
    keyCtrl(45); // Ctrl+X — cut the selection
    assert.equal(inputValue, "aA/aA/abc", "cut deleted only the selection");
    assert.deepEqual(commandSelection(), { start: 9, end: 9, caret: 9 });
    keyCtrl(44); // Ctrl+Z — undo the cut
    assert.equal(inputValue, "aA/aA/abcdef", "undo restored the cut text");
    assert.deepEqual(commandSelection(), { start: 9, end: 12, caret: 9 });
    keyCtrl(21); // Ctrl+Y — redo the cut
    assert.equal(inputValue, "aA/aA/abc", "redo re-applied the cut");
    assert.deepEqual(commandSelection(), { start: 9, end: 9, caret: 9 });
    keyCtrl(44); // Ctrl+Z — back to the shared start state
    assert.equal(inputValue, "aA/aA/abcdef");
    assert.deepEqual(commandSelection(), { start: 9, end: 12, caret: 9 });
    key(107); // End — collapse the selection for the checks below
    assert.deepEqual(commandSelection(), { start: 12, end: 12, caret: 12 });
  },
);

check("TextInput accelerators: a new edit after undo clears the redo stack", () => {
  key(45, true); // Shift+X — type "X"
  assert.equal(inputValue, "aA/aA/abcdefX");
  keyCtrl(44); // Ctrl+Z — undo it; "X" now sits on the redo stack
  assert.equal(inputValue, "aA/aA/abcdef");
  key(53, true); // Shift+/ — type "?" instead: a new edit
  assert.equal(inputValue, "aA/aA/abcdef?");
  assert.deepEqual(commandSelection(), { start: 13, end: 13, caret: 13 });
  keyCtrl(21); // Ctrl+Y — redo is cleared, so this is a no-op
  assert.equal(inputValue, "aA/aA/abcdef?", "redo after a new edit changes nothing");
  assert.deepEqual(commandSelection(), { start: 13, end: 13, caret: 13 });
  keyCtrl(44); // Ctrl+Z — undo the "?" for the checks below
  assert.equal(inputValue, "aA/aA/abcdef");
  assert.deepEqual(commandSelection(), { start: 12, end: 12, caret: 12 });
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

check("TextInput multiline clipboard: paste keeps newlines", () => {
  // Focus is on the note input; caret at the end of the note.
  Sevyn.clipboardWrite("pasted\nline");
  keyCtrl(47); // Ctrl+V
  assert.equal(
    noteValue,
    "aaaa bbbb cccc dddd\npasted\nline",
    "multiline paste kept the newline",
  );
});

check("TextInput selection: drag-select across wrapped rows in a multiline input", () => {
  // Note value "aaaa bbbb cccc dddd\npasted\nline", wrapped at
  // 120px: row 0 "aaaa bbbb" [0,9), row 1 "cccc dddd" [10,19),
  // row 2 "pasted" [20,26), row 3 "line" [27,31). Line height 20px.
  const hit = hitRect(64, "#312e81");
  const note = inputInstByPlaceholder("type a note");
  const noteSelection = () => selectionOf(note);
  pressAt(hit.x + 2 * 8.8, hit.y + 10, 0x110, hit.nodeId);
  assert.deepEqual(noteSelection(), { start: 2, end: 2, caret: 2 });
  moveTo(hit.x + 3 * 8.8, hit.y + 30); // row 1, char 13
  assert.deepEqual(noteSelection(), { start: 2, end: 13, caret: 13 });
  releaseAt(hit.x + 3 * 8.8, hit.y + 30, 0x110);
  assert.deepEqual(noteSelection(), { start: 2, end: 13, caret: 13 });
  assert.equal(highlights().length, 2, "one highlight rect per covered row");
});

// --- Find in app (gap unit 5, audit #6) --------------------------------
// A note-like multiline input with onFindRequest + a controlled
// selection prop, and a find field that mounts with autoFocus when
// Ctrl+F opens it — the renderer primitives Notes' find bar is built
// on. The full flow (type a query, Enter cycles, Esc closes) is
// proven in the app e2e test; these checks prove the primitives.
const findRequests = [];
const findEscapes = [];
const findSubmits = [];
const saveRequests = []; // gap unit 6: Ctrl+S on the note input
let findNoteValue = "";
let findQueryValue = "";
let findSelProp = null; // selection prop the test drives via re-render
function FindApp() {
  const [note, setNote] = React.useState("buy milk and bread buy milk again");
  const [query, setQuery] = React.useState("");
  const [open, setOpen] = React.useState(false);
  findNoteValue = note;
  findQueryValue = query;
  return h(
    "View",
    { style: { width: 800, height: 500, backgroundColor: "#111827" } },
    h("TextInput", {
      value: note,
      onChangeText: setNote,
      placeholder: "find note",
      multiline: true,
      autoFocus: true,
      selection: findSelProp ?? undefined,
      onFindRequest: () => {
        findRequests.push("find");
        setOpen(true);
      },
      onSaveRequest: () => saveRequests.push("save"),
      onEscape: () => findEscapes.push("note-esc"),
      style: {
        width: 800,
        height: 64,
        backgroundColor: "#312e81",
        fontSize: 16,
        color: "#ffffff",
      },
    }),
    open
      ? h("TextInput", {
          value: query,
          onChangeText: setQuery,
          onSubmitEditing: (e) =>
            findSubmits.push(!!(e && e.nativeEvent && e.nativeEvent.shiftKey)),
          onEscape: () => findEscapes.push("find-esc"),
          placeholder: "find query",
          autoFocus: true,
          style: {
            width: 800,
            height: 32,
            backgroundColor: "#1f2937",
            fontSize: 16,
            color: "#ffffff",
          },
        })
      : null,
    h("TextInput", {
      value: "",
      onChangeText: () => {},
      placeholder: "plain input",
      style: {
        width: 800,
        height: 32,
        backgroundColor: "#14532d",
        fontSize: 16,
        color: "#ffffff",
      },
    }),
  );
}

renderer.update(h(FindApp));
// resetAfterCommit presents after the mutation phase but before the
// layout phase where commitMount focuses, so the flush's own present
// predates the focus — a second present (what every key/pointer
// handler does after flushing) shows the caret.
renderer._presentRoot();

check("Find in app: Ctrl+F calls onFindRequest and focuses the find field", () => {
  assert.ok(caret(), "note input focused on mount (autoFocus)");
  keyCtrl(33); // Ctrl+F
  assert.deepEqual(findRequests, ["find"], "onFindRequest fired");
  const find = inputInstByPlaceholder("find query");
  assert.ok(find, "find field mounted");
  key(16); // q — must land in the find field, not the note
  assert.equal(findQueryValue, "q", "typing went to the find field");
  assert.equal(
    findNoteValue,
    "buy milk and bread buy milk again",
    "note untouched by find typing",
  );
});

check("Find in app: Ctrl+F without onFindRequest types nothing", () => {
  // Focus is in the find field, which has no onFindRequest.
  keyCtrl(33); // Ctrl+F
  assert.deepEqual(findRequests, ["find"], "no second find request");
  assert.equal(findQueryValue, "q", "no 'f' typed into the find field");
});

check("Find in app: Enter submits with shiftKey false, Shift+Enter true", () => {
  key(28); // Enter
  key(28, true); // Shift+Enter
  assert.deepEqual(findSubmits, [false, true], "submit told Enter from Shift+Enter");
});

check(
  "Find in app: selection prop selects the match, stale prop is not re-applied",
  () => {
    // "buy milk and bread buy milk again": "milk" is [4,8).
    findSelProp = { start: 4, end: 8 };
    renderer.update(h(FindApp));
    const note = inputInstByPlaceholder("find note");
    assert.deepEqual(selectionOf(note), { start: 4, end: 8, caret: 8 });
    assert.equal(highlights().length, 1, "match highlighted");
    // The user clicks into the note at char 2, then an unrelated
    // re-render happens: the stale prop must not drag the selection
    // back to the old match.
    const hit = hitRect(64, "#312e81");
    pressAt(hit.x + 2 * 8.8, hit.y + 10, 0x110, hit.nodeId);
    releaseAt(hit.x + 2 * 8.8, hit.y + 10, 0x110);
    assert.deepEqual(selectionOf(note), { start: 2, end: 2, caret: 2 });
    renderer.update(h(FindApp));
    assert.deepEqual(
      selectionOf(note),
      { start: 2, end: 2, caret: 2 },
      "stale selection prop not re-applied after a user caret move",
    );
    assert.equal(highlights().length, 0, "no highlight once the match is gone");
    findSelProp = null;
    renderer.update(h(FindApp));
  },
);

check("Find in app: Escape in the find field calls onEscape and keeps focus", () => {
  const findHit = hitRect(32, "#1f2937");
  pressAt(findHit.x + 2, findHit.y + 16, 1, findHit.nodeId);
  releaseAt(findHit.x + 2, findHit.y + 16, 1);
  key(1); // Escape
  assert.deepEqual(findEscapes, ["find-esc"], "onEscape fired");
  // The click placed the caret at 0, so 'w' inserts before the 'q' —
  // the point is the keystroke landed in the find field at all.
  key(17); // w — focus must still be in the find field
  assert.equal(findQueryValue, "wq", "typing still lands in the find field");
});

check("Find in app: Escape without onEscape blurs, autoFocus refocuses the note", () => {
  const plainHit = hitRect(32, "#14532d");
  pressAt(plainHit.x + 2, plainHit.y + 16, 1, plainHit.nodeId);
  releaseAt(plainHit.x + 2, plainHit.y + 16, 1);
  key(1); // Escape — the plain input has no onEscape
  assert.deepEqual(findEscapes, ["find-esc"], "no onEscape fired for the plain input");
  // The blur drops focus; presentRoot re-focuses the first autoFocus
  // input (the note), so the caret is back in the note, not the plain
  // input.
  const noteHit = hitRect(64, "#312e81");
  assert.ok(caret(), "caret drawn again after the autoFocus refocus");
  assert.equal(caret().y, noteHit.y + 1, "caret back in the note input");
});

// --- Save (gap unit 6, audit #7) ------------------------------------
// Ctrl+S on an input with onSaveRequest calls it; without the prop
// the key is swallowed and types nothing.
check("Save: Ctrl+S calls onSaveRequest and types nothing into the note", () => {
  // Focus is back in the note (autoFocus refocus after the blur).
  keyCtrl(31); // Ctrl+S
  assert.deepEqual(saveRequests, ["save"], "onSaveRequest fired");
  assert.equal(
    findNoteValue,
    "buy milk and bread buy milk again",
    "no 's' typed into the note",
  );
});

check("Save: Ctrl+S without onSaveRequest types nothing", () => {
  // Focus is in the find field, which has no onSaveRequest.
  const findHit = hitRect(32, "#1f2937");
  pressAt(findHit.x + 2, findHit.y + 16, 1, findHit.nodeId);
  releaseAt(findHit.x + 2, findHit.y + 16, 1);
  keyCtrl(31); // Ctrl+S
  assert.deepEqual(saveRequests, ["save"], "no second save request");
  assert.equal(findQueryValue, "wq", "no 's' typed into the find field");
});

// --- Terminal interrupt (gap unit 8, audit #10) ---------------------
// A prompt-like input with onInterruptRequest: Ctrl+C fires the
// callback instead of copying, and types nothing. Without the prop
// Ctrl+C still copies (proven by the clipboard checks above).
const interruptRequests = [];
let interruptValue = "";
function InterruptApp() {
  const [value, setValue] = React.useState("shell status");
  interruptValue = value;
  return h(
    "View",
    { style: { width: 800, height: 500, backgroundColor: "#111827" } },
    h("TextInput", {
      value,
      onChangeText: setValue,
      onInterruptRequest: () => interruptRequests.push("interrupt"),
      placeholder: "type a sevyn command",
      autoFocus: true,
      style: {
        height: 32,
        backgroundColor: "#1f2937",
        fontSize: 16,
        color: "#ffffff",
      },
    }),
  );
}

renderer.update(h(InterruptApp));
// Same present-after-mount dance as the find checks: the flush's
// own present predates the commitMount focus.
renderer._presentRoot();

check(
  "Terminal interrupt: Ctrl+C calls onInterruptRequest, copies nothing, types nothing",
  () => {
    assert.ok(caret(), "interrupt input focused on mount (autoFocus)");
    Sevyn.clipboardWrite("sentinel");
    keyCtrl(46); // Ctrl+C
    assert.deepEqual(interruptRequests, ["interrupt"], "onInterruptRequest fired");
    assert.equal(
      Sevyn.clipboardRead(),
      "sentinel",
      "Ctrl+C copied nothing to the clipboard",
    );
    assert.equal(interruptValue, "shell status", "no 'c' typed into the input");
    keyCtrl(46); // Ctrl+C again — still interrupt, still no copy
    assert.deepEqual(
      interruptRequests,
      ["interrupt", "interrupt"],
      "a second Ctrl+C fires again",
    );
    assert.equal(Sevyn.clipboardRead(), "sentinel", "still nothing copied");
    assert.equal(interruptValue, "shell status", "still nothing typed");
  },
);

check(
  "Terminal interrupt: Ctrl+Shift+C copies the line, plain Ctrl+C still interrupts",
  () => {
    // State from the interrupt check: two interrupts, value
    // "shell status", clipboard "sentinel", input still focused.
    assert.ok(caret(), "interrupt input still focused");
    keyShiftCtrl(46); // Ctrl+Shift+C — copy, not interrupt
    assert.deepEqual(
      interruptRequests,
      ["interrupt", "interrupt"],
      "Ctrl+Shift+C did not fire onInterruptRequest",
    );
    assert.equal(
      Sevyn.clipboardRead(),
      "shell status",
      "Ctrl+Shift+C copied the whole line (no selection)",
    );
    assert.equal(interruptValue, "shell status", "copy changed nothing");
    // A selection copies the selection, not the whole line.
    key(102); // Home — caret to the start
    const keyShift = (code) =>
      Sevyn._handlers.key({ key: code, pressed: true, shift: true });
    for (let i = 0; i < 5; i++) keyShift(106); // Shift+Right x5: "shell"
    keyShiftCtrl(46); // Ctrl+Shift+C — copy the selection
    assert.equal(Sevyn.clipboardRead(), "shell", "Ctrl+Shift+C copied the selection");
    // Cut the selection, then paste it back with Ctrl+Shift+V.
    keyCtrl(45); // Ctrl+X — cut
    assert.equal(interruptValue, " status", "cut removed the selection");
    assert.equal(Sevyn.clipboardRead(), "shell", "cut copied the selection");
    keyShiftCtrl(47); // Ctrl+Shift+V — paste at the caret
    assert.equal(interruptValue, "shell status", "paste restored the line");
    // Plain Ctrl+C still interrupts and copies nothing.
    keyCtrl(46); // Ctrl+C
    assert.deepEqual(
      interruptRequests,
      ["interrupt", "interrupt", "interrupt"],
      "plain Ctrl+C still interrupts",
    );
    assert.equal(
      Sevyn.clipboardRead(),
      "shell",
      "plain Ctrl+C copied nothing (clipboard still holds the copy)",
    );
    assert.equal(interruptValue, "shell status", "interrupt typed nothing");
  },
);

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

// --- Context menu (gap unit 9, audit #12) -----------------------------
const { ContextMenu } = require("../context-menu");
const ctxEvents = [];
const ctxSelected = [];
let menuOpen = false;
function MenuApp() {
  const [menu, setMenu] = React.useState(null);
  menuOpen = menu !== null;
  const items = [
    {
      id: "open",
      label: "Open",
      icon: "O",
      onSelect: () => ctxSelected.push("open"),
    },
    { id: "rename", label: "Rename", onSelect: () => ctxSelected.push("rename") },
    { id: "sep", separator: true },
    {
      id: "delete",
      label: "Delete",
      disabled: true,
      onSelect: () => ctxSelected.push("delete"),
    },
    { id: "info", label: "Properties", onSelect: () => ctxSelected.push("info") },
  ];
  return h(
    "View",
    { style: { width: 1024, height: 768, backgroundColor: "#0b0b0f" } },
    h(
      "Pressable",
      {
        testID: "menu-target",
        onPress: () => ctxEvents.push("press"),
        onContextMenu: (ev) => {
          ctxEvents.push("context:" + ev.nativeEvent.x + "," + ev.nativeEvent.y);
          setMenu({ x: ev.nativeEvent.x, y: ev.nativeEvent.y });
        },
        style: { width: 200, height: 100, backgroundColor: "#1f2937" },
      },
      h("Text", { style: { fontSize: 14, color: "#fff" } }, "Target"),
    ),
    h(
      "Pressable",
      {
        testID: "plain-target",
        onPress: () => ctxEvents.push("plain-press"),
        style: { width: 200, height: 100, backgroundColor: "#312e81" },
      },
      h("Text", { style: { fontSize: 14, color: "#fff" } }, "Plain"),
    ),
    menu
      ? h(ContextMenu, {
          x: menu.x,
          y: menu.y,
          items,
          onDismiss: () => {
            ctxEvents.push("dismiss");
            setMenu(null);
          },
        })
      : null,
  );
}

function pressButton(x, y, button, nodeId) {
  Sevyn._handlers.pointer({ type: "button", x, y, button, pressed: true, nodeId });
}
function panelRect() {
  return lastPresent().ops.find(
    (o) => o.type === "rect" && o.color === "#1f2937" && o.w === 220,
  );
}
function highlightRect() {
  return lastPresent().ops.find((o) => o.type === "rect" && o.color === "#3b82f6");
}
function overlayOp() {
  return lastPresent().ops.find(
    (o) => o.type === "rect" && o.color === "#00000000" && o.w === 1024,
  );
}
function openMenuAt(x, y) {
  const target = lastPresent().ops.find(
    (o) => o.type === "rect" && o.color === "#1f2937" && o.w === 200,
  );
  assert.ok(target, "menu target hit op exists");
  pressButton(x, y, 0x111, target.nodeId);
  assert.ok(menuOpen, "menu opened");
}
function closeMenuIfOpen() {
  if (menuOpen) Sevyn._handlers.key({ key: 1, pressed: true }); // Esc
  assert.ok(!menuOpen, "menu closed");
}

renderer.update(h(MenuApp));

check("context menu: right-click fires onContextMenu, not onPress", () => {
  ctxEvents.length = 0;
  openMenuAt(1, 1);
  assert.ok(
    ctxEvents.includes("context:1,1"),
    "onContextMenu fired with the pointer position",
  );
  assert.ok(!ctxEvents.includes("press"), "right-click did not fire onPress");
  const panel = panelRect();
  assert.ok(panel, "menu panel presented");
  assert.equal(panel.x, 1, "panel anchored at the pointer x");
  assert.equal(panel.y, 1, "panel anchored at the pointer y");
  assert.ok(
    lastTexts().includes("Open") && lastTexts().includes("Properties"),
    "menu items presented",
  );
  assert.ok(
    lastPresent().ops.some(
      (o) => o.type === "rect" && o.color === "#4b5563" && o.h === 1,
    ),
    "separator row presented",
  );
  const hl = highlightRect();
  assert.ok(hl, "first enabled item highlighted on open");
  assert.equal(hl.y, panel.y + 4, "highlight starts on Open");
});

check("context menu: left-click still fires onPress, opens no menu", () => {
  closeMenuIfOpen();
  ctxEvents.length = 0;
  const target = lastPresent().ops.find(
    (o) => o.type === "rect" && o.color === "#1f2937" && o.w === 200,
  );
  pressButton(1, 1, 1, target.nodeId);
  assert.ok(ctxEvents.includes("press"), "left-click fired onPress");
  assert.ok(!menuOpen, "left-click opened no menu");
});

check("context menu: right-click on a view without onContextMenu is a no-op", () => {
  ctxEvents.length = 0;
  const plain = lastPresent().ops.find((o) => o.type === "rect" && o.color === "#312e81");
  assert.ok(plain, "plain target hit op exists");
  pressButton(10, 110, 0x111, plain.nodeId);
  assert.ok(!ctxEvents.includes("plain-press"), "no onPress from a right-click");
  assert.ok(!menuOpen, "no menu without onContextMenu");
});

check("context menu: menu clamps to the surface", () => {
  // 5 rows: 32 + 32 + 9 (separator) + 32 + 32 + 8 padding = 145 tall.
  openMenuAt(1000, 750);
  const panel = panelRect();
  assert.equal(panel.x, 1024 - 220, "panel clamped off the right edge");
  assert.equal(panel.y, 768 - 145, "panel clamped off the bottom edge");
  closeMenuIfOpen();
});

check("context menu: click-away dismisses", () => {
  openMenuAt(1, 1);
  const overlay = overlayOp();
  assert.ok(overlay, "click-away overlay presented");
  ctxEvents.length = 0;
  pressButton(10, 700, 1, overlay.nodeId);
  assert.ok(ctxEvents.includes("dismiss"), "overlay press dismissed");
  assert.ok(!menuOpen, "menu closed after click-away");
  assert.ok(!panelRect(), "panel gone after dismiss");
});

check("context menu: Esc dismisses and unregisters the key handler", () => {
  openMenuAt(1, 1);
  ctxEvents.length = 0;
  Sevyn._handlers.key({ key: 1, pressed: true }); // Esc
  assert.ok(ctxEvents.includes("dismiss"), "Esc dismissed");
  assert.ok(!menuOpen, "menu closed after Esc");
  // No handler left behind: Down now moves focus, not a menu.
  Sevyn._handlers.key({ key: 108, pressed: true }); // Down
  assert.ok(!menuOpen, "no menu reopened by a stray key");
});

check("context menu: arrows skip disabled/separator, wrap, Enter activates", () => {
  openMenuAt(1, 1);
  const panel = panelRect();
  assert.equal(highlightRect().y, panel.y + 4, "highlight starts on Open");
  Sevyn._handlers.key({ key: 108, pressed: true }); // Down -> Rename
  assert.equal(highlightRect().y, panel.y + 4 + 32, "Down moved to Rename");
  Sevyn._handlers.key({ key: 108, pressed: true }); // Down skips sep + disabled
  assert.equal(
    highlightRect().y,
    panel.y + 4 + 32 + 32 + 9 + 32,
    "Down skipped the separator and the disabled Delete",
  );
  Sevyn._handlers.key({ key: 108, pressed: true }); // Down wraps to Open
  assert.equal(highlightRect().y, panel.y + 4, "Down wrapped to Open");
  Sevyn._handlers.key({ key: 103, pressed: true }); // Up wraps to Properties
  assert.equal(
    highlightRect().y,
    panel.y + 4 + 32 + 32 + 9 + 32,
    "Up wrapped to Properties",
  );
  ctxSelected.length = 0;
  ctxEvents.length = 0;
  Sevyn._handlers.key({ key: 28, pressed: true }); // Enter
  assert.ok(ctxSelected.includes("info"), "Enter selected Properties");
  assert.ok(ctxEvents.includes("dismiss"), "selection dismissed the menu");
  assert.ok(!menuOpen, "menu closed after selection");
});

check("context menu: clicking a disabled row does nothing", () => {
  openMenuAt(1, 1);
  const panel = panelRect();
  // Delete row: after Open (32) + Rename (32) + separator (9), at
  // panel top + 4 padding + 73.
  const disabled = lastPresent().ops.find(
    (o) =>
      o.type === "rect" &&
      o.color === "#00000000" &&
      o.w === 212 &&
      o.y === panel.y + 4 + 73,
  );
  assert.ok(disabled, "disabled row hit op exists");
  ctxSelected.length = 0;
  pressButton(disabled.x + 1, disabled.y + 1, 1, disabled.nodeId);
  assert.equal(ctxSelected.length, 0, "disabled row selected nothing");
  assert.ok(menuOpen, "menu stayed open after a disabled click");
  closeMenuIfOpen();
});

check("context menu: clicking an enabled row selects and dismisses", () => {
  openMenuAt(1, 1);
  const panel = panelRect();
  const rename = lastPresent().ops.find(
    (o) =>
      o.type === "rect" &&
      o.color === "#00000000" &&
      o.w === 212 &&
      o.y === panel.y + 4 + 32,
  );
  assert.ok(rename, "Rename row hit op exists");
  ctxSelected.length = 0;
  ctxEvents.length = 0;
  pressButton(rename.x + 1, rename.y + 1, 1, rename.nodeId);
  assert.ok(ctxSelected.includes("rename"), "row click selected Rename");
  assert.ok(ctxEvents.includes("dismiss"), "row click dismissed the menu");
  assert.ok(!menuOpen, "menu closed after row click");
});

check("context menu: right-click outside the panel dismisses", () => {
  openMenuAt(1, 1);
  const overlay = overlayOp();
  ctxEvents.length = 0;
  pressButton(10, 700, 0x111, overlay.nodeId);
  assert.ok(ctxEvents.includes("dismiss"), "right-click-away dismissed");
  assert.ok(!menuOpen, "menu closed after right-click-away");
});

// --- Press modifiers (gap unit 13, audit #22) --------------------------
// onPress receives the modifiers held at the moment of the press, so
// a Ctrl/Cmd-click and a Shift-click are distinguishable from a plain
// click; keyboard activation (Tab+Enter) passes the activating key's
// modifiers the same way. A ScrollView with onPress is hit-testable
// through its background rect (the Files list clears the selection
// on an empty-space click), and a child row still wins the hit-test
// where it overlaps the surface.
const pressModsEvents = [];
function PressModsApp() {
  return h(
    "View",
    { style: { width: 1024, height: 768, backgroundColor: "#0b0b0f" } },
    h(
      "ScrollView",
      {
        onPress: (ev) => pressModsEvents.push(["list", ev.nativeEvent]),
        style: { width: 400, height: 200, backgroundColor: "#f9fafb" },
      },
      h(
        "Pressable",
        {
          onPress: (ev) => pressModsEvents.push(["row-a", ev.nativeEvent]),
          style: { width: 400, height: 36, backgroundColor: "#111111" },
        },
        h("Text", { style: { fontSize: 14, color: "#fff" } }, "a"),
      ),
      h(
        "Pressable",
        {
          onPress: (ev) => pressModsEvents.push(["row-b", ev.nativeEvent]),
          style: { width: 400, height: 36, backgroundColor: "#222222" },
        },
        h("Text", { style: { fontSize: 14, color: "#fff" } }, "b"),
      ),
    ),
  );
}
function pressModsRect(color) {
  const rect = lastPresent().ops.find(
    (o) => o.type === "rect" && o.color === color && o.nodeId >= 0,
  );
  assert.ok(rect, "hit rect for " + color + " exists");
  return rect;
}
function pressWithMods(rect, mods) {
  Sevyn._handlers.pointer({
    type: "button",
    x: rect.x + 2,
    y: rect.y + 2,
    button: 1,
    pressed: true,
    nodeId: rect.nodeId,
    ...mods,
  });
}

renderer.update(h(PressModsApp));

check("press: pointer modifiers reach onPress as nativeEvent flags", () => {
  pressModsEvents.length = 0;
  pressWithMods(pressModsRect("#111111"), {});
  assert.deepEqual(pressModsEvents, [
    ["row-a", { shiftKey: false, ctrlKey: false, metaKey: false, altKey: false }],
  ]);
  pressModsEvents.length = 0;
  pressWithMods(pressModsRect("#111111"), { shift: true });
  assert.deepEqual(pressModsEvents[0][1].shiftKey, true);
  assert.deepEqual(pressModsEvents[0][1].ctrlKey, false);
  pressModsEvents.length = 0;
  pressWithMods(pressModsRect("#222222"), { ctrl: true });
  assert.deepEqual(pressModsEvents[0], [
    "row-b",
    { shiftKey: false, ctrlKey: true, metaKey: false, altKey: false },
  ]);
  pressModsEvents.length = 0;
  pressWithMods(pressModsRect("#222222"), { meta: true });
  assert.deepEqual(pressModsEvents[0][1].metaKey, true);
  pressModsEvents.length = 0;
  pressWithMods(pressModsRect("#222222"), { super: true, alt: true });
  assert.deepEqual(pressModsEvents[0][1].metaKey, true);
  assert.deepEqual(pressModsEvents[0][1].altKey, true);
});

check("press: keyboard activation carries the activating key's modifiers", () => {
  pressModsEvents.length = 0;
  Sevyn._handlers.key({ key: 15, pressed: true }); // Tab -> row-a
  Sevyn._handlers.key({ key: 28, pressed: true, ctrl: true }); // Ctrl+Enter
  assert.deepEqual(pressModsEvents, [
    ["row-a", { shiftKey: false, ctrlKey: true, metaKey: false, altKey: false }],
  ]);
  pressModsEvents.length = 0;
  Sevyn._handlers.key({ key: 28, pressed: true, shift: true }); // Shift+Enter
  assert.deepEqual(pressModsEvents[0][1].shiftKey, true);
});

check("press: ScrollView with onPress is hit-testable, rows win the overlap", () => {
  const surface = pressModsRect("#f9fafb");
  assert.ok(surface.h >= 100, "list surface is tall, h=" + surface.h);
  pressModsEvents.length = 0;
  // Below the two 36px rows, inside the 200px surface: empty space.
  Sevyn._handlers.pointer({
    type: "button",
    x: surface.x + 2,
    y: surface.y + 150,
    button: 1,
    pressed: true,
    nodeId: surface.nodeId,
  });
  assert.deepEqual(
    pressModsEvents.map(([who]) => who),
    ["list"],
    "empty-space press hit the list, not a row",
  );
  pressModsEvents.length = 0;
  pressWithMods(pressModsRect("#111111"), {});
  assert.deepEqual(
    pressModsEvents.map(([who]) => who),
    ["row-a"],
    "row press did not leak to the list",
  );
});

renderer.update(h(App));

// --- View hit rect for onContextMenu (gap unit 11, audit #14) --------
// A plain View has the same no-hit-rect shape as a ScrollView: only
// Pressable / onPress views emit one. A View that declares
// onContextMenu must emit a hit rect — transparent when it has no
// background, carrying its yogaId on the background rect when it has
// one — so a right-click on empty desktop space reaches it; a View
// without onContextMenu must still emit none.
const viewMenuEvents = [];
function ViewMenuApp() {
  return h(
    "View",
    { style: { width: 1024, height: 768, backgroundColor: "#0b0b0f" } },
    h("View", {
      testID: "bare-view",
      onContextMenu: (ev) => {
        viewMenuEvents.push("context:" + ev.nativeEvent.x + "," + ev.nativeEvent.y);
      },
      style: { width: 200, height: 100 },
    }),
    h("View", {
      testID: "plain-view",
      style: { width: 200, height: 100 },
    }),
    h("View", {
      testID: "painted-view",
      onContextMenu: (ev) => {
        viewMenuEvents.push("painted:" + ev.nativeEvent.x + "," + ev.nativeEvent.y);
      },
      style: { width: 200, height: 100, backgroundColor: "#312e81" },
    }),
  );
}

renderer.update(h(ViewMenuApp));

check("context menu: a plain View with onContextMenu emits a hit rect", () => {
  const ops = lastPresent().ops;
  // No background, so the rect is transparent — but it carries a
  // nodeId, which is what makes the right-click dispatch.
  const bare = ops.find(
    (o) =>
      o.type === "rect" &&
      o.color === "#00000000" &&
      o.w === 200 &&
      o.h === 100 &&
      o.y === 0 &&
      o.nodeId != null &&
      o.nodeId >= 0,
  );
  assert.ok(bare, "bare View hit rect exists");
  // The sibling View without onContextMenu emits nothing: no hit op
  // covers its centre (10, 150).
  const plainHit = ops.find(
    (o) =>
      o.type === "rect" &&
      o.nodeId != null &&
      o.nodeId >= 0 &&
      10 >= o.x &&
      10 < o.x + o.w &&
      150 >= o.y &&
      150 < o.y + o.h,
  );
  assert.equal(plainHit, undefined, "plain View emits no hit rect");
  // The root background rect still carries nodeId -1: no
  // onContextMenu, no change.
  const root = ops.find((o) => o.type === "rect" && o.color === "#0b0b0f");
  assert.ok(root, "root rect exists");
  assert.equal(root.nodeId, -1, "root View without onContextMenu stays unhittable");
  // Right-clicking the bare View fires onContextMenu, not onPress.
  viewMenuEvents.length = 0;
  pressButton(10, 10, 0x111, bare.nodeId);
  assert.ok(
    viewMenuEvents.includes("context:10,10"),
    "bare View onContextMenu fired with the pointer position",
  );
  // And a View with a background carries its yogaId on that rect.
  const painted = ops.find(
    (o) =>
      o.type === "rect" &&
      o.color === "#312e81" &&
      o.w === 200 &&
      o.h === 100 &&
      o.nodeId != null &&
      o.nodeId >= 0,
  );
  assert.ok(painted, "painted View hit rect exists");
  pressButton(10, 210, 0x111, painted.nodeId);
  assert.ok(
    viewMenuEvents.includes("painted:10,210"),
    "painted View onContextMenu fired with the pointer position",
  );
});

// Restore the shell tree for a clean end state.
renderer.update(h(App));

// --- App store: first-boot race (M9) -----------------------------------
// appd seeds the registry before its socket listens, so the shell's
// first listApps() can return [] while appd is still seeding. The
// snapshot must not memoize the empty list: it retries on a 1s timer
// until appd answers, and handleAppEvent re-LISTs on any event while
// the snapshot is still empty. These run last and async (the timer
// path needs a real 1s wait); the summary prints after them.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const realListApps = Sevyn.listApps;
  try {
    // Timer path: empty first snapshot, appd answers before any
    // event arrives — the retry refills the snapshot and notifies.
    Sevyn.listApps = () => [];
    const first = renderer.getAppsSnapshot();
    assert.equal(first.apps.length, 0, "empty while appd seeds");
    const presentsBefore = Sevyn._presents.length;
    Sevyn.listApps = realListApps;
    await sleep(1200);
    const refilled = renderer.getAppsSnapshot();
    assert.equal(refilled.apps.length, 12, "retry refilled the snapshot");
    assert.ok(
      refilled.apps.some((a) => a.id === "terminal"),
      "refilled list holds the stock apps",
    );
    assert.ok(
      Sevyn._presents.length > presentsBefore,
      "listeners notified on refill (re-presented)",
    );
    passed++;
    console.log("ok - apps snapshot: empty listApps retried until appd answers");
  } finally {
    Sevyn.listApps = realListApps;
  }

  // Backstop path: a fresh module, empty snapshot, then an event
  // arrives before the timer fires — the event re-LISTs immediately.
  delete require.cache[require.resolve("../sevyn-renderer")];
  Sevyn._reset();
  const renderer2 = require("../sevyn-renderer");
  renderer2.render(h(App), { width: 1024, height: 768 });
  try {
    Sevyn.listApps = () => [];
    const first2 = renderer2.getAppsSnapshot();
    assert.equal(first2.apps.length, 0, "empty while appd seeds (backstop)");
    Sevyn.listApps = realListApps;
    // Unknown event kind while empty: the backstop still re-LISTs.
    Sevyn._handlers.appEvent("EVENT SOMETHING terminal");
    const afterUnknown = renderer2.getAppsSnapshot();
    assert.equal(
      afterUnknown.apps.length,
      12,
      "unknown event backstop refilled the snapshot",
    );
    // Unknown event kind with a full snapshot: no re-render, the
    // snapshot object is untouched (pre-existing behaviour).
    Sevyn._handlers.appEvent("EVENT SOMETHING terminal");
    assert.strictEqual(
      renderer2.getAppsSnapshot(),
      afterUnknown,
      "unknown event left a full snapshot alone",
    );
    Sevyn._handlers.appEvent("EVENT LAUNCHED terminal");
    const afterEvent = renderer2.getAppsSnapshot();
    assert.equal(afterEvent.apps.length, 12, "event backstop refilled the snapshot");
    assert.ok(
      afterEvent.running.includes("terminal"),
      "the LAUNCHED event still processed normally",
    );
    passed++;
    console.log("ok - apps snapshot: event backstop re-LISTs while empty");
  } finally {
    Sevyn.listApps = realListApps;
  }

  console.log(`\n${passed} renderer checks passed`);
})();
