/**
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
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

export type DesktopAppDrawerFilter = "all" | "running";

export interface DesktopAppDrawerProps {
  readonly applications?: readonly MobileApplicationSummary[];
  readonly open?: boolean;
  readonly onClose?: () => void;
  readonly onLaunch?: (applicationId: string) => Promise<void> | void;
}

/**
 * Desktop application drawer rendered as a React Native component.
 * Slides in from the left edge of the display with a searchable grid of
 * installed applications. It owns only transient presentation state;
 * application launch and dismissal remain explicit host callbacks.
 */
export function DesktopAppDrawer({
  applications = [],
  open = true,
  onClose,
  onLaunch,
}: DesktopAppDrawerProps = {}): JSX.Element | null {
  const { height } = useWindowDimensions();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<DesktopAppDrawerFilter>("all");
  const [launchingId, setLaunchingId] = useState<string | undefined>(undefined);
  const [launchError, setLaunchError] = useState<string | undefined>(undefined);

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

  const runningCount = applications.filter(
    (application) => application.running === true,
  ).length;

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
      <View style={styles.drawer}>
        <View style={styles.specularLine} />
        <View style={styles.header}>
          <View>
            <Text style={styles.eyebrow}>SEVYNOS</Text>
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
          <DrawerFilterButton
            active={filter === "all"}
            label={`All ${String(applications.length)}`}
            onPress={() => {
              setFilter("all");
            }}
          />
          <DrawerFilterButton
            active={filter === "running"}
            label={`Running ${String(runningCount)}`}
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
          contentContainerStyle={styles.content}
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
            <View style={styles.grid}>
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
                      pressed && styles.applicationPressed,
                    ]}
                  >
                    <View style={styles.iconArea}>
                      <ApplicationIcon application={application} size={56} />
                      {launching ? (
                        <View style={styles.loadingOverlay}>
                          <ActivityIndicator
                            color={SevynShellTheme.colors.primary}
                            size="small"
                          />
                        </View>
                      ) : null}
                    </View>
                    <View style={styles.applicationText}>
                      <Text numberOfLines={1} style={styles.applicationName}>
                        {application.name}
                      </Text>
                      {application.subtitle ? (
                        <Text numberOfLines={1} style={styles.applicationSubtitle}>
                          {application.subtitle}
                        </Text>
                      ) : null}
                    </View>
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

interface DrawerFilterButtonProps {
  readonly active: boolean;
  readonly label: string;
  readonly onPress: () => void;
}

function DrawerFilterButton({
  active,
  label,
  onPress,
}: DrawerFilterButtonProps): JSX.Element {
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
    backgroundColor: SevynShellTheme.colors.overlay,
    bottom: 0,
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
  },
  drawer: {
    backgroundColor: SevynShellTheme.colors.launcherSurface,
    borderColor: SevynShellTheme.colors.launcherBorder,
    borderRightWidth: 1,
    bottom: 0,
    left: 0,
    overflow: "hidden",
    paddingTop: 20,
    position: "absolute",
    top: 0,
    width: 400,
  },
  specularLine: {
    backgroundColor: SevynShellTheme.colors.glassSpecular,
    bottom: 0,
    position: "absolute",
    right: 0,
    top: 0,
    width: 1,
  },
  header: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 24,
  },
  eyebrow: {
    color: SevynShellTheme.colors.gold,
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 2,
  },
  title: {
    color: SevynShellTheme.colors.primary,
    fontSize: 26,
    fontWeight: "700",
    letterSpacing: -0.6,
    marginTop: 4,
  },
  closeButton: {
    alignItems: "center",
    backgroundColor: SevynShellTheme.colors.glassLight,
    borderColor: SevynShellTheme.colors.border,
    borderRadius: 16,
    borderWidth: 1,
    height: 32,
    justifyContent: "center",
    width: 32,
  },
  closeText: {
    color: SevynShellTheme.colors.secondary,
    fontSize: 22,
    fontWeight: "300",
    lineHeight: 24,
  },
  searchBox: {
    alignItems: "center",
    backgroundColor: SevynShellTheme.colors.launcherSearchBackground,
    borderColor: SevynShellTheme.colors.launcherSearchBorder,
    borderRadius: SevynShellTheme.radius.md,
    borderWidth: 1,
    flexDirection: "row",
    height: 44,
    marginHorizontal: 24,
    marginTop: 18,
    paddingHorizontal: 13,
  },
  searchGlyph: { height: 17, width: 17 },
  searchRing: {
    borderColor: SevynShellTheme.colors.secondary,
    borderRadius: 6,
    borderWidth: 1.5,
    height: 11,
    left: 1,
    position: "absolute",
    top: 1,
    width: 11,
  },
  searchHandle: {
    backgroundColor: SevynShellTheme.colors.secondary,
    bottom: 2,
    height: 1.5,
    position: "absolute",
    right: 0,
    transform: [{ rotate: "45deg" }],
    width: 6,
  },
  searchInput: {
    color: SevynShellTheme.colors.primary,
    flex: 1,
    fontSize: 13,
    height: "100%",
    marginLeft: 10,
    paddingVertical: 0,
  },
  clearButton: {
    alignItems: "center",
    backgroundColor: SevynShellTheme.colors.elevatedSurface,
    borderRadius: 11,
    height: 22,
    justifyContent: "center",
    width: 22,
  },
  clearText: { color: SevynShellTheme.colors.secondary, fontSize: 16, lineHeight: 18 },
  filters: {
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 24,
    paddingVertical: 14,
  },
  filterButton: {
    backgroundColor: SevynShellTheme.colors.glassLight,
    borderColor: SevynShellTheme.colors.border,
    borderRadius: SevynShellTheme.radius.round,
    borderWidth: 1,
    paddingHorizontal: 13,
    paddingVertical: 6,
  },
  filterButtonActive: {
    backgroundColor: SevynShellTheme.colors.accentSoft,
    borderColor: "rgba(159, 168, 255, 0.38)",
  },
  filterText: { color: SevynShellTheme.colors.muted, fontSize: 11, fontWeight: "700" },
  filterTextActive: { color: SevynShellTheme.colors.primary },
  errorBanner: {
    backgroundColor: "rgba(244, 109, 117, 0.12)",
    borderColor: "rgba(244, 109, 117, 0.34)",
    borderRadius: SevynShellTheme.radius.md,
    borderWidth: 1,
    marginBottom: 8,
    marginHorizontal: 24,
    padding: 10,
  },
  errorText: { color: "#FFB7BC", fontSize: 12 },
  scroller: { flex: 1 },
  content: { paddingBottom: 32, paddingHorizontal: 16, paddingTop: 4 },
  grid: { flexDirection: "column" },
  application: {
    alignItems: "center",
    borderRadius: SevynShellTheme.radius.md,
    flexDirection: "row",
    gap: 14,
    paddingHorizontal: 10,
    paddingVertical: 9,
  },
  applicationPressed: { backgroundColor: SevynShellTheme.colors.launcherTileHover },
  iconArea: { position: "relative" },
  applicationText: { flex: 1 },
  applicationName: {
    color: SevynShellTheme.colors.primary,
    fontSize: 14,
    fontWeight: "600",
  },
  applicationSubtitle: {
    color: SevynShellTheme.colors.muted,
    fontSize: 11,
    marginTop: 2,
  },
  runningDot: {
    backgroundColor: SevynShellTheme.colors.success,
    borderRadius: 3,
    height: 6,
    width: 6,
  },
  loadingOverlay: {
    alignItems: "center",
    backgroundColor: "rgba(5, 6, 10, 0.65)",
    borderRadius: SevynShellTheme.radius.md,
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
