import { createContext, createElement, useContext, type ReactNode } from "react";

export interface SevynApplicationState {
  readonly applicationId: string;
  readonly sessionId: string;
  readonly lifecycle: "starting" | "running" | "background" | "stopping";
}
export interface SevynWindowContext {
  readonly id: string;
  readonly focused: boolean;
  readonly width: number;
  readonly height: number;
}
export interface SevynSystemContextValue {
  readonly application: SevynApplicationState;
  readonly window: SevynWindowContext;
  readonly theme: "light" | "dark";
  readonly workspace: string;
  readonly display: string;
  readonly reducedMotion: boolean;
}
const SevynSystemContext = createContext<SevynSystemContextValue | undefined>(undefined);
export function SevynSystemProvider(props: {
  readonly value: SevynSystemContextValue;
  readonly children: ReactNode;
}): ReactNode {
  return createElement(
    SevynSystemContext.Provider,
    { value: props.value },
    props.children,
  );
}
function useSystem(): SevynSystemContextValue {
  const value = useContext(SevynSystemContext);
  if (value === undefined)
    throw new Error("Sevyn lifecycle hooks require a SevynSystemProvider.");
  return value;
}
export const useApplicationState = (): SevynApplicationState => useSystem().application;
export const useWindow = (): SevynWindowContext => useSystem().window;
export const useSystemTheme = (): "light" | "dark" => useSystem().theme;
export const useWorkspace = (): string => useSystem().workspace;
export const useDisplay = (): string => useSystem().display;
export const useReducedMotion = (): boolean => useSystem().reducedMotion;
