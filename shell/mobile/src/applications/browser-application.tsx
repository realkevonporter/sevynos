import type { ComponentType, JSX } from "react";
import { useRef, useState } from "react";
import {
  ActivityIndicator,
  Keyboard,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type NativeSyntheticEvent,
} from "react-native";
import WebView, { type WebViewNavigation, type WebViewProps } from "react-native-webview";
import { SevynShellTheme } from "@sevynos/system-applications";

const WebViewComponent = WebView as unknown as ComponentType<
  WebViewProps & { readonly ref?: unknown }
>;
const START_URL = "https://duckduckgo.com";
type WebViewErrorEvent = NativeSyntheticEvent<{ readonly description: string }>;

function normalizeAddress(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") return START_URL;
  if (/^[a-z][a-z\d+.-]*:/i.test(trimmed)) return trimmed;
  if (trimmed.includes(".") && !trimmed.includes(" ")) return `https://${trimmed}`;
  return `https://duckduckgo.com/?q=${encodeURIComponent(trimmed)}`;
}

export function BrowserApplication(): JSX.Element {
  const webView = useRef<WebView>(null);
  const [address, setAddress] = useState(START_URL);
  const [currentUrl, setCurrentUrl] = useState(START_URL);
  const [title, setTitle] = useState("New Tab");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);

  const navigate = (): void => {
    const nextUrl = normalizeAddress(address);
    setAddress(nextUrl);
    setError(undefined);
    Keyboard.dismiss();
    webView.current?.injectJavaScript(
      `window.location.href = ${JSON.stringify(nextUrl)}; true;`,
    );
  };

  const handleNavigation = (navigation: WebViewNavigation): void => {
    setCurrentUrl(navigation.url);
    setAddress(navigation.url);
    setTitle(navigation.title);
    setCanGoBack(navigation.canGoBack);
    setCanGoForward(navigation.canGoForward);
  };

  return (
    <View style={styles.container}>
      <View style={styles.toolbar}>
        <Pressable
          accessibilityLabel="Go back"
          accessibilityRole="button"
          disabled={!canGoBack}
          onPress={(): void => webView.current?.goBack()}
          style={({ pressed }) => [
            styles.navigationButton,
            (!canGoBack || pressed) && styles.navigationButtonMuted,
          ]}
        >
          <Text style={styles.navigationButtonText}>‹</Text>
        </Pressable>
        <Pressable
          accessibilityLabel="Go forward"
          accessibilityRole="button"
          disabled={!canGoForward}
          onPress={(): void => webView.current?.goForward()}
          style={({ pressed }) => [
            styles.navigationButton,
            (!canGoForward || pressed) && styles.navigationButtonMuted,
          ]}
        >
          <Text style={styles.navigationButtonText}>›</Text>
        </Pressable>
        <Pressable
          accessibilityLabel="Reload page"
          accessibilityRole="button"
          onPress={(): void => webView.current?.reload()}
          style={({ pressed }) => [styles.navigationButton, pressed && styles.pressed]}
        >
          <Text style={styles.navigationButtonText}>↻</Text>
        </Pressable>
        <TextInput
          accessibilityLabel="Address or search"
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={setAddress}
          onSubmitEditing={navigate}
          returnKeyType="go"
          selectTextOnFocus
          style={styles.addressInput}
          value={address}
        />
        <Pressable
          accessibilityLabel="Open address"
          accessibilityRole="button"
          onPress={navigate}
          style={({ pressed }) => [styles.goButton, pressed && styles.pressed]}
        >
          <Text style={styles.goButtonText}>Go</Text>
        </Pressable>
      </View>
      <View style={styles.statusBar}>
        <Text numberOfLines={1} style={styles.title}>
          {title || currentUrl}
        </Text>
        <Text style={styles.engineLabel}>
          {Platform.OS === "android" ? "Chromium engine" : "Secure web engine"}
        </Text>
      </View>
      {loading && (
        <View pointerEvents="none" style={styles.loadingOverlay}>
          <ActivityIndicator color={SevynShellTheme.colors.gold} />
          <Text style={styles.loadingText}>Loading page…</Text>
        </View>
      )}
      {error !== undefined && (
        <View style={styles.errorOverlay}>
          <Text style={styles.errorTitle}>Unable to load this page</Text>
          <Text style={styles.errorMessage}>{error}</Text>
          <Pressable
            onPress={(): void => webView.current?.reload()}
            style={styles.retryButton}
          >
            <Text style={styles.retryText}>Try again</Text>
          </Pressable>
        </View>
      )}
      <WebViewComponent
        allowsBackForwardNavigationGestures
        allowsInlineMediaPlayback
        cacheEnabled
        javaScriptEnabled
        onError={(event: WebViewErrorEvent): void => {
          setLoading(false);
          setError(event.nativeEvent.description);
        }}
        onLoadEnd={(): void => {
          setLoading(false);
        }}
        onLoadStart={(): void => {
          setLoading(true);
          setError(undefined);
        }}
        onNavigationStateChange={handleNavigation}
        ref={webView}
        sharedCookiesEnabled
        source={{ uri: START_URL }}
        style={styles.webView}
        textInteractionEnabled
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { backgroundColor: SevynShellTheme.colors.backgroundRaised, flex: 1 },
  toolbar: {
    alignItems: "center",
    backgroundColor: SevynShellTheme.colors.glassStrong,
    borderBottomColor: SevynShellTheme.colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 6,
    minHeight: 58,
    paddingHorizontal: 10,
  },
  navigationButton: {
    alignItems: "center",
    backgroundColor: SevynShellTheme.colors.glass,
    borderColor: SevynShellTheme.colors.border,
    borderRadius: 9,
    borderWidth: 1,
    height: 36,
    justifyContent: "center",
    width: 36,
  },
  navigationButtonMuted: { opacity: 0.35 },
  navigationButtonText: {
    color: SevynShellTheme.colors.primary,
    fontSize: 25,
    lineHeight: 28,
  },
  addressInput: {
    backgroundColor: "rgba(0, 0, 0, 0.22)",
    borderColor: SevynShellTheme.colors.border,
    borderRadius: 9,
    borderWidth: 1,
    color: SevynShellTheme.colors.primary,
    flex: 1,
    fontSize: 13,
    height: 38,
    paddingHorizontal: 12,
  },
  goButton: {
    alignItems: "center",
    backgroundColor: SevynShellTheme.colors.goldSoft,
    borderRadius: 9,
    height: 36,
    justifyContent: "center",
    paddingHorizontal: 12,
  },
  goButtonText: { color: SevynShellTheme.colors.gold, fontSize: 12, fontWeight: "700" },
  pressed: { opacity: 0.62 },
  statusBar: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
    minHeight: 32,
    paddingHorizontal: 12,
  },
  title: {
    color: SevynShellTheme.colors.primary,
    flex: 1,
    fontSize: 12,
    fontWeight: "600",
  },
  engineLabel: { color: SevynShellTheme.colors.success, fontSize: 10 },
  webView: { backgroundColor: "#FFFFFF", flex: 1 },
  loadingOverlay: {
    alignItems: "center",
    backgroundColor: "rgba(20, 24, 35, 0.88)",
    bottom: 0,
    justifyContent: "center",
    left: 0,
    position: "absolute",
    right: 0,
    top: 90,
    zIndex: 2,
  },
  loadingText: { color: SevynShellTheme.colors.primary, fontSize: 13, marginTop: 12 },
  errorOverlay: {
    alignItems: "center",
    backgroundColor: SevynShellTheme.colors.backgroundRaised,
    bottom: 0,
    justifyContent: "center",
    left: 0,
    padding: 24,
    position: "absolute",
    right: 0,
    top: 90,
    zIndex: 3,
  },
  errorTitle: { color: SevynShellTheme.colors.primary, fontSize: 16, fontWeight: "700" },
  errorMessage: {
    color: SevynShellTheme.colors.secondary,
    fontSize: 12,
    marginTop: 8,
    textAlign: "center",
  },
  retryButton: {
    backgroundColor: SevynShellTheme.colors.goldSoft,
    borderRadius: 9,
    marginTop: 16,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  retryText: { color: SevynShellTheme.colors.gold, fontSize: 12, fontWeight: "700" },
});
