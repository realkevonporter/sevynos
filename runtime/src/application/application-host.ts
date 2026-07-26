import type { ApplicationHostId } from "./application-host-id.js";
import type { ApplicationSession } from "./application-session.js";

export interface ApplicationHostStartResult {
  /**
   * Host-specific identifier for the running application instance.
   *
   * Examples:
   * - operating system process ID
   * - container ID
   * - worker ID
   * - React Native surface ID
   */
  readonly instanceId: string;
}

export interface ApplicationHost {
  /**
   * Stable identifier used by application descriptors.
   *
   * Example:
   * sevyn.host.react-native
   */
  readonly id: ApplicationHostId;

  /**
   * Starts the application represented by the session.
   */
  start(session: ApplicationSession): Promise<ApplicationHostStartResult>;

  /**
   * Stops the application represented by the session.
   */
  stop(session: ApplicationSession): Promise<void>;
}
