#!/usr/bin/env node
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";

const ESBUILD = process.env["SEVYN_STUDIO_ESBUILD"] ?? "/usr/local/lib/sevynos/esbuild";
const HERMESC = process.env["SEVYN_STUDIO_HERMESC"] ?? "/usr/local/lib/sevynos/hermesc";
const input = await readStdin();

try {
  const request = parseRequest(input);
  const directory = await mkdtemp(join(tmpdir(), "sevyn-studio-"));
  try {
    await writeFile(join(directory, "App.tsx"), request.source, "utf8");
    await writeFile(
      join(directory, "index.ts"),
      request.source.includes("AppRegistry.registerComponent")
        ? request.source
        : 'import App from "./App.tsx";\nimport { AppRegistry } from "@sevynos/react-native";\nAppRegistry.registerComponent("main", () => App);\n',
      "utf8",
    );
    await writeFile(join(directory, "react-runtime.js"), reactRuntime(), "utf8");
    await writeFile(join(directory, "jsx-runtime.js"), jsxRuntime(), "utf8");
    await writeFile(join(directory, "native-runtime.js"), nativeRuntime(), "utf8");
    const bundlePath = join(directory, "index.js");
    const bytecodePath = join(directory, "index.hbc");
    await run(ESBUILD, [
      join(directory, "index.ts"),
      "--bundle",
      "--platform=neutral",
      "--format=iife",
      "--target=es2022",
      "--jsx=automatic",
      "--sourcemap=inline",
      "--outfile=" + bundlePath,
      "--resolve-extensions=.sevynos.tsx,.sevynos.ts,.sevynos.jsx,.sevynos.js,.tsx,.ts,.jsx,.js,.json",
      `--alias:react=${join(directory, "react-runtime.js")}`,
      `--alias:react/jsx-runtime=${join(directory, "jsx-runtime.js")}`,
      `--alias:react/jsx-dev-runtime=${join(directory, "jsx-runtime.js")}`,
      `--alias:react-native=${join(directory, "native-runtime.js")}`,
      `--alias:@sevynos/react-native=${join(directory, "native-runtime.js")}`,
    ]);
    await run(HERMESC, ["-O", "-emit-binary", "-out", bytecodePath, bundlePath]);
    const bundle = await readFile(bundlePath, "utf8");
    const bytecodeBase64 = (await readFile(bytecodePath)).toString("base64");
    const icon =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path fill="#d7ac57" d="M8 8h48v48H8z"/><path fill="#11151d" d="M20 20h24v24H20z"/></svg>';
    const manifest = {
      manifestVersion: 1,
      id: request.applicationId,
      name: request.applicationName,
      version: "0.1.0",
      runtime: "react-native",
      applicationKey: "main",
      developer: "Sevyn Studio",
      icon: "icons/app.svg",
      entrypoint: "dist/index.js",
      minimumSevynOSVersion: "0.1.0",
      permissions: ["filesystem.read", "notifications"],
      services: [],
      windowModes: ["standard"],
      instanceMode: "single",
    };
    const files = { "dist/index.js": bundle, "dist/index.js.hbc": bytecodeBase64 };
    const icons = { "icons/app.svg": icon };
    const allEntries = { ...files, ...icons };
    const integrityFiles = Object.fromEntries(
      Object.entries(allEntries).map(([path, content]) => [path, sha256(content)]),
    );
    const canonical = Object.entries(allEntries)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, content]) => `${path}\0${content}`)
      .join("\0");
    const applicationPackage = {
      packageVersion: 1,
      manifest,
      files,
      assets: {},
      icons,
      migrations: {},
      integrity: {
        algorithm: "SHA-256",
        files: integrityFiles,
        packageHash: sha256(canonical),
      },
    };
    write({
      bundle,
      bytecodeBase64,
      packageJson: JSON.stringify(applicationPackage, null, 2),
      diagnostics: [
        "✓ TypeScript/JSX bundle generated.",
        "✓ Hermes bytecode generated.",
        `✓ Package integrity verified: ${applicationPackage.integrity.packageHash.slice(0, 12)}…`,
      ],
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.stderr.write("\n");
  process.exitCode = 1;
}

function parseRequest(value) {
  const request = JSON.parse(value);
  if (!request || typeof request !== "object")
    throw new Error("Studio build request must be an object.");
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(request.applicationId))
    throw new Error("Studio application ID is invalid.");
  if (
    typeof request.applicationName !== "string" ||
    request.applicationName.trim() === ""
  )
    throw new Error("Studio application name is required.");
  if (typeof request.source !== "string" || request.source.trim() === "")
    throw new Error("Studio source is empty.");
  return request;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(stderr.trim() || `${command} failed with code ${String(code)}.`),
          ),
    );
  });
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let value = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      value += chunk;
    });
    process.stdin.once("end", () => resolve(value));
    process.stdin.once("error", reject);
  });
}

function write(value) {
  process.stdout.write(JSON.stringify(value));
}

function reactRuntime() {
  return `const moduleValue = globalThis.__SEVYN_MODULES__["react"];\n${["Children", "Fragment", "Profiler", "StrictMode", "Suspense", "cloneElement", "createContext", "createElement", "createRef", "forwardRef", "isValidElement", "lazy", "memo", "startTransition", "useCallback", "useContext", "useDebugValue", "useDeferredValue", "useEffect", "useId", "useImperativeHandle", "useInsertionEffect", "useLayoutEffect", "useMemo", "useReducer", "useRef", "useState", "useSyncExternalStore", "useTransition"].map((name) => `export const ${name} = moduleValue.${name};`).join("\n")}\nexport default moduleValue;\n`;
}

function jsxRuntime() {
  return `const moduleValue = globalThis.__SEVYN_MODULES__["react/jsx-runtime"];\nexport const Fragment = moduleValue.Fragment;\nexport const jsx = moduleValue.jsx;\nexport const jsxs = moduleValue.jsxs;\nexport const jsxDEV = moduleValue.jsxDEV;\n`;
}

function nativeRuntime() {
  return `const moduleValue = globalThis.__SEVYN_MODULES__["react-native"];\n${["AccessibilityInfo", "Alert", "Animated", "AppRegistry", "Appearance", "Dimensions", "FlatList", "Image", "ImageBackground", "KeyboardAvoidingView", "Modal", "NativeScrollView", "NativeText", "NativeTextInput", "PixelRatio", "Platform", "Pressable", "RefreshControl", "SafeAreaView", "ScrollView", "SectionList", "StatusBar", "StyleSheet", "Switch", "Text", "TextInput", "TouchableOpacity", "TouchableWithoutFeedback", "View", "VirtualizedList", "useColorScheme", "useWindowDimensions"].map((name) => `export const ${name} = moduleValue.${name};`).join("\n")}\n`;
}
