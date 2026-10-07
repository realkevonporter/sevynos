import { useEffect, useMemo, useState, type JSX } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type SevynApplicationManifest,
  type SevynTimeService,
  type SevynWirelessNetworkService,
  type TimeSyncState,
  type WirelessNetworkSnapshot,
} from "@sevynos/react-native";

/** Structural subset of the wireless network descriptor (public API only). */
interface WizardWirelessNetwork {
  readonly ssid: string;
  readonly signal: number;
  readonly security: "open" | "personal" | "enhanced-open" | "enterprise" | "legacy";
  readonly supported: boolean;
  readonly requiresPassword: boolean;
}

export const setupWizardManifest: SevynApplicationManifest = {
  manifestVersion: 1,
  id: "org.sevynos.setup-wizard",
  name: "Setup",
  version: "1.0.0",
  runtime: "react-native",
  applicationKey: "SetupWizard",
  developer: "SevynOS",
  // Custom "Sevyn Orbit" icon set asset, following the icons/<app>.svg convention.
  icon: "icons/setup-wizard.svg",
  entrypoint: "dist/index.js",
  minimumSevynOSVersion: "0.1.0",
  permissions: [],
  services: [],
  windowModes: ["standard"],
  instanceMode: "single",
};

export type SetupWizardStep = "welcome" | "timezone" | "wifi" | "finish";

export interface SetupWizardApplicationProps {
  readonly time?: SevynTimeService | undefined;
  readonly network?: SevynWirelessNetworkService | undefined;
  readonly onComplete?: (() => void) | undefined;
}

/**
 * Ordered setup flow. Pure step helpers below keep the state machine
 * testable without rendering.
 */
export const SETUP_WIZARD_STEPS: readonly SetupWizardStep[] = Object.freeze([
  "welcome",
  "timezone",
  "wifi",
  "finish",
]);

export function nextSetupWizardStep(step: SetupWizardStep): SetupWizardStep {
  const index = SETUP_WIZARD_STEPS.indexOf(step);
  return SETUP_WIZARD_STEPS[Math.min(index + 1, SETUP_WIZARD_STEPS.length - 1)] ?? step;
}

export function previousSetupWizardStep(step: SetupWizardStep): SetupWizardStep {
  const index = SETUP_WIZARD_STEPS.indexOf(step);
  return SETUP_WIZARD_STEPS[Math.max(index - 1, 0)] ?? step;
}

export function setupWizardStepIndex(step: SetupWizardStep): number {
  return SETUP_WIZARD_STEPS.indexOf(step);
}

/**
 * Curated list of common IANA timezones shown in the picker. Every entry is
 * validated against the system's zoneinfo database when applied through
 * SevynTimeService.setTimezone, so a stale entry fails loudly instead of
 * silently keeping UTC.
 */
export const COMMON_TIMEZONES: readonly string[] = Object.freeze([
  "Pacific/Midway",
  "Pacific/Honolulu",
  "America/Anchorage",
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "America/Halifax",
  "America/Sao_Paulo",
  "Atlantic/Azores",
  "Europe/London",
  "Europe/Lisbon",
  "Europe/Berlin",
  "Europe/Paris",
  "Europe/Moscow",
  "Africa/Cairo",
  "Africa/Lagos",
  "Africa/Johannesburg",
  "Asia/Dubai",
  "Asia/Karachi",
  "Asia/Kolkata",
  "Asia/Dhaka",
  "Asia/Bangkok",
  "Asia/Singapore",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Asia/Seoul",
  "Australia/Perth",
  "Australia/Sydney",
  "Pacific/Auckland",
  "America/Toronto",
  "America/Vancouver",
  "America/Mexico_City",
  "America/Bogota",
  "America/Santiago",
  "America/Argentina/Buenos_Aires",
  "Europe/Madrid",
  "Europe/Rome",
  "Europe/Amsterdam",
  "Europe/Zurich",
  "Europe/Stockholm",
  "Europe/Athens",
  "Europe/Istanbul",
  "Asia/Tehran",
  "Asia/Riyadh",
  "Asia/Hong_Kong",
  "Asia/Taipei",
  "Australia/Melbourne",
  "Pacific/Fiji",
  "UTC",
]);

const INITIAL_WIFI_SNAPSHOT: WirelessNetworkSnapshot = {
  available: false,
  enabled: false,
  state: "unavailable",
  networks: [],
};

function signalLabel(signal: number): string {
  if (signal >= 75) return "Excellent";
  if (signal >= 50) return "Good";
  if (signal >= 25) return "Fair";
  return "Weak";
}

