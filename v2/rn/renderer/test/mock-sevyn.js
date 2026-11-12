"use strict";
// Mock Sevyn host global for Node testing of the renderer.
// Implements the Yoga subset with a deterministic naive layout (row /
// column flow, style width/height or measure results) — enough to prove
// the renderer's wiring: tree building, style application, op emission,
// hit routing, focus, scroll. Real flexbox is Yoga's job (CI/QEMU).

const nodes = new Map();
let nextId = 1;

const handlers = { pointer: null, key: null, status: null, appEvent: null, scroll: null };
const presents = []; // {ops, bg} per Sevyn.present call
const logs = [];

// The 12 stock apps, as appd's LIST would return them (id|name|
// version|color|glyph|...). The shell falls back to its built-in list
// when listApps() is empty; the mock returns the full set so the
// shell renders from the appd path.
const MOCK_APPS = [
  {
    id: "files",
    name: "Files",
    version: "1.0.0",
    color: "#3b82f6",
    glyph: "F",
    system: false,
    protected: false,
    permissions: ["status.read"],
  },
  {
    id: "terminal",
    name: "Terminal",
    version: "1.0.0",
    color: "#111827",
    glyph: ">",
    system: true,
    protected: true,
    permissions: [],
  },
  {
    id: "browser",
    name: "Browser",
    version: "1.0.0",
    color: "#0ea5e9",
    glyph: "B",
    system: false,
    protected: false,
    permissions: [],
  },
  {
    id: "settings",
    name: "Settings",
    version: "1.0.0",
    color: "#6b7280",
    glyph: "S",
    system: false,
    protected: false,
    permissions: [],
  },
  {
    id: "music",
    name: "Music",
    version: "1.0.0",
    color: "#ec4899",
    glyph: "M",
    system: false,
    protected: false,
    permissions: [],
  },
  {
    id: "photos",
    name: "Photos",
    version: "1.0.0",
    color: "#f59e0b",
    glyph: "P",
    system: false,
    protected: false,
    permissions: [],
  },
  {
    id: "calendar",
    name: "Calendar",
    version: "1.0.0",
    color: "#ef4444",
    glyph: "C",
    system: false,
    protected: false,
    permissions: [],
  },
  {
    id: "notes",
    name: "Notes",
    version: "1.0.0",
    color: "#eab308",
    glyph: "N",
    system: false,
    protected: false,
    permissions: [],
  },
  {
    id: "calculator",
    name: "Calculator",
    version: "1.0.0",
    color: "#8b5cf6",
    glyph: "=",
    system: false,
    protected: false,
    permissions: [],
  },
  {
    id: "camera",
    name: "Camera",
    version: "1.0.0",
    color: "#14b8a6",
    glyph: "O",
    system: false,
    protected: false,
    permissions: [],
  },
  {
    id: "messages",
    name: "Messages",
    version: "1.0.0",
    color: "#22c55e",
    glyph: "M",
    system: false,
    protected: false,
    permissions: [],
  },
  {
    id: "store",
    name: "Store",
    version: "1.0.0",
    color: "#f97316",
    glyph: "S",
    system: false,
    protected: false,
    permissions: [],
  },
];

function dim(v, parent) {
  if (v == null) return null;
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.endsWith("%")) {
    if (parent == null) return null;
    return (parseFloat(v) / 100) * parent;
  }
  return null;
}

