import type { SevynRuntime } from "@sevynos/runtime";
import { useSyncExternalStore } from "react";

export function useSevynRuntime(runtime: SevynRuntime): SevynRuntime {
  useSyncExternalStore(
    runtime.subscribe.bind(runtime),
    runtime.getSnapshot.bind(runtime),
    runtime.getSnapshot.bind(runtime),
  );

  return runtime;
}