function securityLabel(network: WizardWirelessNetwork): string {
  switch (network.security) {
    case "open":
      return "Open";
    case "enhanced-open":
      return "Enhanced open";
    case "personal":
      return "Secured";
    case "legacy":
      return "Secured (legacy)";
    case "enterprise":
      return "Enterprise";
    default:
      return "Unknown";
  }
}

export function SetupWizardApplication({
  time,
  network,
  onComplete,
}: SetupWizardApplicationProps): JSX.Element {
  const [step, setStep] = useState<SetupWizardStep>("welcome");
  const [timeState, setTimeState] = useState<TimeSyncState | undefined>(undefined);
  const [timezoneQuery, setTimezoneQuery] = useState("");
  const [timezoneBusy, setTimezoneBusy] = useState(false);
  const [timezoneError, setTimezoneError] = useState<string | undefined>(undefined);
  const [wifiSnapshot, setWifiSnapshot] =
    useState<WirelessNetworkSnapshot>(INITIAL_WIFI_SNAPSHOT);
  const [wifiBusy, setWifiBusy] = useState(false);
  const [wifiError, setWifiError] = useState<string | undefined>(undefined);
  const [selectedSsid, setSelectedSsid] = useState<string | undefined>(undefined);
  const [wifiPassword, setWifiPassword] = useState("");

  useEffect(() => {
    if (!time) return;
    let cancelled = false;
    void time
      .snapshot()
      .then((snapshot) => {
        if (!cancelled) setTimeState(snapshot);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [time]);

  useEffect(() => {
    if (step !== "wifi" || !network) return;
    let cancelled = false;
    setWifiBusy(true);
    setWifiError(undefined);
    void network
      .scan()
      .then((snapshot) => {
        if (!cancelled) setWifiSnapshot(snapshot);
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setWifiError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) setWifiBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [step, network]);

  const filteredTimezones = useMemo(() => {
    const query = timezoneQuery.trim().toLowerCase();
    if (query.length === 0) return COMMON_TIMEZONES;
    return COMMON_TIMEZONES.filter((zone) => zone.toLowerCase().includes(query));
  }, [timezoneQuery]);

  const applyTimezone = (zone: string): void => {
    if (!time || timezoneBusy) return;
    setTimezoneBusy(true);
    setTimezoneError(undefined);
    void time
      .setTimezone(zone)
      .then((snapshot) => {
        setTimeState(snapshot);
        // NTP needs the new zone applied first so the corrected clock lands
        // in local time correctly; best effort after a zone change.
        return time.syncNow().catch(() => undefined);
      })
      .then(() => time.snapshot().catch(() => undefined))
      .then((snapshot) => {
        if (snapshot) setTimeState(snapshot);
      })
      .catch((error: unknown) => {
        setTimezoneError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        setTimezoneBusy(false);
      });
  };

  const connectWifi = (ssid: string): void => {
    if (!network || wifiBusy) return;
    setWifiBusy(true);
    setWifiError(undefined);
    const password = wifiPassword.length > 0 ? wifiPassword : undefined;
    void network
      .connect(ssid, password)
      .then((snapshot) => {
        setWifiSnapshot(snapshot);
        if (snapshot.state === "connected") {
          setSelectedSsid(undefined);
          setWifiPassword("");
        } else if (snapshot.error) {
          setWifiError(snapshot.error);
        }
      })
      .catch((error: unknown) => {
        setWifiError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        setWifiBusy(false);
      });
  };

  const stepNumber = setupWizardStepIndex(step) + 1;

  return (
    <View
      accessibilityRole="application"
      accessibilityLabel="SevynOS setup"
      style={styles.container}
    >
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Set up SevynOS</Text>
        <Text style={styles.headerStep}>
          Step {stepNumber} of {SETUP_WIZARD_STEPS.length}
        </Text>
      </View>
      <View style={styles.progressTrack}>
        <View
          style={{
            ...styles.progressFill,
            flex: stepNumber / SETUP_WIZARD_STEPS.length,
          }}
        />
      </View>

      {step === "welcome" && (
        <View style={styles.body}>
          <Text style={styles.title}>Welcome to SevynOS</Text>
          <Text style={styles.paragraph}>
            This short setup gets your system ready: choose your timezone so the clock is
            correct, connect to Wi-Fi, and you are done.
          </Text>
          <Text style={styles.paragraph}>
            Your choices are applied to the real system immediately and saved, so this
            setup only runs once.
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Begin setup"
            onPress={() => {
              setStep(nextSetupWizardStep(step));
            }}
            style={styles.primaryButton}
          >
            <Text style={styles.primaryButtonText}>Begin setup →</Text>
          </Pressable>
        </View>
      )}

      {step === "timezone" && (
        <View style={styles.body}>
          <Text style={styles.title}>Choose your timezone</Text>
          <Text style={styles.paragraph}>
            Current timezone: {timeState?.timezone ?? "UTC"}
            {timeState?.lastSyncAt !== undefined ? " · clock synced" : ""}
          </Text>
          {time === undefined && (
            <Text style={styles.warning}>
              Time service unavailable — the timezone cannot be changed here. You can set
              it later in Settings.
            </Text>
          )}
          <TextInput
            value={timezoneQuery}
            onChangeText={setTimezoneQuery}
            placeholder="Search timezones…"
            style={styles.input}
          />
          {timezoneError !== undefined && (
            <Text style={styles.error}>{timezoneError}</Text>
          )}
          <ScrollView style={styles.list}>
            {filteredTimezones.map((zone) => {
              const active = timeState?.timezone === zone;
              return (
                <Pressable
                  key={zone}
                  accessibilityRole="button"
                  accessibilityLabel={`Use timezone ${zone}`}
                  disabled={time === undefined || timezoneBusy}
                  onPress={() => {
                    applyTimezone(zone);
                  }}
                  style={
                    active
                      ? { ...styles.listItem, ...styles.listItemActive }
                      : styles.listItem
                  }
                >
                  <Text
                    style={
                      active
                        ? { ...styles.listItemText, ...styles.listItemTextActive }
                        : styles.listItemText
                    }
                  >
                    {zone}
                  </Text>
                  {active && <Text style={styles.listItemCheck}>Active</Text>}
                </Pressable>
              );
            })}
            {filteredTimezones.length === 0 && (
              <Text style={styles.paragraph}>No timezones match your search.</Text>
            )}
          </ScrollView>
          <View style={styles.footerRow}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Back"
              onPress={() => {
                setStep(previousSetupWizardStep(step));
              }}
              style={styles.secondaryButton}
            >
              <Text style={styles.secondaryButtonText}>← Back</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Continue"
              onPress={() => {
                setStep(nextSetupWizardStep(step));
              }}
              style={styles.primaryButton}
            >
              <Text style={styles.primaryButtonText}>Continue →</Text>
            </Pressable>
          </View>
        </View>
      )}

      {step === "wifi" && (
        <View style={styles.body}>
          <Text style={styles.title}>Connect to Wi-Fi</Text>
          {wifiSnapshot.state === "connected" ? (
            <Text style={styles.paragraph}>
              Connected to {wifiSnapshot.connectedSsid ?? "a network"}
              {wifiSnapshot.ipAddress ? ` (${wifiSnapshot.ipAddress})` : ""}.
            </Text>
          ) : (
            <Text style={styles.paragraph}>
              {network === undefined
                ? "Wi-Fi service unavailable on this device."
                : wifiBusy
                  ? "Scanning for networks…"
                  : "Pick a network to connect. The password is saved on this system."}
            </Text>
          )}
          {wifiError !== undefined && <Text style={styles.error}>{wifiError}</Text>}
          <ScrollView style={styles.list}>
            {wifiSnapshot.networks.map((item) => {
              const selected = selectedSsid === item.ssid;
              return (
                <View key={item.ssid} style={styles.listItemColumn}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Select network ${item.ssid}`}
                    disabled={!network || wifiBusy || !item.supported}
                    onPress={() => {
                      setSelectedSsid(selected ? undefined : item.ssid);
                      setWifiPassword("");
                      setWifiError(undefined);
                    }}
                    style={
                      selected
                        ? { ...styles.listItem, ...styles.listItemActive }
                        : styles.listItem
                    }
                  >
                    <View style={styles.wifiRow}>
                      <Text
                        style={
                          selected
                            ? { ...styles.listItemText, ...styles.listItemTextActive }
                            : styles.listItemText
                        }
                      >
                        {item.ssid}
                      </Text>
                      <Text style={styles.wifiMeta}>
                        {`${signalLabel(item.signal)} · ${item.supported ? securityLabel(item) : "Unsupported"}`}
                      </Text>
                    </View>
                  </Pressable>
                  {selected && item.requiresPassword && (
                    <TextInput
                      value={wifiPassword}
                      onChangeText={setWifiPassword}
                      placeholder="Wi-Fi password"
                      secureTextEntry
                      style={styles.input}
                    />
                  )}
                  {selected && (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Connect to ${item.ssid}`}
                      disabled={!network || wifiBusy}
                      onPress={() => {
                        connectWifi(item.ssid);
                      }}
                      style={styles.primaryButton}
                    >
                      <Text style={styles.primaryButtonText}>
                        {wifiBusy ? "Connecting…" : `Connect to ${item.ssid}`}
                      </Text>
                    </Pressable>
                  )}
                </View>
              );
            })}
            {wifiSnapshot.networks.length === 0 && !wifiBusy && (
              <Text style={styles.paragraph}>No networks found.</Text>
            )}
          </ScrollView>
          <View style={styles.footerRow}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Back"
              onPress={() => {
                setStep(previousSetupWizardStep(step));
              }}
              style={styles.secondaryButton}
            >
              <Text style={styles.secondaryButtonText}>← Back</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={
                wifiSnapshot.state === "connected" ? "Continue" : "Skip Wi-Fi setup"
              }
              onPress={() => {
                setStep(nextSetupWizardStep(step));
              }}
              style={styles.secondaryButton}
            >
              <Text style={styles.secondaryButtonText}>
                {wifiSnapshot.state === "connected" ? "Continue →" : "Skip for now"}
              </Text>
            </Pressable>
          </View>
        </View>
      )}

      {step === "finish" && (
        <View style={styles.body}>
          <Text style={styles.title}>You are all set</Text>
          <Text style={styles.paragraph}>Timezone: {timeState?.timezone ?? "UTC"}</Text>
          <Text style={styles.paragraph}>
            Wi-Fi:{" "}
            {wifiSnapshot.state === "connected"
              ? `connected to ${wifiSnapshot.connectedSsid ?? "a network"}`
              : "not connected — you can connect any time in Settings"}
          </Text>
          <Text style={styles.paragraph}>Setup will not run again on this system.</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Start using SevynOS"
            onPress={() => {
              onComplete?.();
            }}
            style={styles.primaryButton}
          >
            <Text style={styles.primaryButtonText}>Start using SevynOS →</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

export default SetupWizardApplication;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0F1115",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 24,
    paddingTop: 20,
    paddingBottom: 8,
  },
  headerTitle: {
    fontSize: 15,
    fontWeight: "700",
    color: "#F0F6FC",
  },
  headerStep: {
    fontSize: 11,
    color: "#8B949E",
  },
  progressTrack: {
    height: 4,
    backgroundColor: "rgba(255,255,255,0.08)",
    marginHorizontal: 24,
    borderRadius: 2,
    flexDirection: "row",
  },
  progressFill: {
    height: 4,
    backgroundColor: "#D7AC57",
    borderRadius: 2,
  },
  body: {
    flex: 1,
    padding: 24,
    gap: 12,
  },
  title: {
    fontSize: 22,
    fontWeight: "700",
    color: "#F0F6FC",
  },
  paragraph: {
    fontSize: 13,
    color: "#9CA3AF",
    lineHeight: 18,
  },
  warning: {
    fontSize: 12,
    color: "#D7AC57",
    lineHeight: 16,
  },
  error: {
    fontSize: 12,
    color: "#F87171",
    lineHeight: 16,
  },
  input: {
    backgroundColor: "rgba(255,255,255,0.04)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 13,
    color: "#F0F6FC",
  },
  list: {
    flex: 1,
  },
  listItem: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
    borderRadius: 8,
    marginBottom: 6,
    backgroundColor: "rgba(255,255,255,0.02)",
  },
  listItemActive: {
    borderColor: "#D7AC57",
    backgroundColor: "rgba(215,172,87,0.08)",
  },
  listItemText: {
    fontSize: 13,
    color: "#E5E7EB",
  },
  listItemTextActive: {
    color: "#F0F6FC",
    fontWeight: "700",
  },
  listItemCheck: {
    fontSize: 11,
    fontWeight: "700",
    color: "#D7AC57",
  },
  listItemColumn: {
    marginBottom: 6,
    gap: 6,
  },
  wifiRow: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  wifiMeta: {
    fontSize: 11,
    color: "#8B949E",
  },
  footerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 12,
  },
  primaryButton: {
    backgroundColor: "#D7AC57",
    borderRadius: 8,
    paddingHorizontal: 18,
    paddingVertical: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryButtonText: {
    fontSize: 13,
    fontWeight: "700",
    color: "#0F1115",
  },
  secondaryButton: {
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.16)",
    borderRadius: 8,
    paddingHorizontal: 18,
    paddingVertical: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  secondaryButtonText: {
    fontSize: 13,
    fontWeight: "600",
    color: "#E5E7EB",
  },
});
