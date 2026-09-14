import { app, BrowserWindow, dialog, ipcMain, Menu } from "electron";
import { watch, type FSWatcher } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateDesktopSession, validateDesktopSettings } from "@sevynos/desktop-shell";

const CURRENT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
app.setName("SevynOS Genesis");

let mainWindow: BrowserWindow | undefined;
let shutdownAllowed = false;
let shellApplicationWatcher: FSWatcher | undefined;
let shellApplicationRevision = 0;
let developmentApplicationWatcher: FSWatcher | undefined;

function sessionPath(): string {
  return join(app.getPath("userData"), "genesis-desktop-session.json");
}
function settingsPath(): string {
  return join(app.getPath("userData"), "genesis-desktop-settings.json");
}
function applicationsPath(): string {
  return join(app.getPath("userData"), "applications");
}
async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}
async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), "utf8");
  await rename(temporary, path);
}
ipcMain.handle("genesis:settings:load", () => readJson(settingsPath()));
ipcMain.handle(
  "genesis:development-application:load",
  async (): Promise<string | undefined> => {
    const packagePath = process.env["SEVYN_DEV_APPLICATION_PACKAGE"];
    if (app.isPackaged || packagePath === undefined) return undefined;
    return readFile(packagePath, "utf8");
  },
);
ipcMain.handle("genesis:applications:load", async (): Promise<readonly string[]> => {
  try {
    const directory = applicationsPath();
    const entries = await readdir(directory, { withFileTypes: true });
    return await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".sevynapp"))
        .map((entry) => readFile(join(directory, entry.name), "utf8")),
    );
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return [];
    throw error;
  }
});
ipcMain.handle(
  "genesis:applications:save",
  async (_event, packageJson: string): Promise<void> => {
    if (typeof packageJson !== "string" || packageJson.length > 32 * 1024 * 1024)
      throw new TypeError("Application package is invalid or too large.");
    const value: unknown = JSON.parse(packageJson);
    if (
      typeof value !== "object" ||
      value === null ||
      !("manifest" in value) ||
      typeof value.manifest !== "object" ||
      value.manifest === null ||
      !("id" in value.manifest) ||
      typeof value.manifest.id !== "string" ||
      !/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(value.manifest.id)
    )
      throw new TypeError("Application package identity is invalid.");
    await writeJson(
      join(applicationsPath(), `${encodeURIComponent(value.manifest.id)}.sevynapp`),
      value,
    );
  },
);
ipcMain.handle("genesis:settings:save", (_event, value: unknown) =>
  writeJson(settingsPath(), validateDesktopSettings(value)),
);
ipcMain.handle(
  "genesis:diagnostics:export",
  async (_event, snapshot: unknown): Promise<string | undefined> => {
    const result = await dialog.showSaveDialog({
      title: "Export Genesis Diagnostics",
      defaultPath: "genesis-diagnostics.json",
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (result.canceled) return undefined;
    await writeJson(result.filePath, snapshot);
    return result.filePath;
  },
);

ipcMain.handle("genesis:session:load", async (): Promise<unknown> => {
  try {
    return JSON.parse(await readFile(sessionPath(), "utf8")) as unknown;
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return undefined;
    console.warn("Unable to load Genesis desktop session.", error);
    return undefined;
  }
});
ipcMain.handle(
  "genesis:session:save",
  async (_event, session: unknown): Promise<void> => {
    const validated = validateDesktopSession(session);
    if (validated === undefined) {
      throw new TypeError("Refusing to save an invalid Genesis desktop session.");
    }
    const destination = sessionPath();
    const temporary = `${destination}.tmp`;
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(temporary, JSON.stringify(validated), "utf8");
    await rename(temporary, destination);
  },
);
ipcMain.handle("genesis:session:clear", async (): Promise<void> => {
  await rm(sessionPath(), { force: true });
});
ipcMain.handle("genesis:shutdown-complete", (): void => {
  shutdownAllowed = true;
  mainWindow?.destroy();
  app.quit();
});

function createDesktopWindow(): BrowserWindow {
  const production = app.isPackaged;
  const window = new BrowserWindow({
    width: 1440,

    height: 900,

    minWidth: 960,

    minHeight: 640,

    show: false,

    backgroundColor: "#0b1020",

    title: "SevynOS Genesis",

    webPreferences: {
      preload: join(CURRENT_DIRECTORY, "preload.cjs"),

      nodeIntegration: false,

      contextIsolation: true,

      sandbox: true,
      devTools: !production,
      webSecurity: true,
    },
  });
  window.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    console.log(`[Renderer log level ${level}] ${message} (${sourceId}:${line})`);
  });
  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    console.error(`[Renderer load failed] ${errorCode}: ${errorDescription} (${validatedURL})`);
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    console.error("[Renderer process gone]", details);
  });

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    const allowed = pathToFileURL(join(CURRENT_DIRECTORY, "index.html")).href;
    if (url !== allowed) event.preventDefault();
  });

  void window
    .loadFile(join(CURRENT_DIRECTORY, "index.html"))
    .then(() => {
      window.center();
      window.show();
      window.focus();
    })
    .catch((error: unknown) => {
      console.error("Unable to load the SevynOS desktop renderer.", error);
    });

  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = undefined;
    }
  });

  window.on("close", (event) => {
    if (shutdownAllowed) return;
    event.preventDefault();
    window.webContents.send("genesis:shutdown-requested");
  });

  return window;
}

function watchShellApplications(): void {
  if (app.isPackaged || shellApplicationWatcher !== undefined) return;
  const directory = join(CURRENT_DIRECTORY, "system-applications");
  shellApplicationWatcher = watch(directory, (_event, filename) => {
    if (filename?.endsWith(".js") !== true) return;
    shellApplicationRevision += 1;
    mainWindow?.webContents.send(
      "genesis:shell-application-changed",
      filename.slice(0, -3),
      shellApplicationRevision,
    );
  });
  shellApplicationWatcher.on("error", (error) => {
    console.warn("Shell application watcher stopped.", error);
    shellApplicationWatcher?.close();
    shellApplicationWatcher = undefined;
  });
}

function watchDevelopmentApplication(): void {
  const packagePath = process.env["SEVYN_DEV_APPLICATION_PACKAGE"];
  if (app.isPackaged || packagePath === undefined) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const publish = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      void readFile(packagePath, "utf8")
        .then((packageJson) => {
          mainWindow?.webContents.send(
            "genesis:development-application-changed",
            packageJson,
          );
        })
        .catch((error: unknown) => {
          console.warn("Development application package could not be read.", error);
        });
    }, 75);
  };
  developmentApplicationWatcher = watch(packagePath, publish);
  developmentApplicationWatcher.on("error", (error) => {
    console.warn("Development application watcher stopped.", error);
    developmentApplicationWatcher?.close();
    developmentApplicationWatcher = undefined;
  });
  publish();
}

void app.whenReady().then(() => {
  if (app.isPackaged) Menu.setApplicationMenu(null);
  mainWindow = createDesktopWindow();
  watchShellApplications();
  watchDevelopmentApplication();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createDesktopWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", (event) => {
  if (shutdownAllowed || mainWindow === undefined) return;
  event.preventDefault();
  mainWindow.webContents.send("genesis:shutdown-requested");
});

app.on("will-quit", () => {
  shellApplicationWatcher?.close();
  shellApplicationWatcher = undefined;
  developmentApplicationWatcher?.close();
  developmentApplicationWatcher = undefined;
});

ipcMain.handle("genesis:quit", (): void => {
  mainWindow?.webContents.send("genesis:shutdown-requested");
});
