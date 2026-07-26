export type ApplicationId = string;
export type ApplicationHostId = string;

export interface ApplicationDescriptor {
  /**
   * Stable, globally unique application identifier.
   *
   * Example:
   * dev.sevyn.hello
   */
  readonly id: ApplicationId;

  /**
   * Human-readable application name.
   */
  readonly name: string;

  /**
   * Application version declared by its manifest.
   */
  readonly version: string;

  /**
   * Identifies the framework host responsible for launching the app.
   *
   * Example:
   * sevyn.host.react-native
   */
  readonly hostId: ApplicationHostId;

  /**
   * Host-specific entrypoint.
   *
   * The Runtime stores this value but does not interpret it.
   */
  readonly entrypoint: string;
}
