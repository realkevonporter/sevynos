/**
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import type { JSX } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SevynShellTheme } from "../theme.js";
import type {
  DesktopShellApplicationSummary,
  DesktopWindowSwitcherRenderInput,
} from "../desktop.js";

export interface DesktopWindowSwitcherProps extends DesktopWindowSwitcherRenderInput {
  readonly onSelectApplication?: (applicationId: string) => void;
}

const PANEL_MARGIN = SevynShellTheme.spacing.xl;
const ITEM_WIDTH = 140;
const ITEM_HEIGHT = 140;
const ITEM_GAP = SevynShellTheme.spacing.md;
const MAX_COLUMNS = 6;

function switcherIconLabel(label: string): string {
  const lower = label.toLocaleLowerCase();
  if (lower.includes("studio") || lower.includes("ide")) return "</>";
  if (lower.includes("console") || lower.includes("terminal")) return ">_";
  if (lower.includes("browser") || lower.includes("web")) return "WB";
  if (lower.includes("file")) return "FL";
  if (lower.includes("setting")) return "⚙";
  if (lower.includes("monitor")) return "SM";
  if (lower.includes("note")) return "NT";
  if (lower.includes("gallery")) return "UI";
  const words = label.trim().split(/\s+/u).filter(Boolean);
  return (
    words
      .slice(0, 2)
      .map((word) => word.slice(0, 1).toLocaleUpperCase())
      .join("") || "•"
  );
}

interface SwitcherEntryProps {
  readonly application: DesktopShellApplicationSummary;
  readonly selected: boolean;
  readonly onSelect: ((applicationId: string) => void) | undefined;
}

function SwitcherEntry({
  application,
  selected,
  onSelect,
}: SwitcherEntryProps): JSX.Element {
  return (
    <Pressable
      accessibilityLabel={`Switch to ${application.label}`}
      accessibilityRole="button"
      onPress={
        onSelect === undefined
          ? undefined
          : () => {
              onSelect(application.applicationId);
            }
      }
      style={({ pressed }) => [
        styles.entry,
        selected && styles.entrySelected,
        pressed && styles.entryPressed,
      ]}
    >
      <View style={[styles.icon, selected && styles.iconSelected]}>
        <Text style={styles.iconLabel}>{switcherIconLabel(application.label)}</Text>
      </View>
      <Text
        numberOfLines={1}
        style={[styles.entryLabel, selected && styles.entryLabelSelected]}
      >
        {application.label}
      </Text>
      {application.running === true ? <View style={styles.runningDot} /> : null}
    </Pressable>
  );
}

/**
 * Window switcher overlay rendered as a real React Native component.
 * Grid of running/pinned application entries with a frosted-glass panel,
 * centered over the display. Pure function of the render input; the host
 * drives re-renders when the switcher state changes.
 */
export function DesktopWindowSwitcher({
  open,
  displayBounds,
  applications,
  selectedApplicationId,
  onSelectApplication,
}: DesktopWindowSwitcherProps): JSX.Element | null {
  if (!open || applications.length === 0) return null;
  const columns = Math.min(applications.length, MAX_COLUMNS);
  const rows = Math.ceil(applications.length / MAX_COLUMNS);
  const contentWidth = columns * ITEM_WIDTH + (columns - 1) * ITEM_GAP;
  const contentHeight = rows * ITEM_HEIGHT + (rows - 1) * ITEM_GAP;
  const panelWidth = contentWidth + PANEL_MARGIN * 2;
  const panelHeight = contentHeight + PANEL_MARGIN * 2;
  const rowGroups: DesktopShellApplicationSummary[][] = [];
  for (let row = 0; row < rows; row += 1) {
    rowGroups.push(applications.slice(row * MAX_COLUMNS, (row + 1) * MAX_COLUMNS));
  }
  return (
    <View
      style={[
        styles.overlay,
        {
          left: displayBounds.x,
          top: displayBounds.y,
          width: displayBounds.width,
          height: displayBounds.height,
        },
      ]}
    >
      <View style={[styles.panel, { width: panelWidth, height: panelHeight }]}>
        <View style={styles.specularLine} />
        {rowGroups.map((rowApps, rowIndex) => (
          <View key={`switcher-row-${String(rowIndex)}`} style={styles.row}>
            {rowApps.map((application) => (
              <SwitcherEntry
                key={application.applicationId}
                application={application}
                selected={application.applicationId === selectedApplicationId}
                onSelect={onSelectApplication}
              />
            ))}
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    backgroundColor: SevynShellTheme.colors.overlay,
    justifyContent: "center",
    position: "absolute",
  },
  panel: {
    backgroundColor: SevynShellTheme.colors.glassStrong,
    borderColor: SevynShellTheme.colors.borderStrong,
    borderRadius: SevynShellTheme.radius.lg,
    borderWidth: 1,
    flexDirection: "column",
    justifyContent: "center",
    padding: PANEL_MARGIN,
    position: "relative",
    shadowColor: SevynShellTheme.shadows.floating.shadowColor,
    shadowOffset: SevynShellTheme.shadows.floating.shadowOffset,
    shadowOpacity: SevynShellTheme.shadows.floating.shadowOpacity,
    shadowRadius: SevynShellTheme.shadows.floating.shadowRadius,
  },
  specularLine: {
    backgroundColor: SevynShellTheme.colors.glassSpecular,
    borderRadius: SevynShellTheme.radius.round,
    height: 1,
    left: PANEL_MARGIN,
    position: "absolute",
    right: PANEL_MARGIN,
    top: 0,
  },
  row: {
    flexDirection: "row",
    gap: ITEM_GAP,
    justifyContent: "center",
    marginBottom: ITEM_GAP,
  },
  entry: {
    alignItems: "center",
    borderColor: "transparent",
    borderRadius: SevynShellTheme.radius.md,
    borderWidth: 1,
    height: ITEM_HEIGHT,
    justifyContent: "center",
    padding: SevynShellTheme.spacing.sm,
    width: ITEM_WIDTH,
  },
  entrySelected: {
    backgroundColor: SevynShellTheme.colors.accentSoft,
    borderColor: SevynShellTheme.colors.accentGlow,
  },
  entryPressed: {
    opacity: 0.7,
    transform: [{ scale: 0.96 }],
  },
  icon: {
    alignItems: "center",
    backgroundColor: SevynShellTheme.colors.elevatedSurface,
    borderColor: SevynShellTheme.colors.border,
    borderRadius: SevynShellTheme.radius.squircle,
    borderWidth: 1,
    height: 64,
    justifyContent: "center",
    marginBottom: SevynShellTheme.spacing.sm,
    width: 64,
  },
  iconSelected: {
    borderColor: SevynShellTheme.colors.accentGlow,
  },
  iconLabel: {
    color: SevynShellTheme.colors.secondary,
    fontSize: 22,
    fontWeight: "600",
  },
  entryLabel: {
    color: SevynShellTheme.colors.secondary,
    fontSize: SevynShellTheme.typography.caption,
    textAlign: "center",
  },
  entryLabelSelected: {
    color: SevynShellTheme.colors.primary,
    fontWeight: "600",
  },
  runningDot: {
    backgroundColor: SevynShellTheme.colors.accent,
    borderRadius: SevynShellTheme.radius.round,
    height: 5,
    marginTop: SevynShellTheme.spacing.xs,
    width: 5,
  },
});
