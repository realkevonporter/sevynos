import { useMemo, useState, type JSX } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { SevynShellTheme } from "../theme.js";
import {
  iconGlyphForManifestIcon,
  ShellGlyph,
  tileColorForApplication,
} from "./application-icons.js";

export interface MobileApplicationSummary {
  readonly id: string;
  readonly name: string;
  readonly subtitle?: string;
  readonly accent?: string;
  readonly running?: boolean;
  /**
   * Manifest icon path (SevynApplicationManifest.icon, e.g.
   * "icons/browser.svg"). ApplicationIcon renders the matching vector glyph
   * from the app's custom SVG icon set; when absent it falls back to the
   * letter tile.
   */
  readonly icon?: string | undefined;
}

export interface MobileHomeApplicationProps {
  readonly applications: readonly MobileApplicationSummary[];
  readonly onLaunch: (applicationId: string) => Promise<void>;
}

export function MobileHomeApplication(props: MobileHomeApplicationProps): JSX.Element {
  const { width } = useWindowDimensions();
  const [query, setQuery] = useState("");
  const [launchingApplicationId, setLaunchingApplicationId] = useState<string>();
  const [launchError, setLaunchError] = useState<string>();
  const compact = width < 430;
  const horizontalPadding = compact ? 20 : 28;
  const columnCount = width >= 720 ? 6 : width >= 520 ? 5 : 4;
  const columnGap = compact ? 12 : 16;
  const tileWidth = Math.floor(
    (width - horizontalPadding * 2 - columnGap * (columnCount - 1)) / columnCount,
  );
  const visibleApplications = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (normalizedQuery.length === 0) return props.applications;
    return props.applications.filter((application) =>
      `${application.name} ${application.subtitle ?? ""}`
        .toLocaleLowerCase()
        .includes(normalizedQuery),
    );
  }, [props.applications, query]);
  const featuredApplication = props.applications[0];

  const launch = (applicationId: string): void => {
    setLaunchError(undefined);
    setLaunchingApplicationId(applicationId);
    void props
      .onLaunch(applicationId)
      .catch((error: unknown) => {
        setLaunchError(
          error instanceof Error ? error.message : "The application could not open.",
        );
      })
      .finally(() => {
        setLaunchingApplicationId(undefined);
      });
  };

  return (
    <ScrollView
      contentContainerStyle={[styles.content, { paddingHorizontal: horizontalPadding }]}
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
      style={styles.container}
    >
      <View style={styles.masthead}>
        <View>
          <View style={styles.brandRow}>
            <SevynMark />
            <Text style={styles.brand}>SEVYN OS</Text>
          </View>
          <Text style={[styles.heading, compact && styles.headingCompact]}>
            Your space,
            {"\n"}
            ready when you are.
          </Text>
        </View>
        <View style={styles.profileBadge}>
          <Text style={styles.profileInitial}>S</Text>
        </View>
      </View>

      <View style={styles.searchContainer}>
        <SearchGlyph />
        <TextInput
          accessibilityLabel="Search applications"
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={setQuery}
          placeholder="Search your applications"
          placeholderTextColor={SevynShellTheme.colors.muted}
          returnKeyType="search"
          selectionColor={SevynShellTheme.colors.accent}
          style={styles.searchInput}
          value={query}
        />
        {query.length > 0 ? (
          <Pressable
            accessibilityLabel="Clear application search"
            accessibilityRole="button"
            hitSlop={10}
            onPress={(): void => {
              setQuery("");
            }}
            style={({ pressed }) => [styles.clearButton, pressed && styles.pressed]}
          >
            <Text style={styles.clearButtonText}>×</Text>
          </Pressable>
        ) : null}
      </View>

      {query.length === 0 && featuredApplication !== undefined ? (
        <Pressable
          accessibilityLabel={`Open ${featuredApplication.name}`}
          accessibilityRole="button"
          onPress={(): void => {
            launch(featuredApplication.id);
          }}
          style={({ pressed }) => [
            styles.featuredCard,
            pressed && styles.featuredCardPressed,
          ]}
        >
          <View style={styles.featuredCopy}>
            <View style={styles.featuredEyebrowRow}>
              <View style={styles.featuredDot} />
              <Text style={styles.featuredEyebrow}>
                {featuredApplication.running ? "CONTINUE" : "READY FOR YOU"}
              </Text>
            </View>
            <Text numberOfLines={1} style={styles.featuredTitle}>
              {featuredApplication.name}
            </Text>
            <Text numberOfLines={2} style={styles.featuredSubtitle}>
              {featuredApplication.subtitle ?? "Open your SevynOS application"}
            </Text>
            <View style={styles.openAction}>
              <Text style={styles.openActionText}>Open</Text>
              <Text style={styles.openActionArrow}>→</Text>
            </View>
          </View>
          <View style={styles.featuredIconWrap}>
            <ApplicationIcon application={featuredApplication} size={74} />
          </View>
        </Pressable>
      ) : null}

      <View style={styles.sectionHeading}>
        <Text style={styles.sectionTitle}>
          {query.length === 0 ? "Applications" : "Search results"}
        </Text>
        <Text style={styles.sectionCount}>{visibleApplications.length}</Text>
      </View>

      {launchError === undefined ? null : (
        <View accessibilityRole="alert" style={styles.errorBanner}>
          <Text style={styles.errorText}>{launchError}</Text>
        </View>
      )}

      {visibleApplications.length === 0 ? (
        <View style={styles.emptyState}>
          <View style={styles.emptyGlyph}>
            <SearchGlyph />
          </View>
          <Text style={styles.emptyTitle}>No matches</Text>
          <Text style={styles.emptyMessage}>
            Try another name or clear your search to see every application.
          </Text>
        </View>
      ) : (
        <View style={[styles.grid, { columnGap }]}>
          {visibleApplications.map((application) => {
            const launching = launchingApplicationId === application.id;
            return (
              <Pressable
                key={application.id}
                accessibilityLabel={`Open ${application.name}`}
                accessibilityRole="button"
                disabled={launching}
                onPress={(): void => {
                  launch(application.id);
                }}
                style={({ pressed }) => [
                  styles.application,
                  { width: tileWidth },
                  pressed && styles.applicationPressed,
                ]}
              >
                <View style={styles.applicationIconArea}>
                  <ApplicationIcon
                    application={application}
                    size={Math.min(tileWidth - 6, 66)}
                  />
                  {launching ? (
                    <View style={styles.loadingOverlay}>
                      <ActivityIndicator color={SevynShellTheme.colors.primary} />
                    </View>
                  ) : null}
                </View>
                <Text numberOfLines={1} style={styles.applicationName}>
                  {application.name}
                </Text>
                {application.running ? <View style={styles.runningIndicator} /> : null}
              </Pressable>
            );
          })}
        </View>
      )}
    </ScrollView>
  );
}

