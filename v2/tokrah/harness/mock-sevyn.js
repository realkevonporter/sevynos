// SevynOS M6 experiment — mock Sevyn host for Node.
// Lets a Metro bundle run under the real v2 renderer in Node, with a
// trivial Yoga stand-in (column stack; style dims win, measured text
// otherwise) and present() recording the draw ops instead of painting.
// This is the fast loop: bundle -> run -> read the rendered tree in
// seconds, no QEMU. The real host is the gate later.
// The Node HTTP transport for the bundle's env glue (the bundle
// itself never references Node builtins, so Metro can bundle it for
// Hermes): {status, headers, body}.
const http = require("http");
const https = require("https");
globalThis.__sevynHttpRequest = (method, url, headers, body) =>
  new Promise((resolve, reject) => {
    const lib = url.startsWith("https:") ? https : http;
    const req = lib.request(url, { method, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    });
    req.on("error", reject);
    if (body != null) req.write(body);
    req.end();
  });

const nodes = new Map();
let nextId = 1;

function styleOf(id) {
  return nodes.get(id)?.style || {};
}
function measureNode(id, availW) {
  const n = nodes.get(id);
  if (!n) return { width: 0, height: 0 };
  if (n.measure) {
    const m = n.measure(availW, availW === Infinity ? 0 : 2, 0, 0);
    return { width: m.width || 0, height: m.height || 0 };
  }
  return { width: 0, height: 0 };
}
// Resolve a style dimension: numbers pass through, "N%" resolves
// against the available size (real Yoga does this; the mock used to
// pass the string through, which made percentage-width buttons
// zero-width / unhittable).
function resolveDim(v, avail) {
  if (typeof v === "string" && v.endsWith("%")) {
    const pct = parseFloat(v) / 100;
    return avail != null && Number.isFinite(avail) ? avail * pct : 0;
  }
  return v;
}
function padOf(st) {
  return {
    l: st.paddingLeft ?? st.paddingHorizontal ?? st.padding ?? 0,
    r: st.paddingRight ?? st.paddingHorizontal ?? st.padding ?? 0,
    t: st.paddingTop ?? st.paddingVertical ?? st.padding ?? 0,
    b: st.paddingBottom ?? st.paddingVertical ?? st.padding ?? 0,
  };
}
// Intrinsic size of a node given the available space. Children are
// sized recursively; flex:1 children take a share of the remaining
// space on the parent's main axis. min/max clamps apply.
function computeSize(id, availW, availH) {
  const n = nodes.get(id);
  if (!n) return { width: 0, height: 0 };
  const st = n.style || {};
  let width = resolveDim(st.width, availW);
  let height = resolveDim(st.height, availH);
  const row = st.flexDirection === "row";
  const gap = typeof st.gap === "number" ? st.gap : 0;
  const pad = padOf(st);
  const innerW = width != null ? width - pad.l - pad.r : availW;
  const innerH = height != null ? height - pad.t - pad.b : availH;
  // First pass: fixed-size children.
  const childSizes = new Map();
  let fixedMain = 0;
  let flexTotal = 0;
  for (const c of n.children) {
    const cs = styleOf(c);
    const flex = typeof cs.flex === "number" ? cs.flex : 0;
    if (flex > 0) {
      flexTotal += flex;
      continue;
    }
    const s = computeSize(c, row ? innerW : innerW, row ? innerH : innerH);
    childSizes.set(c, s);
    fixedMain += row ? s.width : s.height;
  }
  const gaps = Math.max(0, n.children.length - 1) * gap;
  // Flex children share what is left on the main axis.
  if (flexTotal > 0) {
    const mainAvail = row ? innerW : innerH;
    const remaining = mainAvail != null ? Math.max(0, mainAvail - fixedMain - gaps) : 0;
    for (const c of n.children) {
      const cs = styleOf(c);
      const flex = typeof cs.flex === "number" ? cs.flex : 0;
      if (flex <= 0) continue;
      const share = remaining * (flex / flexTotal);
      const s = computeSize(c, row ? share : innerW, row ? innerH : share);
      if (row) s.width = share;
      else s.height = share;
      childSizes.set(c, s);
    }
  }
  let contentW = 0;
  let contentH = 0;
  for (const c of n.children) {
    const s = childSizes.get(c) || { width: 0, height: 0 };
    if (row) {
      contentW += s.width;
      contentH = Math.max(contentH, s.height);
    } else {
      contentH += s.height;
      contentW = Math.max(contentW, s.width);
    }
  }
  if (n.children.length > 1) {
    if (row) contentW += gaps;
    else contentH += gaps;
  }
  if (width == null) {
    width = n.measure ? measureNode(id, availW ?? 0).width : contentW + pad.l + pad.r;
  }
  if (height == null) {
    height = n.measure ? measureNode(id, width ?? 0).height : contentH + pad.t + pad.b;
  }
  if (width == null) width = 0;
  if (height == null) height = 0;
  if (st.minWidth != null) width = Math.max(width, resolveDim(st.minWidth, availW) ?? 0);
  if (st.maxWidth != null)
    width = Math.min(width, resolveDim(st.maxWidth, availW) ?? Infinity);
  if (st.minHeight != null)
    height = Math.max(height, resolveDim(st.minHeight, availH) ?? 0);
  if (st.maxHeight != null)
    height = Math.min(height, resolveDim(st.maxHeight, availH) ?? Infinity);
  return { width, height };
}
// Layout: assign positions. Sizes come from computeSize (children
// sized before the parent's height is derived from them, so a column
// of fields stacks instead of collapsing onto one row).
// yogaGetLayout must return PARENT-RELATIVE coordinates (real Yoga
// semantics: emitInstance adds the parent's offset itself), so the
// stored layout is the delta from the parent's absolute position.
function layout(id, x, y, w, h, px = 0, py = 0) {
  const n = nodes.get(id);
  if (!n) return;
  const st = n.style || {};
  const size = computeSize(id, w, h);
  n.layout = { x: x - px, y: y - py, width: size.width, height: size.height };
  const row = st.flexDirection === "row";
  const gap = typeof st.gap === "number" ? st.gap : 0;
  const pad = padOf(st);
  let cx = x + pad.l;
  let cy = y + pad.t;
  const innerW = size.width - pad.l - pad.r;
  const innerH = size.height - pad.t - pad.b;
  for (const c of n.children) {
    const s = computeSize(c, innerW, innerH);
    layout(c, cx, cy, s.width, s.height, x, y);
    if (row) cx += s.width + gap;
    else cy += s.height + gap;
  }
}

