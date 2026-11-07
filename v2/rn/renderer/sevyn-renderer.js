"use strict";
// SevynOS v2 M2 — React Native renderer for the Sevyn host.
//
// A react-reconciler host config (mutation mode, no hydration, no
// Suspense support) that turns a React tree into:
//   1. a Yoga layout tree (via the Sevyn.yoga* host functions), then
//   2. a flat draw-op list per commit (via Sevyn.present).
//
// Host component types: View, Text, Image, Pressable, ScrollView.
// The shell app is written against these five; nothing else exists yet.
//
// Event flow (host -> JS):
//   Sevyn.onPointer(ev)  ev = {type:'move'|'button'|'axis', x, y,
//                               button, pressed, nodeId?}
//     nodeId is set on button-press only: the yoga id of the topmost
//     hit op (host hit-tests the last presented ops).
//   Sevyn.onKey(ev)      ev = {key: <linux keycode>, pressed: bool}
//   Sevyn.onStatus(ev)   ev = {key, value} — statusd push.
//   Sevyn.onAppEvent(line) line = "EVENT LAUNCHED files" — appd push.
//   Sevyn.listApps()     -> [{id, name, version, color, glyph,
//                          system, protected, permissions}] — appd LIST.
//   Sevyn.launchApp(id)  -> bool — appd LAUNCH.
//
// The renderer keeps a yoga-id -> instance map for hit routing and a
// focus list for keyboard activation. ScrollView scrolls only via
// scrollBy/scrollTo (the host does not forward wheel/axis events).

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
  return inst;
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
    // Content size = max child extent (for scroll clamping).
    let cw = 0;
    let ch = 0;
    for (const c of inst.children) {
      const cl = Sevyn.yogaGetLayout(c.yogaId);
      cw = Math.max(cw, cl.x + cl.width);
      ch = Math.max(ch, cl.y + cl.height);
    }
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
  }

  // Focus ring: a thin outline around the focused pressable.
  if (focusedInstance === inst && pressable) {
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
  syncYogaChildren(rootContainer);
  Sevyn.yogaCalculateLayout(rootContainer.yogaId, rootWidth, rootHeight);
  const ops = [];
  for (const c of rootContainer.children) emitInstance(c, 0, 0, ops, false);
  Sevyn.present(ops, backgroundColor);
}

// ------------------------------------------------------------------- focus
let focusedInstance = null;

function focusables() {
  const out = [];
  function walk(inst) {
    if (inst.hidden) return;
    if (inst.type === "Pressable" || (inst.props && inst.props.onPress)) {
      out.push(inst);
    }
    for (const c of inst.children) walk(c);
  }
  if (rootContainer) for (const c of rootContainer.children) walk(c);
  return out;
}

function moveFocus(dir) {
  const list = focusables();
  if (list.length === 0) return;
  const i = list.indexOf(focusedInstance);
  const next = list[(i + dir + list.length) % list.length];
  focusedInstance = next;
  presentRoot();
}

function activateFocused() {
  if (focusedInstance && focusedInstance.props && focusedInstance.props.onPress) {
    focusedInstance.props.onPress();
  }
}

// Linux keycodes (evdev): Enter 28, Space 57, Tab 15, Left 105,
// Right 106, Up 103, Down 108, Escape 1.
function handleKey(ev) {
  if (!ev.pressed) return;
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
  if (!inst) return;
  focusedInstance = inst;
  if (inst.props && inst.props.onPress) {
    inst.props.onPress();
  }
  // Force the state update out now (see handleKey) and present, so the
  // press result is visible on the very next frame.
  SevynReconciler.flushSyncWork();
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
    running = running.filter((r) => r !== id);
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
  if (typeof Sevyn.onAppEvent === "function") Sevyn.onAppEvent(handleAppEvent);

  // NOTE: the onUncaughtError handler must log — a no-op here would
  // silently swallow render throws and mount an empty tree.
  const onUncaughtError = (error) => {
    Sevyn.log(
      "render error: " + (error && error.message ? error.message : String(error)),
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
  // Exposed for tests: the live instance map and present pass.
  _instancesByYogaId: instancesByYogaId,
  _presentRoot: presentRoot,
};
