export interface JavaScriptApplicationContext {
  readonly applicationId: string;
  readonly sessionId: string;

  readonly log: (message: string) => void;
}

export interface JavaScriptApplicationInstance {
  readonly title?: string;
}

export interface JavaScriptApplicationModule {
  readonly start: (
    context: JavaScriptApplicationContext,
  ) => JavaScriptApplicationInstance | Promise<JavaScriptApplicationInstance>;

  readonly stop?: (context: JavaScriptApplicationContext) => void | Promise<void>;
}
