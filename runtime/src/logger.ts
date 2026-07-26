export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogContext = Readonly<Record<string, unknown>>;

export interface RuntimeLogger {
  log(level: LogLevel, event: string, context?: LogContext): void;
}

export class SevynRuntimeLogger implements RuntimeLogger {
  public log(level: LogLevel, event: string, context: LogContext = {}): void {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      component: "org.sevynos.runtime",
      event,
      ...context,
    };

    const serialized = JSON.stringify(entry);

    if (level === "error") {
      console.error(serialized);
      return;
    }

    if (level === "warn") {
      console.warn(serialized);
      return;
    }

    console.log(serialized);
  }

  public debug(event: string, context?: LogContext): void {
    this.log("debug", event, context);
  }

  public info(event: string, context?: LogContext): void {
    this.log("info", event, context);
  }

  public warn(event: string, context?: LogContext): void {
    this.log("warn", event, context);
  }

  public error(event: string, context?: LogContext): void {
    this.log("error", event, context);
  }
}
