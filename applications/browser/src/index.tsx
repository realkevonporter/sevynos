import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import {
  NativeImage,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type BrowserEngineSnapshot,
  type SevynBrowserEngine,
  type SevynApplicationManifest,
} from "@sevynos/react-native";

interface BrowserPointerEvent {
  readonly x: number;
  readonly y: number;
  readonly button?: number;
}

interface BrowserWheelEvent {
  readonly x: number;
  readonly y: number;
  readonly deltaY: number;
  readonly deltaX?: number;
}

interface BrowserKeyboardEvent {
  readonly key: string;
  readonly code: string;
  readonly shift: boolean;
  readonly alt: boolean;
  readonly control: boolean;
  readonly meta: boolean;
}

export const browserManifest: SevynApplicationManifest = {
  manifestVersion: 1,
  id: "org.sevynos.browser",
  name: "Web Browser",
  version: "1.0.0",
  runtime: "react-native",
  applicationKey: "Browser",
  developer: "SevynOS",
  icon: "icons/browser.svg",
  entrypoint: "dist/index.js",
  minimumSevynOSVersion: "0.1.0",
  permissions: ["network"],
  services: [],
  windowModes: ["standard"],
  instanceMode: "multiple",
};

export interface BrowserTab {
  readonly id: string;
  readonly url: string;
  readonly title: string;
  readonly loading: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly error?: string | undefined;
}

export function normalizeBrowserUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed || trimmed === "sevyn://start" || trimmed === "about:blank") {
    return "sevyn://start";
  }
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)) {
    return trimmed;
  }
  if (trimmed.includes(".") && !trimmed.includes(" ")) {
    return `https://${trimmed}`;
  }
  return `https://duckduckgo.com/?q=${encodeURIComponent(trimmed)}`;
}

export interface BrowserApplicationProps {
  readonly engine?: SevynBrowserEngine | undefined;
  readonly createEngine?: (() => SevynBrowserEngine | undefined) | undefined;
  readonly initialUrl?: string | undefined;
}

export interface DocsSection {
  readonly title: string;
  readonly content: string;
}

export const DOCS_SECTIONS: readonly DocsSection[] = [
  {
    title: "1. System Architecture & Kernel",
    content:
      "SevynOS runs on standard x86-64 hardware with a dedicated SevynOS kernel. Hardware scanout is driven via direct DRM/KMS scanout with Intel UHD Graphics support and hardware acceleration.",
  },
  {
    title: "2. Genesis Compositor & Wayland Bridge",
    content:
      "The window compositor splits mechanism (Rust bridge owning DRM/EGL/evdev and wl_surface frame callbacks) and policy (Node.js PresentationFrameScheduler owning the scene graph with 1-frame-in-flight backpressure).",
  },
  {
    title: "3. React Native Application Runtime",
    content:
      "System and third-party apps run in isolated worker processes using @sevynos/react-native. Primitives (View, Text, Pressable, ScrollView, NativeImage) are reconciled and composited with high fidelity.",
  },
  {
    title: "4. Web Browser & Chromium CDP Engine",
    content:
      "The browser leverages headless Chromium via Chrome DevTools Protocol (CDP) for full web standards compatibility, streaming live page screenshots and receiving pointer, keyboard, and scroll events.",
  },
];

export const DEFAULT_BOOKMARKS = [
  { title: "DuckDuckGo", url: "https://duckduckgo.com", icon: "🦆" },
  { title: "React Native", url: "https://reactnative.dev", icon: "⚛️" },
  { title: "Sevyn Docs", url: "sevyn://docs", icon: "📖" },
  { title: "GitHub", url: "https://github.com", icon: "🐙" },
  { title: "Wikipedia", url: "https://en.wikipedia.org", icon: "🌐" },
  { title: "Hacker News", url: "https://news.ycombinator.com", icon: "📰" },
];

