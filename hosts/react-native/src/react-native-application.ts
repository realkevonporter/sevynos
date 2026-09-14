import type { ComponentType } from "react";

import type { ApplicationSessionId } from "@sevynos/runtime";

export interface ReactNativeApplicationProps {
  readonly applicationId: string;
  readonly sessionId: ApplicationSessionId;
}

export type ReactNativeApplicationComponent = ComponentType<ReactNativeApplicationProps>;