const presents = [];
const logs = [];
const handlers = {};

global.Sevyn = {
  yogaCreateNode() {
    const id = nextId++;
    nodes.set(id, {
      style: {},
      children: [],
      measure: null,
      layout: { x: 0, y: 0, width: 0, height: 0 },
    });
    return id;
  },
  yogaFreeNode(id) {
    nodes.delete(id);
  },
  yogaSetStyle(id, style) {
    const n = nodes.get(id);
    if (n) n.style = style || {};
  },
  yogaSetChildren(id, children) {
    const n = nodes.get(id);
    if (n) n.children = children || [];
  },
  yogaSetMeasureFunc(id, fn) {
    const n = nodes.get(id);
    if (n) n.measure = fn;
  },
  yogaClearMeasureFunc(id) {
    const n = nodes.get(id);
    if (n) n.measure = null;
  },
  yogaCalculateLayout(rootId, width, height) {
    layout(rootId, 0, 0, width, height);
  },
  yogaGetLayout(id) {
    const n = nodes.get(id);
    return n ? { ...n.layout } : { x: 0, y: 0, width: 0, height: 0 };
  },
  present(ops, backgroundColor) {
    presents.push({ ops, backgroundColor });
  },
  measureText(text, size, _bold, maxWidth) {
    const w = String(text).length * size * 0.55;
    const width = maxWidth > 0 ? Math.min(w, maxWidth) : w;
    const lines = maxWidth > 0 ? Math.max(1, Math.ceil(w / maxWidth)) : 1;
    return { width, height: size * 1.25 * lines };
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
  onAppEvent(fn) {
    handlers.appEvent = fn;
  },
  listApps() {
    return [];
  },
  launchApp() {
    return false;
  },
  closeApp() {
    return false;
  },
  getStatus() {
    return {};
  },
  hasPermission() {
    return true;
  },
  exec() {
    return "0\n";
  },
  log(msg) {
    logs.push(String(msg));
  },
  appId: "tokrah",
  appName: "Tokrah",
  appColor: "#111827",
  appGlyph: "T",
};

module.exports = { presents, logs, handlers, nodes };
