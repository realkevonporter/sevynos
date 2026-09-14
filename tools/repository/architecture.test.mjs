import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");

test("legacy responsibility buckets do not return", () => {
  for (const directory of [
    "assets",
    "compositor",
    "examples",
    "future",
    "genesis",
    "packages",
    "protocols",
    "qemu",
    "scripts",
  ]) {
    assert.equal(existsSync(resolve(root, directory)), false, directory);
  }
});

test("runtime production code remains independent of extracted subsystems", async () => {
  const sourceFiles = (await collectTypeScript(resolve(root, "runtime/src"))).filter(
    (path) => !path.includes(".test.") && !path.includes("/integration/"),
  );
  const forbidden = /@sevynos\/(?:desktop-shell|graphics|input|react-native(?:-host)?)/;

  for (const path of sourceFiles) {
    assert.doesNotMatch(await readFile(path, "utf8"), forbidden, path);
  }
});

test("Genesis remains independent of shell applications and device classes", async () => {
  const sourceFiles = (await collectTypeScript(resolve(root, "graphics"))).filter(
    (path) => !path.includes(".test.") && !path.includes("/dist/"),
  );
  const shellConcepts =
    /desktop|dock|taskbar|launcher|home screen|status bar|notification center|quick settings|lock screen|tablet|mobile/i;

  for (const path of sourceFiles) {
    assert.doesNotMatch(await readFile(path, "utf8"), shellConcepts, path);
  }
});

test("shell applications depend on shell contracts instead of operating-system internals", async () => {
  const core = await readManifest("shell/core/package.json");
  const applications = await readManifest("applications/shell/package.json");

  assert.equal(core.dependencies, undefined);
  assert.equal(applications.dependencies["@sevynos/shell-core"], "workspace:*");
  assert.equal(applications.dependencies["@sevynos/runtime"], undefined);
  assert.equal(applications.dependencies["@sevynos/graphics"], undefined);
  for (const application of [
    "desktop-home",
    "tablet-home",
    "mobile-home",
    "wallpaper",
    "dock",
    "status-bar",
    "launcher",
    "app-drawer",
    "notifications",
    "quick-settings",
    "lock-screen",
    "split-view",
  ])
    assert.equal(
      existsSync(resolve(root, `applications/shell/${application}/index.ts`)),
      true,
      application,
    );
});

test("mobile shell chrome is composed with React Native components", async () => {
  const mobileShell = await readFile(
    resolve(root, "shell/mobile/src/sevyn-os-shell.tsx"),
    "utf8",
  );
  const mobileExports = await readFile(
    resolve(root, "applications/shell/mobile.ts"),
    "utf8",
  );
  const metroConfig = await readFile(
    resolve(root, "shell/mobile/metro.config.js"),
    "utf8",
  );

  assert.doesNotMatch(mobileShell, /GenesisSceneRenderer|mountOverlay|renderOverlay/);
  for (const component of [
    "MobileLauncherApplication",
    "MobileStatusBarApplication",
    "MobileTaskbarApplication",
    "MobileWallpaperApplication",
  ]) {
    assert.match(mobileShell, new RegExp(`<${component}`));
    assert.match(mobileExports, new RegExp(component));
  }
  assert.match(metroConfig, /resolveRequest/);
  assert.match(metroConfig, /\.endsWith\("\.js"\)/);
});

test("desktop shell chrome and system applications stay on React Native", async () => {
  for (const component of [
    "applications/shell/desktop-home/desktop.tsx",
    "applications/shell/dock/desktop.tsx",
    "applications/shell/status-bar/desktop.tsx",
    "applications/shell/launcher/desktop.tsx",
    "applications/shell/window-switcher/desktop.tsx",
  ]) {
    const source = await readFile(resolve(root, component), "utf8");
    assert.match(source, /from ["']react-native["']/, component);
    assert.doesNotMatch(
      source,
      /document\.|createElement\(["'](?:div|button|input)/,
      component,
    );
  }

  const systemApplications = await readFile(
    resolve(root, "frameworks/react-native/src/system-applications.ts"),
    "utf8",
  );
  for (const application of [
    "WelcomeApplication",
    "InstallerApplication",
    "GenesisConsoleApplication",
    "SystemMonitorApplication",
    "SettingsReactApplication",
    "FilesApplication",
    "BrowserApplication",
    "TextEditorApplication",
    "NotesApplication",
    "ComponentGalleryApplication",
    "AppManagerApplication",
    "ReactNativeIdeApplication",
  ])
    assert.match(systemApplications, new RegExp(`function ${application}`), application);
});

test("desktop development reloads isolated shell bundles", async () => {
  const desktop = await readManifest("hosts/desktop/package.json");
  assert.match(desktop.scripts.dev, /scripts\/dev\.mjs/);
  assert.match(desktop.scripts["build:dev"], /build-system-applications\.mjs/);
  assert.ok(desktop.build.files.includes("dist/system-applications/*.js"));
});

test("Electron and QEMU consume one desktop appearance contract", async () => {
  const appearance = await readFile(
    resolve(root, "shell/desktop/src/desktop-appearance.ts"),
    "utf8",
  );
  const canvas = await readFile(
    resolve(root, "hosts/desktop/src/canvas-genesis-renderer.ts"),
    "utf8",
  );
  const linux = await readFile(
    resolve(root, "hosts/linux/src/software-frame-renderer.ts"),
    "utf8",
  );

  assert.match(appearance, /DARK_DESKTOP_APPEARANCE/);
  assert.match(appearance, /LIGHT_DESKTOP_APPEARANCE/);
  for (const renderer of [canvas, linux]) {
    assert.match(renderer, /resolveDesktopAppearance/);
    assert.match(renderer, /DESKTOP_VISUAL_METRICS/);
    assert.doesNotMatch(renderer, /#151A28|#D8E2F0/);
  }
  assert.match(linux, /desktopBackground/);
  assert.match(linux, /softShadow/);
  assert.doesNotMatch(linux, /\.toUpperCase\(\)/);
});

test("platform hosts share the desktop shell without depending on each other", async () => {
  const linux = JSON.parse(
    await readFile(resolve(root, "hosts/linux/package.json"), "utf8"),
  );
  assert.equal(linux.dependencies["@sevynos/desktop-shell"], "workspace:*");
  assert.equal(linux.dependencies["@sevynos/desktop-host"], undefined);
});

test("runnable entry points build their workspace dependency graph", async () => {
  const root = await readManifest("package.json");
  const desktop = await readManifest("hosts/desktop/package.json");
  const linux = await readManifest("hosts/linux/package.json");
  const demo = await readManifest("tools/demo/package.json");

  assert.match(desktop.scripts.start, /build:workspace/);
  assert.match(desktop.scripts["build:workspace"], /desktop-host\.\.\./);
  assert.match(linux.scripts.start, /build:workspace/);
  assert.match(linux.scripts.wayland, /build:workspace/);
  assert.match(demo.scripts.start, /build:workspace/);
  assert.match(root.scripts["desktop:build"], /build:workspace:prod/);
  assert.match(root.scripts["linux:build"], /build:workspace/);
});

async function readManifest(path) {
  return JSON.parse(await readFile(resolve(root, path), "utf8"));
}

async function collectTypeScript(directory) {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) paths.push(...(await collectTypeScript(path)));
    else if (entry.isFile() && entry.name.endsWith(".ts")) paths.push(path);
  }
  return paths;
}
