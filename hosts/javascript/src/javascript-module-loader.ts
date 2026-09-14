import type { JavaScriptApplicationModule } from "./javascript-application-module.js";

export interface JavaScriptModuleLoader {
  load(source: string): Promise<JavaScriptApplicationModule>;
}

export class DataUrlJavaScriptModuleLoader implements JavaScriptModuleLoader {
  public async load(source: string): Promise<JavaScriptApplicationModule> {
    const encoded = Buffer.from(source, "utf8").toString("base64");

    const moduleUrl = `data:text/javascript;base64,${encoded}`;

    const imported: unknown = await import(moduleUrl);

    if (typeof imported !== "object" || imported === null) {
      throw new Error(
        "Application entrypoint did not produce a valid JavaScript module.",
      );
    }

    return imported as JavaScriptApplicationModule;
  }
}