function layoutNode(
  id,
  px,
  py,
  pw,
  ph,
  parentPx,
  parentPy,
  flexW,
  flexH,
  stretchW,
  stretchH,
) {
  const n = nodes.get(id);
  if (!n) return { x: px, y: py, width: 0, height: 0 };
  const st = n.style || {};
  let w = dim(st.width, pw);
  if (w == null && flexW != null) w = flexW;
  let h = dim(st.height, ph);
  if (h == null && flexH != null) h = flexH;
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
  // Yoga stretch (default alignItems): a child with no explicit
  // cross size and no measure function fills the parent's content
  // cross size. Without this the dock row auto-sized to its content
  // (1128px) instead of the 1024px surface, so its flex:1
  // ScrollView took the content width and the dock never overflowed.
  if (w == null && stretchW != null) w = stretchW;
  if (h == null && stretchH != null) h = stretchH;
  // NOTE: unresolved sizes stay null through the children loop and
  // the auto-size block below — zeroing them here pinned
  // content-sized containers (the dock pill) to zero and disabled
  // their auto-size fallback. They default to 0 at the layout
  // assignment at the end of this function.
  // Children flow.
  const row = st.flexDirection === "row";
  const padL = st.paddingLeft || st.paddingHorizontal || st.padding || 0;
  const padT = st.paddingTop || st.paddingVertical || st.padding || 0;
  const padR = st.paddingRight || st.paddingHorizontal || st.padding || 0;
  const padB = st.paddingBottom || st.paddingVertical || st.padding || 0;
  // Flex distribution: children with flex>0 and no explicit size in
  // the flow direction share what is left after the fixed children,
  // margins, and padding. (Without this the ScrollView's flex:1
  // collapsed to its content width and the dock never overflowed.)
  const mainSize = row ? w : h;
  let fixed = row ? padL + padR : padT + padB;
  let flexTotal = 0;
  for (const cid of n.children) {
    const c = nodes.get(cid);
    if (!c) continue;
    const cs = c.style || {};
    const flex = cs.flex || 0;
    const main = row ? cs.width : cs.height;
    if (flex > 0 && dim(main, mainSize) == null) {
      flexTotal += flex;
    } else {
      let sz = dim(main, mainSize);
      if (sz == null && c.measure) {
        const m = c.measure(0, 0, 0, 0);
        sz = row ? m.width : m.height;
      }
      const m1 = row
        ? cs.marginLeft || cs.marginHorizontal || cs.margin || 0
        : cs.marginTop || cs.marginVertical || cs.margin || 0;
      const m2 = row
        ? cs.marginRight || cs.marginHorizontal || cs.margin || 0
        : cs.marginBottom || cs.marginVertical || cs.margin || 0;
      fixed += (sz == null ? 0 : sz) + m1 + m2;
    }
  }
  const flexUnit = flexTotal > 0 ? Math.max(0, mainSize - fixed) / flexTotal : 0;
  let cx = px;
  let cy = py;
  cx += padL;
  cy += padT;
  for (const cid of n.children) {
    const c = nodes.get(cid);
    if (!c) continue;
    const cs = c.style || {};
    const abs = cs.position === "absolute";
    // Yoga honours margins in flow: the child is offset by its
    // start margin and the cursor advances past its end margin.
    const mL = cs.marginLeft || cs.marginHorizontal || cs.margin || 0;
    const mR = cs.marginRight || cs.marginHorizontal || cs.margin || 0;
    const mT = cs.marginTop || cs.marginVertical || cs.margin || 0;
    const mB = cs.marginBottom || cs.marginVertical || cs.margin || 0;
    const flex = cs.flex || 0;
    const main = row ? cs.width : cs.height;
    const isFlexChild = flex > 0 && dim(main, mainSize) == null;
    const childFlexW = row && isFlexChild ? flexUnit * flex : null;
    const childFlexH = !row && isFlexChild ? flexUnit * flex : null;
    // Cross-axis stretch for this child (null when it has an
    // explicit cross size or a measure function). Null — not 0 —
    // when the parent's cross size is itself unresolved: stretching
    // a child to a 0-wide parent pinned content-sized containers
    // (the dock pill) to zero and disabled their auto-size fallback.
    const cross = row ? cs.height : cs.width;
    const crossAvail = row ? h : w;
    const childStretchW =
      !row && dim(cross, crossAvail) == null && !c.measure && w != null
        ? Math.max(0, w - padL - padR - mL - mR)
        : null;
    const childStretchH =
      row && dim(cross, crossAvail) == null && !c.measure && h != null
        ? Math.max(0, h - padT - padB - mT - mB)
        : null;
    const clx = abs ? px + (cs.left || 0) : cx + (row ? mL : 0);
    const cly = abs ? py + (cs.top || 0) : cy + (row ? 0 : mT);
    const cl = layoutNode(
      cid,
      clx,
      cly,
      w,
      h,
      px,
      py,
      childFlexW,
      childFlexH,
      childStretchW,
      childStretchH,
    );
    if (!abs) {
      if (row) cx += cl.width + mL + mR;
      else cy += cl.height + mT + mB;
    }
  }
  // justifyContent: center — shift the flow children so the content
  // is centered in the container. (The mock previously ignored it, so
  // the dock pill sat at x=0 instead of centered, and the shell's
  // welcome text sat at the top of the main area.) Layouts are
  // parent-relative, so shifting a child shifts its whole subtree.
  // Only "center" is implemented; anything else is flex-start.
  if (st.justifyContent === "center") {
    if (row) {
      const used = cx - px;
      const free = Math.max(0, w - used - padR);
      const off = free / 2;
      if (off > 0) {
        for (const cid of n.children) {
          const c = nodes.get(cid);
          if (!c || !c.layout) continue;
          const cs = c.style || {};
          if (cs.position === "absolute") continue;
          c.layout.x += off;
        }
      }
    } else {
      const used = cy - py;
      const free = Math.max(0, h - used - padB);
      const off = free / 2;
      if (off > 0) {
        for (const cid of n.children) {
          const c = nodes.get(cid);
          if (!c || !c.layout) continue;
          const cs = c.style || {};
          if (cs.position === "absolute") continue;
          c.layout.y += off;
        }
      }
    }
  }
  // Auto size from children when the size is genuinely unresolved
  // (no explicit size, no flex share, no stretch, no measure). A
  // stretched or flexed size must NOT be overridden by the content
  // extent — that undid the stretch and re-broke the dock width.
  const wAuto =
    dim(st.width, pw) == null && flexW == null && stretchW == null && !n.measure;
  const hAuto =
    dim(st.height, ph) == null && flexH == null && stretchH == null && !n.measure;
  if (wAuto) {
    if (row) w = Math.max(w, cx - px + (st.paddingRight || 0));
    else {
      // Column width from its widest child (real Yoga sizes a column
      // to its widest child); the mock previously left it 0, which
      // collapsed content-sized columns like the dock pill's ring.
      let widest = padL + padR;
      for (const cid of n.children) {
        const c = nodes.get(cid);
        if (!c || !c.layout) continue;
        const cs = c.style || {};
        if (cs.position === "absolute") continue;
        const mL = cs.marginLeft || cs.marginHorizontal || cs.margin || 0;
        const mR = cs.marginRight || cs.marginHorizontal || cs.margin || 0;
        widest = Math.max(widest, c.layout.x + c.layout.width + mL + mR + padR);
      }
      w = Math.max(w, widest);
    }
  }
  // Row cross size (M9): a row container with no explicit height
  // sizes to its tallest child, margins included — real Yoga does
  // this, and without it every row of a grid collapsed to height 0
  // and the parent column stacked them all at the same y (the M9
  // calculator keys all landed on the first row).
  if (hAuto && row) {
    let cross = padT + padB;
    for (const cid of n.children) {
      const c = nodes.get(cid);
      if (!c || !c.layout) continue;
      const cs = c.style || {};
      const mT2 = cs.marginTop || cs.marginVertical || cs.margin || 0;
      const mB2 = cs.marginBottom || cs.marginVertical || cs.margin || 0;
      cross = Math.max(cross, c.layout.y + c.layout.height + mT2 + mB2 + padB);
    }
    h = Math.max(h, cross);
  }
  if (hAuto) {
    if (!row) h = Math.max(h, cy - py + (st.paddingBottom || 0));
    else h = Math.max(h, 0);
  }
  // Yoga parity: yogaGetLayout returns positions RELATIVE to the
  // parent (the renderer adds the parent offset when emitting ops).
  // The mock used to store absolute positions, which double-counted
  // every ancestor offset in the ops — invisible while every
  // pressable was a direct ScrollView child (one uniform shift), but
  // the M3 dock wraps each tile in a column View and the extra level
  // doubled the tile spacing in the ops.
  n.layout = {
    x: px - (parentPx || 0),
    y: py - (parentPy || 0),
    width: w == null ? 0 : w,
    height: h == null ? 0 : h,
  };
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
  onScroll(fn) {
    handlers.scroll = fn;
  },
  onAppEvent(fn) {
    handlers.appEvent = fn;
  },
  _status: { battery: "87", wifi: "on", volume: "43" },
  getStatus() {
    return Object.assign({}, Sevyn._status);
  },
  appId: "shell",
  appName: "SevynOS",
  appColor: "#111827",
  appGlyph: "S",
  hasPermission() {
    return true;
  },
  listApps() {
    return MOCK_APPS.map((a) =>
      Object.assign({}, a, { permissions: a.permissions.slice() }),
    );
  },
  closeApp() {
    logs.push("CLOSEAPP");
    return true;
  },
  // One-shot `sevyn` CLI run (M4). Records the call; tests answer
  // through _execHandler (a function of cmdline -> "code\noutput"),
  // defaulting to a bare success so template tests never see it.
  // Mirrors the real host's gate: without cli.exec the call is
  // refused before it reaches the handler.
  _execHandler: null,
  exec(cmdline) {
    logs.push("EXEC " + cmdline);
    if (!Sevyn.hasPermission("cli.exec")) {
      return "ERR permission denied: cli.exec";
    }
    if (typeof Sevyn._execHandler === "function") {
      return Sevyn._execHandler(cmdline);
    }
    return "0\n";
  },
  // Off-thread exec (M9 wifi scan, M10 comms login/send/call):
  // same string shape as exec, as a Promise.
  execAsync(cmdline) {
    return Promise.resolve(Sevyn.exec(cmdline));
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
    Sevyn._execHandler = null;
    nodes.clear();
    // NOTE: nextId is deliberately NOT reset. Yoga node IDs must be
    // unique for the life of the process (real Yoga never reuses
    // one): a previous load's instances can outlive _reset — the
    // Terminal's auto-scroll setTimeout fires after unmount and
    // calls scrollTo on its stale ScrollView, which re-presents the
    // new tree. If IDs were reused, that stale View could share a
    // yogaId with a new #text (which installs a measure function),
    // and syncYogaChildren would throw "Nodes with measure
    // functions cannot have children" on the View. Monotonic IDs
    // make that collision impossible.
    presents.length = 0;
    logs.length = 0;
    handlers.pointer = null;
    handlers.key = null;
    handlers.status = null;
    handlers.appEvent = null;
    handlers.scroll = null;
  },
};

module.exports = Sevyn;
