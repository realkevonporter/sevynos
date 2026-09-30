import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { build, type Plugin } from "esbuild";
import {
  buildSevynApplicationPackage,
  validateSevynApplicationManifest,
  verifyPackageIntegrity,
  type SevynApplicationPackage,
} from "@sevynos/react-native";
import {
  ApplicationInstaller,
  createSevynBundle,
  ApplicationPackageRegistry,
  type InstalledApplicationRecord,
  type ApplicationManifest,
} from "@sevynos/runtime";

export const starterManifest = (id: string, name: string) => ({
  manifestVersion: 1,
  id,
  name,
  version: "0.1.0",
  runtime: "react-native",
  applicationKey: "main",
  developer: "SevynOS Developer",
  icon: "icons/app.svg",
  entrypoint: "dist/index.js",
  minimumSevynOSVersion: "0.1.0",
  permissions: ["filesystem.read", "notifications"],
  services: [],
  windowModes: ["standard"],
  instanceMode: "single",
});

export async function createApplication(
  directory: string,
  id: string,
  name: string,
): Promise<void> {
  await mkdir(join(directory, "src"), { recursive: true });
  await mkdir(join(directory, "sevynos"), { recursive: true });
  await mkdir(join(directory, "icons"), { recursive: true });
  await writeFile(
    join(directory, "sevyn.manifest.json"),
    JSON.stringify(starterManifest(id, name), null, 2),
  );
  await writeFile(
    join(directory, "src/index.ts"),
    'import { AppRegistry } from "react-native";\nimport { Application } from "./Application";\n\nAppRegistry.registerComponent("main", () => Application);\n',
  );
  await writeFile(
    join(directory, "src/Application.tsx"),
    'import { Pressable, Text, View, Platform } from "react-native";\n\nexport function Application() {\n  return (\n    <View accessibilityRole="application">\n      <Text>Running on {Platform.OS}</Text>\n      <Pressable onPress={() => console.log("Pressed on SevynOS")}>\n        <Text>Test input</Text>\n      </Pressable>\n    </View>\n  );\n}\n',
  );
  await writeFile(
    join(directory, "app.json"),
    JSON.stringify({ name: id, displayName: name }, null, 2),
  );
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify(
      {
        name: id,
        version: "0.1.0",
        private: true,
        main: "src/index.ts",
        dependencies: {
          "@babel/runtime": "^7.28.0",
          "@sevynos/react-native": "^1.0.0",
          react: "^19.2.0",
        },
        devDependencies: { "@react-native/babel-preset": "0.85.3" },
      },
      null,
      2,
    ),
  );
  await writeFile(
    join(directory, "babel.config.cjs"),
    'module.exports = { presets: [require.resolve("@react-native/babel-preset")] };\n',
  );
  await writeFile(
    join(directory, "icons/app.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path fill="#d7ac57" d="M12 12h40v40H12z"/></svg>',
  );
}

export async function readManifest(
  project: string,
): Promise<ReturnType<typeof validateSevynApplicationManifest>> {
  const input: unknown = JSON.parse(
    await readFile(join(project, "sevyn.manifest.json"), "utf8"),
  );
  return validateSevynApplicationManifest(input);
}

export async function validateProject(project: string): Promise<void> {
  await readManifest(project);
}

export async function packageProject(project: string): Promise<SevynApplicationPackage> {
  const manifest = await readManifest(project);
  const source = await readFile(join(project, "dist/index.js"), "utf8");
  const bytecode = await readFile(join(project, "dist/index.hbc"), "base64");
  const icon = await readFile(join(project, manifest.icon), "utf8");
  const applicationPackage = await buildSevynApplicationPackage({
    manifest,
    files: {
      [manifest.entrypoint]: source,
      [`${manifest.entrypoint}.hbc`]: bytecode,
    },
    icons: { [manifest.icon]: icon },
  });
  await verifyPackageIntegrity(applicationPackage);
  return applicationPackage;
}

export async function writePackage(
  project: string,
  output = join(project, "dist/application.sevynapp"),
): Promise<string> {
  const applicationPackage = await packageProject(project);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(applicationPackage, null, 2));
  return output;
}

