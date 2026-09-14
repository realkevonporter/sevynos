import type { JSX } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import {
  ApplicationIcon,
  SevynMark,
  type MobileApplicationSummary,
} from "../mobile-home/mobile.js";
import { SevynShellTheme } from "../theme.js";

export interface MobileTaskbarApplicationProps {
  readonly applications: readonly MobileApplicationSummary[];
  readonly activeApplicationId?: string;
  readonly onCloseApplication: () => void;
  readonly onLaunch: (applicationId: string) => Promise<void>;
  readonly onOpenHome: () => void;
}

export type MobileDockApplicationProps = MobileTaskbarApplicationProps;

export function MobileTaskbarApplication({
  applications,
  activeApplicationId,
  onCloseApplication,
  onLaunch,
  onOpenHome,
}: MobileTaskbarApplicationProps): JSX.Element {
  const pinnedApplications = applications.slice(0, 4);
  return (
    <View style={styles.wrapper}>
      <View accessibilityRole="toolbar" style={styles.taskbar}>
        <View style={styles.specularLine} />
        <Pressable
          accessibilityLabel="Open launcher"
          accessibilityRole="button"
          onPress={onOpenHome}
          style={({ pressed }) => [
            styles.launcherButton,
            activeApplicationId === undefined && styles.launcherButtonActive,
            pressed && styles.buttonPressed,
          ]}
        >
          <SevynMark />
        </Pressable>

        {pinnedApplications.length > 0 ? <View style={styles.divider} /> : null}

        <ScrollView
          contentContainerStyle={styles.applicationList}
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.applicationScroller}
        >
          {pinnedApplications.map((application) => {
            const active = application.id === activeApplicationId;
            return (
              <Pressable
                key={application.id}
                accessibilityLabel={`Open ${application.name}`}
                accessibilityRole="button"
                onPress={(): void => {
                  void onLaunch(application.id);
                }}
                style={({ pressed }) => [
                  styles.applicationButton,
                  active && styles.applicationButtonActive,
                  pressed && styles.buttonPressed,
                ]}
              >
                <ApplicationIcon application={application} size={34} />
                {application.running ? (
                  <View
                    style={[
                      styles.runningIndicator,
                      active && styles.runningIndicatorActive,
                    ]}
                  />
                ) : null}
              </Pressable>
            );
          })}
        </ScrollView>

        {activeApplicationId === undefined ? null : (
          <>
            <View style={styles.divider} />
            <Pressable
              accessibilityLabel="Close application"
              accessibilityRole="button"
              onPress={onCloseApplication}
              style={({ pressed }) => [
                styles.closeButton,
                pressed && styles.buttonPressed,
              ]}
            >
              <Text style={styles.closeIcon}>×</Text>
            </Pressable>
          </>
        )}
      </View>
      <View style={styles.gestureHandle} />
    </View>
  );
}

export const MobileDockApplication = MobileTaskbarApplication;

const styles = StyleSheet.create({
  wrapper: {
    alignItems: "center",
    paddingBottom: SevynShellTheme.spacing.xs,
    paddingHorizontal: SevynShellTheme.spacing.md,
    paddingTop: SevynShellTheme.spacing.xs,
  },
  taskbar: {
    alignItems: "center",
    alignSelf: "center",
    backgroundColor: SevynShellTheme.colors.dockBackground,
    borderColor: SevynShellTheme.colors.dockBorder,
    borderRadius: SevynShellTheme.radius.dock,
    borderWidth: 1,
    flexDirection: "row",
    maxWidth: 560,
    minHeight: 64,
    paddingHorizontal: 10,
    paddingVertical: 8,
    shadowColor: SevynShellTheme.shadows.dock.shadowColor,
    shadowOffset: SevynShellTheme.shadows.dock.shadowOffset,
    shadowOpacity: SevynShellTheme.shadows.dock.shadowOpacity,
    shadowRadius: SevynShellTheme.shadows.dock.shadowRadius,
    width: "100%",
  },
  specularLine: {
    backgroundColor: SevynShellTheme.colors.dockSpecular,
    height: 1,
    left: 24,
    position: "absolute",
    right: 24,
    top: 0,
  },
  launcherButton: {
    alignItems: "center",
    borderRadius: 18,
    height: 48,
    justifyContent: "center",
    width: 50,
  },
  launcherButtonActive: {
    backgroundColor: SevynShellTheme.colors.goldSoft,
    borderColor: SevynShellTheme.colors.goldGlow,
    borderWidth: 1,
  },
  divider: {
    backgroundColor: "rgba(255, 255, 255, 0.12)",
    height: 30,
    marginHorizontal: 7,
    width: 1,
  },
  applicationScroller: { flexGrow: 0, flexShrink: 1 },
  applicationList: { alignItems: "center", gap: 6 },
  applicationButton: {
    alignItems: "center",
    borderRadius: 18,
    height: 48,
    justifyContent: "center",
    position: "relative",
    width: 50,
  },
  applicationButtonActive: {
    backgroundColor: SevynShellTheme.colors.accentSoft,
    borderColor: SevynShellTheme.colors.accentGlow,
    borderWidth: 1,
  },
  buttonPressed: { opacity: 0.65, transform: [{ scale: 0.94 }] },
  runningIndicator: {
    backgroundColor: "rgba(255, 255, 255, 0.40)",
    borderRadius: SevynShellTheme.radius.round,
    bottom: 3,
    height: 3,
    position: "absolute",
    width: 12,
  },
  runningIndicatorActive: {
    backgroundColor: SevynShellTheme.colors.gold,
    width: 20,
  },
  closeButton: {
    alignItems: "center",
    backgroundColor: "rgba(244, 109, 117, 0.14)",
    borderColor: "rgba(244, 109, 117, 0.25)",
    borderRadius: 18,
    borderWidth: 1,
    height: 48,
    justifyContent: "center",
    width: 46,
  },
  closeIcon: {
    color: "#FF9AA0",
    fontSize: 26,
    fontWeight: "300",
    lineHeight: 28,
  },
  gestureHandle: {
    backgroundColor: "rgba(255, 255, 255, 0.65)",
    borderRadius: SevynShellTheme.radius.round,
    height: 4,
    marginTop: 8,
    width: 42,
  },
});
