// SevynOS M6 experiment — run a Metro bundle under the mock Sevyn
// and dump what the renderer presented (texts + op counts).
// Usage: node run-bundle.js <bundle.js>
const { presents, logs } = require("./mock-sevyn.js");
const bundle = process.argv[2];
if (!bundle) {
  console.error("usage: node run-bundle.js <bundle.js>");
  process.exit(1);
}
// An unhandled rejection in an effect (e.g. a stub missing an API
// the app calls) must not kill the run: log it and keep the presented
// tree, so the iteration loop sees the render instead of a crash.
process.on("unhandledRejection", (e) => {
  console.error("UNHANDLED REJECTION:", e && e.stack ? e.stack : String(e));
});
// Debug: DEBUG_ELEMENTS=1 wraps element creation to name the
// component that renders an undefined element type (React error #130
// in production React gives no name). The stack's bundle positions
// map back via sourcemap-query.js.
if (process.env.DEBUG_ELEMENTS) {
  const React = require("react");
  const jsxRuntime = require("react/jsx-runtime");
  const wrap =
    (fn, name) =>
    (...args) => {
      if (args[0] == null) {
        const e = new Error(`createElement(${name}) with undefined type`);
        console.error(e.stack.split("\n").slice(0, 8).join("\n"));
      }
      return fn(...args);
    };
  React.createElement = wrap(React.createElement, "createElement");
  jsxRuntime.jsx = wrap(jsxRuntime.jsx, "jsx");
  jsxRuntime.jsxs = wrap(jsxRuntime.jsxs, "jsxs");
}

const t0 = Date.now();
try {
  require(bundle);
} catch (e) {
  console.error("BUNDLE THREW AT LOAD:");
  console.error(e && e.stack ? e.stack : String(e));
  process.exit(1);
}
// Let timers + microtasks flush (React scheduler, effects).
setTimeout(() => {
  console.log(`presents: ${presents.length} (after ${Date.now() - t0}ms)`);
  // The first present is often the empty root (router still resolving);
  // report the last present that actually painted anything.
  const painted = [...presents].reverse().find((p) => p.ops.length > 0);
  const last = painted || presents[presents.length - 1];
  if (!last) {
    console.log("NO PRESENT — the bundle never rendered");
  } else {
    const texts = last.ops.filter((o) => o.type === "text").map((o) => o.text);
    const rects = last.ops.filter((o) => o.type === "rect").length;
    const images = last.ops.filter((o) => o.type === "image").length;
    console.log(
      `last painted present: bg: ${last.backgroundColor} rects: ${rects} images: ${images} texts: ${texts.length}`,
    );
    for (const t of texts.slice(0, 40)) console.log(`  TEXT: ${JSON.stringify(t)}`);
  }
  const interesting = logs.filter((l) => !l.startsWith("[shim]"));
  if (interesting.length) {
    console.log("--- host logs ---");
    for (const l of interesting.slice(0, 40)) console.log(`  ${l}`);
  }
  // The app keeps timers alive (intervals, sockets); exit after the
  // report instead of waiting for the loop to drain.
  process.exit(0);
}, 3000);
