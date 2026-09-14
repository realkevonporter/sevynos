import { getDefaultConfig, type MetroConfig } from "metro-config";
import { existsSync, readFileSync, statSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function tryFile(candidate: string): string | undefined {
  if (existsSync(candidate)) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // ignore
    }
  }
  return undefined;
}

function resolveWithExtensions(
  basePath: string,
  platform?: string | null,
): string | undefined {
  const direct = tryFile(basePath);
  if (direct) return direct;

  const bases = basePath.endsWith(".js") ? [basePath, basePath.slice(0, -3)] : [basePath];
  const exts = [
    ...(platform
      ? [`.${platform}.tsx`, `.${platform}.ts`, `.${platform}.jsx`, `.${platform}.js`]
      : []),
    ".native.tsx",
    ".native.ts",
    ".native.jsx",
    ".native.js",
    ".ios.tsx",
    ".ios.ts",
    ".ios.jsx",
    ".ios.js",
    ".android.tsx",
    ".android.ts",
    ".android.jsx",
    ".android.js",
    ".tsx",
    ".ts",
    ".jsx",
    ".js",
    ".json",
  ];

  for (const base of bases) {
    for (const ext of exts) {
      const file = tryFile(`${base}${ext}`);
      if (file) return file;
    }
    for (const ext of exts) {
      const file = tryFile(resolve(base, `index${ext}`));
      if (file) return file;
    }
  }

  return undefined;
}

export interface SevynMetroOptions {
  readonly port?: number;
  readonly platforms?: readonly string[];
}

const NODE_CORE_MODULES = new Set([
  "http",
  "https",
  "http2",
  "net",
  "tls",
  "fs",
  "dgram",
  "child_process",
  "cluster",
  "dns",
  "readline",
  "vm",
]);

const EXPO_COMPAT_MODULES = new Set([
  "expo-constants",
  "expo-device",
  "expo-secure-store",
  "expo-clipboard",
  "expo-haptics",
  "expo-linking",
  "expo-location",
  "expo-notifications",
  "expo-font",
  "expo-asset",
  "expo-status-bar",
  "expo-splash-screen",
  "expo-linear-gradient",
  "expo-blur",
  "expo-image",
  "expo-crypto",
  "expo-system-ui",
  "expo-web-browser",
]);

const COMMUNITY_COMPAT_MODULES = new Set([
  "@react-native-community/netinfo",
  "react-native-screens",
  "react-native-gesture-handler",
  "react-native-reanimated",
  "react-native-svg",
  "@livekit/react-native",
]);

