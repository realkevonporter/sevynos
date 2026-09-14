import { createContext, type ReactNode } from "react";
import ReactReconciler from "react-reconciler";
import { DefaultEventPriority } from "react-reconciler/constants.js";
import type {
  NativeChild,
  NativeElementType,
  NativeHostNode,
  NativeProps,
  NativeTextNode,
} from "./native-types.js";

export interface NativeRootContainer {
  readonly roots: NativeChild[];
  nextNodeNumber: number;
  revision: number;
  readonly changedNodeIds: Set<string>;
  readonly onCommit: () => void;
  readonly onError: (error: Error) => void;
}
type TimeoutHandle = ReturnType<typeof setTimeout>;
interface NativeHostContext {
  readonly sevynRoot: true;
}
const nativeHostContext: NativeHostContext = Object.freeze({ sevynRoot: true });
const noTimeout = -1 as const;
let currentPriority = DefaultEventPriority;

function markDirty(node: NativeChild): void {
  if (node.kind === "host") node.dirty = true;
  if (node.parent?.dirty === false) markDirty(node.parent);
}
function append(parent: NativeHostNode, child: NativeChild): void {
  const existing = parent.children.indexOf(child);
  if (existing >= 0) parent.children.splice(existing, 1);
  parent.children.push(child);
  child.parent = parent;
  markDirty(parent);
}
function insert(parent: NativeHostNode, child: NativeChild, before: NativeChild): void {
  const existing = parent.children.indexOf(child);
  if (existing >= 0) parent.children.splice(existing, 1);
  const index = parent.children.indexOf(before);
  parent.children.splice(index < 0 ? parent.children.length : index, 0, child);
  child.parent = parent;
  markDirty(parent);
}
function remove(parent: NativeHostNode, child: NativeChild): void {
  const index = parent.children.indexOf(child);
  if (index >= 0) parent.children.splice(index, 1);
  delete child.parent;
  markDirty(parent);
}
function rootAppend(container: NativeRootContainer, child: NativeChild): void {
  const existing = container.roots.indexOf(child);
  if (existing >= 0) container.roots.splice(existing, 1);
  container.roots.push(child);
  container.changedNodeIds.add(child.id);
}
function rootInsert(
  container: NativeRootContainer,
  child: NativeChild,
  before: NativeChild,
): void {
  const existing = container.roots.indexOf(child);
  if (existing >= 0) container.roots.splice(existing, 1);
  const index = container.roots.indexOf(before);
  container.roots.splice(index < 0 ? container.roots.length : index, 0, child);
  container.changedNodeIds.add(child.id);
}
function rootRemove(container: NativeRootContainer, child: NativeChild): void {
  const index = container.roots.indexOf(child);
  if (index >= 0) container.roots.splice(index, 1);
  container.changedNodeIds.add(child.id);
}
function createId(container: NativeRootContainer, requested: string | undefined): string {
  if (requested !== undefined) return requested;
  container.nextNodeNumber += 1;
  return `native-${String(container.nextNodeNumber)}`;
}

const hostConfig: ReactReconciler.HostConfig<
  NativeElementType,
  NativeProps,
  NativeRootContainer,
  NativeHostNode,
  NativeTextNode,
  never,
  never,
  never,
  NativeChild,
  NativeHostContext,
  never,
  TimeoutHandle,
  typeof noTimeout,
  null