export const MobileLauncherApplication = MobileHomeApplication;
export type MobileLauncherApplicationProps = MobileHomeApplicationProps;

export interface ApplicationIconProps {
  readonly application: MobileApplicationSummary;
  readonly size: number;
}

export function ApplicationIcon({
  application,
  size,
}: ApplicationIconProps): JSX.Element {
  const tileColor = tileColorForApplication(
    application.id,
    application.accent ?? colorForApplication(application.id),
    SevynShellTheme.colors.accent,
  );
  const tileStyle = {
    backgroundColor: tileColor,
    borderRadius: Math.round(size * 0.27),
    height: size,
    width: size,
  };
  const glyph = iconGlyphForManifestIcon(application.icon);
  if (glyph !== undefined) {
    const glyphSize = Math.round(size * 0.62);
    return (
      <View style={[styles.icon, tileStyle]}>
        <View style={styles.iconLight} />
        <View style={styles.iconGlyphWrap}>
          <ShellGlyph name={glyph} size={glyphSize} />
        </View>
      </View>
    );
  }
  const accent = application.accent ?? colorForApplication(application.id);
  const fontSize = Math.max(15, Math.round(size * 0.32));
  return (
    <View
      style={[
        styles.icon,
        {
          backgroundColor: accent,
          borderRadius: Math.round(size * 0.27),
          height: size,
          width: size,
        },
      ]}
    >
      <View style={styles.iconLight} />
      <View style={styles.iconOrbit} />
      <Text style={[styles.iconText, { fontSize }]}>
        {application.name.trim().slice(0, 1).toLocaleUpperCase() || "7"}
      </Text>
    </View>
  );
}

export function SevynMark(): JSX.Element {
  return (
    <View accessibilityElementsHidden style={styles.sevynMark}>
      <View style={styles.markTop} />
      <View style={styles.markMiddle} />
      <View style={styles.markBottom} />
    </View>
  );
}

function SearchGlyph(): JSX.Element {
  return (
    <View accessibilityElementsHidden style={styles.searchGlyph}>
      <View style={styles.searchRing} />
      <View style={styles.searchHandle} />
    </View>
  );
}