export async function packSevynBundle(
  project: string,
  output = join(project, "dist/application.sevyn"),
): Promise<string> {
  const manifest = await readManifest(project);
  let bytecode: Uint8Array;
  try {
    bytecode = await readFile(join(project, "dist/index.hbc"));
  } catch {
    bytecode = await readFile(join(project, "dist/index.js"));
  }

  let iconData = "";
  try {
    iconData = await readFile(join(project, manifest.icon), "utf8");
  } catch {
    iconData = "<svg></svg>";
  }

  const runtimeManifest: ApplicationManifest = {
    manifestVersion: 2,
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    hostId: "sevyn.host.javascript",
    entrypoint: "dist/index.js",
    permissions: manifest.permissions,
    system: false,
  };

  const bundle = createSevynBundle({
    manifest: runtimeManifest,
    bytecode,
    assets: {
      [manifest.icon]: iconData,
    },
    extraFiles: {
      "dist/index.js": await readFile(join(project, "dist/index.js")),
    },
  });

  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, bundle);
  return output;
}

export function createCliInstaller(
  options: {
    appsDir?: string | undefined;
    pristineDir?: string | undefined;
  } = {},
): ApplicationInstaller {
  const packages = new ApplicationPackageRegistry();
  return new ApplicationInstaller({
    packages,
    appsDirectory: options.appsDir,
    pristineDirectory: options.pristineDir,
  });
}

export async function installApp(
  bundleOrId: string,
  options: { appsDir?: string | undefined; pristineDir?: string | undefined } = {},
): Promise<InstalledApplicationRecord> {
  const installer = createCliInstaller(options);
  await installer.init();

  let isFilePath = false;
  try {
    const fileStat = await stat(bundleOrId);
    if (fileStat.isFile()) {
      isFilePath = true;
    }
  } catch {
    isFilePath = false;
  }

  if (isFilePath || bundleOrId.endsWith(".sevyn") || bundleOrId.endsWith(".sevynapp")) {
    return installer.install(bundleOrId);
  }

  return installer.installFromPristine(bundleOrId);
}

export async function uninstallApp(
  appId: string,
  options: { appsDir?: string | undefined; pristineDir?: string | undefined } = {},
): Promise<void> {
  const installer = createCliInstaller(options);
  await installer.init();
  await installer.uninstall(appId);
}

export async function listApps(
  options: { appsDir?: string | undefined; pristineDir?: string | undefined } = {},
): Promise<readonly InstalledApplicationRecord[]> {
  const installer = createCliInstaller(options);
  await installer.init();
  return installer.listInstalled();
}

export async function buildProject(project: string): Promise<void> {
  await mkdir(join(project, "dist"), { recursive: true });
  await build({
    entryPoints: [join(project, "src/index.ts")],
    outfile: join(project, "dist/index.js"),
    bundle: true,
    platform: "neutral",
    format: "iife",
    target: "es2022",
    jsx: "automatic",
    resolveExtensions: [
      ".sevynos.tsx",
      ".sevynos.ts",
      ".sevynos.jsx",
      ".sevynos.js",
      ".tsx",
      ".ts",
      ".jsx",
      ".js",
      ".json",
    ],
    loader: {
      ".png": "dataurl",
      ".jpg": "dataurl",
      ".jpeg": "dataurl",
      ".gif": "dataurl",
      ".webp": "dataurl",
      ".svg": "dataurl",
      ".ttf": "file",
      ".otf": "file",
      ".woff": "file",
      ".woff2": "file",
    },
    plugins: [sevynRuntimeModules()],
    sourcemap: "inline",
    sourcesContent: true,
    logLevel: "silent",
  });
  await compileHermesBytecode(
    join(project, "dist/index.js"),
    join(project, "dist/index.hbc"),
  );
}

const executeFile = promisify(execFile);
const require = createRequire(import.meta.url);

