import type { JSX } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SevynShellTheme } from "../theme.js";
import type { DesktopShellApplicationSummary } from "../desktop.js";

export interface DesktopWindowSwitcherProps {
  readonly applications: readonly DesktopShellApplicationSummary[];
  readonly selectedApplicationId?: string | undefined;
  readonly onSelect: (applicationId: string) => void;
  readonly open: boolean;
}

export function DesktopWindowSwitcher({
  applications,
  selectedApplicationId,
  onSelect,
  open,
}: DesktopWindowSwitcherProps): JSX.Element | null {
  if (!open || applications.length === 0) return null;

  return (
    <View style={styles.overlay}>
      <View style={styles.surface}>
        {/* Specular glass reflection line */}
        <View style={styles.specularLine} />

        <View style={styles.grid}>
          {applications.map((application) => {
            const selected = application.applicationId === selectedApplicationId;
            const monogram = getAppMonogram(application.label);

            return (
              <Pressable
                key={application.applicationId}
                accessibilityLabel={`Switch to ${application.label}`}
                accessibilityRole="button"
                onPress={() => {
                  onSelect(application.applicationId);
                }}
                style={({ pressed }) => [
                  styles.appTile,
                  selected && styles.appTileSelected,
                  pressed && styles.buttonPressed,
                ]}
              >
                <View
                  style={[
                    styles.appIconContainer,
                    selected && styles.appIconContainerSelected,
                  ]}
                >
                  <Text
                    style={[
                      styles.appIconMonogram,
                      selected && styles.appIconMonogramSelected,
                    ]}
                  >
                    {monogram}
                  </Text>
                </View>
                <Text
                  numberOfLines={1}
                  style={[styles.appLabel, selected && styles.appLabelSelected]}
                >
                  {application.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>
    </View>
  );
}

function getAppMonogram(label: string): string {
  const lower = label.toLocaleLowerCase();
  if (lower.includes("welcome")) return "W";
  if (lower.includes("studio") || lower.includes("ide")) return "</>";
  if (lower.includes("console") || lower.includes("terminal")) return ">_";
  if (lower.includes("browser") || lower.includes("web")) return "WB";
  if (lower.includes("file")) return "FL";
  if (lower.includes("setting")) return "⚙";
  if (lower.includes("monitor")) return "SM";
  if (lower.includes("note")) return "NT";
  if (lower.includes("text") || lower.includes("editor")) return "TE";
  if (lower.includes("app") && lower.includes("manage")) return "AM";
  if (lower.includes("gallery") || lower.includes("component")) return "UI";
  return label.slice(0, 1).toLocaleUpperCase() || "•";
}

const styles = StyleSheet.create({
  overlay: {
    alignItems: "center",
    bottom: 0,
    justifyContent: "center",
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
    zIndex: 1000,
  },
  surface: {
    backgroundColor: SevynShellTheme.colors.glassStrong,
    borderColor: SevynShellTheme.colors.borderStrong,
    borderRadius: SevynShellTheme.radius.xl,
    borderWidth: 1,
    padding: SevynShellTheme.spacing.xl,
    position: "relative",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.5,
    shadowRadius: 20,
    elevation: 10,
    maxWidth: "80%",
    maxHeight: "80%",
  },
  specularLine: {
    backgroundColor: SevynShellTheme.colors.glassSpecular,
    height: 1,
    left: 30,
    position: "absolute",
    right: 30,
    top: 0,
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: SevynShellTheme.spacing.md,
    justifyContent: "center",
  },
  appTile: {
    alignItems: "center",
    backgroundColor: "rgba(255, 255, 255, 0.03)",
    borderColor: "rgba(255, 255, 255, 0.06)",
    borderRadius: SevynShellTheme.radius.lg,
    borderWidth: 1,
    gap: SevynShellTheme.spacing.sm,
    height: 120,
    justifyContent: "center",
    padding: SevynShellTheme.spacing.md,
    width: 120,
  },
  appTileSelected: {
    backgroundColor: SevynShellTheme.colors.accentSoft,
    borderColor: "rgba(159, 168, 255, 0.35)",
  },
  appIconContainer: {
    alignItems: "center",
    backgroundColor: "rgba(255, 255, 255, 0.08)",
    borderRadius: SevynShellTheme.radius.md,
    height: 48,
    justifyContent: "center",
    width: 48,
  },
  appIconContainerSelected: {
    backgroundColor: SevynShellTheme.colors.accent,
  },
  appIconMonogram: {
    color: SevynShellTheme.colors.secondary,
    fontSize: 20,
    fontWeight: "700",
  },
  appIconMonogramSelected: {
    color: "#FFFFFF",
  },
  appLabel: {
    color: SevynShellTheme.colors.secondary,
    fontSize: SevynShellTheme.typography.caption,
    fontWeight: "600",
    textAlign: "center",
  },
  appLabelSelected: {
    color: SevynShellTheme.colors.primary,
  },
  buttonPressed: {
    opacity: 0.6,
    transform: [{ scale: 0.96 }],
  },
});
