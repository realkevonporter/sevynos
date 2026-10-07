/**
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import { useMemo, type JSX } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { ApplicationIcon } from "../mobile-home/mobile.js";
import { SevynShellTheme } from "../theme.js";
import type { DesktopLauncherRenderInput } from "../desktop.js";

/**
 * Desktop launcher (Launchpad) rendered as a React Native component.
 * macOS-style full-screen overlay: search field at the top, a responsive grid
 * of application tiles below, and the Reset Desktop action near the bottom.
 * The component is a pure function of the render input — visibility, the
 * search query, and the catalog all come from the host, matching the native
 * renderDesktopLauncher contract.
 */
export function DesktopLauncher(input: DesktopLauncherRenderInput): JSX.Element | null {
  const query = input.searchQuery?.trim().toLocaleLowerCase() ?? "";
  const visibleCatalog = useMemo(
    () =>
      input.catalog.filter(
        (entry) =>
          query.length === 0 ||
          entry.label.toLocaleLowerCase().includes(query) ||
          entry.applicationId.toLocaleLowerCase().includes(query),
      ),
    [input.catalog, query],
  );

  if (!input.open) return null;

  const margin = SevynShellTheme.spacing.lg;
  const gap = SevynShellTheme.launcher.gridGap;
  const minTileWidth = SevynShellTheme.launcher.minimumTileWidth;
  const contentWidth = Math.max(0, input.displayBounds.width - margin * 2);
  const columns = Math.max(
    1,
    Math.min(
      SevynShellTheme.launcher.maximumColumns,
      Math.floor((contentWidth + gap) / (minTileWidth + gap)),
    ),
  );
  const tileWidth = Math.floor((contentWidth - gap * (columns - 1)) / columns);
  const searchWidth = Math.min(SevynShellTheme.launcher.searchWidth, contentWidth);

  return (
    <View
      accessibilityLabel="Application launcher"
      accessibilityViewIsModal={true}
      style={[
        styles.surface,
        {
          left: input.displayBounds.x,
          top: input.displayBounds.y,
          width: input.displayBounds.width,
          height: input.displayBounds.height,
        },
      ]}
    >
      <View style={styles.header}>
        <Text style={styles.title}>Applications</Text>
        <Text style={styles.subtitle}>
          {visibleCatalog.length === input.catalog.length
            ? `${String(input.catalog.length)} applications`
            : `${String(visibleCatalog.length)} of ${String(input.catalog.length)} applications`}
        </Text>
      </View>
      <View style={[styles.searchBox, { width: searchWidth }]}>
        <TextInput
          accessibilityLabel="Search applications"
          autoCapitalize="none"
          autoCorrect={false}
          editable={false}
          placeholder="Search applications"
          placeholderTextColor={SevynShellTheme.colors.muted}
          style={styles.searchInput}
          value={input.searchQuery ?? ""}
        />
      </View>
      <ScrollView
        contentContainerStyle={[styles.grid, { gap }]}
        showsVerticalScrollIndicator={false}
        style={styles.gridScroll}
      >
        {visibleCatalog.map((entry) => (
          <Pressable
            key={entry.applicationId}
            accessibilityLabel={`Open ${entry.label}`}
            accessibilityRole="button"
            style={({ pressed }) => [
              styles.tile,
              { width: tileWidth, height: SevynShellTheme.launcher.tileHeight },
              pressed && styles.tilePressed,
            ]}
          >
            <ApplicationIcon
              application={{
                id: entry.applicationId,
                name: entry.label,
                running: entry.running,
                ...(entry.icon === undefined ? {} : { icon: entry.icon }),
              }}
              size={SevynShellTheme.launcher.iconSize}
            />
            <Text numberOfLines={2} style={styles.tileLabel}>
              {entry.label}
            </Text>
            {entry.running ? <View style={styles.runningDot} /> : null}
          </Pressable>
        ))}
        {visibleCatalog.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyText}>
              No applications match {"\u201C"}
              {input.searchQuery}
              {"\u201D"}.
            </Text>
          </View>
        ) : null}
      </ScrollView>
      <View style={styles.footer}>
        <View style={styles.resetPill}>
          <Text style={styles.resetLabel}>Reset Desktop</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  surface: {
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: SevynShellTheme.colors.launcherSurface,
    paddingBottom: SevynShellTheme.spacing.lg,
    paddingHorizontal: SevynShellTheme.spacing.lg,
    paddingTop: SevynShellTheme.spacing.lg,
    position: "absolute",
  },
  header: {
    alignItems: "center",
    marginBottom: SevynShellTheme.spacing.md,
    marginTop: SevynShellTheme.spacing.sm,
  },
  title: {
    color: SevynShellTheme.colors.primary,
    fontSize: SevynShellTheme.typography.heading,
    fontWeight: "700",
  },
  subtitle: {
    color: SevynShellTheme.colors.muted,
    fontSize: SevynShellTheme.typography.caption,
    marginTop: SevynShellTheme.spacing.xxs,
  },
  searchBox: {
    alignSelf: "center",
    backgroundColor: SevynShellTheme.colors.launcherSearchBackground,
    borderColor: SevynShellTheme.colors.launcherSearchBorder,
    borderRadius: SevynShellTheme.radius.capsule,
    borderWidth: 1,
    height: 46,
    justifyContent: "center",
    marginBottom: SevynShellTheme.spacing.lg,
    paddingHorizontal: SevynShellTheme.spacing.lg,
  },
  searchInput: {
    color: SevynShellTheme.colors.primary,
    fontSize: SevynShellTheme.typography.body,
    textAlign: "center",
  },
  gridScroll: {
    flex: 1,
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
  },
  tile: {
    alignItems: "center",
    backgroundColor: SevynShellTheme.colors.launcherTile,
    borderColor: SevynShellTheme.colors.launcherTileBorder,
    borderRadius: SevynShellTheme.radius.md,
    borderWidth: 1,
    justifyContent: "center",
    paddingHorizontal: SevynShellTheme.spacing.xs,
    paddingVertical: SevynShellTheme.spacing.sm,
  },
  tilePressed: {
    backgroundColor: SevynShellTheme.colors.launcherTileHover,
    borderColor: SevynShellTheme.colors.launcherTileHoverBorder,
  },
  tileLabel: {
    color: SevynShellTheme.colors.secondary,
    fontSize: SevynShellTheme.typography.caption,
    marginTop: SevynShellTheme.spacing.xs,
    textAlign: "center",
  },
  runningDot: {
    backgroundColor: SevynShellTheme.colors.accent,
    borderRadius: SevynShellTheme.radius.round,
    height: 5,
    marginTop: SevynShellTheme.spacing.xxs,
    width: 5,
  },
  emptyState: {
    alignItems: "center",
    paddingVertical: SevynShellTheme.spacing.xxl,
    width: "100%",
  },
  emptyText: {
    color: SevynShellTheme.colors.muted,
    fontSize: SevynShellTheme.typography.body,
  },
  footer: {
    alignItems: "center",
    marginTop: SevynShellTheme.spacing.md,
  },
  resetPill: {
    backgroundColor: SevynShellTheme.colors.launcherTile,
    borderColor: SevynShellTheme.colors.launcherBorder,
    borderRadius: SevynShellTheme.radius.capsule,
    borderWidth: 1,
    paddingHorizontal: SevynShellTheme.spacing.lg,
    paddingVertical: SevynShellTheme.spacing.sm,
  },
  resetLabel: {
    color: SevynShellTheme.colors.secondary,
    fontSize: SevynShellTheme.typography.body,
  },
});
