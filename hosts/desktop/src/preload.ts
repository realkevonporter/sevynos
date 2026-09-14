import { clipboard, contextBridge, ipcRenderer } from "electron";
import type { DesktopSettings, PersistedDesktopSessionV1 } from "@sevynos/desktop-shell";

export interface GenesisDesktopHostApi {
  loadDesktopSession(): Promise<unknown>;
  saveDesktopSession(session: PersistedDesktopSessionV1): Promise<void>;
  clearDesktopSession(): Promise<void>;
  onShutdownRequested(listener: () => void): () => void;
  completeShutdown(): Promise<void>;
  loadDesktopSettings(): Promise<unknown>;
  saveDesktopSettings(settings: DesktopSettings): Promise<void>;
  exportDiagnostics(snapshot: unknown): Promise<string | undefined>;
  quitDesktop(): Promise<void>;
  onShellApplicationChanged(
    listener: (applicationId: string, revision: number) => void,
  ): () => void;
  onDevelopmentApplicationChanged(listener: (packageJson: string) => void): () => void;
  loadDevelopmentApplicationPackage(): Promise<string | undefined>;
  loadInstalledApplicationPackages(): Promise<readonly string[]>;
  saveInstalledApplicationPackage(packageJson: string): Promise<void>;
  readClipboardText(): Promise<string>;
  writeClipboardText(text: string): Promise<void>;
}

const api: GenesisDesktopHostApi = Object.freeze<GenesisDesktopHostApi>({
  loadDesktopSession: () =>
    ipcRenderer.invoke("genesis:session:load") as Promise<unknown>,
  saveDesktopSession: (session: PersistedDesktopSessionV1) =>
    ipcRenderer.invoke("genesis:session:save", session) as Promise<void>,
  clearDesktopSession: () => ipcRenderer.invoke("genesis:session:clear") as Promise<void>,
  onShutdownRequested: (listener: () => void) => {
    const handler = (): void => {
      listener();
    };
    ipcRenderer.on("genesis:shutdown-requested", handler);
    return (): void => {
      ipcRenderer.removeListener("genesis:shutdown-requested", handler);
    };
  },
  completeShutdown: () =>
    ipcRenderer.invoke("genesis:shutdown-complete") as Promise<void>,
  loadDesktopSettings: () =>
    ipcRenderer.invoke("genesis:settings:load") as Promise<unknown>,
  saveDesktopSettings: (settings: DesktopSettings) =>
    ipcRenderer.invoke("genesis:settings:save", settings) as Promise<void>,
  exportDiagnostics: (snapshot: unknown) =>
    ipcRenderer.invoke("genesis:diagnostics:export", snapshot) as Promise<
      string | undefined
    >,
  quitDesktop: () => ipcRenderer.invoke("genesis:quit") as Promise<void>,
  onShellApplicationChanged: (listener) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      applicationId: string,
      revision: number,
    ): void => {
      listener(applicationId, revision);
    };
    ipcRenderer.on("genesis:shell-application-changed", handler);
    return (): void => {
      ipcRenderer.removeListener("genesis:shell-application-changed", handler);
    };
  },
  onDevelopmentApplicationChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, packageJson: string): void => {
      listener(packageJson);
    };
    ipcRenderer.on("genesis:development-application-changed", handler);
    return (): void => {
      ipcRenderer.removeListener("genesis:development-application-changed", handler);
    };
  },
  loadDevelopmentApplicationPackage: () =>
    ipcRenderer.invoke("genesis:development-application:load") as Promise<
      string | undefined
    >,
  loadInstalledApplicationPackages: () =>
    ipcRenderer.invoke("genesis:applications:load") as Promise<readonly string[]>,
  saveInstalledApplicationPackage: (packageJson) =>
    ipcRenderer.invoke("genesis:applications:save", packageJson) as Promise<void>,
  readClipboardText: () => Promise.resolve(clipboard.readText()),
  writeClipboardText: (text: string) => {
    clipboard.writeText(text);
    return Promise.resolve();
  },
});

contextBridge.exposeInMainWorld("genesisHost", api);

declare global {
  interface Window {
    readonly genesisHost: GenesisDesktopHostApi;
  }
}