export async function compileHermesBytecode(
  input: string,
  output: string,
): Promise<void> {
  if (process.platform !== "darwin" && process.platform !== "linux")
    throw new Error(`Hermes bytecode compilation is unavailable on ${process.platform}.`);
  const compilerRoot = dirname(require.resolve("hermes-compiler/package.json"));
  const compiler = join(
    compilerRoot,
    "hermesc",
    process.platform === "darwin" ? "osx-bin" : "linux64-bin",
    "hermesc",
  );
  await executeFile(compiler, [
    "-O",
    "-emit-binary",
    "-output-source-map",
    "-out",
    output,
    input,
  ]);
}

function sevynRuntimeModules(): Plugin {
  const reactExports = [
    "Activity",
    "Children",
    "Component",
    "Fragment",
    "Profiler",
    "PureComponent",
    "StrictMode",
    "Suspense",
    "cloneElement",
    "createContext",
    "createElement",
    "createRef",
    "forwardRef",
    "isValidElement",
    "lazy",
    "memo",
    "startTransition",
    "useCallback",
    "useContext",
    "useDebugValue",
    "useDeferredValue",
    "useEffect",
    "useId",
    "useImperativeHandle",
    "useInsertionEffect",
    "useLayoutEffect",
    "useMemo",
    "useReducer",
    "useRef",
    "useState",
    "useSyncExternalStore",
    "useTransition",
  ];
  const nativeExports = [
    "AFTER_FIRST_UNLOCK",
    "AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY",
    "ALWAYS",
    "ALWAYS_THIS_DEVICE_ONLY",
    "AccessibilityInfo",
    "ActionSheetIOS",
    "ActivityIndicator",
    "Alert",
    "Animated",
    "AnimatedInterpolation",
    "AnimatedValue",
    "AnimatedValueXY",
    "AntDesign",
    "AppRegistry",
    "AppState",
    "Appearance",
    "ApplicationHotReloadController",
    "ApplicationInstaller",
    "ApplicationResourceGovernor",
    "ApplicationStorageQuotaError",
    "Asset",
    "AudioSession",
    "BackHandler",
    "BlurView",
    "Button",
    "Circle",
    "ClipPath",
    "Clipboard",
    "CommunityNetInfo",
    "ConditionallyIgnoredEventHandlers",
    "Constants",
    "Crypto",
    "CryptoDigestAlgorithm",
    "Defs",
    "DevMenu",
    "DevSettings",
    "Device",
    "DeviceEventEmitter",
    "DeviceInfo",
    "DeviceType",
    "Dimensions",
    "Directions",
    "DrawerLayoutAndroid",
    "DynamicColorIOS",
    "Easing",
    "Entypo",
    "ErrorUtils",
    "EventEmitter",
    "EventEmitterModule",
    "EvilIcons",
    "ExpoClipboard",
    "ExpoEventEmitter",
    "ExpoImage",
    "ExpoLinking",
    "ExpoStatusBar",
    "Extrapolate",
    "Extrapolation",
    "FadeIn",
    "FadeInLeft",
    "FadeInRight",
    "FadeOut",
    "FadeOutLeft",
    "FadeOutRight",
    "Feather",
    "FlatList",
    "FlingGestureHandler",
    "Font",
    "FontAwesome",
    "FontAwesome5",
    "FontAwesome6",
    "Fontisto",
    "Foundation",
    "FullWindowOverlay",
    "G",
    "Gesture",
    "GestureDetector",
    "GestureHandlerRootView",
    "Haptics",
    "I18nManager",
    "Image",
    "ImageBackground",
    "ImpactFeedbackStyle",
    "InMemoryApplicationPermissionStore",
    "InMemoryFileSystem",
    "InnerScreen",
    "InputAccessoryView",
    "InteractionManager",
    "Ionicons",
    "Keyboard",
    "KeyboardAvoidingView",
    "Layout",
    "LayoutAnimation",
    "LegacyEventEmitter",
    "Line",
    "LinearGradient",
    "Linking",
    "Location",
    "LocationAccuracy",
    "LogBox",
    "LongPressGestureHandler",
    "Mask",
    "MaterialCommunityIcons",
    "MaterialIcons",
    "Modal",
    "Module",
    "NamespacedApplicationStorage",
    "NativeAppEventEmitter",
    "NativeComponentRegistry",
    "NativeDialogManagerAndroid",
    "NativeEventEmitter",
    "NativeIcon",
    "NativeImage",
    "NativeModule",
    "NativeModuleUnavailableError",
    "NativeModules",
    "NativeModulesProxy",
    "NativeModulesProxyVersion",
    "NativeOverlay",
    "NativeScreen",
    "NativeScreenContainer",
    "NativeScreenNavigationContainer",
    "NativeScrollView",
    "NativeSegmentedControl",
    "NativeSelect",
    "NativeSlider",
    "NativeText",
    "NativeTextInput",
    "NativeToggle",
    "NativeViewGestureHandler",
    "NetInfo",
    "NetInfoStateType",
    "Networking",
    "NotificationFeedbackType",
    "Notifications",
    "Octicons",
    "PanGestureHandler",
    "PanResponder",
    "Path",
    "Pattern",
    "PermissionStatus",
    "PermissionsAndroid",
    "PinchGestureHandler",
    "PixelRatio",
    "Platform",
    "PlatformColor",
    "Polygon",
    "Polyline",
    "Pressable",
    "ProgressBarAndroid",
    "PushNotificationIOS",
    "ReactNativeVersion",
    "Reanimated",
    "Rect",
    "ReduceMotion",
    "RefreshControl",
    "RootTagContext",
    "RotationGestureHandler",
    "SEVYN_APPLICATION_API_MAJOR",
    "SEVYN_APPLICATION_API_VERSION",
    "SEVYN_MANIFEST_VERSION",
    "SEVYN_PACKAGE_VERSION",
    "SafeAreaView",
    "Screen",
    "ScreenContainer",
    "ScreenContentWrapper",
    "ScreenFooter",
    "ScreenStack",
    "ScreenStackHeaderBackButtonImage",
    "ScreenStackHeaderCenterView",
    "ScreenStackHeaderConfig",
    "ScreenStackHeaderLeftView",
    "ScreenStackHeaderRightView",
    "ScreenStackHeaderSearchBarView",
    "ScreenStackHeaderSubview",
    "ScreenStackItem",
    "ScrollView",
    "SearchBar",
    "SectionList",
    "SecureStore",
    "Settings",
    "SevynApplicationSdkProvider",
    "SevynErrorBoundary",
    "SevynManifestError",
    "SevynNativeModules",
    "SevynOS",
    "SevynSystemProvider",
    "SevynWebSocket",
    "Share",
    "SharedObject",
    "SharedRef",
    "SimpleLineIcons",
    "SlideInUp",
    "SlideOutDown",
    "SplashScreen",
    "State",
    "StatusBar",
    "StatusBarComponent",
    "Stop",
    "StyleSheet",
    "Svg",
    "SvgLinearGradient",
    "SvgRadialGradient",
    "SvgText",
    "Switch",
    "SystemNotificationService",
    "SystemUI",
    "Systrace",
    "TapGestureHandler",
    "Text",
    "TextInput",
    "ThirdPartyApplicationExecutionService",
    "ToastAndroid",
    "Touchable",
    "TouchableHighlight",
    "TouchableNativeFeedback",
    "TouchableOpacity",
    "TouchableWithoutFeedback",
    "TurboModuleRegistry",
    "UIManager",
    "UTFSequence",
    "UnavailabilityError",
    "UnsupportedSevynFeatureError",
    "Use",
    "Vibration",
    "VideoView",
    "View",
    "VirtualApplicationPackageRepository",
    "VirtualViewMode",
    "VirtualizedList",
    "VirtualizedSectionList",
    "WHEN_PASSCODE_SET_THIS_DEVICE_ONLY",
    "WHEN_UNLOCKED",
    "WHEN_UNLOCKED_THIS_DEVICE_ONLY",
    "WebBrowser",
    "WebSocket",
    "Zocial",
    "add",
    "addEventListener",
    "addNotificationReceivedListener",
    "addNotificationResponseReceivedListener",
    "addWhitelistedNativeProps",
    "addWhitelistedUIProps",
    "brand",
    "buildSevynApplicationPackage",
    "canOpenURL",
    "cancelAllScheduledNotificationsAsync",
    "cancelAnimation",
    "cancelAnimationFrame",
    "cancelScheduledNotificationAsync",
    "clamp",
    "clearLastNotificationResponseAsync",
    "clearPendingLayoutAnimation",
    "codegenNativeCommands",
    "codegenNativeComponent",
    "compatibilityFlags",
    "consumePendingLayoutAnimation",
    "contextMenuKeyHandler",
    "createAnimatedComponent",
    "createApplicationCapabilities",
    "createContextMenuState",
    "createIconSet",
    "createMotionTransition",
    "createPackageIntegrity",
    "createPermissionHook",
    "createSharedValue",
    "createURL",
    "decay",
    "delay",
    "deleteItemAsync",
    "deleteNotificationChannelAsync",
    "designName",
    "deviceType",
    "deviceYearClass",
    "diffClamp",
    "digestStringAsync",
    "dismissActionSheet",
    "dismissAllNotificationsAsync",
    "dismissBrowser",
    "dismissContextMenu",
    "dismissNotificationAsync",
    "dispatchCommand",
    "divide",
    "enableScreens",
    "event",
    "executeNativeBackPress",
    "experimental_LayoutConformance",
    "featureFlags",
    "findNodeHandle",
    "get",
    "getActiveActionSheet",
    "getAllScheduledNotificationsAsync",
    "getBackgroundColorAsync",
    "getBadgeCountAsync",
    "getCurrentPositionAsync",
    "getDevicePushTokenAsync",
    "getExpoPushTokenAsync",
    "getForegroundPermissionsAsync",
    "getInitialURL",
    "getItemAsync",
    "getLastNotificationResponseAsync",
    "getNativeAdapters",
    "getNotificationChannelsAsync",
    "getPendingLayoutAnimation",
    "getStringAsync",
    "hasStringAsync",
    "hideAsync",
    "impactAsync",
    "installNativeAdapters",
    "installOnUIRuntime",
    "interpolate",
    "interpolateColor",
    "isAvailableAsync",
    "isDevice",
    "isFontLoaded",
    "isLoaded",
    "isMenuAction",
    "isMenuSeparator",
    "isMenuSubmenu",
    "isSearchBarAvailableForCurrentPlatform",
    "loadAsync",
    "loadFontAsync",
    "loop",
    "makeMutable",
    "manufacturer",
    "measure",
    "modelName",
    "modulo",
    "motionDuration",
    "multiply",
    "notificationAsync",
    "openBrowserAsync",
    "openURL",
    "osBuildId",
    "osInternalBuildId",
    "osName",
    "osVersion",
    "parallel",
    "preventAutoHideAsync",
    "processColor",
    "productName",
    "randomUUID",
    "registerCallableModule",
    "registerGlobals",
    "registerWebModule",
    "reloadAppAsync",
    "renderContextMenu",
    "requestAnimationFrame",
    "requestBackgroundPermissionsAsync",
    "requestForegroundPermissionsAsync",
    "requestNotificationPermissionsAsync",
    "requireNativeAdapter",
    "requireNativeComponent",
    "requireNativeModule",
    "requireNativeViewManager",
    "requireOptionalNativeModule",
    "resolveAccent",
    "resolveAnimatedStyle",
    "resolveSevynColors",
    "reverseGeocodeAsync",
    "runOnJS",
    "runOnUI",
    "scheduleNotificationAsync",
    "screensEnabled",
    "scrollTo",
    "selectionAsync",
    "sequence",
    "setBackgroundColorAsync",
    "setBadgeCountAsync",
    "setItemAsync",
    "setKeyboardAvoidanceHeight",
    "setNotificationChannelAsync",
    "setNotificationHandler",
    "setStatusBarBackgroundColor",
    "setStatusBarHidden",
    "setStatusBarStyle",
    "setStatusBarTranslucent",
    "setStringAsync",
    "sevynTokens",
    "sha256",
    "spring",
    "stagger",
    "subscribeActionSheet",
    "subtract",
    "supportedCpuArchitectures",
    "timing",
    "totalMemory",
    "unstable_NativeText",
    "unstable_NativeView",
    "unstable_TextAncestorContext",
    "unstable_VirtualView",
    "unstable_batchedUpdates",
    "useAnimatedColor",
    "useAnimatedProps",
    "useAnimatedReaction",
    "useAnimatedRef",
    "useAnimatedScrollHandler",
    "useAnimatedStyle",
    "useAnimatedValue",
    "useAnimatedValueXY",
    "useApplicationState",
    "useColorScheme",
    "useDerivedValue",
    "useDisplay",
    "useFonts",
    "useNetInfo",
    "useOptionalSevynApplicationSdk",
    "useParticipants",
    "usePressability",
    "useReducedMotion",
    "useReleasingSharedObject",
    "useRoom",
    "useSevynApplicationSdk",
    "useSharedValue",
    "useSystemTheme",
    "useTracks",
    "useWindow",
    "useWindowDimensions",
    "useWorkletCallback",
    "useWorkspace",
    "uuid",
    "validateSevynApplicationManifest",
    "verifyPackageIntegrity",
    "withDelay",
    "withRepeat",
    "withSequence",
    "withSpring",
    "withTiming",
  ];
  const exportsFor = (module: "react" | "react-native"): string => {
    const names = module === "react" ? reactExports : nativeExports;
    const reference = `globalThis.__SEVYN_MODULES__[${JSON.stringify(module)}]`;
    return [
      `const moduleValue = ${reference};`,
      ...(module === "react" ? ["export default moduleValue;"] : []),
      ...names.map((name) => `export const ${name} = moduleValue.${name};`),
    ].join("\n");
  };
  return {
    name: "sevynos-runtime-modules",
    setup(builder) {
      builder.onResolve({ filter: /^(react|react-native)$/ }, (args) => ({
        path: args.path,
        namespace: "sevynos-runtime",
      }));
      builder.onResolve({ filter: /^react\/(jsx-runtime|jsx-dev-runtime)$/ }, (args) => ({
        path: args.path,
        namespace: "sevynos-runtime",
      }));
      // Handle react-native/Libraries/* deep imports by mapping to the main module.
      // Third-party libraries sometimes import from internal paths; we re-export
      // everything from the main react-native module.
      builder.onResolve({ filter: /^react-native\// }, (args) => ({
        path: "react-native",
        namespace: "sevynos-runtime",
      }));
      builder.onLoad({ filter: /.*/, namespace: "sevynos-runtime" }, (args) => {
        if (args.path === "react") return { contents: exportsFor("react"), loader: "js" };
        if (args.path === "react-native")
          return { contents: exportsFor("react-native"), loader: "js" };
        return {
          contents:
            'const runtime = globalThis.__SEVYN_MODULES__["react/jsx-runtime"];' +
            "export const Fragment = runtime.Fragment;" +
            "export const jsx = runtime.jsx;" +
            "export const jsxs = runtime.jsxs;" +
            "export const jsxDEV = runtime.jsxDEV;",
          loader: "js",
        };
      });
    },
  };
}

