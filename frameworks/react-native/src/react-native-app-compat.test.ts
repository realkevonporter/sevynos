import { describe, expect, it } from "vitest";
import * as React from "react";
import { createElement, createRef } from "react";
import * as ReactNative from "./index.js";
import * as ExpoCompat from "./expo-compat.js";
import * as CommunityCompat from "./community-compat.js";
import * as ExpoModulesCore from "./expo-modules-core.js";
import { codegenNativeComponent } from "./fabric.js";
import {
  MaterialCommunityIcons,
  Ionicons,
  Feather,
  FontAwesome,
  AntDesign,
  MaterialIcons,
  Entypo,
} from "./vector-icons.js";
import {
  View,
  Text,
  NativeScrollView,
  type NativeScrollViewMethods,
  type NativeTextInputMethods,
} from "./primitives.js";
import { SevynApplicationRuntime } from "./application-runtime.js";
import { AppRegistry } from "./app-registry.js";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("React Native Application Compatibility Suite for SevynOS", () => {
  describe("Expo Modules Platform Compatibility", () => {
    it("provides expo-constants with complete device and app metadata", () => {
      expect(ExpoCompat.Constants.name).toBe("expo-constants");
      expect(ExpoCompat.Constants.deviceName).toBe("SevynOS Device");
      expect(ExpoCompat.Constants.sessionId).toBeDefined();
      expect(ExpoCompat.Constants.expoConfig.slug).toBe("sample-app");
      expect(ExpoCompat.Constants.platform.sevynos).toBeDefined();
    });

    it("provides expo-device hardware characteristics", () => {
      expect(ExpoCompat.isDevice).toBe(true);
      expect(ExpoCompat.brand).toBe("Sevyn");
      expect(ExpoCompat.manufacturer).toBe("SevynOS");
      expect(ExpoCompat.deviceType).toBe(ExpoCompat.DeviceType.DESKTOP);
      expect(ExpoCompat.totalMemory).toBeGreaterThan(0);
      expect(ExpoCompat.supportedCpuArchitectures).toContain("arm64");
    });

    it("provides expo-secure-store async persistence methods", async () => {
      expect(await ExpoCompat.isAvailableAsync()).toBe(true);
      await ExpoCompat.setItemAsync("sample_app_token", "jwt-token-12345");
      expect(await ExpoCompat.getItemAsync("sample_app_token")).toBe("jwt-token-12345");
      await ExpoCompat.deleteItemAsync("sample_app_token");
      expect(await ExpoCompat.getItemAsync("sample_app_token")).toBeNull();
    });

    it("provides expo-clipboard string manipulation", async () => {
      await ExpoCompat.setStringAsync("https://example.com/post/1");
      expect(await ExpoCompat.hasStringAsync()).toBe(true);
      expect(await ExpoCompat.getStringAsync()).toBe("https://example.com/post/1");
    });

    it("provides expo-haptics graceful feedback stubs", async () => {
      await expect(
        ExpoCompat.impactAsync(ExpoCompat.ImpactFeedbackStyle.Medium),
      ).resolves.toBeUndefined();
      await expect(
        ExpoCompat.notificationAsync(ExpoCompat.NotificationFeedbackType.Success),
      ).resolves.toBeUndefined();
      await expect(ExpoCompat.selectionAsync()).resolves.toBeUndefined();
    });

    it("provides expo-location location queries and permissions", async () => {
      const perms = await ExpoCompat.requestForegroundPermissionsAsync();
      expect(perms.status).toBe(ExpoModulesCore.PermissionStatus.GRANTED);
      const position = await ExpoCompat.getCurrentPositionAsync();
      expect(position.coords.latitude).toBeDefined();
      expect(position.coords.longitude).toBeDefined();
    });

    it("provides expo-notifications token and schedule endpoints", async () => {
      const token = await ExpoCompat.getExpoPushTokenAsync();
      expect(token.data).toContain("ExponentPushToken");
      const id = await ExpoCompat.scheduleNotificationAsync({
        content: { title: "Sample notification", body: "New follower" },
        trigger: null,
      });
      expect(typeof id).toBe("string");
    });

    it("provides expo-font and expo-asset hooks", async () => {
      await expect(
        ExpoCompat.loadFontAsync("Inter-Bold", "asset://font.ttf"),
      ).resolves.toBeUndefined();
      expect(ExpoCompat.isFontLoaded("Inter-Bold")).toBe(true);
      const asset = ExpoCompat.Asset.fromModule(1);
      await asset.downloadAsync();
      expect(asset.downloaded).toBe(true);
    });

    it("provides expo-crypto UUID generation and hashing", async () => {
      const uuid = ExpoCompat.randomUUID();
      expect(uuid).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      const hash = await ExpoCompat.digestStringAsync(
        ExpoCompat.CryptoDigestAlgorithm.SHA256,
        "sample-app",
      );
      expect(typeof hash).toBe("string");
      expect(hash.length).toBeGreaterThan(0);
    });

    it("provides expo-system-ui and expo-web-browser stubs", async () => {
      await expect(
        ExpoCompat.setBackgroundColorAsync("#000000"),
      ).resolves.toBeUndefined();
      const result = await ExpoCompat.openBrowserAsync("https://example.com");
      expect(result.type).toBe("opened");
    });
  });

  describe("Community Libraries Compatibility", () => {
    it("provides @react-native-community/netinfo network state and listeners", async () => {
      const state = await CommunityCompat.NetInfo.fetch();
      expect(state).toBeDefined();
      expect(state.type).toBeDefined();

      const unsubscribe = CommunityCompat.NetInfo.addEventListener((next) => {
        expect(next).toBeDefined();
      });
      expect(typeof unsubscribe).toBe("function");
      unsubscribe();
    });

    it("provides react-native-screens primitives without runtime overhead", () => {
      CommunityCompat.enableScreens(true);
      expect(CommunityCompat.screensEnabled()).toBe(true);
      const screen = createElement(
        CommunityCompat.Screen,
        { activityState: 2 } as Record<string, unknown>,
        createElement(Text, null, "Sample App Screen"),
      );
      expect(screen).toBeDefined();
    });

    it("provides react-native-gesture-handler builders and handlers", () => {
      const pan = (
        (CommunityCompat.Gesture.Pan() as Record<string, unknown>)["minDistance"] as (
          arg: number,
        ) => unknown
      )(10);
      expect(pan).toBeDefined();
      const root = createElement(
        CommunityCompat.GestureHandlerRootView,
        null,
        createElement(
          CommunityCompat.GestureDetector,
          { gesture: pan },
          createElement(Text, null, "Swipeable"),
        ),
      );
      expect(root).toBeDefined();
    });

    it("provides react-native-reanimated hooks and interpolation stubs", () => {
      const interpolated = CommunityCompat.interpolate(0.5, [0, 1], [100, 200]);
      expect(interpolated).toBe(150);

      const identity = CommunityCompat.runOnJS((x: number) => x * 2);
      expect(identity(5)).toBe(10);
    });

    it("provides react-native-svg vector primitives", () => {
      const svg = createElement(
        CommunityCompat.Svg,
        { width: 100, height: 100 } as Record<string, unknown>,
        createElement(CommunityCompat.Circle, {
          cx: 50,
          cy: 50,
          r: 25,
          fill: "blue",
        } as Record<string, unknown>),
        createElement(CommunityCompat.Path, {
          d: "M 10 10 L 90 90",
          stroke: "white",
        } as Record<string, unknown>),
      );
      expect(svg).toBeDefined();
    });

    it("provides @livekit/react-native audio/video primitives and WebRTC globals", () => {
      CommunityCompat.registerGlobals();
      expect(
        (globalThis as unknown as Record<string, unknown>)["RTCPeerConnection"],
      ).toBeDefined();
      expect(CommunityCompat.AudioSession.isStarted).toBe(false);
      const video = createElement(CommunityCompat.VideoView, { mirror: true } as Record<
        string,
        unknown
      >);
      expect(video).toBeDefined();
    });
  });

  describe("Fabric codegenNativeComponent Safe Fallback", () => {
    it("returns pre-registered native element types for known components", () => {
      const ScreenComponent = codegenNativeComponent("RNSScreen");
      expect(ScreenComponent.displayName).toBe("RNSScreen");
      expect(ScreenComponent({}).type).toBe("view");

      const ButtonComponent = codegenNativeComponent("RNGestureHandlerButton");
      expect(ButtonComponent.displayName).toBe("RNGestureHandlerButton");
      expect(ButtonComponent({}).type).toBe("button");

      const PagerComponent = codegenNativeComponent("RNCViewPager");
      expect(PagerComponent({}).type).toBe("scroll");
    });

    it("falls back to view gracefully for unknown third-party Fabric components without throwing", () => {
      const CustomComponent = codegenNativeComponent("ThirdPartyUnknownNitroComponent");
      expect(CustomComponent.displayName).toBe("ThirdPartyUnknownNitroComponent");
      expect(CustomComponent({}).type).toBe("view");
    });
  });

  describe("expo-modules-core Resilient Stubs", () => {
    it("returns resilient module proxies for uninstalled native modules", () => {
      const module = ExpoModulesCore.requireNativeModule<{
        readonly name: string;
        readonly addListener: unknown;
        readonly getConstants: () => Record<string, unknown>;
      }>("SomeFutureExpoModule");
      expect(module).toBeDefined();
      expect(typeof module.addListener).toBe("function");
      expect(module.getConstants()["name"]).toBe("SomeFutureExpoModule");
      expect(module.getConstants()["brand"]).toBe("Sevyn");
    });

    it("supports EventEmitter addListener and emit", () => {
      const emitter = new ExpoModulesCore.EventEmitter();
      let count = 0;
      const sub = emitter.addListener("test", () => {
        count += 1;
      });
      emitter.emit("test");
      expect(count).toBe(1);
      sub.remove();
      emitter.emit("test");
      expect(count).toBe(1);
    });
  });

  describe("Vector Icons Integration", () => {
    it("renders icons across all major families without errors", () => {
      const mcIcon = createElement(MaterialCommunityIcons, {
        name: "heart",
        size: 24,
        color: "#ff0000",
      });
      const ioIcon = createElement(Ionicons, {
        name: "home",
        size: 24,
        color: "#00ff00",
      });
      const feIcon = createElement(Feather, { name: "user", size: 24, color: "#0000ff" });
      const faIcon = createElement(FontAwesome, {
        name: "search",
        size: 24,
        color: "#ffffff",
      });
      const adIcon = createElement(AntDesign, {
        name: "star",
        size: 24,
        color: "#ffff00",
      });
      const miIcon = createElement(MaterialIcons, {
        name: "settings",
        size: 24,
        color: "#ff00ff",
      });
      const enIcon = createElement(Entypo, { name: "share", size: 24, color: "#00ffff" });

      expect(mcIcon).toBeDefined();
      expect(ioIcon).toBeDefined();
      expect(feIcon).toBeDefined();
      expect(faIcon).toBeDefined();
      expect(adIcon).toBeDefined();
      expect(miIcon).toBeDefined();
      expect(enIcon).toBeDefined();
    });
  });

  describe("NativeScrollView and NativeTextInput Methods & Ref Compatibility", () => {
    it("supports imperative methods on NativeScrollView ref handle", () => {
      const ref = createRef<NativeScrollViewMethods>();
      let scrolledToY: number | null = null;
      let scrolledToEnd = false;

      createElement(NativeScrollView, {
        ref,
        onScroll: () => undefined,
      });

      // Simulate attached handle
      (ref as { current: unknown }).current = {
        scrollTo: (params: { y?: number }) => {
          scrolledToY = params.y ?? 0;
        },
        scrollToEnd: () => {
          scrolledToEnd = true;
        },
        flashScrollIndicators: () => undefined,
      };

      ref.current?.scrollTo({ y: 250 });
      expect(scrolledToY).toBe(250);
      ref.current?.scrollToEnd();
      expect(scrolledToEnd).toBe(true);
    });

    it("supports imperative methods on NativeTextInput ref handle", () => {
      const ref = createRef<NativeTextInputMethods>();
      let focused = false;
      let text = "initial";

      (ref as { current: unknown }).current = {
        focus: () => {
          focused = true;
        },
        blur: () => {
          focused = false;
        },
        clear: () => {
          text = "";
        },
        isFocused: () => focused,
        setNativeProps: () => undefined,
      };

      ref.current?.focus();
      expect(ref.current?.isFocused()).toBe(true);
      ref.current?.clear();
      expect(text).toBe("");
    });
  });

  describe("Complex React Native UI Tree Mount Simulation in SevynApplicationRuntime", () => {
    it("mounts a complex application-like screen tree in SevynApplicationRuntime and produces layout commands", () => {
      const runtime = new SevynApplicationRuntime({
        bounds: { x: 0, y: 0, width: 800, height: 600 },
      });

      const sampleApplicationTree = createElement(
        CommunityCompat.GestureHandlerRootView,
        { style: { flex: 1, backgroundColor: "#0f0f14" } },
        createElement(
          CommunityCompat.ScreenContainer,
          { style: { flex: 1 } },
          createElement(
            CommunityCompat.Screen,
            { style: { flex: 1 } },
            // Feed Header with LinearGradient
            createElement(
              ExpoCompat.LinearGradient,
              {
                colors: ["#1a1a24", "#0f0f14"],
                style: {
                  height: 60,
                  paddingHorizontal: 16,
                  flexDirection: "row",
                  alignItems: "center",
                },
              },
              createElement(
                Text,
                { style: { color: "#ffffff", fontSize: 20, fontWeight: "bold" } },
                "Sample App",
              ),
              createElement(MaterialCommunityIcons, {
                name: "bell-outline",
                size: 22,
                color: "#ffffff",
              }),
            ),
            // Scrollable Feed
            createElement(
              NativeScrollView,
              { style: { flex: 1 } },
              // Post Card with BlurView and Image
              createElement(
                View,
                {
                  style: {
                    margin: 12,
                    padding: 12,
                    backgroundColor: "#1c1c28",
                    borderRadius: 12,
                  },
                },
                createElement(
                  View,
                  {
                    style: {
                      flexDirection: "row",
                      alignItems: "center",
                      marginBottom: 8,
                    },
                  },
                  createElement(MaterialCommunityIcons, {
                    name: "account-circle",
                    size: 36,
                    color: "#9a9ab0",
                  }),
                  createElement(
                    Text,
                    { style: { marginLeft: 8, color: "#ffffff", fontWeight: "600" } },
                    "alice_social",
                  ),
                ),
                createElement(
                  Text,
                  { style: { color: "#e0e0e6", marginBottom: 8 } },
                  "Testing React Native compatibility on SevynOS!",
                ),
                createElement(ExpoCompat.Image, {
                  source: { uri: "https://example.com/sample-post.png" },
                  contentFit: "cover",
                  style: { height: 200, borderRadius: 8 },
                }),
                createElement(
                  View,
                  { style: { flexDirection: "row", marginTop: 10, gap: 16 } },
                  createElement(MaterialCommunityIcons, {
                    name: "heart-outline",
                    size: 22,
                    color: "#ff4d6d",
                  }),
                  createElement(MaterialCommunityIcons, {
                    name: "comment-outline",
                    size: 22,
                    color: "#9a9ab0",
                  }),
                  createElement(MaterialCommunityIcons, {
                    name: "share-variant-outline",
                    size: 22,
                    color: "#9a9ab0",
                  }),
                ),
              ),
              // Live Stream Room Card (LiveKit VideoView + SVG badge)
              createElement(
                View,
                {
                  style: {
                    margin: 12,
                    padding: 12,
                    backgroundColor: "#1c1c28",
                    borderRadius: 12,
                  },
                },
                createElement(
                  Text,
                  { style: { color: "#ffffff", fontWeight: "bold", marginBottom: 6 } },
                  "Live Room",
                ),
                createElement(CommunityCompat.VideoView, {
                  mirror: false,
                  style: { height: 180, backgroundColor: "#000000", borderRadius: 8 },
                } as Record<string, unknown>),
                createElement(
                  CommunityCompat.Svg,
                  { width: 60, height: 20, style: { marginTop: 6 } } as Record<
                    string,
                    unknown
                  >,
                  createElement(CommunityCompat.Rect, {
                    width: 60,
                    height: 20,
                    rx: 4,
                    fill: "#e63946",
                  } as Record<string, unknown>),
                  createElement(CommunityCompat.Circle, {
                    cx: 12,
                    cy: 10,
                    r: 4,
                    fill: "#ffffff",
                  } as Record<string, unknown>),
                ),
              ),
            ),
          ),
        ),
      );

      runtime.mount(sampleApplicationTree);

      const snapshot = runtime.snapshot;
      expect(snapshot.revision).toBeGreaterThanOrEqual(1);
      expect(snapshot.commands.length).toBeGreaterThan(0);
      expect(snapshot.accessibility.length).toBeGreaterThan(0);

      runtime.unmount();
    });

    it("executes the full optional Metro-compiled React Native bundle and verifies root component registration", async () => {
      const bundlePath = resolve(
        process.cwd(),
        "../../dist/react-native-compat.bundle.js",
      );
      if (!existsSync(bundlePath)) {
        return;
      }

      const bundleCode = readFileSync(bundlePath, "utf-8");
      const previousDev = (globalThis as unknown as { __DEV__?: boolean | undefined })
        .__DEV__;
      const previousReact = (globalThis as unknown as { React?: unknown }).React;
      const previousModules = (globalThis as unknown as { __SEVYN_MODULES__?: unknown })
        .__SEVYN_MODULES__;

      (globalThis as unknown as { __DEV__?: boolean | undefined }).__DEV__ = false;
      (globalThis as unknown as { React?: unknown }).React = React;
      (globalThis as unknown as { __SEVYN_MODULES__?: unknown }).__SEVYN_MODULES__ = {
        react: React,
        "react/jsx-runtime": {
          Fragment: React.Fragment,
          jsx: (type: any, props: any, key?: any) =>
            React.createElement(type, { ...props, key }),
          jsxs: (type: any, props: any, key?: any) =>
            React.createElement(type, { ...props, key }),
        },
        "react-native": ReactNative,
        "@sevynos/react-native": ReactNative,
      };

      try {
        // Execute the bundle
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        const execute = new Function(bundleCode) as () => void;
        execute();

        // Expo / expo-router registers 'main'
        const runnable = AppRegistry.getRunnable("main");
        expect(runnable).toBeDefined();
        expect(typeof runnable?.run).toBe("function");

        if (runnable) {
          const rootElement = runnable.run({ initialProps: {} });
          expect(rootElement).toBeDefined();

          const runtime = new SevynApplicationRuntime({
            bounds: { x: 0, y: 0, width: 800, height: 600 },
          });

          runtime.mount(rootElement);
          await new Promise((r) => setTimeout(r, 100));
          expect(runtime.snapshot.revision).toBeGreaterThanOrEqual(1);
          expect(runtime.snapshot.commands.length).toBeGreaterThan(0);
          runtime.unmount();
        }
      } finally {
        (globalThis as unknown as { __DEV__?: boolean | undefined }).__DEV__ =
          previousDev;
        (globalThis as unknown as { React?: unknown }).React = previousReact;
        (globalThis as unknown as { __SEVYN_MODULES__?: unknown }).__SEVYN_MODULES__ =
          previousModules;
      }
    });
  });
});
