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
import { ApplicationIcon, type MobileApplicationSummary } from "../mobile-home/mobile.js";
import { SevynShellTheme } from "../theme.js";

export type AppDrawerFilter = "all" | "running";

export interface AppDrawerApplicationProps {
  readonly applications?: readonly MobileApplicationSummary[];
  readonly open?: boolean;
  readonly onClose?: () => void;
  readonly onLaunch?: (applicationId: string) => Promise<void> | void;
}

/**
 * Native mobile application browser used by the app-drawer system role.
 * It owns only transient presentation state; application launch and dismissal
 * remain explicit host callbacks.
 */
export function AppDrawerApplication({
  applications = [],
  open = true,
  onClose,
  onLaunch,
}: AppDrawerApplicationProps = {}): JSX.Element | null {
  const { width, height } = useWindowDimensions();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<AppDrawerFilter>("all");
  const [launchingId, setLaunchingId] = useState<string>();
  const [launchError, setLaunchError] = useState<string>();
  const horizontalPadding = width < 430 ? 18 : 26;
  const columnCount = width >= 700 ? 6 : width >= 520 ? 5 : 4;
  const gap = width < 430 ? 12 : 16;
  const tileWidth = Math.max(
    64,
    Math.floor((width - horizontalPadding * 2 - gap * (columnCount - 1)) / columnCount),
  );

  const visibleApplications = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return applications.filter((application) => {
      if (filter === "running" && application.running !== true) return false;
      if (normalizedQuery.length === 0) return true;
      return `${application.name} ${application.subtitle ?? ""}`
        .toLocaleLowerCase()
        .includes(normalizedQuery);
    });
  }, [applications, filter, query]);

  if (!open) return null;

  const launch = (applicationId: string): void => {
    setLaunchError(undefined);
    setLaunchingId(applicationId);
    Promise.resolve(onLaunch?.(applicationId))
      .then(() => {
        onClose?.();
      })
      .catch((error: unknown) => {
        setLaunchError(
          error instanceof Error ? error.message : "This application could not open.",
        );
      })
      .finally(() => {
        setLaunchingId(undefined);
      });
  };

  return (
    <View
      accessibilityLabel="Application drawer"
      accessibilityViewIsModal
      style={[styles.overlay, { height }]}
    >
      <Pressable
        accessibilityLabel="Close application drawer"
        accessibilityRole="button"
        onPress={onClose}
        style={styles.backdrop}
      />

      <View style={styles.sheet}>
        <View style={styles.handle} />
        <View style={styles.header}>
          <View>
            <Text style={styles.eyebrow}>YOUR SPACE</Text>
            <Text style={styles.title}>Applications</Text>
          </View>
          <Pressable
            accessibilityLabel="Close application drawer"
            accessibilityRole="button"
            onPress={onClose}
            style={({ pressed }) => [styles.closeButton, pressed && styles.pressed]}
          >
            <Text style={styles.closeText}>×</Text>
          </Pressable>
        </View>

        <View style={styles.searchBox}>
          <View accessibilityElementsHidden style={styles.searchGlyph}>
            <View style={styles.searchRing} />
            <View style={styles.searchHandle} />
          </View>
          <TextInput
            accessibilityLabel="Search applications"
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={setQuery}
            placeholder="Search applications"
            placeholderTextColor={SevynShellTheme.colors.muted}
            returnKeyType="search"
            selectionColor={SevynShellTheme.colors.accent}
            style={styles.searchInput}
            value={query}
          />
          {query.length === 0 ? null : (
            <Pressable
              accessibilityLabel="Clear search"
              accessibilityRole="button"
              hitSlop={10}
              onPress={() => {
                setQuery("");
              }}
              style={({ pressed }) => [styles.clearButton, pressed && styles.pressed]}
            >
              <Text style={styles.clearText}>×</Text>
            </Pressable>
          )}
        </View>

        <View accessibilityRole="tablist" style={styles.filters}>
          <FilterButton
            active={filter === "all"}
            label={`All ${String(applications.length)}`}
            onPress={() => {
              setFilter("all");
            }}
          />
          <FilterButton
            active={filter === "running"}
            label={`Running ${String(applications.filter((app) => app.running === true).length)}`}
            onPress={() => {
              setFilter("running");
            }}
          />
        </View>

        {launchError === undefined ? null : (
          <View accessibilityRole="alert" style={styles.errorBanner}>
            <Text style={styles.errorText}>{launchError}</Text>
          </View>
        )}

        <ScrollView
          contentContainerStyle={[
            styles.content,
            { paddingHorizontal: horizontalPadding },
          ]}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          style={styles.scroller}
        >
          {visibleApplications.length === 0 ? (
            <View style={styles.emptyState}>
              <View style={styles.emptyMark}>
                <Text style={styles.emptyMarkText}>7</Text>
              </View>
              <Text style={styles.emptyTitle}>
                {applications.length === 0 ? "No applications yet" : "No matches"}
              </Text>
              <Text style={styles.emptyBody}>
                {applications.length === 0
                  ? "Installed applications will appear here automatically."
                  : "Try another search or show all applications."}
              </Text>
            </View>
          ) : (
            <View style={[styles.grid, { columnGap: gap, rowGap: 22 }]}>
              {visibleApplications.map((application) => {
                const launching = launchingId === application.id;
                return (
                  <Pressable
                    key={application.id}
                    accessibilityLabel={`Open ${application.name}`}
                    accessibilityRole="button"
                    accessibilityState={{ busy: launching }}
                    disabled={launching}
                    onPress={() => {
                      launch(application.id);
                    }}
                    style={({ pressed }) => [
                      styles.application,
                      { width: tileWidth },
                      pressed && styles.applicationPressed,
                    ]}
                  >
                    <View style={styles.iconArea}>
                      <ApplicationIcon
                        application={application}
                        size={Math.min(64, tileWidth - 8)}
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
                    {application.running === true ? (
                      <View accessibilityLabel="Running" style={styles.runningDot} />
                    ) : null}
                  </Pressable>
                );
              })}
            </View>
          )}
        </ScrollView>
      </View>
    </View>
  );
}