export interface DoctorCheck {
  readonly name: string;
  readonly passed: boolean;
  readonly message: string;
}

export interface DoctorDiagnostic {
  readonly nodeVersion: string;
  readonly platform: string;
  readonly arch: string;
  readonly sevynVersion: string;
  readonly status: "healthy" | "warning" | "error";
  readonly checks: readonly DoctorCheck[];
}

export function runDoctor(): Promise<DoctorDiagnostic> {
  const nodeMajor = parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  const nodeValid = nodeMajor >= 20;

  const checks: DoctorCheck[] = [
    {
      name: "Node.js Runtime",
      passed: nodeValid,
      message: nodeValid
        ? `Node.js ${process.version} (supported)`
        : `Node.js ${process.version} (unsupported, requires >= 20.0.0)`,
    },
    {
      name: "Host Environment",
      passed: true,
      message: `${process.platform} (${process.arch})`,
    },
    {
      name: "SevynOS Platform Specification",
      passed: true,
      message: "SevynOS v0.1.0 (sevynos.org)",
    },
  ];

  return Promise.resolve({
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    sevynVersion: "0.1.0",
    status: checks.every((c) => c.passed) ? "healthy" : "warning",
    checks,
  });
}

export { bundleWithMetro, getSevynMetroConfig } from "@sevynos/metro";
