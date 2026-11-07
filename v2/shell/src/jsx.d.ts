// SevynOS host components (react-reconciler host config).
// The renderer implements exactly these five; anything else is a bug.
// Styles are the subset the host's applyStyle understands (see
// v2/rn/README.md): Yoga layout props + backgroundColor, color,
// fontSize, fontWeight, textAlign, borderRadius.
//
// React 19 types put the JSX namespace under React.JSX; this augments
// it with the Sevyn host elements.

import "react";

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      View: any;
      Text: any;
      Image: any;
      Pressable: any;
      ScrollView: any;
    }
  }
}

declare global {
  interface SevynAppInfo {
    id: string;
    name: string;
    version: string;
    color: string;
    glyph: string;
    system: boolean;
    protected: boolean;
    permissions: string[];
  }

  const Sevyn: {
    yogaCreateNode(): number;
    yogaFreeNode(id: number): void;
    yogaSetStyle(id: number, style: any): void;
    yogaSetMeasureFunc(
      id: number,
      fn: (
        w: number,
        wm: number,
        h: number,
        hm: number,
      ) => { width: number; height: number },
    ): void;
    yogaClearMeasureFunc(id: number): void;
    yogaSetChildren(id: number, kids: number[]): void;
    yogaCalculateLayout(id: number, width: number, height: number): void;
    yogaGetLayout(id: number): { x: number; y: number; width: number; height: number };
    measureText(
      text: string,
      size: number,
      bold: boolean,
      maxWidth: number,
    ): { width: number; height: number };
    present(ops: any[], backgroundColor: string): void;
    onPointer(fn: (ev: any) => void): void;
    onKey(fn: (ev: any) => void): void;
    onStatus(fn: (ev: any) => void): void;
    getStatus(): { [key: string]: string };
    // App identity (set by the host; the shell reads "shell" here).
    appId: string;
    appName: string;
    appColor: string;
    appGlyph: string;
    hasPermission(name: string): boolean;
    listApps(): SevynAppInfo[];
    launchApp(appId: string): boolean;
    onAppEvent(fn: (line: string) => void): void;
    closeApp(): boolean;
    log(msg: string): void;
  };
}