export async function getSevynMetroConfig(
  projectRoot: string,
  options: SevynMetroOptions = {},
): Promise<MetroConfig> {
  const base = await getDefaultConfig(projectRoot);
  const platforms = options.platforms ?? ["sevynos", "ios", "android", "native"];
  const metroDir = dirname(fileURLToPath(import.meta.url));
  const sevynReactNativeRoot = await realpath(
    resolve(metroDir, "../node_modules/@sevynos/react-native"),
  );
  const rawVectorIconsRoot = resolve(metroDir, "../node_modules/@expo/vector-icons");
  const sevynVectorIconsRoot = existsSync(rawVectorIconsRoot)
    ? await realpath(rawVectorIconsRoot)
    : resolve(sevynReactNativeRoot, "../vector-icons");

  const metroNodeModules = resolve(metroDir, "../node_modules");
  const babelRuntimeRoot = await realpath(resolve(metroNodeModules, "@babel/runtime"));
  const metroRuntimeRoot = await realpath(resolve(metroNodeModules, "metro-runtime"));
  const pnpmVirtualStore = resolve(metroNodeModules, "../../../node_modules/.pnpm");
  const expoTransformer = resolve(
    projectRoot,
    "node_modules/@expo/metro-config/build/babel-transformer.js",
  );

  let tsconfigPaths: Record<string, string[]> = {};
  const tsconfigPath = resolve(projectRoot, "tsconfig.json");
  if (existsSync(tsconfigPath)) {
    try {
      const parsed = JSON.parse(readFileSync(tsconfigPath, "utf-8"));
      tsconfigPaths = (parsed?.compilerOptions?.paths as Record<string, string[]>) ?? {};
    } catch {
      // ignore
    }
  }

  return {
    ...base,
    projectRoot,
    transformer: {
      ...base.transformer,
      unstable_allowRequireContext: true,
      assetRegistryPath: resolve(sevynReactNativeRoot, "src/asset-registry.ts"),
      ...(existsSync(expoTransformer) ? { babelTransformerPath: expoTransformer } : {}),
    },
    watchFolders: Object.freeze([
      projectRoot,
      sevynReactNativeRoot,
      sevynVectorIconsRoot,
      babelRuntimeRoot,
      metroRuntimeRoot,
      ...(existsSync(pnpmVirtualStore) ? [pnpmVirtualStore] : []),
      ...(base.watchFolders ?? []).filter((folder) => folder !== projectRoot),
    ]),
    server: {
      ...base.server,
      port: options.port ?? 8081,
    },
    resolver: {
      ...base.resolver,
      resolveRequest: (context, moduleName, platform) => {
        if (
          moduleName === "missing-asset-registry-path" ||
          moduleName === "react-native/Libraries/Image/AssetRegistry" ||
          moduleName === "@react-native/assets-registry/registry"
        ) {
          return {
            type: "sourceFile",
            filePath: resolve(sevynReactNativeRoot, "src/asset-registry.ts"),
          };
        }

        // 1. Check tsconfig path aliases (e.g. @/* -> ./*)
        if (moduleName.startsWith("@/")) {
          const resolved = resolveWithExtensions(
            resolve(projectRoot, moduleName.slice(2)),
            platform,
          );
          if (resolved) return { type: "sourceFile", filePath: resolved };
        }
        for (const [pattern, targets] of Object.entries(tsconfigPaths)) {
          if (pattern.endsWith("/*")) {
            const prefix = pattern.slice(0, -1);
            if (moduleName.startsWith(prefix)) {
              const rest = moduleName.slice(prefix.length);
              for (const target of targets) {
                const cleanTarget = target.replace(/\*$/, rest);
                const resolved = resolveWithExtensions(
                  resolve(projectRoot, cleanTarget),
                  platform,
                );
                if (resolved) return { type: "sourceFile", filePath: resolved };
              }
            }
          } else if (pattern === moduleName) {
            for (const target of targets) {
              const resolved = resolveWithExtensions(
                resolve(projectRoot, target),
                platform,
              );
              if (resolved) return { type: "sourceFile", filePath: resolved };
            }
          }
        }

        // 2. Relative imports
        if (moduleName.startsWith("./") || moduleName.startsWith("../")) {
          const callerDir = dirname(context.originModulePath);
          const rawPath = resolve(callerDir, moduleName);
          if (!existsSync(rawPath)) {
            const resolved = resolveWithExtensions(rawPath, platform);
            if (resolved) return { type: "sourceFile", filePath: resolved };
          }
        }

        if (NODE_CORE_MODULES.has(moduleName)) {
          return {
            type: "sourceFile",
            filePath: resolve(sevynReactNativeRoot, "src/empty-module.ts"),
          };
        }

        if (
          moduleName === "react" ||
          moduleName === "react/index" ||
          moduleName === "react/index.js"
        ) {
          return {
            type: "sourceFile",
            filePath: resolve(sevynReactNativeRoot, "src/react-shim.ts"),
          };
        }

        if (
          moduleName === "react/jsx-runtime" ||
          moduleName === "react/jsx-runtime.js" ||
          moduleName === "react/jsx-dev-runtime" ||
          moduleName === "react/jsx-dev-runtime.js"
        ) {
          return {
            type: "sourceFile",
            filePath: resolve(sevynReactNativeRoot, "src/react-jsx-shim.ts"),
          };
        }

        if (
          moduleName === "react-native" ||
          moduleName === "react-native/index" ||
          moduleName === "react-native/index.js"
        ) {
          return {
            type: "sourceFile",
            filePath: resolve(sevynReactNativeRoot, "src/index.ts"),
          };
        }

        if (moduleName.startsWith("react-native/")) {
          if (
            moduleName === "react-native/Libraries/Utilities/codegenNativeComponent" ||
            moduleName === "react-native/Libraries/Utilities/codegenNativeCommands"
          ) {
            return {
              type: "sourceFile",
              filePath:
                moduleName === "react-native/Libraries/Utilities/codegenNativeCommands"
                  ? resolve(sevynReactNativeRoot, "src/codegen-native-commands.ts")
                  : resolve(sevynReactNativeRoot, "src/fabric.ts"),
            };
          }
          if (
            moduleName === "react-native/Libraries/Image/AssetRegistry" ||
            moduleName === "react-native/Libraries/Image/assetLoader"
          ) {
            return {
              type: "sourceFile",
              filePath: resolve(sevynReactNativeRoot, "src/asset-registry.ts"),
            };
          }
          if (
            moduleName === "react-native/Libraries/vendor/emitter/EventEmitter" ||
            moduleName.endsWith("/EventEmitter")
          ) {
            return {
              type: "sourceFile",
              filePath: resolve(sevynReactNativeRoot, "src/event-emitter-shim.ts"),
            };
          }
          return {
            type: "sourceFile",
            filePath: resolve(sevynReactNativeRoot, "src/index.ts"),
          };
        }

        if (moduleName === "react-native-safe-area-context")
          return {
            type: "sourceFile",
            filePath: resolve(sevynReactNativeRoot, "src/safe-area-context.ts"),
          };
        if (moduleName === "react-native-webview")
          return {
            type: "sourceFile",
            filePath: resolve(sevynReactNativeRoot, "src/webview.ts"),
          };
        if (
          moduleName === "expo-modules-core" ||
          moduleName.startsWith("expo-modules-core/")
        )
          return {
            type: "sourceFile",
            filePath: resolve(sevynReactNativeRoot, "src/expo-modules-core.ts"),
          };

        if (
          moduleName === "@expo/vector-icons" ||
          moduleName.startsWith("@expo/vector-icons/")
        ) {
          const sub = moduleName
            .replace("@expo/vector-icons/", "")
            .replace(/^build\//, "");
          if (sub && sub !== "@expo/vector-icons") {
            const specific = resolve(sevynVectorIconsRoot, `src/${sub}.ts`);
            if (existsSync(specific)) return { type: "sourceFile", filePath: specific };
          }
          return {
            type: "sourceFile",
            filePath: resolve(sevynVectorIconsRoot, "src/index.ts"),
          };
        }

        const baseModuleName = moduleName.startsWith("@")
          ? moduleName.split("/").slice(0, 2).join("/")
          : (moduleName.split("/")[0] ?? "");

        if (
          EXPO_COMPAT_MODULES.has(moduleName) ||
          EXPO_COMPAT_MODULES.has(baseModuleName)
        ) {
          return {
            type: "sourceFile",
            filePath: resolve(sevynReactNativeRoot, "src/expo-compat.ts"),
          };
        }

        if (
          COMMUNITY_COMPAT_MODULES.has(moduleName) ||
          COMMUNITY_COMPAT_MODULES.has(moduleName.split("/")[0] ?? "") ||
          (moduleName.startsWith("@react-native-community/") &&
            moduleName.includes("netinfo")) ||
          (moduleName.startsWith("@livekit/") && moduleName.includes("react-native"))
        ) {
          return {
            type: "sourceFile",
            filePath: resolve(sevynReactNativeRoot, "src/community-compat.ts"),
          };
        }

        if (moduleName === "react-native/Libraries/Utilities/codegenNativeComponent") {
          return {
            type: "sourceFile",
            filePath: resolve(sevynReactNativeRoot, "src/fabric.ts"),
          };
        }

        const runtimePrefix = "@babel/runtime/";
        if (moduleName.startsWith(runtimePrefix)) {
          const filePath = resolve(
            babelRuntimeRoot,
            `${moduleName.slice(runtimePrefix.length)}.js`,
          );
          if (existsSync(filePath)) return { type: "sourceFile", filePath };
        }
        const metroRuntimePrefix = "metro-runtime/";
        if (moduleName.startsWith(metroRuntimePrefix)) {
          const filePath = resolve(
            metroRuntimeRoot,
            `${moduleName.slice(metroRuntimePrefix.length)}.js`,
          );
          if (existsSync(filePath)) return { type: "sourceFile", filePath };
        }
        return context.resolveRequest(context, moduleName, platform);
      },
      platforms,
      resolverMainFields: [
        "react-native",
        "browser",
        "main",
        ...(base.resolver?.resolverMainFields ?? []),
      ],
      nodeModulesPaths: [
        resolve(projectRoot, "node_modules"),
        metroNodeModules,
        ...(base.resolver?.nodeModulesPaths ?? []),
      ],
      sourceExts: [
        ...(base.resolver?.sourceExts ?? ["js", "jsx", "ts", "tsx", "json"]),
        "mjs",
        "cjs",
      ],
      extraNodeModules: {
        ...(base.resolver?.extraNodeModules ?? {}),
        // Metro expects absolute package roots here. A package name string is
        // interpreted as a path and breaks projects outside this monorepo.
        react: sevynReactNativeRoot,
        "react/jsx-runtime": sevynReactNativeRoot,
        "react/jsx-dev-runtime": sevynReactNativeRoot,
        "react-native": sevynReactNativeRoot,
        "expo-modules-core": sevynReactNativeRoot,
        "@expo/vector-icons": sevynVectorIconsRoot,
        "@babel/runtime": babelRuntimeRoot,
      },
    },
  };
}