function colorForApplication(applicationId: string): string {
  const palette = ["#7D88EB", "#D17C66", "#4C9A8A", "#B47BC4", "#C5974E"] as const;
  let hash = 0;
  for (const character of applicationId) hash += character.codePointAt(0) ?? 0;
  return palette[hash % palette.length] ?? SevynShellTheme.colors.accent;
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { paddingBottom: 36, paddingTop: 16 },
  masthead: {
    alignItems: "flex-start",
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 24,
  },
  brandRow: { alignItems: "center", flexDirection: "row", gap: 9 },
  brand: {
    color: SevynShellTheme.colors.gold,
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 2.8,
  },
  heading: {
    color: SevynShellTheme.colors.primary,
    fontSize: 34,
    fontWeight: "700",
    letterSpacing: -1.25,
    lineHeight: 39,
    marginTop: 16,
  },
  headingCompact: { fontSize: 30, lineHeight: 35 },
  profileBadge: {
    alignItems: "center",
    backgroundColor: SevynShellTheme.colors.goldSoft,
    borderColor: "rgba(230, 196, 122, 0.34)",
    borderRadius: SevynShellTheme.radius.round,
    borderWidth: 1,
    height: 40,
    justifyContent: "center",
    width: 40,
  },
  profileInitial: {
    color: SevynShellTheme.colors.gold,
    fontSize: 14,
    fontWeight: "800",
  },
  searchContainer: {
    alignItems: "center",
    backgroundColor: SevynShellTheme.colors.glassStrong,
    borderColor: SevynShellTheme.colors.border,
    borderRadius: SevynShellTheme.radius.lg,
    borderWidth: 1,
    flexDirection: "row",
    height: 54,
    paddingHorizontal: 17,
  },
  searchInput: {
    color: SevynShellTheme.colors.primary,
    flex: 1,
    fontSize: 15,
    height: "100%",
    marginLeft: 12,
    paddingVertical: 0,
  },
  clearButton: {
    alignItems: "center",
    backgroundColor: SevynShellTheme.colors.surface,
    borderRadius: SevynShellTheme.radius.round,
    height: 28,
    justifyContent: "center",
    width: 28,
  },
  clearButtonText: {
    color: SevynShellTheme.colors.secondary,
    fontSize: 21,
    lineHeight: 23,
  },
  pressed: { opacity: 0.68 },
  searchGlyph: { height: 20, position: "relative", width: 20 },
  searchRing: {
    borderColor: SevynShellTheme.colors.secondary,
    borderRadius: SevynShellTheme.radius.round,
    borderWidth: 1.7,
    height: 13,
    left: 1,
    position: "absolute",
    top: 1,
    width: 13,
  },
  searchHandle: {
    backgroundColor: SevynShellTheme.colors.secondary,
    borderRadius: 2,
    bottom: 3,
    height: 1.7,
    position: "absolute",
    right: 1,
    transform: [{ rotate: "45deg" }],
    width: 8,
  },
  featuredCard: {
    backgroundColor: SevynShellTheme.colors.glass,
    borderColor: SevynShellTheme.colors.borderStrong,
    borderRadius: SevynShellTheme.radius.xl,
    borderWidth: 1,
    flexDirection: "row",
    marginTop: 18,
    minHeight: 166,
    overflow: "hidden",
    padding: 22,
  },
  featuredCardPressed: { opacity: 0.82, transform: [{ scale: 0.99 }] },
  featuredCopy: { flex: 1, justifyContent: "center", paddingRight: 14 },
  featuredEyebrowRow: { alignItems: "center", flexDirection: "row", gap: 7 },
  featuredDot: {
    backgroundColor: SevynShellTheme.colors.success,
    borderRadius: SevynShellTheme.radius.round,
    height: 6,
    width: 6,
  },
  featuredEyebrow: {
    color: SevynShellTheme.colors.secondary,
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 1.7,
  },
  featuredTitle: {
    color: SevynShellTheme.colors.primary,
    fontSize: 25,
    fontWeight: "700",
    letterSpacing: -0.6,
    marginTop: 10,
  },
  featuredSubtitle: {
    color: SevynShellTheme.colors.secondary,
    fontSize: 13,
    lineHeight: 18,
    marginTop: 5,
  },
  openAction: { alignItems: "center", flexDirection: "row", gap: 7, marginTop: 14 },
  openActionText: {
    color: SevynShellTheme.colors.gold,
    fontSize: 13,
    fontWeight: "700",
  },
  openActionArrow: { color: SevynShellTheme.colors.gold, fontSize: 16 },
  featuredIconWrap: { alignItems: "center", justifyContent: "center" },
  sectionHeading: {
    alignItems: "center",
    flexDirection: "row",
    marginBottom: 16,
    marginTop: 28,
  },
  sectionTitle: {
    color: SevynShellTheme.colors.primary,
    fontSize: 20,
    fontWeight: "700",
    letterSpacing: -0.35,
  },
  sectionCount: {
    color: SevynShellTheme.colors.muted,
    fontSize: 12,
    fontWeight: "700",
    marginLeft: 9,
  },
  grid: { flexDirection: "row", flexWrap: "wrap", rowGap: 22 },
  application: { alignItems: "center" },
  applicationPressed: { opacity: 0.62, transform: [{ scale: 0.96 }] },
  applicationIconArea: { position: "relative" },
  applicationName: {
    color: SevynShellTheme.colors.primary,
    fontSize: 12,
    fontWeight: "600",
    marginTop: 9,
    textAlign: "center",
    width: "100%",
  },
  runningIndicator: {
    backgroundColor: SevynShellTheme.colors.gold,
    borderRadius: SevynShellTheme.radius.round,
    height: 3,
    marginTop: 5,
    width: 14,
  },
  icon: {
    alignItems: "center",
    borderColor: "rgba(255, 255, 255, 0.24)",
    borderWidth: 1,
    justifyContent: "center",
    overflow: "hidden",
    shadowColor: "#000000",
    shadowOffset: { height: 7, width: 0 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
  },
  iconLight: {
    backgroundColor: "rgba(255, 255, 255, 0.19)",
    borderRadius: SevynShellTheme.radius.round,
    height: "82%",
    left: "-18%",
    position: "absolute",
    top: "-36%",
    width: "112%",
  },
  iconOrbit: {
    borderColor: "rgba(255, 255, 255, 0.22)",
    borderRadius: SevynShellTheme.radius.round,
    borderWidth: 1,
    bottom: "-33%",
    height: "74%",
    position: "absolute",
    right: "-18%",
    width: "74%",
  },
  iconGlyphWrap: {
    alignItems: "center",
    height: "100%",
    justifyContent: "center",
    width: "100%",
  },
  iconText: {
    color: "#FFFFFF",
    fontWeight: "800",
    textShadowColor: "rgba(0, 0, 0, 0.18)",
    textShadowOffset: { height: 1, width: 0 },
    textShadowRadius: 3,
  },
  loadingOverlay: {
    alignItems: "center",
    backgroundColor: "rgba(5, 6, 10, 0.62)",
    borderRadius: SevynShellTheme.radius.lg,
    bottom: 0,
    justifyContent: "center",
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
  },
  errorBanner: {
    backgroundColor: "rgba(244, 109, 117, 0.12)",
    borderColor: "rgba(244, 109, 117, 0.36)",
    borderRadius: SevynShellTheme.radius.md,
    borderWidth: 1,
    marginBottom: 16,
    padding: 12,
  },
  errorText: { color: "#FFB7BC", fontSize: 12, lineHeight: 17 },
  emptyState: { alignItems: "center", paddingHorizontal: 26, paddingVertical: 48 },
  emptyGlyph: {
    alignItems: "center",
    backgroundColor: SevynShellTheme.colors.surface,
    borderRadius: SevynShellTheme.radius.round,
    height: 52,
    justifyContent: "center",
    width: 52,
  },
  emptyTitle: {
    color: SevynShellTheme.colors.primary,
    fontSize: 17,
    fontWeight: "700",
    marginTop: 16,
  },
  emptyMessage: {
    color: SevynShellTheme.colors.secondary,
    fontSize: 13,
    lineHeight: 19,
    marginTop: 6,
    textAlign: "center",
  },
  sevynMark: { height: 17, justifyContent: "space-between", width: 18 },
  markTop: {
    alignSelf: "flex-end",
    backgroundColor: SevynShellTheme.colors.gold,
    borderRadius: 2,
    height: 4,
    width: 13,
  },
  markMiddle: {
    alignSelf: "center",
    backgroundColor: SevynShellTheme.colors.gold,
    borderRadius: 2,
    height: 4,
    width: 13,
  },
  markBottom: {
    alignSelf: "flex-start",
    backgroundColor: SevynShellTheme.colors.gold,
    borderRadius: 2,
    height: 4,
    width: 13,
  },
});
