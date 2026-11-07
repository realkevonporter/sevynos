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

console.log(`\n${passed} renderer checks passed`);
