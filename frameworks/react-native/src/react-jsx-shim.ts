/**
 * SevynOS Host React JSX Runtime Bridge Shim
 */
interface HostScope {
  readonly __SEVYN_MODULES__?: Readonly<Record<string, unknown>>;
  readonly React?: typeof import("react");
}

const hostScope = globalThis as unknown as HostScope;
const activeJsx = (hostScope.__SEVYN_MODULES__?.["react/jsx-runtime"] ??
  hostScope.__SEVYN_MODULES__?.["react"] ??
  hostScope.React) as any;

export const Fragment = activeJsx?.Fragment;
export const jsx = activeJsx?.jsx ?? activeJsx?.createElement;
export const jsxs = activeJsx?.jsxs ?? activeJsx?.createElement;
export const jsxDEV = activeJsx?.jsxDEV ?? activeJsx?.createElement;

export default activeJsx;
