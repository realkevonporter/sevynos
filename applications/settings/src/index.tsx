import { useEffect, useState, type JSX } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type SevynAudioService,
  type SevynBatteryService,
  type SevynPowerService,
  type SevynSystemService,
  type SevynWirelessNetworkService,
  type WirelessNetworkSnapshot,
  type SevynApplicationManifest,
} from "@sevynos/react-native";

export const settingsManifest: SevynApplicationManifest = {
  manifestVersion: 1,
  id: "org.sevynos.settings",
  name: "Settings",
  version: "1.0.0",
  runtime: "react-native",
  applicationKey: "Settings",
  developer: "SevynOS",
  icon: "icons/settings.svg",
  entrypoint: "dist/index.js",
  minimumSevynOSVersion: "0.1.0",
  permissions: [],
  services: [],
  windowModes: ["standard"],
  instanceMode: "single",
};

export type SettingsCategory =
  "appearance" | "network" | "sound" | "battery" | "applications" | "shortcuts" | "about";

export interface InstalledAppInfo {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly permissions?: readonly string[] | undefined;
  readonly system?: boolean | undefined;
  readonly icon?: string | undefined;
}

export const DEFAULT_INSTALLED_APPS: readonly InstalledAppInfo[] = [
  {
    id: "org.sevynos.shell",
    name: "Desktop Shell",
    version: "2.0.0",
    permissions: ["runtime:lifecycle", "runtime:windows", "system:power"],
    system: true,
  },
  {
    id: "org.sevynos.terminal",
    name: "Terminal",
    version: "1.0.0",
    permissions: ["filesystem.read", "filesystem.write"],
    system: true,
  },
  {
    id: "org.sevynos.browser",
    name: "Browser",
    version: "1.0.0",
    permissions: ["network:http", "storage:cookies"],
    system: false,
  },
  {
    id: "org.sevynos.files",
    name: "Files",
    version: "1.0.0",
    permissions: ["filesystem:user"],
    system: false,
  },
  {
    id: "org.sevynos.notes",
    name: "Notes",
    version: "1.0.0",
    permissions: ["storage:local"],
    system: false,
  },
  {
    id: "org.sevynos.settings",
    name: "Settings",
    version: "1.0.0",
    permissions: ["system:config", "hardware:query"],
    system: false,
  },
  {
    id: "org.sevynos.system-monitor",
    name: "System Monitor",
    version: "1.0.0",
    permissions: ["process:inspect", "hardware:query"],
    system: false,
  },
  {
    id: "org.sevynos.welcome",
    name: "Welcome",
    version: "1.0.0",
    permissions: [],
    system: false,
  },
  {
    id: "org.sevynos.camera",
    name: "Camera",
    version: "1.0.0",
    permissions: ["hardware:camera", "filesystem:user"],
    system: false,
  },
  {
    id: "org.sevynos.music",
    name: "Music",
    version: "1.0.0",
    permissions: ["hardware:media", "filesystem:user"],
    system: false,
  },
];

export function isAppProtected(app: InstalledAppInfo): boolean {
  return app.system === true;
}

export function canUninstallApp(app: InstalledAppInfo): boolean {
  return !app.system;
}

export interface SettingsModel {
  theme?: ("dark" | "light" | "system") | undefined;
  accentColor?: string | undefined;
  taskbarPosition?: ("bottom" | "top" | "left" | "right") | undefined;
  dockAutohide?: boolean | undefined;
  scaleFactor?: number | undefined;
  idleLockTimeoutMinutes?: number | undefined;
}

export interface SettingsApplicationProps {
  readonly settings?: SettingsModel | undefined;
  readonly network?: SevynWirelessNetworkService | undefined;
  readonly power?: SevynPowerService | undefined;
  readonly battery?: SevynBatteryService | undefined;
  readonly audio?: SevynAudioService | undefined;
  readonly system?: SevynSystemService | undefined;
  readonly onUpdateSetting?: ((key: string, value: unknown) => void) | undefined;
  readonly installedApplications?: readonly InstalledAppInfo[] | undefined;
  readonly onUninstallApp?: ((id: string) => void) | undefined;
  readonly onReinstallApp?: ((id: string) => void) | undefined;
}

const ACCENT_COLORS = [
  { name: "Sevyn Gold", value: "#D7AC57" },
  { name: "Obsidian Silver", value: "#A0AEC0" },
  { name: "Cyber Emerald", value: "#10B981" },
  { name: "Hyper Sapphire", value: "#3B82F6" },
  { name: "Neon Amethyst", value: "#8B5CF6" },
  { name: "Crimson Blaze", value: "#EF4444" },
];

export interface SystemShortcutEntry {
  readonly label: string;
  readonly keys: string;
  readonly description: string;
}

export interface SystemShortcutGroup {
  readonly category: string;
  readonly shortcuts: readonly SystemShortcutEntry[];
}