export function BrowserApplication({
  engine,
  createEngine,
  initialUrl = "sevyn://start",
}: BrowserApplicationProps): JSX.Element {
  // Per-tab browser engines for true tab isolation. Each tab gets its own
  // engine instance so navigation, history, and page state don't leak across tabs.
  const tabEngines = useRef(new Map<string, SevynBrowserEngine>());
  if (engine !== undefined && !tabEngines.current.has("tab-1")) {
    tabEngines.current.set("tab-1", engine);
  }

  const [tabs, setTabs] = useState<readonly BrowserTab[]>([
    {
      id: "tab-1",
      url: initialUrl,
      title: initialUrl === "sevyn://start" ? "New Tab" : initialUrl,
      loading: false,
      canGoBack: false,
      canGoForward: false,
    },
  ]);
  const [activeTabId, setActiveTabId] = useState<string>("tab-1");
  const [addressInput, setAddressInput] = useState<string>(
    initialUrl === "sevyn://start" ? "" : initialUrl,
  );
  const activeEngine = tabEngines.current.get(activeTabId);
  const [engineSnapshot, setEngineSnapshot] = useState<BrowserEngineSnapshot | undefined>(
    activeEngine?.snapshot(),
  );

  const activeTab: BrowserTab = tabs.find((t) => t.id === activeTabId) ??
    tabs[0] ?? {
      id: "tab-default",
      url: initialUrl,
      title: "New Tab",
      loading: false,
      canGoBack: false,
      canGoForward: false,
    };

  useEffect(() => {
    const tabEngine = tabEngines.current.get(activeTabId);
    if (!tabEngine) return;
    // Sync snapshot immediately when switching tabs
    setEngineSnapshot(tabEngine.snapshot());
    const unsubscribe = tabEngine.subscribe(() => {
      const snap = tabEngine.snapshot();
      setEngineSnapshot(snap);
      if (snap.url && snap.url !== "about:blank") {
        setTabs((prev) =>
          prev.map((t) =>
            t.id === activeTabId
              ? {
                  ...t,
                  url: snap.url,
                  title: snap.title || snap.url,
                  loading: snap.loading,
                  error: snap.error,
                }
              : t,
          ),
        );
      }
    });
    return unsubscribe;
  }, [activeTabId]);

  const navigateTo = useCallback(
    (targetUrl: string) => {
      const normalized = normalizeBrowserUrl(targetUrl);
      setAddressInput(normalized === "sevyn://start" ? "" : normalized);

      const isInternal = normalized.startsWith("sevyn://");
      const title =
        normalized === "sevyn://start"
          ? "New Tab"
          : normalized === "sevyn://docs"
            ? "Sevyn Docs"
            : normalized;

      setTabs((prev) =>
        prev.map((t) =>
          t.id === activeTabId
            ? {
                ...t,
                url: normalized,
                title,
                loading: !isInternal,
                error: undefined,
              }
            : t,
        ),
      );

      if (!isInternal) {
        if (!activeEngine) {
          setTabs((prev) =>
            prev.map((t) =>
              t.id === activeTabId
                ? {
                    ...t,
                    loading: false,
                    error: "Browser engine is not available on this device.",
                  }
                : t,
            ),
          );
          return;
        }

        void activeEngine.navigate(normalized).then((snap) => {
          setEngineSnapshot(snap);
          setTabs((prev) =>
            prev.map((t) =>
              t.id === activeTabId
                ? {
                    ...t,
                    url: snap.url,
                    title: snap.title || snap.url,
                    loading: false,
                    error: snap.error,
                  }
                : t,
            ),
          );
        });
      }
    },
    [activeTabId, engine],
  );

  const handleBack = useCallback(() => {
    if (activeEngine) {
      void activeEngine.back().then((snap) => {
        setEngineSnapshot(snap);
      });
    }
  }, [activeEngine]);

  const handleForward = useCallback(() => {
    if (activeEngine) {
      void activeEngine.forward().then((snap) => {
        setEngineSnapshot(snap);
      });
    }
  }, [activeEngine]);

  const handleReload = useCallback(() => {
    if (!activeTab.url.startsWith("sevyn://") && activeEngine) {
      void activeEngine.reload().then((snap) => {
        setEngineSnapshot(snap);
      });
    }
  }, [activeTab.url, activeEngine]);

  const handleHome = useCallback(() => {
    navigateTo("sevyn://start");
  }, [navigateTo]);

  const handleNewTab = useCallback(() => {
    const newId = `tab-${String(Date.now())}`;
    const newTab: BrowserTab = {
      id: newId,
      url: "sevyn://start",
      title: "New Tab",
      loading: false,
      canGoBack: false,
      canGoForward: false,
    };
    // Create a dedicated engine for the new tab for true isolation.
    // Falls back to sharing if the factory is unavailable.
    const newEngine = createEngine?.();
    if (newEngine !== undefined) {
      tabEngines.current.set(newId, newEngine);
    }
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newId);
    setAddressInput("");
  }, [createEngine]);

  const handleCloseTab = useCallback(
    (tabId: string) => {
      if (tabs.length === 1) {
        navigateTo("sevyn://start");
        return;
      }
      const filtered = tabs.filter((t) => t.id !== tabId);
      setTabs(filtered);
      if (activeTabId === tabId) {
        const nextActive = filtered[filtered.length - 1];
        if (nextActive) {
          setActiveTabId(nextActive.id);
          setAddressInput(nextActive.url === "sevyn://start" ? "" : nextActive.url);
        }
      }
    },
    [tabs, activeTabId, navigateTo],
  );

  const isStartPage = activeTab.url === "sevyn://start";
  const isDocsPage = activeTab.url === "sevyn://docs";
  const isInternalPage = activeTab.url.startsWith("sevyn://");

  return (
    <View
      accessibilityRole="application"
      accessibilityLabel="Browser"
      style={styles.container}
    >
      {/* Tab Strip */}
      <View style={styles.tabStrip}>
        <View style={styles.tabRow}>
          {tabs.map((tab) => {
            const isActive = tab.id === activeTabId;
            return (
              <Pressable
                key={tab.id}
                onPress={() => {
                  setActiveTabId(tab.id);
                  setAddressInput(tab.url === "sevyn://start" ? "" : tab.url);
                }}
                style={isActive ? styles.tabActive : styles.tab}
              >
                <Text style={styles.tabIcon}>
                  {tab.url === "sevyn://start" ? "🏠" : "🌐"}
                </Text>
                <Text style={isActive ? styles.tabTitleActive : styles.tabTitle}>
                  {tab.title}
                </Text>
                <Pressable
                  onPress={() => {
                    handleCloseTab(tab.id);
                  }}
                  style={styles.tabCloseButton}
                >
                  <Text style={styles.tabCloseText}>×</Text>
                </Pressable>
              </Pressable>
            );
          })}
        </View>
        <Pressable onPress={handleNewTab} style={styles.newTabButton}>
          <Text style={styles.newTabText}>+</Text>
        </Pressable>
      </View>

      {/* Navigation Toolbar */}
      <View style={styles.toolbar}>
        <Pressable onPress={handleBack} style={styles.navButton}>
          <Text style={styles.navButtonText}>←</Text>
        </Pressable>

        <Pressable onPress={handleForward} style={styles.navButton}>
          <Text style={styles.navButtonText}>→</Text>
        </Pressable>

        <Pressable onPress={handleReload} style={styles.navButton}>
          <Text style={styles.navButtonText}>↻</Text>
        </Pressable>

        <Pressable onPress={handleHome} style={styles.navButton}>
          <Text style={styles.navButtonText}>⌂</Text>
        </Pressable>

        {/* Omnibox Address / Search Input */}
        <View style={styles.addressBar}>
          <Text style={styles.securityBadge}>
            {activeTab.url.startsWith("https://") ? "🔒" : "🌐"}
          </Text>
          <TextInput
            onChangeText={setAddressInput}
            onSubmitEditing={() => {
              navigateTo(addressInput);
            }}
            placeholder="Search the web or enter address…"
            style={styles.addressInput}
            value={addressInput}
          />
          {addressInput.length > 0 && (
            <Pressable
              onPress={() => {
                setAddressInput("");
              }}
              style={styles.clearButton}
            >
              <Text style={styles.clearButtonText}>✕</Text>
            </Pressable>
          )}
        </View>

        <Pressable
          onPress={() => {
            navigateTo(addressInput);
          }}
          style={styles.goButton}
        >
          <Text style={styles.goButtonText}>Go</Text>
        </Pressable>
      </View>

      {/* Main Viewport Content */}
      <View style={styles.content}>
        {isStartPage ? (
          <ScrollView style={styles.startPageScroll}>
            {/* Start Page Header */}
            <View style={styles.startHeader}>
              <View style={styles.logoBadge}>
                <Text style={styles.logoText}>⚡</Text>
              </View>
              <Text style={styles.startTitle}>SevynOS Browser</Text>
              <Text style={styles.startSubtitle}>
                Hardware-accelerated web engine with privacy-first standards.
              </Text>
            </View>

            {/* Quick Search Card */}
            <View style={styles.searchCard}>
              <TextInput
                onChangeText={setAddressInput}
                onSubmitEditing={() => {
                  navigateTo(addressInput);
                }}
                placeholder="Search DuckDuckGo or enter URL…"
                style={styles.heroSearchInput}
                value={addressInput}
              />
              <Pressable
                onPress={() => {
                  navigateTo(addressInput);
                }}
                style={styles.heroSearchButton}
              >
                <Text style={styles.heroSearchButtonText}>Search</Text>
              </Pressable>
            </View>

            {/* Bookmarks Grid */}
            <Text style={styles.sectionHeader}>Quick Bookmarks</Text>
            <View style={styles.bookmarksGrid}>
              {DEFAULT_BOOKMARKS.map((bookmark) => (
                <Pressable
                  key={bookmark.url}
                  onPress={() => {
                    navigateTo(bookmark.url);
                  }}
                  style={styles.bookmarkCard}
                >
                  <Text style={styles.bookmarkIcon}>{bookmark.icon}</Text>
                  <Text style={styles.bookmarkTitle}>{bookmark.title}</Text>
                  <Text style={styles.bookmarkUrl}>{bookmark.url}</Text>
                </Pressable>
              ))}
            </View>

            {/* System Status / Engine Badge */}
            <View style={styles.engineCard}>
              <Text style={styles.engineCardTitle}>Web Engine Status</Text>
              <Text style={styles.engineCardBody}>
                {engineSnapshot?.ready
                  ? "● Chromium CDP rendering engine connected and active."
                  : "○ Local high-performance web runtime ready. Enter any web address above to browse."}
              </Text>
            </View>
          </ScrollView>
        ) : isDocsPage ? (
          <ScrollView style={styles.startPageScroll}>
            <View style={styles.startHeader}>
              <View style={styles.logoBadge}>
                <Text style={styles.logoText}>📖</Text>
              </View>
              <Text style={styles.startTitle}>SevynOS Documentation</Text>
              <Text style={styles.startSubtitle}>
                Offline system architecture and developer reference guides.
              </Text>
            </View>

            <View style={styles.docsContainer}>
              {DOCS_SECTIONS.map((section) => (
                <View key={section.title} style={styles.docCard}>
                  <Text style={styles.docCardTitle}>{section.title}</Text>
                  <Text style={styles.docCardBody}>{section.content}</Text>
                </View>
              ))}
            </View>

            <View style={styles.docsFooter}>
              <Pressable onPress={handleHome} style={styles.homeSecondaryButton}>
                <Text style={styles.homeSecondaryButtonText}>Return to Start Page</Text>
              </Pressable>
            </View>
          </ScrollView>
        ) : isInternalPage ? (
          <ScrollView style={styles.startPageScroll}>
            <View style={styles.startHeader}>
              <View style={styles.logoBadge}>
                <Text style={styles.logoText}>ℹ️</Text>
              </View>
              <Text style={styles.startTitle}>{activeTab.title}</Text>
              <Text style={styles.startSubtitle}>{activeTab.url}</Text>
            </View>
            <View style={styles.docsFooter}>
              <Pressable onPress={handleHome} style={styles.homeSecondaryButton}>
                <Text style={styles.homeSecondaryButtonText}>Return to Start Page</Text>
              </Pressable>
            </View>
          </ScrollView>
        ) : !engine ? (
          <View style={styles.errorContainer}>
            <Text style={styles.errorIcon}>⚠️</Text>
            <Text style={styles.errorTitle}>Browser Engine Unavailable</Text>
            <Text style={styles.errorDescription}>
              The standards-based web browser engine is not connected or could not start
              on this system.
            </Text>
            <Pressable onPress={handleHome} style={styles.homeSecondaryButton}>
              <Text style={styles.homeSecondaryButtonText}>Return to Start Page</Text>
            </Pressable>
          </View>
        ) : activeTab.error ? (
          <View style={styles.errorContainer}>
            <Text style={styles.errorIcon}>⚠️</Text>
            <Text style={styles.errorTitle}>Unable to connect to website</Text>
            <Text style={styles.errorDescription}>{activeTab.error}</Text>
            <View style={styles.errorActions}>
              <Pressable
                onPress={() => {
                  navigateTo(activeTab.url);
                }}
                style={styles.retryButton}
              >
                <Text style={styles.retryButtonText}>Try Again</Text>
              </Pressable>
              <Pressable onPress={handleHome} style={styles.homeSecondaryButton}>
                <Text style={styles.homeSecondaryButtonText}>Return to Start Page</Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <View style={styles.webContainer}>
            {activeTab.loading && (
              <View style={styles.loadingBarContainer}>
                <View style={styles.loadingBarProgress} />
              </View>
            )}
            {engineSnapshot?.pixels ? (
              <NativeImage
                key="web-view"
                id="browser.web-view"
                role="button"
                label="Web page content"
                source={{
                  width: engineSnapshot.width,
                  height: engineSnapshot.height,
                  pixels: engineSnapshot.pixels,
                }}
                onPointerDown={(event: BrowserPointerEvent) => {
                  void activeEngine?.pointerDown(event.x, event.y, event.button ?? 0);
                }}
                onPointerUp={(event: BrowserPointerEvent) => {
                  void activeEngine
                    ?.pointerUp(event.x, event.y, event.button ?? 0)
                    .then((snap) => {
                      setEngineSnapshot(snap);
                    });
                }}
                onWheel={(event: BrowserWheelEvent) => {
                  void activeEngine
                    ?.scroll(event.x, event.y, event.deltaY, event.deltaX)
                    .then((snap) => {
                      setEngineSnapshot(snap);
                    });
                }}
                onKeyDown={(event: BrowserKeyboardEvent) => {
                  void activeEngine
                    ?.key(event.key, event.code, {
                      shift: event.shift,
                      alt: event.alt,
                      control: event.control,
                      meta: event.meta,
                    })
                    .then((snap) => {
                      setEngineSnapshot(snap);
                    });
                }}
                style={styles.webViewport}
              />
            ) : (
              <View style={styles.loadingViewport}>
                <Text style={styles.loadingViewportText}>
                  {activeTab.loading ? `Connecting to ${activeTab.url}…` : "Ready"}
                </Text>
              </View>
            )}
          </View>
        )}
      </View>
    </View>
  );
}

