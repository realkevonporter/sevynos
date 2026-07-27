export interface ApplicationModuleContext {
  readonly applicationId: string;
  readonly sessionId: string;

  readonly log: (message: string) => void;
}

export interface ApplicationModuleInstance {
  readonly title?: string;
}

export interface ApplicationModule {
  readonly start: (
    context: ApplicationModuleContext,
  ) => ApplicationModuleInstance | Promise<ApplicationModuleInstance>;

  readonly stop?: (context: ApplicationModuleContext) => void | Promise<void>;
}
