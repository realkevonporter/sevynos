import { type JSX } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type SevynApplicationManifest,
} from "@sevynos/react-native";

export const welcomeManifest: SevynApplicationManifest = {
  manifestVersion: 1,
  id: "org.sevynos.welcome",
  name: "Welcome",
  version: "1.0.0",
  runtime: "react-native",
  applicationKey: "Welcome",
  developer: "SevynOS",
  icon: "icons/welcome.svg",
  entrypoint: "dist/index.js",
  minimumSevynOSVersion: "0.1.0",
  permissions: [],
  services: [],
  windowModes: ["standard"],
  instanceMode: "single",
};

export interface WelcomeApplicationProps {
  readonly onLaunch?: ((applicationId: string) => void) | undefined;
}

const APPS = [
  {
    id: "org.sevynos.browser",
    title: "Browser",
    icon: "🌐",
    desc: "Browse offline docs & web",
    color: "#38BDF8",
  },
  {
    id: "org.sevynos.settings",
    title: "Settings",
    icon: "⚙️",
    desc: "Themes, displays & audio",
    color: "#D7AC57",
  },
  {
    id: "org.sevynos.files",
    title: "Files",
    icon: "📁",
    desc: "Documents & storage",
    color: "#F472B6",
  },
  {
    id: "org.sevynos.terminal",
    title: "Terminal",
    icon: "💻",
    desc: "Genesis command console",
    color: "#34D399",
  },
];

export function WelcomeApplication({ onLaunch }: WelcomeApplicationProps): JSX.Element {
  return (
    <View
      accessibilityRole="application"
      accessibilityLabel="Welcome"
      style={styles.container}
    >
      <ScrollView style={styles.scroll}>
        {/* Hero Header */}
        <View style={styles.hero}>
          <View style={styles.heroHeaderRow}>
            <View style={styles.logoBadge}>
              <Text style={styles.logoIcon}>⚡</Text>
            </View>
            <View style={styles.heroTextContainer}>
              <Text style={styles.heroTitle}>Welcome to SevynOS</Text>
              <Text style={styles.heroSubtitle}>
                Calm minimalism powered by React Native and the Genesis Engine.
              </Text>
            </View>
          </View>
        </View>

        {/* Quick Launch Applications Row */}
        <Text style={styles.sectionTitle}>EXPLORE SYSTEM APPLICATIONS</Text>
        <View style={styles.cardsRow}>
          {APPS.map((app) => (
            <Pressable
              key={app.id}
              onPress={() => onLaunch?.(app.id)}
              style={styles.card}
            >
              <View style={styles.cardHeader}>
                <Text style={styles.cardIcon}>{app.icon}</Text>
                <Text style={styles.cardTitle}>{app.title}</Text>
              </View>
              <Text style={styles.cardDesc}>{app.desc}</Text>
              <Text style={{ ...styles.cardAction, color: app.color }}>Launch →</Text>
            </Pressable>
          ))}
        </View>

        {/* Essential Shortcuts Bar */}
        <Text style={styles.sectionTitle}>ESSENTIAL SHORTCUTS</Text>
        <View style={styles.shortcutCard}>
          <View style={styles.shortcutItem}>
            <Text style={styles.shortcutKey}>Alt + Tab</Text>
            <Text style={styles.shortcutDesc}>Switch Windows</Text>
          </View>
          <View style={styles.shortcutItem}>
            <Text style={styles.shortcutKey}>Super</Text>
            <Text style={styles.shortcutDesc}>Application Launcher</Text>
          </View>
          <View style={styles.shortcutItem}>
            <Text style={styles.shortcutKey}>Ctrl + Alt + T</Text>
            <Text style={styles.shortcutDesc}>Genesis Terminal</Text>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

export default WelcomeApplication;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0F1115",
  },
  scroll: {
    flex: 1,
    padding: 16,
  },
  hero: {
    marginBottom: 16,
    padding: 14,
    backgroundColor: "rgba(215, 172, 87, 0.08)",
    borderColor: "rgba(215, 172, 87, 0.35)",
    borderWidth: 1,
    borderRadius: 10,
  },
  heroHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  heroTextContainer: {
    flex: 1,
  },
  logoBadge: {
    width: 38,
    height: 38,
    borderRadius: 10,
    backgroundColor: "rgba(215, 172, 87, 0.15)",
    borderWidth: 1,
    borderColor: "#D7AC57",
    alignItems: "center",
    justifyContent: "center",
  },
  logoIcon: {
    fontSize: 18,
  },
  heroTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: "#F0F6FC",
  },
  heroSubtitle: {
    fontSize: 11,
    color: "#8B949E",
    marginTop: 2,
  },
  sectionTitle: {
    fontSize: 10,
    fontWeight: "700",
    color: "#8B949E",
    marginBottom: 8,
  },
  cardsRow: {
    flexDirection: "row",
    gap: 10,
    marginBottom: 16,
  },
  card: {
    flex: 1,
    backgroundColor: "rgba(255, 255, 255, 0.03)",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.08)",
    padding: 10,
    gap: 4,
    minHeight: 72,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  cardIcon: {
    fontSize: 14,
  },
  cardTitle: {
    fontSize: 12,
    fontWeight: "700",
    color: "#F3F4F6",
  },
  cardDesc: {
    fontSize: 10,
    color: "#9CA3AF",
    lineHeight: 14,
  },
  cardAction: {
    fontSize: 10,
    fontWeight: "700",
    marginTop: 2,
  },
  shortcutCard: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: "rgba(255, 255, 255, 0.02)",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.06)",
    padding: 10,
  },
  shortcutItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  shortcutKey: {
    fontSize: 10,
    fontWeight: "700",
    color: "#D7AC57",
    backgroundColor: "rgba(215, 172, 87, 0.12)",
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 4,
  },
  shortcutDesc: {
    fontSize: 10,
    color: "#9CA3AF",
  },
});
