// SevynOS host components (react-reconciler host config).
// The renderer implements exactly these six; anything else is a bug.
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
      TextInput: any;
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
    // Per-app single-instance flag (false = multi-instance:
    // Files, Terminal, Notes, Browser). Absent on old list lines.
    singleInstance: boolean;
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
    // Drag-and-drop (gap unit 15, audit #18): the renderer
    // subscribes in render(); startFileDrag starts a Wayland DnD
    // drag carrying the given absolute paths, false when there is
    // no compositor drag to start (headless runs).
    onDragDrop(fn: (ev: any) => boolean | void): void;
    startFileDrag(paths: string[]): boolean;
    onKey(fn: (ev: any) => void): void;
    onStatus(fn: (ev: any) => void): void;
    getStatus(): { [key: string]: string };
    // App identity (set by the host; the shell reads "shell" here).
    // Window size in pixels (set by the host from the real surface;
    // for the shell, the output's preferred mode — M9).
    width: number;
    height: number;
    appId: string;
    appName: string;
    appColor: string;
    appGlyph: string;
    hasPermission(name: string): boolean;
    // One-shot run of /usr/local/bin/sevyn only; returns
    // "<exit-code>\n<output>". Gated by the cli.exec permission.
    exec(cmdline: string): string;
    // Same run off the JS thread (M9 wifi scan/connect): a Promise
    // of the same "<exit-code>\n<output>" shape. The shell uses it
    // for the hourly time resync (#134 follow-up) so an NTP round
    // trip never blocks the shell's JS thread.
    execAsync(cmdline: string): Promise<string>;
    // RN audio module (port of PR #129): async audiod calls. Each
    // returns a Promise of ONE JSON line — the daemon's reply, or a
    // synthesized {ok:false, code, error} line. The JS adapter
    // (v2/rn/renderer/sevyn-audio.js) parses the line and rejects
    // with an AudiodError carrying the stable code. Never rejects;
    // a dead daemon is an {ok:false} line, never a hang.
    audioPlay(path: string): Promise<string>;
    audioPause(): Promise<string>;
    audioResume(): Promise<string>;
    audioStop(): Promise<string>;
    audioSeek(seconds: number): Promise<string>;
    audioVolume(volume: number): Promise<string>;
    audioStatus(): Promise<string>;
    audioScan(directory?: string): Promise<string>;
    listApps(): SevynAppInfo[];
    launchApp(appId: string): boolean;
    // Focus a running app (dock click on a running single-instance
    // app): appd raises its window. False when it is not running.
    focusApp(appId: string): boolean;
    onAppEvent(fn: (line: string) => void): void;
    closeApp(): boolean;
    log(msg: string): void;
  };
}