export const SYSTEM_SHORTCUTS: readonly SystemShortcutGroup[] = [
  {
    category: "Window Management",
    shortcuts: [
      {
        label: "Close Window",
        keys: "Alt + F4",
        description: "Close the currently focused window",
      },
      {
        label: "Minimize Window",
        keys: "Super + ↓",
        description: "Minimize window to the dock",
      },
      {
        label: "Maximize / Restore",
        keys: "Super + ↑",
        description: "Toggle window between maximized and normal bounds",
      },
      {
        label: "Snap Left (Half)",
        keys: "Super + ←",
        description: "Snap window to the left half of the display",
      },
      {
        label: "Snap Right (Half)",
        keys: "Super + →",
        description: "Snap window to the right half of the display",
      },
      {
        label: "Snap Top-Left (Quarter)",
        keys: "Super + Alt + ←",
        description: "Snap window to the top-left quarter",
      },
      {
        label: "Snap Top-Right (Quarter)",
        keys: "Super + Alt + →",
        description: "Snap window to the top-right quarter",
      },
      {
        label: "Snap Bottom-Left (Quarter)",
        keys: "Super + Alt + ↓",
        description: "Snap window to the bottom-left quarter",
      },
      {
        label: "Snap Bottom-Right (Quarter)",
        keys: "Super + Alt + ↑",
        description: "Snap window to the bottom-right quarter",
      },
      {
        label: "Window Switcher",
        keys: "Alt + Tab",
        description: "Cycle through open windows in MRU order",
      },
      {
        label: "Window Switcher (Reverse)",
        keys: "Alt + Shift + Tab",
        description: "Cycle backwards through open windows",
      },
    ],
  },
  {
    category: "System & Shell",
    shortcuts: [
      {
        label: "App Launcher",
        keys: "Super + Space",
        description: "Open or close the application launcher",
      },
      {
        label: "Lock Screen",
        keys: "Super + L",
        description: "Immediately lock the screen",
      },
      {
        label: "Copy",
        keys: "Ctrl + C",
        description: "Copy selected content to clipboard",
      },
      {
        label: "Cut",
        keys: "Ctrl + X",
        description: "Cut selected content to clipboard",
      },
      { label: "Paste", keys: "Ctrl + V", description: "Paste content from clipboard" },
      {
        label: "Select All",
        keys: "Ctrl + A",
        description: "Select all content in the focused element",
      },
      { label: "Undo", keys: "Ctrl + Z", description: "Undo the last action" },
      { label: "Redo", keys: "Ctrl + Shift + Z", description: "Redo the undone action" },
      { label: "Save", keys: "Ctrl + S", description: "Save current document or state" },
    ],
  },
  {
    category: "Workspaces",
    shortcuts: [
      {
        label: "Switch to Workspace 1..4",
        keys: "Super + 1..4",
        description: "Switch active desktop workspace",
      },
      {
        label: "Move Window to Workspace 1..4",
        keys: "Super + Shift + 1..4",
        description: "Move focused window directly to workspace",
      },
      {
        label: "Move Window Left",
        keys: "Super + Shift + ←",
        description: "Move focused window to the previous workspace",
      },
      {
        label: "Move Window Right",
        keys: "Super + Shift + →",
        description: "Move focused window to the next workspace",
      },
    ],
  },
];