> = {
  supportsMutation: true,
  supportsPersistence: false,
  supportsHydration: false,
  isPrimaryRenderer: false,
  warnsIfNotActing: false,
  createInstance: (type, props, root) => ({
    kind: "host",
    id: createId(root, props.id),
    type,
    props,
    children: [],
    hidden: false,
    dirty: true,
    revision: root.revision,
  }),
  createTextInstance: (text, root) => ({
    kind: "raw-text",
    id: createId(root, undefined),
    text,
    hidden: false,
  }),
  appendInitialChild: append,
  finalizeInitialChildren: () => false,
  shouldSetTextContent: () => false,
  getRootHostContext: () => nativeHostContext,
  getChildHostContext: () => nativeHostContext,
  getPublicInstance: (instance) => instance,
  prepareForCommit: () => null,
  resetAfterCommit: (container) => {
    container.revision += 1;
    container.onCommit();
  },
  preparePortalMount: () => undefined,
  scheduleTimeout: (callback, delay) => setTimeout(callback, delay),
  cancelTimeout: (handle) => {
    clearTimeout(handle);
  },
  noTimeout,
  supportsMicrotasks: true,
  scheduleMicrotask: (callback) => {
    queueMicrotask(callback);
  },
  getInstanceFromNode: () => undefined,
  beforeActiveInstanceBlur: () => undefined,
  afterActiveInstanceBlur: () => undefined,
  prepareScopeUpdate: () => undefined,
  getInstanceFromScope: () => null,
  detachDeletedInstance: () => undefined,
  appendChild: append,
  appendChildToContainer: rootAppend,
  insertBefore: insert,
  insertInContainerBefore: rootInsert,
  removeChild: remove,
  removeChildFromContainer: rootRemove,
  resetTextContent: (instance) => {
    instance.children.splice(0);
    markDirty(instance);
  },
  commitTextUpdate: (instance, _oldText, newText) => {
    instance.text = newText;
    markDirty(instance);
  },
  commitUpdate: (instance, _type, _previous, next) => {
    instance.props = next;
    instance.revision += 1;
    markDirty(instance);
  },
  hideInstance: (instance) => {
    instance.hidden = true;
    markDirty(instance);
  },
  hideTextInstance: (instance) => {
    instance.hidden = true;
    markDirty(instance);
  },
  unhideInstance: (instance) => {
    instance.hidden = false;
    markDirty(instance);
  },
  unhideTextInstance: (instance) => {
    instance.hidden = false;
    markDirty(instance);
  },
  clearContainer: (container) => {
    container.roots.splice(0);
    return false;
  },
  NotPendingTransition: null,
  // @ts-expect-error React's public Context type hides private reconciler fields present at runtime.
  HostTransitionContext: createContext<null>(null),
  setCurrentUpdatePriority: (priority) => {
    currentPriority = priority;
  },
  getCurrentUpdatePriority: () => currentPriority,
  resolveUpdatePriority: () => currentPriority || DefaultEventPriority,
  resetFormInstance: () => undefined,
  requestPostPaintCallback: (callback) => {
    queueMicrotask(() => {
      callback(Date.now());
    });
  },
  shouldAttemptEagerTransition: () => false,
  trackSchedulerEvent: () => undefined,
  resolveEventType: () => null,
  resolveEventTimeStamp: () => Date.now(),
  maySuspendCommit: () => false,
  preloadInstance: () => true,
  startSuspendingCommit: () => undefined,
  suspendInstance: () => undefined,
  waitForCommitToBeReady: () => null,
};

const reconciler = ReactReconciler(hostConfig);
const synchronousReconciler = reconciler as typeof reconciler & {
  updateContainerSync: (
    tree: ReactNode,
    root: unknown,
    parentComponent: null,
    callback: () => void,
  ) => void;
  flushSyncWork: () => void;
};
export interface NativeReconcilerRoot {
  readonly render: (tree: ReactNode) => void;
}
export function createNativeReconcilerRoot(
  container: NativeRootContainer,
): NativeReconcilerRoot {
  // The upstream reconciler declarations intentionally leave their opaque root untyped.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const opaqueRoot = reconciler.createContainer(
    container,
    0,
    null,
    false,
    null,
    "sevyn-",
    (error) => {
      container.onError(error);
    },
    (error) => {
      container.onError(error);
    },
    (error) => {
      container.onError(error);
    },
    () => undefined,
    null,
  );
  return Object.freeze({
    render: (tree: ReactNode): void => {
      synchronousReconciler.updateContainerSync(tree, opaqueRoot, null, () => {
        reconciler.flushPassiveEffects();
      });
      synchronousReconciler.flushSyncWork();
    },
  });
}
