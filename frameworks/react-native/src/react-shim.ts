/**
 * SevynOS Host React Bridge Shim
 *
 * Exposes the host runtime's React instance and ReactCurrentDispatcher
 * to third-party application bundles, eliminating multi-instance dispatcher mismatch.
 */
interface HostScope {
  readonly __SEVYN_MODULES__?: Readonly<Record<string, unknown>>;
  readonly React?: typeof import("react");
}

const hostScope = globalThis as unknown as HostScope;
const activeReact = (hostScope.__SEVYN_MODULES__?.["react"] ?? hostScope.React) as any;

if (activeReact && !activeReact.default) {
  try {
    activeReact.default = activeReact;
  } catch {
    // Ignore if frozen
  }
}

export const Children = activeReact?.Children;
export const Component = activeReact?.Component;
export const Fragment = activeReact?.Fragment;
export const Profiler = activeReact?.Profiler;
export const PureComponent = activeReact?.PureComponent;
export const StrictMode = activeReact?.StrictMode;
export const Suspense = activeReact?.Suspense;
export const Activity = activeReact?.Activity;
export const cloneElement = activeReact?.cloneElement;
export const createContext = activeReact?.createContext;
export const createElement = activeReact?.createElement;
export const createRef = activeReact?.createRef;
export const forwardRef = activeReact?.forwardRef;
export const isValidElement = activeReact?.isValidElement;
export const lazy = activeReact?.lazy;
export const memo = activeReact?.memo;
export const startTransition = activeReact?.startTransition;
export const act = activeReact?.act;
export const cache = activeReact?.cache;
export const cacheSignal = activeReact?.cacheSignal;
export const captureOwnerStack = activeReact?.captureOwnerStack;
export const use = activeReact?.use;
export const useActionState = activeReact?.useActionState;
export const useCallback = activeReact?.useCallback;
export const useContext = activeReact?.useContext;
export const useDebugValue = activeReact?.useDebugValue;
export const useDeferredValue = activeReact?.useDeferredValue;
export const useEffect = activeReact?.useEffect;
export const useEffectEvent = activeReact?.useEffectEvent;
export const useId = activeReact?.useId;
export const useImperativeHandle = activeReact?.useImperativeHandle;
export const useInsertionEffect = activeReact?.useInsertionEffect;
export const useLayoutEffect = activeReact?.useLayoutEffect;
export const useMemo = activeReact?.useMemo;
export const useOptimistic = activeReact?.useOptimistic;
export const useReducer = activeReact?.useReducer;
export const useRef = activeReact?.useRef;
export const useState = activeReact?.useState;
export const useSyncExternalStore = activeReact?.useSyncExternalStore;
export const useTransition = activeReact?.useTransition;
export const version = activeReact?.version;
export const __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE =
  activeReact?.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
export const __COMPILER_RUNTIME = activeReact?.__COMPILER_RUNTIME;

export default activeReact;