export function SettingsApplication({
  settings = {},
  battery,
  audio,
  network,
  onUpdateSetting,
  installedApplications,
  onUninstallApp,
  onReinstallApp,
}: SettingsApplicationProps): JSX.Element {
  const [activeCategory, setActiveCategory] = useState<SettingsCategory>("appearance");
  const [themeMode, setThemeMode] = useState<string>(settings.theme ?? "dark");
  const [selectedAccent, setSelectedAccent] = useState<string>(
    settings.accentColor ?? "#D7AC57",
  );
  const [volumeLevel, setVolumeLevel] = useState<number>(75);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [wifiEnabled, setWifiEnabled] = useState<boolean>(true);
  const [wifiSnapshot, setWifiSnapshot] = useState<WirelessNetworkSnapshot>({
    available: true,
    enabled: true,
    state: "disconnected",
    networks: [],
  });
  const [selectedSsid, setSelectedSsid] = useState<string | null>(null);
  const [wifiPassword, setWifiPassword] = useState<string>("");
  const [wifiBusy, setWifiBusy] = useState<boolean>(false);
  const [wifiError, setWifiError] = useState<string | null>(null);
  const [batteryPercent, setBatteryPercent] = useState<number>(85);
  const [isCharging, setIsCharging] = useState<boolean>(true);
  const [apps, setApps] = useState<readonly InstalledAppInfo[]>(
    installedApplications ?? DEFAULT_INSTALLED_APPS,
  );
  const [idleLockTimeout, setIdleLockTimeout] = useState<number>(
    settings.idleLockTimeoutMinutes ?? 0,
  );
  const [appActionError, setAppActionError] = useState<string | null>(null);
  const [appActionSuccess, setAppActionSuccess] = useState<string | null>(null);

  const handleIdleLockChange = (minutes: number) => {
    setIdleLockTimeout(minutes);
    onUpdateSetting?.("idleLockTimeoutMinutes", minutes);
  };

  useEffect(() => {
    if (audio) {
      void audio.snapshot().then((snap) => {
        setVolumeLevel(snap.volume);
        setIsMuted(snap.muted);
      });
    }
    if (battery) {
      void battery.snapshot().then((snap) => {
        setBatteryPercent(snap.percent);
        setIsCharging(snap.charging);
      });
    }
  }, [audio, battery]);

  useEffect(() => {
    if (!network) return undefined;
    let active = true;
    const refresh = () => {
      void network
        .snapshot()
        .then((snap) => {
          if (active) {
            setWifiSnapshot(snap);
            setWifiEnabled(snap.enabled);
            if (snap.error) setWifiError(snap.error);
          }
        })
        .catch((err: unknown) => {
          if (active) {
            setWifiError(err instanceof Error ? err.message : "Wi-Fi query failed.");
          }
        });
    };
    refresh();
    void network.scan().catch(() => undefined);
    const unsubscribe = network.subscribe(refresh);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [network]);

  const handleScan = () => {
    if (!network || wifiBusy) return;
    setWifiBusy(true);
    setWifiError(null);
    void network
      .scan()
      .then((snap) => {
        setWifiSnapshot(snap);
      })
      .catch((err: unknown) => {
        setWifiError(err instanceof Error ? err.message : "Scan failed.");
      })
      .finally(() => {
        setWifiBusy(false);
      });
  };

  const handleWifiEnabledChange = () => {
    if (!network || wifiBusy) return;
    const enabled = !wifiEnabled;
    setWifiBusy(true);
    setWifiError(null);
    const operation = network.setEnabled?.(enabled);
    if (!operation) {
      setWifiEnabled(enabled);
      setWifiBusy(false);
      return;
    }
    void operation
      .then((snapshot) => {
        setWifiSnapshot(snapshot);
        setWifiEnabled(snapshot.enabled);
      })
      .catch((error: unknown) => {
        setWifiError(
          error instanceof Error ? error.message : "Wi-Fi power change failed.",
        );
      })
      .finally(() => {
        setWifiBusy(false);
      });
  };

  const handleConnect = (ssid: string, pwd?: string) => {
    if (!network || wifiBusy) return;
    setWifiBusy(true);
    setWifiError(null);
    void network
      .connect(ssid, pwd)
      .then((snap) => {
        setWifiSnapshot(snap);
        if (snap.state === "connected") {
          setSelectedSsid(null);
          setWifiPassword("");
        }
      })
      .catch((err: unknown) => {
        setWifiError(err instanceof Error ? err.message : "Connection failed.");
      })
      .finally(() => {
        setWifiBusy(false);
      });
  };

  const handleDisconnect = () => {
    if (!network || wifiBusy) return;
    setWifiBusy(true);
    setWifiError(null);
    void network
      .disconnect()
      .then((snap) => {
        setWifiSnapshot(snap);
      })
      .catch((err: unknown) => {
        setWifiError(err instanceof Error ? err.message : "Disconnect failed.");
      })
      .finally(() => {
        setWifiBusy(false);
      });
  };

  const handleAccentChange = (color: string) => {
    setSelectedAccent(color);
    onUpdateSetting?.("accentColor", color);
  };

  const handleThemeChange = (mode: string) => {
    setThemeMode(mode);
    onUpdateSetting?.("theme", mode);
  };

  const handleVolumeChange = (newVol: number) => {
    const clamped = Math.max(0, Math.min(100, newVol));
    setVolumeLevel(clamped);
    if (audio) {
      void audio.setVolume(clamped).catch((error: unknown) => {
        console.warn("audio.setVolume failed:", error);
      });
    }
  };

  const toggleMute = () => {
    const nextMuted = !isMuted;
    setIsMuted(nextMuted);
    if (audio) {
      void audio.setMuted(nextMuted).catch((error: unknown) => {
        console.warn("audio.setMuted failed:", error);
      });
    }
  };

  return (
    <View
      accessibilityRole="application"
      accessibilityLabel="Settings"
      style={styles.container}
    >
      {/* Left Sidebar */}
      <View style={styles.sidebar}>
        <View style={styles.sidebarHeader}>
          <Text style={styles.sidebarTitle}>System Settings</Text>
        </View>

        <ScrollView style={styles.navList}>
          <SidebarItem
            active={activeCategory === "appearance"}
            icon="🎨"
            label="Appearance"
            onPress={() => {
              setActiveCategory("appearance");
            }}
          />
          <SidebarItem
            active={activeCategory === "network"}
            icon="📶"
            label="Network & Wi-Fi"
            onPress={() => {
              setActiveCategory("network");
            }}
          />
          <SidebarItem
            active={activeCategory === "sound"}
            icon="🔊"
            label="Sound & Audio"
            onPress={() => {
              setActiveCategory("sound");
            }}
          />
          <SidebarItem
            active={activeCategory === "battery"}
            icon="🔋"
            label="Power & Battery"
            onPress={() => {
              setActiveCategory("battery");
            }}
          />
          <SidebarItem
            active={activeCategory === "applications"}
            icon="📦"
            label="Applications"
            onPress={() => {
              setActiveCategory("applications");
            }}
          />
          <SidebarItem
            active={activeCategory === "shortcuts"}
            icon="⌨️"
            label="Keyboard Shortcuts"
            onPress={() => {
              setActiveCategory("shortcuts");
            }}
          />
          <SidebarItem
            active={activeCategory === "about"}
            icon="ℹ️"
            label="About SevynOS"
            onPress={() => {
              setActiveCategory("about");
            }}
          />
        </ScrollView>
      </View>

      {/* Main Settings Panel */}
      <View style={styles.mainPanel}>
        <ScrollView style={styles.panelScroll}>
          {activeCategory === "appearance" && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Appearance & Personalization</Text>
              <Text style={styles.sectionSubtitle}>
                Customize the visual aesthetics, theme, and color accents of SevynOS.
              </Text>

              {/* Theme Mode Card */}
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Desktop Theme</Text>
                <View style={styles.segmentedControl}>
                  {["dark", "light", "system"].map((mode) => (
                    <Pressable
                      key={mode}
                      action="theme"
                      value={mode}
                      onPress={() => {
                        handleThemeChange(mode);
                      }}
                      style={
                        themeMode === mode
                          ? styles.segmentButtonActive
                          : styles.segmentButton
                      }
                    >
                      <Text
                        style={
                          themeMode === mode
                            ? styles.segmentTextActive
                            : styles.segmentText
                        }
                      >
                        {mode.charAt(0).toUpperCase() + mode.slice(1)}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </View>

              {/* Accent Color Card */}
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Accent Color</Text>
                <Text style={styles.cardDesc}>
                  Select the primary accent color used across the dock, buttons, and
                  indicators.
                </Text>
                <View style={styles.accentGrid}>
                  {ACCENT_COLORS.map((accent) => (
                    <Pressable
                      key={accent.value}
                      onPress={() => {
                        handleAccentChange(accent.value);
                      }}
                      style={{
                        ...styles.accentSwatch,
                        backgroundColor: accent.value,
                        ...(selectedAccent === accent.value
                          ? styles.accentSwatchActive
                          : {}),
                      }}
                    >
                      {selectedAccent === accent.value && (
                        <Text style={styles.checkMark}>✓</Text>
                      )}
                    </Pressable>
                  ))}
                </View>
              </View>

              {/* Dock Behavior */}
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Dock & Taskbar</Text>
                <View style={styles.rowBetween}>
                  <Text style={styles.settingLabel}>Position</Text>
                  <Text style={styles.settingValue}>Bottom (Default)</Text>
                </View>
                <View style={styles.rowBetween}>
                  <Text style={styles.settingLabel}>Specular Glass Effect</Text>
                  <Text style={styles.settingValue}>Enabled</Text>
                </View>
              </View>

              {/* Idle Screen Lock */}
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Idle Screen Lock</Text>
                <Text style={styles.cardDesc}>
                  Automatically lock the screen after a period of inactivity.
                </Text>
                <View style={styles.segmentedControl}>
                  {[
                    { label: "Never", value: 0 },
                    { label: "1m", value: 1 },
                    { label: "5m", value: 5 },
                    { label: "10m", value: 10 },
                    { label: "15m", value: 15 },
                    { label: "30m", value: 30 },
                  ].map((option) => (
                    <Pressable
                      key={String(option.value)}
                      onPress={() => {
                        handleIdleLockChange(option.value);
                      }}
                      style={
                        idleLockTimeout === option.value
                          ? styles.segmentButtonActive
                          : styles.segmentButton
                      }
                    >
                      <Text
                        style={
                          idleLockTimeout === option.value
                            ? styles.segmentTextActive
                            : styles.segmentText
                        }
                      >
                        {option.label}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            </View>
          )}

          {activeCategory === "network" && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Network & Wi-Fi</Text>
              <Text style={styles.sectionSubtitle}>
                Manage wireless networking and internet connectivity.
              </Text>

              {wifiError && (
                <View style={styles.wifiErrorBanner}>
                  <Text style={styles.wifiErrorText}>⚠ {wifiError}</Text>
                </View>
              )}

              <View style={styles.card}>
                <View style={styles.rowBetween}>
                  <View>
                    <Text style={styles.cardTitle}>Wi-Fi Adapter</Text>
                    <Text style={styles.cardDesc}>
                      {wifiEnabled
                        ? wifiSnapshot.interfaceName
                          ? `Active (${wifiSnapshot.interfaceName})`
                          : "Active"
                        : "Wi-Fi is turned off"}
                    </Text>
                  </View>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={wifiEnabled ? "Turn Wi-Fi off" : "Turn Wi-Fi on"}
                    disabled={wifiBusy || !wifiSnapshot.available}
                    onPress={handleWifiEnabledChange}
                    style={wifiEnabled ? styles.toggleButtonActive : styles.toggleButton}
                  >
                    <Text style={styles.toggleText}>{wifiEnabled ? "ON" : "OFF"}</Text>
                  </Pressable>
                </View>
              </View>

              <View style={styles.card}>
                <View style={styles.rowBetween}>
                  <Text style={styles.cardTitle}>Available Networks</Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Scan for Wi-Fi networks"
                    disabled={wifiBusy || !wifiEnabled}
                    onPress={handleScan}
                    style={
                      wifiBusy || !wifiEnabled
                        ? { ...styles.scanButton, ...styles.buttonDisabled }
                        : styles.scanButton
                    }
                  >
                    <Text style={styles.scanButtonText}>
                      {wifiBusy ? "Scanning..." : "Scan Networks"}
                    </Text>
                  </Pressable>
                </View>

                {wifiSnapshot.networks.length === 0 ? (
                  <View style={styles.emptyNetworks}>
                    <Text style={styles.emptyNetworksText}>
                      {wifiBusy
                        ? "Scanning for nearby Wi-Fi networks..."
                        : wifiSnapshot.available
                          ? "No Wi-Fi networks found. Click 'Scan Networks' to search."
                          : "Wi-Fi adapter is currently unavailable."}
                    </Text>
                  </View>
                ) : (
                  wifiSnapshot.networks.map((net) => {
                    const isConnected =
                      wifiSnapshot.state === "connected" &&
                      (wifiSnapshot.connectedSsid === net.ssid || net.connected);
                    const isSelected = selectedSsid === net.ssid;
                    const isConnecting = wifiBusy && selectedSsid === net.ssid;

                    return (
                      <View key={net.ssid} style={styles.networkItemCard}>
                        <View style={styles.networkRow}>
                          <Text style={styles.networkIcon}>
                            {net.signal >= 75 ? "📶" : net.signal >= 40 ? "🛜" : "📡"}
                          </Text>
                          <View style={styles.networkInfo}>
                            <Text style={styles.networkName}>{net.ssid}</Text>
                            <Text style={styles.networkStatus}>
                              {isConnected
                                ? `Connected (${wifiSnapshot.ipAddress ?? "Active"}) • ${net.security.toUpperCase()}`
                                : isConnecting
                                  ? "Connecting..."
                                  : `${net.security === "open" ? "Open Network" : "Secure (" + net.security.toUpperCase() + ")"} • ${String(net.signal)}%`}
                            </Text>
                          </View>
                          {isConnected ? (
                            <View style={styles.connectedRow}>
                              <Text style={styles.networkConnectedBadge}>Connected</Text>
                              <Pressable
                                accessibilityRole="button"
                                accessibilityLabel={`Disconnect from ${net.ssid}`}
                                disabled={wifiBusy}
                                onPress={handleDisconnect}
                                style={styles.disconnectButton}
                              >
                                <Text style={styles.disconnectButtonText}>
                                  Disconnect
                                </Text>
                              </Pressable>
                            </View>
                          ) : (
                            <Pressable
                              accessibilityRole="button"
                              accessibilityLabel={`Join ${net.ssid}`}
                              disabled={wifiBusy}
                              onPress={() => {
                                if (net.security === "open" || !net.requiresPassword) {
                                  handleConnect(net.ssid);
                                } else {
                                  setSelectedSsid(isSelected ? null : net.ssid);
                                  setWifiPassword("");
                                }
                              }}
                              style={styles.joinButton}
                            >
                              <Text style={styles.joinButtonText}>
                                {isSelected ? "Cancel" : "Join"}
                              </Text>
                            </Pressable>
                          )}
                        </View>

                        {isSelected && !isConnected && (
                          <View style={styles.passwordRow}>
                            <TextInput
                              accessibilityLabel="Wi-Fi Password"
                              placeholder="Enter Wi-Fi password"
                              value={wifiPassword}
                              secureTextEntry
                              onChangeText={setWifiPassword}
                              style={styles.passwordInput}
                            />
                            <Pressable
                              accessibilityRole="button"
                              accessibilityLabel="Connect to network"
                              disabled={
                                wifiBusy ||
                                (net.requiresPassword && wifiPassword.length < 8)
                              }
                              onPress={() => {
                                handleConnect(net.ssid, wifiPassword);
                              }}
                              style={
                                wifiBusy ||
                                (net.requiresPassword && wifiPassword.length < 8)
                                  ? {
                                      ...styles.connectSubmitButton,
                                      ...styles.buttonDisabled,
                                    }
                                  : styles.connectSubmitButton
                              }
                            >
                              <Text style={styles.connectSubmitText}>
                                {wifiBusy ? "Connecting..." : "Connect"}
                              </Text>
                            </Pressable>
                          </View>
                        )}
                      </View>
                    );
                  })
                )}
              </View>
            </View>
          )}

          {activeCategory === "sound" && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Sound & Audio</Text>
              <Text style={styles.sectionSubtitle}>
                Configure speaker volume, microphones, and sound outputs.
              </Text>

              <View style={styles.card}>
                <View style={styles.rowBetween}>
                  <Text style={styles.cardTitle}>Master Volume</Text>
                  <Text style={styles.settingValue}>{volumeLevel}%</Text>
                </View>
                <View style={styles.volumeControls}>
                  <Pressable
                    onPress={() => {
                      handleVolumeChange(volumeLevel - 10);
                    }}
                    style={styles.volumeStepButton}
                  >
                    <Text style={styles.stepButtonText}>-</Text>
                  </Pressable>
                  <View style={styles.volumeBar}>
                    <View style={{ ...styles.volumeFill, width: volumeLevel * 2 }} />
                  </View>
                  <Pressable
                    onPress={() => {
                      handleVolumeChange(volumeLevel + 10);
                    }}
                    style={styles.volumeStepButton}
                  >
                    <Text style={styles.stepButtonText}>+</Text>
                  </Pressable>
                  <Pressable
                    onPress={toggleMute}
                    style={isMuted ? styles.muteButtonActive : styles.muteButton}
                  >
                    <Text style={styles.muteButtonText}>
                      {isMuted ? "Unmute" : "Mute"}
                    </Text>
                  </Pressable>
                </View>
              </View>
            </View>
          )}

          {activeCategory === "battery" && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Power & Battery</Text>
              <Text style={styles.sectionSubtitle}>
                Battery diagnostics and power management.
              </Text>

              <View style={styles.card}>
                <View style={styles.rowBetween}>
                  <View>
                    <Text style={styles.cardTitle}>Battery Status</Text>
                    <Text style={styles.cardDesc}>
                      {isCharging ? "Charging on AC Power" : "Discharging"}
                    </Text>
                  </View>
                  <Text style={styles.batteryPercentText}>{batteryPercent}%</Text>
                </View>
                <View style={styles.batteryBar}>
                  <View
                    style={{
                      ...styles.batteryFill,
                      width: batteryPercent * 2,
                      backgroundColor: isCharging ? "#10B981" : "#D7AC57",
                    }}
                  />
                </View>
              </View>
            </View>
          )}

          {activeCategory === "applications" && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Applications & Packages</Text>
              <Text style={styles.sectionSubtitle}>
                Manage installed applications, inspect permissions, and restore stock
                packages.
              </Text>

              {appActionError && (
                <View style={styles.errorBanner}>
                  <Text style={styles.errorBannerText}>{appActionError}</Text>
                </View>
              )}

              {appActionSuccess && (
                <View style={styles.successBanner}>
                  <Text style={styles.successBannerText}>{appActionSuccess}</Text>
                </View>
              )}

              <View style={styles.card}>
                <Text style={styles.cardTitle}>
                  Installed Applications ({apps.length})
                </Text>
                <Text style={styles.cardDesc}>
                  Core system applications are protected against uninstallation to
                  preserve OS stability.
                </Text>

                {apps.map((app) => (
                  <View key={app.id} style={styles.appRow}>
                    <View style={styles.appInfo}>
                      <View style={styles.appHeaderRow}>
                        <Text style={styles.appName}>{app.name}</Text>
                        <Text style={styles.appVersion}>v{app.version}</Text>
                        {app.system ? (
                          <View style={styles.protectedBadge}>
                            <Text style={styles.protectedBadgeText}>Protected Core</Text>
                          </View>
                        ) : (
                          <View style={styles.deletableBadge}>
                            <Text style={styles.deletableBadgeText}>Deletable Stock</Text>
                          </View>
                        )}
                      </View>
                      <Text style={styles.appId}>{app.id}</Text>
                      {app.permissions && app.permissions.length > 0 ? (
                        <View style={styles.permissionsList}>
                          <Text style={styles.permissionsTitle}>Permissions:</Text>
                          {app.permissions.map((perm) => (
                            <View key={perm} style={styles.permissionPill}>
                              <Text style={styles.permissionPillText}>{perm}</Text>
                            </View>
                          ))}
                        </View>
                      ) : (
                        <Text style={styles.noPermissionsText}>
                          No special permissions required
                        </Text>
                      )}
                    </View>

                    <View style={styles.appActions}>
                      {app.system ? (
                        <View style={styles.lockedBadge}>
                          <Text style={styles.lockedBadgeText}>🔒 Protected</Text>
                        </View>
                      ) : (
                        <Pressable
                          action="uninstall-app"
                          value={app.id}
                          style={styles.uninstallButton}
                          onPress={() => {
                            if (app.system) {
                              setAppActionError(
                                `Cannot uninstall protected system application "${app.name}" (${app.id}).`,
                              );
                              setAppActionSuccess(null);
                              return;
                            }
                            setApps((prev) => prev.filter((a) => a.id !== app.id));
                            setAppActionError(null);
                            setAppActionSuccess(`Successfully uninstalled ${app.name}`);
                            onUninstallApp?.(app.id);
                          }}
                        >
                          <Text style={styles.uninstallButtonText}>Uninstall</Text>
                        </Pressable>
                      )}
                    </View>
                  </View>
                ))}
              </View>

              {DEFAULT_INSTALLED_APPS.some(
                (stock) => !apps.some((a) => a.id === stock.id),
              ) && (
                <View style={styles.card}>
                  <Text style={styles.cardTitle}>
                    Pristine Packages Available to Restore
                  </Text>
                  <Text style={styles.cardDesc}>
                    Stock applications uninstalled from the system can be restored from
                    /usr/share/sevyn/pristine/.
                  </Text>

                  {DEFAULT_INSTALLED_APPS.filter(
                    (stock) => !apps.some((a) => a.id === stock.id),
                  ).map((stock) => (
                    <View key={stock.id} style={styles.appRow}>
                      <View style={styles.appInfo}>
                        <View style={styles.appHeaderRow}>
                          <Text style={styles.appName}>{stock.name}</Text>
                          <Text style={styles.appVersion}>v{stock.version}</Text>
                        </View>
                        <Text style={styles.appId}>{stock.id}</Text>
                      </View>
                      <Pressable
                        action="reinstall-app"
                        value={stock.id}
                        style={styles.reinstallButton}
                        onPress={() => {
                          setApps((prev) => [...prev, stock]);
                          setAppActionError(null);
                          setAppActionSuccess(
                            `Restored ${stock.name} from pristine storage.`,
                          );
                          onReinstallApp?.(stock.id);
                        }}
                      >
                        <Text style={styles.reinstallButtonText}>Reinstall</Text>
                      </Pressable>
                    </View>
                  ))}
                </View>
              )}
            </View>
          )}

          {activeCategory === "shortcuts" && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Keyboard Shortcuts</Text>
              <Text style={styles.sectionSubtitle}>
                Master SevynOS with system, window management, and workspace shortcuts.
              </Text>

              {SYSTEM_SHORTCUTS.map((group) => (
                <View key={group.category} style={styles.card}>
                  <Text style={styles.cardTitle}>{group.category}</Text>
                  <View style={styles.shortcutList}>
                    {group.shortcuts.map((sc, i) => (
                      <View
                        key={sc.label}
                        style={{
                          ...styles.shortcutRow,
                          ...(i > 0 ? styles.shortcutRowBorder : {}),
                        }}
                      >
                        <View style={styles.shortcutInfo}>
                          <Text style={styles.shortcutLabel}>{sc.label}</Text>
                          <Text style={styles.shortcutDesc}>{sc.description}</Text>
                        </View>
                        <View style={styles.keyBadge}>
                          <Text style={styles.keyBadgeText}>{sc.keys}</Text>
                        </View>
                      </View>
                    ))}
                  </View>
                </View>
              ))}
            </View>
          )}

          {activeCategory === "about" && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>About SevynOS</Text>
              <Text style={styles.sectionSubtitle}>
                Operating system specifications and framework runtime.
              </Text>

              <View style={styles.card}>
                <View style={styles.rowBetween}>
                  <Text style={styles.settingLabel}>Operating System</Text>
                  <Text style={styles.settingValueBold}>SevynOS 1.0 (Genesis)</Text>
                </View>
                <View style={styles.rowBetween}>
                  <Text style={styles.settingLabel}>Application Runtime</Text>
                  <Text style={styles.settingValue}>React Native on SevynOS</Text>
                </View>
                <View style={styles.rowBetween}>
                  <Text style={styles.settingLabel}>Compositor & Display</Text>
                  <Text style={styles.settingValue}>Genesis Wayland Engine</Text>
                </View>
                <View style={styles.rowBetween}>
                  <Text style={styles.settingLabel}>Architecture</Text>
                  <Text style={styles.settingValue}>x86_64 / amd64</Text>
                </View>
                <View style={styles.rowBetween}>
                  <Text style={styles.settingLabel}>Accent Color Token</Text>
                  <Text style={{ ...styles.settingValue, color: selectedAccent }}>
                    {selectedAccent}
                  </Text>
                </View>
              </View>
            </View>
          )}
        </ScrollView>
      </View>
    </View>
  );
}