function FilterButton({
  active,
  label,
  onPress,
}: {
  readonly active: boolean;
  readonly label: string;
  readonly onPress: () => void;
}): JSX.Element {
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.filterButton,
        active && styles.filterButtonActive,
        pressed && styles.pressed,
      ]}
    >
      <Text style={[styles.filterText, active && styles.filterTextActive]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  overlay: {
    bottom: 0,
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
    zIndex: 1200,
  },
  backdrop: {
    backgroundColor: "rgba(2, 4, 9, 0.64)",
    bottom: 0,
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
  },
  sheet: {
    backgroundColor: SevynShellTheme.colors.launcherSurface,
    borderColor: SevynShellTheme.colors.borderStrong,
    borderTopLeftRadius: 32,
    borderTopRightRadius: 32,
    borderWidth: 1,
    bottom: 0,
    height: "88%",
    left: 0,
    overflow: "hidden",
    paddingTop: 10,
    position: "absolute",
    right: 0,
  },
  handle: {
    alignSelf: "center",
    backgroundColor: SevynShellTheme.colors.borderStrong,
    borderRadius: SevynShellTheme.radius.round,
    height: 4,
    width: 38,
  },
  header: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 22,
    paddingTop: 18,
  },
  eyebrow: {
    color: SevynShellTheme.colors.gold,
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 2,
  },
  title: {
    color: SevynShellTheme.colors.primary,
    fontSize: 29,
    fontWeight: "700",
    letterSpacing: -0.8,
    marginTop: 3,
  },
  closeButton: {
    alignItems: "center",
    backgroundColor: SevynShellTheme.colors.glassLight,
    borderColor: SevynShellTheme.colors.border,
    borderRadius: 18,
    borderWidth: 1,
    height: 38,
    justifyContent: "center",
    width: 38,
  },
  closeText: {
    color: SevynShellTheme.colors.secondary,
    fontSize: 25,
    fontWeight: "300",
    lineHeight: 27,
  },
  searchBox: {
    alignItems: "center",
    backgroundColor: SevynShellTheme.colors.glass,
    borderColor: SevynShellTheme.colors.border,
    borderRadius: SevynShellTheme.radius.lg,
    borderWidth: 1,
    flexDirection: "row",
    height: 50,
    marginHorizontal: 22,
    marginTop: 18,
    paddingHorizontal: 15,
  },
  searchGlyph: { height: 19, width: 19 },
  searchRing: {
    borderColor: SevynShellTheme.colors.secondary,
    borderRadius: 7,
    borderWidth: 1.5,
    height: 12,
    left: 1,
    position: "absolute",
    top: 1,
    width: 12,
  },
  searchHandle: {
    backgroundColor: SevynShellTheme.colors.secondary,
    bottom: 3,
    height: 1.5,
    position: "absolute",
    right: 1,
    transform: [{ rotate: "45deg" }],
    width: 7,
  },
  searchInput: {
    color: SevynShellTheme.colors.primary,
    flex: 1,
    fontSize: 14,
    height: "100%",
    marginLeft: 11,
    paddingVertical: 0,
  },
  clearButton: {
    alignItems: "center",
    backgroundColor: SevynShellTheme.colors.surface,
    borderRadius: 13,
    height: 26,
    justifyContent: "center",
    width: 26,
  },
  clearText: { color: SevynShellTheme.colors.secondary, fontSize: 19, lineHeight: 21 },
  filters: {
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 22,
    paddingVertical: 14,
  },
  filterButton: {
    backgroundColor: SevynShellTheme.colors.glassLight,
    borderColor: SevynShellTheme.colors.border,
    borderRadius: SevynShellTheme.radius.round,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  filterButtonActive: {
    backgroundColor: SevynShellTheme.colors.accentSoft,
    borderColor: "rgba(159, 168, 255, 0.38)",
  },
  filterText: { color: SevynShellTheme.colors.muted, fontSize: 12, fontWeight: "700" },
  filterTextActive: { color: SevynShellTheme.colors.primary },
  errorBanner: {
    backgroundColor: "rgba(244, 109, 117, 0.12)",
    borderColor: "rgba(244, 109, 117, 0.34)",
    borderRadius: SevynShellTheme.radius.md,
    borderWidth: 1,
    marginBottom: 8,
    marginHorizontal: 22,
    padding: 11,
  },
  errorText: { color: "#FFB7BC", fontSize: 12 },
  scroller: { flex: 1 },
  content: { paddingBottom: 42, paddingTop: 8 },
  grid: { flexDirection: "row", flexWrap: "wrap" },
  application: { alignItems: "center" },
  applicationPressed: { opacity: 0.62, transform: [{ scale: 0.96 }] },
  iconArea: { position: "relative" },
  applicationName: {
    color: SevynShellTheme.colors.primary,
    fontSize: 12,
    fontWeight: "600",
    marginTop: 9,
    textAlign: "center",
    width: "100%",
  },
  runningDot: {
    backgroundColor: SevynShellTheme.colors.success,
    borderRadius: 3,
    height: 4,
    marginTop: 5,
    width: 13,
  },
  loadingOverlay: {
    alignItems: "center",
    backgroundColor: "rgba(5, 6, 10, 0.65)",
    borderRadius: SevynShellTheme.radius.lg,
    bottom: 0,
    justifyContent: "center",
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
  },
  emptyState: { alignItems: "center", paddingHorizontal: 28, paddingVertical: 58 },
  emptyMark: {
    alignItems: "center",
    backgroundColor: SevynShellTheme.colors.goldSoft,
    borderRadius: 24,
    height: 58,
    justifyContent: "center",
    width: 58,
  },
  emptyMarkText: { color: SevynShellTheme.colors.gold, fontSize: 24, fontWeight: "800" },
  emptyTitle: {
    color: SevynShellTheme.colors.primary,
    fontSize: 17,
    fontWeight: "700",
    marginTop: 16,
  },
  emptyBody: {
    color: SevynShellTheme.colors.secondary,
    fontSize: 13,
    lineHeight: 19,
    marginTop: 6,
    textAlign: "center",
  },
  pressed: { opacity: 0.64 },
});