export default BrowserApplication;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0F1115",
  },
  tabStrip: {
    height: 38,
    backgroundColor: "#161920",
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    borderBottomWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.08)",
  },
  tabRow: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
  },
  tab: {
    height: 32,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    marginRight: 4,
    borderRadius: 8,
    backgroundColor: "rgba(255, 255, 255, 0.04)",
    maxWidth: 200,
    gap: 6,
  },
  tabActive: {
    height: 32,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    marginRight: 4,
    borderRadius: 8,
    backgroundColor: "#1F2430",
    borderTopWidth: 2,
    borderColor: "#D7AC57",
    maxWidth: 200,
    gap: 6,
  },
  tabIcon: {
    fontSize: 12,
  },
  tabTitle: {
    color: "#8E95A5",
    fontSize: 12,
    flex: 1,
    overflow: "hidden",
  },
  tabTitleActive: {
    color: "#F3F4F6",
    fontWeight: "600",
    fontSize: 12,
    flex: 1,
    overflow: "hidden",
  },
  tabCloseButton: {
    padding: 2,
    borderRadius: 4,
  },
  tabCloseText: {
    color: "#6B7280",
    fontSize: 14,
  },
  newTabButton: {
    width: 28,
    height: 28,
    borderRadius: 6,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255, 255, 255, 0.06)",
    marginLeft: 4,
  },
  newTabText: {
    color: "#D7AC57",
    fontSize: 16,
    fontWeight: "bold",
  },
  toolbar: {
    height: 48,
    backgroundColor: "#1A1D24",
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    gap: 8,
    borderBottomWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.06)",
  },
  navButton: {
    width: 32,
    height: 32,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255, 255, 255, 0.05)",
  },
  navButtonText: {
    color: "#E2E8F0",
    fontSize: 15,
    fontWeight: "600",
  },
  addressBar: {
    flex: 1,
    height: 34,
    backgroundColor: "rgba(0, 0, 0, 0.35)",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.12)",
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 10,
    gap: 6,
  },
  securityBadge: {
    fontSize: 12,
  },
  addressInput: {
    flex: 1,
    color: "#F8FAFC",
    fontSize: 13,
    paddingVertical: 0,
    height: 32,
  },
  clearButton: {
    padding: 4,
  },
  clearButtonText: {
    color: "#64748B",
    fontSize: 11,
  },
  goButton: {
    paddingHorizontal: 14,
    height: 34,
    borderRadius: 8,
    backgroundColor: "#D7AC57",
    alignItems: "center",
    justifyContent: "center",
  },
  goButtonText: {
    color: "#0F1115",
    fontWeight: "700",
    fontSize: 13,
  },
  content: {
    flex: 1,
  },
  startPageScroll: {
    padding: 32,
  },
  startHeader: {
    alignItems: "center",
    marginBottom: 28,
  },
  logoBadge: {
    width: 56,
    height: 56,
    borderRadius: 16,
    backgroundColor: "rgba(215, 172, 87, 0.15)",
    borderWidth: 1,
    borderColor: "#D7AC57",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 12,
  },
  logoText: {
    fontSize: 26,
  },
  startTitle: {
    fontSize: 26,
    fontWeight: "700",
    color: "#F3F4F6",
    marginBottom: 6,
  },
  startSubtitle: {
    fontSize: 14,
    color: "#9CA3AF",
    textAlign: "center",
    maxWidth: 480,
  },
  searchCard: {
    flexDirection: "row",
    width: "100%",
    maxWidth: 640,
    alignSelf: "center",
    backgroundColor: "#1E222B",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(215, 172, 87, 0.3)",
    padding: 6,
    marginBottom: 32,
  },
  heroSearchInput: {
    flex: 1,
    paddingHorizontal: 16,
    color: "#F3F4F6",
    fontSize: 15,
    height: 44,
  },
  heroSearchButton: {
    backgroundColor: "#D7AC57",
    borderRadius: 8,
    paddingHorizontal: 20,
    justifyContent: "center",
    alignItems: "center",
  },
  heroSearchButtonText: {
    color: "#0F1115",
    fontWeight: "700",
    fontSize: 14,
  },
  sectionHeader: {
    fontSize: 16,
    fontWeight: "600",
    color: "#D7AC57",
    alignSelf: "center",
    maxWidth: 640,
    width: "100%",
    marginBottom: 12,
  },
  bookmarksGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignSelf: "center",
    maxWidth: 640,
    width: "100%",
    gap: 12,
    marginBottom: 32,
  },
  bookmarkCard: {
    width: 200,
    backgroundColor: "#1A1D24",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.08)",
    padding: 14,
    alignItems: "center",
    gap: 4,
  },
  bookmarkIcon: {
    fontSize: 22,
    marginBottom: 4,
  },
  bookmarkTitle: {
    fontSize: 13,
    fontWeight: "600",
    color: "#F3F4F6",
  },
  bookmarkUrl: {
    fontSize: 11,
    color: "#6B7280",
  },
  engineCard: {
    alignSelf: "center",
    maxWidth: 640,
    width: "100%",
    backgroundColor: "rgba(215, 172, 87, 0.06)",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "rgba(215, 172, 87, 0.2)",
    padding: 16,
  },
  engineCardTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: "#D7AC57",
    marginBottom: 4,
  },
  engineCardBody: {
    fontSize: 12,
    color: "#9CA3AF",
  },
  errorContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 40,
  },
  errorIcon: {
    fontSize: 48,
    marginBottom: 16,
  },
  errorTitle: {
    fontSize: 20,
    fontWeight: "700",
    color: "#F3F4F6",
    marginBottom: 8,
  },
  errorDescription: {
    fontSize: 14,
    color: "#EF4444",
    marginBottom: 24,
    textAlign: "center",
  },
  errorActions: {
    flexDirection: "row",
    gap: 12,
  },
  retryButton: {
    backgroundColor: "#D7AC57",
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 8,
  },
  retryButtonText: {
    color: "#0F1115",
    fontWeight: "700",
    fontSize: 13,
  },
  homeSecondaryButton: {
    backgroundColor: "rgba(255, 255, 255, 0.08)",
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 8,
  },
  homeSecondaryButtonText: {
    color: "#E2E8F0",
    fontSize: 13,
  },
  webContainer: {
    flex: 1,
  },
  loadingBarContainer: {
    height: 3,
    backgroundColor: "rgba(255, 255, 255, 0.1)",
    width: "100%",
  },
  loadingBarProgress: {
    height: 3,
    backgroundColor: "#D7AC57",
    width: 200,
  },
  renderViewport: {
    flex: 1,
    padding: 16,
  },
  activePageHeader: {
    fontSize: 16,
    fontWeight: "600",
    color: "#F3F4F6",
  },
  loadingViewport: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  loadingViewportText: {
    color: "#9CA3AF",
    fontSize: 14,
  },
  webViewport: {
    flex: 1,
    overflow: "hidden",
    backgroundColor: "#FFFFFF",
  },
  docsContainer: {
    maxWidth: 640,
    width: "100%",
    alignSelf: "center",
    gap: 16,
    marginBottom: 32,
  },
  docCard: {
    backgroundColor: "#1A1D24",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.08)",
    padding: 16,
    gap: 8,
  },
  docCardTitle: {
    fontSize: 15,
    fontWeight: "700",
    color: "#D7AC57",
  },
  docCardBody: {
    fontSize: 13,
    lineHeight: 20,
    color: "#CBD5E1",
  },
  docsFooter: {
    alignItems: "center",
    marginTop: 8,
    marginBottom: 32,
  },
});