function SidebarItem({
  active,
  icon,
  label,
  onPress,
}: {
  active: boolean;
  icon: string;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={active ? styles.sidebarItemActive : styles.sidebarItem}
    >
      <Text style={styles.sidebarItemIcon}>{icon}</Text>
      <Text style={active ? styles.sidebarItemLabelActive : styles.sidebarItemLabel}>
        {label}
      </Text>
    </Pressable>
  );
}

export default SettingsApplication;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    flexDirection: "row",
    backgroundColor: "#0F1115",
  },
  sidebar: {
    width: 220,
    backgroundColor: "#161920",
    borderRightWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.08)",
  },
  sidebarHeader: {
    padding: 18,
    borderBottomWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.06)",
  },
  sidebarTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: "#F3F4F6",
  },
  navList: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 8,
  },
  sidebarItem: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 8,
    gap: 10,
    marginBottom: 4,
  },
  sidebarItemActive: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 8,
    gap: 10,
    marginBottom: 4,
    backgroundColor: "rgba(215, 172, 87, 0.15)",
  },
  sidebarItemIcon: {
    fontSize: 16,
  },
  sidebarItemLabel: {
    fontSize: 13,
    color: "#9CA3AF",
    fontWeight: "500",
  },
  sidebarItemLabelActive: {
    fontSize: 13,
    color: "#D7AC57",
    fontWeight: "700",
  },
  mainPanel: {
    flex: 1,
  },
  panelScroll: {
    padding: 28,
  },
  section: {
    maxWidth: 680,
  },
  sectionTitle: {
    fontSize: 22,
    fontWeight: "700",
    color: "#F3F4F6",
    marginBottom: 6,
  },
  sectionSubtitle: {
    fontSize: 13,
    color: "#9CA3AF",
    marginBottom: 24,
  },
  card: {
    backgroundColor: "#1A1D24",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.08)",
    padding: 18,
    marginBottom: 16,
  },
  cardTitle: {
    fontSize: 15,
    fontWeight: "600",
    color: "#F3F4F6",
    marginBottom: 4,
  },
  cardDesc: {
    fontSize: 12,
    color: "#9CA3AF",
    marginBottom: 12,
  },
  segmentedControl: {
    flexDirection: "row",
    backgroundColor: "#12141A",
    borderRadius: 8,
    padding: 4,
    gap: 4,
    marginTop: 8,
  },
  segmentButton: {
    flex: 1,
    paddingVertical: 8,
    alignItems: "center",
    borderRadius: 6,
  },
  segmentButtonActive: {
    flex: 1,
    paddingVertical: 8,
    alignItems: "center",
    borderRadius: 6,
    backgroundColor: "#D7AC57",
  },
  segmentText: {
    fontSize: 12,
    color: "#9CA3AF",
    fontWeight: "600",
  },
  segmentTextActive: {
    fontSize: 12,
    color: "#0F1115",
    fontWeight: "700",
  },
  accentGrid: {
    flexDirection: "row",
    gap: 12,
    marginTop: 8,
  },
  accentSwatch: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
  },
  accentSwatchActive: {
    borderWidth: 3,
    borderColor: "#FFFFFF",
  },
  checkMark: {
    color: "#000000",
    fontWeight: "900",
    fontSize: 16,
  },
  rowBetween: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 8,
  },
  settingLabel: {
    fontSize: 13,
    color: "#E2E8F0",
  },
  settingValue: {
    fontSize: 13,
    color: "#9CA3AF",
  },
  settingValueBold: {
    fontSize: 13,
    color: "#D7AC57",
    fontWeight: "700",
  },
  toggleButton: {
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: "rgba(255, 255, 255, 0.1)",
  },
  toggleButtonActive: {
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: "#10B981",
  },
  toggleText: {
    fontSize: 11,
    fontWeight: "700",
    color: "#FFFFFF",
  },
  networkItem: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.05)",
    gap: 12,
  },
  networkIcon: {
    fontSize: 18,
  },
  networkInfo: {
    flex: 1,
  },
  networkName: {
    fontSize: 13,
    fontWeight: "600",
    color: "#F3F4F6",
  },
  networkStatus: {
    fontSize: 11,
    color: "#9CA3AF",
  },
  networkConnectedBadge: {
    fontSize: 11,
    fontWeight: "600",
    color: "#10B981",
  },
  volumeControls: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: 8,
  },
  volumeStepButton: {
    width: 32,
    height: 32,
    borderRadius: 6,
    backgroundColor: "rgba(255, 255, 255, 0.08)",
    alignItems: "center",
    justifyContent: "center",
  },
  stepButtonText: {
    color: "#F3F4F6",
    fontSize: 16,
    fontWeight: "700",
  },
  volumeBar: {
    flex: 1,
    height: 8,
    borderRadius: 4,
    backgroundColor: "rgba(255, 255, 255, 0.1)",
    overflow: "hidden",
  },
  volumeFill: {
    height: 8,
    backgroundColor: "#D7AC57",
  },
  muteButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: "rgba(255, 255, 255, 0.08)",
  },
  muteButtonActive: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: "#EF4444",
  },
  muteButtonText: {
    color: "#F3F4F6",
    fontSize: 12,
    fontWeight: "600",
  },
  batteryPercentText: {
    fontSize: 22,
    fontWeight: "700",
    color: "#F3F4F6",
  },
  batteryBar: {
    height: 10,
    borderRadius: 5,
    backgroundColor: "rgba(255, 255, 255, 0.1)",
    overflow: "hidden",
    marginTop: 10,
  },
  batteryFill: {
    height: 10,
  },
  storageBar: {
    height: 10,
    borderRadius: 5,
    backgroundColor: "rgba(255, 255, 255, 0.1)",
    overflow: "hidden",
    marginTop: 8,
  },
  storageFill: {
    height: 10,
    backgroundColor: "#3B82F6",
  },
  errorBanner: {
    backgroundColor: "rgba(239, 68, 68, 0.15)",
    borderColor: "#EF4444",
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    marginBottom: 16,
  },
  errorBannerText: {
    color: "#EF4444",
    fontSize: 13,
    fontWeight: "600",
  },
  successBanner: {
    backgroundColor: "rgba(16, 185, 129, 0.15)",
    borderColor: "#10B981",
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    marginBottom: 16,
  },
  successBannerText: {
    color: "#10B981",
    fontSize: 13,
    fontWeight: "600",
  },
  appRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.06)",
    gap: 12,
  },
  appInfo: {
    flex: 1,
  },
  appHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 2,
  },
  appName: {
    fontSize: 14,
    fontWeight: "600",
    color: "#F3F4F6",
  },
  appVersion: {
    fontSize: 11,
    color: "#9CA3AF",
  },
  protectedBadge: {
    backgroundColor: "rgba(215, 172, 87, 0.15)",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: "rgba(215, 172, 87, 0.4)",
  },
  protectedBadgeText: {
    fontSize: 10,
    fontWeight: "700",
    color: "#D7AC57",
  },
  deletableBadge: {
    backgroundColor: "rgba(59, 130, 246, 0.15)",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  deletableBadgeText: {
    fontSize: 10,
    fontWeight: "600",
    color: "#60A5FA",
  },
  appId: {
    fontSize: 11,
    fontFamily: "monospace",
    color: "#6B7280",
    marginBottom: 4,
  },
  permissionsList: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 4,
    marginTop: 2,
  },
  permissionsTitle: {
    fontSize: 11,
    color: "#9CA3AF",
    marginRight: 4,
  },
  permissionPill: {
    backgroundColor: "rgba(255, 255, 255, 0.06)",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  permissionPillText: {
    fontSize: 10,
    fontFamily: "monospace",
    color: "#CBD5E1",
  },
  noPermissionsText: {
    fontSize: 11,
    color: "#6B7280",
    fontStyle: "italic",
  },
  appActions: {
    flexDirection: "row",
    alignItems: "center",
  },
  lockedBadge: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: "rgba(255, 255, 255, 0.05)",
  },
  lockedBadgeText: {
    fontSize: 11,
    color: "#9CA3AF",
  },
  uninstallButton: {
    backgroundColor: "rgba(239, 68, 68, 0.15)",
    borderWidth: 1,
    borderColor: "rgba(239, 68, 68, 0.4)",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
  },
  uninstallButtonText: {
    fontSize: 12,
    fontWeight: "600",
    color: "#EF4444",
  },
  reinstallButton: {
    backgroundColor: "rgba(16, 185, 129, 0.15)",
    borderWidth: 1,
    borderColor: "rgba(16, 185, 129, 0.4)",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
  },
  reinstallButtonText: {
    fontSize: 12,
    fontWeight: "600",
    color: "#10B981",
  },
  shortcutList: {
    marginTop: 8,
  },
  shortcutRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 10,
    gap: 16,
  },
  shortcutRowBorder: {
    borderTopWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.06)",
  },
  shortcutInfo: {
    flex: 1,
  },
  shortcutLabel: {
    fontSize: 13,
    fontWeight: "600",
    color: "#F3F4F6",
  },
  shortcutDesc: {
    fontSize: 11,
    color: "#9CA3AF",
    marginTop: 2,
  },
  keyBadge: {
    backgroundColor: "rgba(255, 255, 255, 0.08)",
    borderColor: "rgba(255, 255, 255, 0.16)",
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  keyBadgeText: {
    fontSize: 11,
    fontWeight: "700",
    color: "#E5E7EB",
    fontFamily: "monospace",
  },
  scanButton: {
    backgroundColor: "rgba(215, 172, 87, 0.15)",
    borderWidth: 1,
    borderColor: "#D7AC57",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
  },
  scanButtonText: {
    fontSize: 12,
    fontWeight: "600",
    color: "#D7AC57",
  },
  connectedRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  disconnectButton: {
    backgroundColor: "rgba(239, 68, 68, 0.12)",
    borderWidth: 1,
    borderColor: "rgba(239, 68, 68, 0.3)",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
  },
  disconnectButtonText: {
    fontSize: 11,
    fontWeight: "600",
    color: "#EF4444",
  },
  joinButton: {
    backgroundColor: "rgba(255, 255, 255, 0.08)",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.16)",
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 6,
  },
  joinButtonText: {
    fontSize: 12,
    fontWeight: "600",
    color: "#F3F4F6",
  },
  networkItemCard: {
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255, 255, 255, 0.06)",
  },
  networkRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  passwordRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 10,
    paddingLeft: 34,
  },
  passwordInput: {
    flex: 1,
    height: 36,
    backgroundColor: "rgba(255, 255, 255, 0.05)",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.15)",
    borderRadius: 6,
    paddingHorizontal: 10,
    color: "#FFFFFF",
    fontSize: 13,
  },
  connectSubmitButton: {
    backgroundColor: "#D7AC57",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 6,
  },
  connectSubmitText: {
    fontSize: 12,
    fontWeight: "700",
    color: "#07090D",
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  wifiErrorBanner: {
    backgroundColor: "rgba(239, 68, 68, 0.15)",
    borderWidth: 1,
    borderColor: "rgba(239, 68, 68, 0.4)",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    marginBottom: 16,
  },
  wifiErrorText: {
    color: "#EF4444",
    fontSize: 13,
    fontWeight: "600",
  },
  emptyNetworks: {
    paddingVertical: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyNetworksText: {
    color: "#9CA3AF",
    fontSize: 13,
    textAlign: "center",
  },
});
