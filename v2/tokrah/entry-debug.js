// Debug entry: wraps element creation on the bundle's own React copy
// to name the component that renders an invalid element type
// (React error #130 in production React gives no name). Not shipped.
require("./shim/env.js");
const React = require("react");
const jsxRuntime = require("react/jsx-runtime");
function isValidType(t) {
  if (t == null) return false;
  if (typeof t === "string" || typeof t === "function" || typeof t === "symbol")
    return true;
  // memo / forwardRef / lazy / context / fragment carry $$typeof.
  if (typeof t === "object" && t.$$typeof != null) return true;
  return false;
}
// Ring buffer of recently created elements: when the reconciler
// throws #130 for a type that never passed through the wrappers
// (e.g. an element the reconciler itself synthesizes), the buffer
// shows what was being built just before the error.
const recentElements = [];
function recordElement(type, name) {
  const desc =
    type == null
      ? String(type)
      : typeof type === "string"
        ? `host:${type}`
        : typeof type === "function"
          ? `fn:${type.name || "?"}`
          : `obj:$$typeof=${String(type.$$typeof)} keys=${JSON.stringify(Object.keys(type))}`;
  const stack = new Error().stack.split("\n").slice(2, 6).join(" | ");
  recentElements.push(`${name} ${desc} :: ${stack}`);
  if (recentElements.length > 30) recentElements.shift();
}
if (typeof globalThis.Sevyn !== "undefined" && globalThis.Sevyn.log) {
  const origLog = globalThis.Sevyn.log;
  globalThis.Sevyn.log = function (msg) {
    origLog(msg);
    if (typeof msg === "string" && msg.startsWith("render error")) {
      // eslint-disable-next-line no-console
      console.error("--- recent elements before render error ---");
      for (const line of recentElements) {
        // eslint-disable-next-line no-console
        console.error(line);
      }
    }
  };
}
function wrap(fn, name) {
  return function (...args) {
    recordElement(args[0], name);
    const t = args[0];
    if (typeof t === "object" && t !== null) {
      // Bare Context objects (and other $$typeof carriers that are
      // not valid element types) slip past the validity check — log
      // every object-typed element with its $$typeof + keys.
      const e = new Error(
        `object element type via ${name}: $$typeof=${String(t.$$typeof)} keys=${JSON.stringify(Object.keys(t))}`,
      );
      // eslint-disable-next-line no-console
      console.error(e.stack.split("\n").slice(0, 8).join("\n"));
    }
    if (!isValidType(t)) {
      const e = new Error(
        `invalid element type via ${name}: ${t == null ? t : typeof t + " " + JSON.stringify(Object.keys(t || {}))}`,
      );
      // Log the stack; bundle positions map back via sourcemap-query.js.
      // eslint-disable-next-line no-console
      console.error(e.stack.split("\n").slice(0, 10).join("\n"));
    }
    return fn(...args);
  };
}
React.createElement = wrap(React.createElement, "createElement");
React.cloneElement = wrap(React.cloneElement, "cloneElement");
jsxRuntime.jsx = wrap(jsxRuntime.jsx, "jsx");
jsxRuntime.jsxs = wrap(jsxRuntime.jsxs, "jsxs");
require("./entry-tokrah.js");
