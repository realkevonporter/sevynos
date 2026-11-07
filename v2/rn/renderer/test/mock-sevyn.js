"use strict";
// Mock Sevyn host global for Node testing of the renderer.
// Implements the Yoga subset with a deterministic naive layout (row /
// column flow, style width/height or measure results) — enough to prove
// the renderer's wiring: tree building, style application, op emission,
// hit routing, focus, scroll. Real flexbox is Yoga's job (CI/QEMU).

const nodes = new Map();
let nextId = 1;

const handlers = { pointer: null, key: null, status: null };
const presents = []; // {ops, bg} per Sevyn.present call
const logs = [];

function dim(v, parent) {
  if (v == null) return null;
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.endsWith("%")) {
    return (parseFloat(v) / 100) * parent;
  }
  return null;
}

function layoutNode(id, px, py, pw, ph) {
  const n = nodes.get(id);
  if (!n) return { x: px, y: py, width: 0, height: 0 };
  const st = n.style || {};
  let w = dim(st.width, pw);
  let h = dim(st.height, ph);
  if (w == null || h == null) {
    if (n.measure) {
      // widthMode: 0 undefined, 1 exactly, 2 at-most.
      const wm = w != null ? 1 : 0;
      const hm = h != null ? 1 : 0;
      const m = n.measure(w || 0, wm, h || 0, hm);
      if (w == null) w = m.width;
      if (h == null) h = m.height;
    }
  }
  if (w == null) w = 0;
  if (h == null) h = 0;
  // Children flow.
  const row = st.flexDirection === "row";
  let cx = px;
  let cy = py;
  const padL = st.paddingLeft || st.paddingHorizontal || st.padding || 0;
  const padT = st.paddingTop || st.paddingVertical || st.padding || 0;
  cx += padL;
  cy += padT;
  for (const cid of n.children) {
    const c = nodes.get(cid);
    if (!c) continue;
    const cs = c.style || {};
    const abs = cs.position === "absolute";
    const clx = abs ? px + (cs.left || 0) : cx;
    const cly = abs ? py + (cs.top || 0) : cy;
    const cl = layoutNode(cid, clx, cly, w, h);
    if (!abs) {
      if (row) cx += cl.width;
      else cy += cl.height;
    }
  }
  // Auto size from children when no explicit size and no measure.
  if (!n.measure && st.width == null) {
    if (row) w = Math.max(w, cx - px + (st.paddingRight || 0));
    else w = Math.max(w, 0);
  }
  if (!n.measure && st.height == null) {
    if (!row) h = Math.max(h, cy - py + (st.paddingBottom || 0));
    else h = Math.max(h, 0);
  }
  n.layout = { x: px, y: py, width: w, height: h };
  return n.layout;
}

const Sevyn = {
  yogaCreateNode() {
    const id = nextId++;
    nodes.set(id, { style: {}, children: [], layout: null, measure: null });
    return id;
  },
  yogaFreeNode(id) {
    nodes.delete(id);
  },
  yogaSetStyle(id, style) {
    const n = nodes.get(id);
    if (n) n.style = style || {};
  },
  yogaSetMeasureFunc(id, fn) {
    const n = nodes.get(id);
    if (n) n.measure = fn;
  },
  yogaClearMeasureFunc(id) {
    const n = nodes.get(id);
    if (n) n.measure = null;
  },
  yogaSetChildren(id, kids) {
    const n = nodes.get(id);
    if (!n) return;
    // Mirror Yoga's real invariant (YGNodeInsertChild): a node with a
    // measure function cannot have children. The mock used to accept
    // anything, which hid exactly this bug until CI/QEMU hit real Yoga.
    if (n.measure && kids.length > 0) {
      throw new Error(
        "Cannot add child: Nodes with measure functions cannot have children.",
      );
    }
    n.children = kids.slice();
  },
  yogaCalculateLayout(id, w, h) {
    layoutNode(id, 0, 0, w, h);
  },
  yogaGetLayout(id) {
    const n = nodes.get(id);
    if (!n || !n.layout) return { x: 0, y: 0, width: 0, height: 0 };
    return n.layout;
  },
  measureText(text, size, bold, maxWidth) {
    // Deterministic stand-in: 0.55 * size per char, 1.25 * size per line.
    const charW = size * 0.55;
    if (!maxWidth || maxWidth <= 0) {
      return { width: text.length * charW, height: size * 1.25 };
    }
    const words = text.split(" ");
    let lines = 1;
    let lineW = 0;
    for (const word of words) {
      const ww = word.length * charW;
      if (lineW > 0 && lineW + charW + ww > maxWidth) {
        lines++;
        lineW = ww;
      } else {
        lineW += (lineW > 0 ? charW : 0) + ww;
      }
    }
    return {
      width: Math.min(text.length * charW, maxWidth),
      height: lines * size * 1.25,
    };
  },
  present(ops, bg) {
    presents.push({ ops, bg });
  },
  onPointer(fn) {
    handlers.pointer = fn;
  },
  onKey(fn) {
    handlers.key = fn;
  },
  onStatus(fn) {
    handlers.status = fn;
  },
  _status: { battery: "87", wifi: "on", volume: "43" },
  getStatus() {
    return Object.assign({}, Sevyn._status);
  },
  launchApp(appId) {
    logs.push("LAUNCH " + appId);
    return true;
  },
  log(msg) {
    logs.push(String(msg));
  },
  // Test helpers.
  _nodes: nodes,
  _handlers: handlers,
  _presents: presents,
  _logs: logs,
  _reset() {
    Sevyn._status = { battery: "87", wifi: "on", volume: "43" };
    nodes.clear();
    nextId = 1;
    presents.length = 0;
    logs.length = 0;
    handlers.pointer = null;
    handlers.key = null;
    handlers.status = null;
  },
};

module.exports = Sevyn;
