import type { JSX } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { ApplicationPackage } from "@sevynos/runtime";

export interface ApplicationLauncherProps {
  readonly applications: readonly ApplicationPackage[];

  readonly onLaunch: (application: ApplicationPackage) => Promise<void>;
}

export function ApplicationLauncher(props: ApplicationLauncherProps): JSX.Element {
  return (
    <View style={[styles.container]}>
      <View style={styles.header}>
        <Text style={styles.brand}>SEVYN</Text>

        <Text style={styles.heading}>Applications</Text>
      </View>

      <View style={styles.grid}>
        {props.applications.map((application) => {
          const launchApplication = (): void => {
            void props.onLaunch(application);
          };

          return (
            <Pressable
              key={application.manifest.id}
              accessibilityRole="button"
              accessibilityLabel={`Open ${application.manifest.name}`}
              onPress={launchApplication}
              style={({ pressed }) => [
                styles.application,
                pressed && styles.applicationPressed,
              ]}
            >
              <View style={styles.icon}>
                <Text style={styles.iconText}>
                  {application.manifest.name.charAt(0).toUpperCase()}
                </Text>
              </View>

              <Text numberOfLines={1} style={styles.applicationName}>
                {application.manifest.name}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 24,
    backgroundColor: "#0d0d0d",
  },

  header: {
    marginBottom: 32,
  },

  brand: {
    color: "#777777",
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 4,
  },

  heading: {
    marginTop: 8,
    color: "#ffffff",
    fontSize: 32,
    fontWeight: "700",
  },

  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 20,
  },

  application: {
    width: 92,
    alignItems: "center",
  },

  applicationPressed: {
    opacity: 0.6,
  },

  icon: {
    width: 68,
    height: 68,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 18,
    backgroundColor: "#ffffff",
  },

  iconText: {
    color: "#111111",
    fontSize: 30,
    fontWeight: "800",
  },

  applicationName: {
    width: "100%",
    marginTop: 10,
    color: "#ffffff",
    fontSize: 13,
    textAlign: "center",
  },
});
