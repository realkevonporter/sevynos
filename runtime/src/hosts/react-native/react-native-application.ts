import type { ComponentType } from "react";

import type { ApplicationSessionId } from "../../application/application-session.js";

export interface ReactNativeApplicationProps {
  readonly applicationId: string;
  readonly sessionId: ApplicationSessionId;
}

export type ReactNativeApplicationComponent = ComponentType<ReactNativeApplicationProps>;
