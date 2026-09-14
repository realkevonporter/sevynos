import {
  useMemo,
  useState,
  useEffect,
  type ComponentProps,
  type ComponentType,
  type JSX,
} from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { SevynShellTheme } from "../theme.js";
import { matchesLauncherSearch } from "../desktop.js";
import type { DesktopShellCatalogEntry } from "../desktop.js";
import {
  createContextMenuState,
  dismissContextMenu,
  renderContextMenu,
  type ContextMenuState,
  type MenuItem,
} from "../context-menu.js";

declare module "react-native" {
  interface ViewStyle {
    backdropBlur?: number | undefined;
    blur?: number | undefined;
  }
}

interface ContextMenuEvent {
  readonly nativeEvent: { readonly pageX: number; readonly pageY: number };
  preventDefault: () => void;
}

type WebPressableProps = ComponentProps<typeof Pressable> & {
  readonly onContextMenu?: (event: ContextMenuEvent) => void;
};

const WebPressable = Pressable as unknown as ComponentType<WebPressableProps>;

export interface DesktopLauncherApplicationProps {
  readonly open: boolean;
  readonly catalog: readonly DesktopShellCatalogEntry[];
  readonly onLaunch: (applicationId: string) => Promise<void> | void;
  readonly onClose?: () => void;
  readonly onResetDesktop?: () => void;
}

export function DesktopLauncherApplication({
  open,
  catalog,
  onLaunch,
  onClose,
  onResetDesktop,
}: DesktopLauncherApplicationProps): JSX.Element | null {
  const { width, height } = useWindowDimensions();
  const [searchQuery, setSearchQuery] = useState("");
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(dismissContextMenu());
  const [selectedIndex, setSelectedIndex] = useState(0);

  const filteredCatalog = useMemo(() => {
    return catalog.filter((entry) =>
      matchesLauncherSearch(entry.label, entry.applicationId, searchQuery),
    );
  }, [catalog, searchQuery]);

  // Keyboard navigation
  useEffect(() => {
    if (!open) return undefined;

    const handleKeyDown = (e: globalThis.KeyboardEvent & { readonly key: string }) => {
      if (contextMenu.visible) return; // Let context menu handle keys if open

      const columns = Math.max(
        1,
        Math.floor(
          (Math.min(720 - 48, width) + SevynShellTheme.launcher.gridGap) /
            (SevynShellTheme.launcher.minimumTileWidth +
              SevynShellTheme.launcher.gridGap),
        ),
      );

      switch (e.key) {
        case "ArrowRight":
          setSelectedIndex((prev) => Math.min(prev + 1, filteredCatalog.length - 1));
          e.preventDefault();
          break;
        case "ArrowLeft":
          setSelectedIndex((prev) => Math.max(prev - 1, 0));
          e.preventDefault();
          break;
        case "ArrowDown":
          setSelectedIndex((prev) =>
            Math.min(prev + columns, filteredCatalog.length - 1),
          );
          e.preventDefault();
          break;
        case "ArrowUp":
          setSelectedIndex((prev) => Math.max(prev - columns, 0));
          e.preventDefault();
          break;
        case "Enter":
          if (filteredCatalog[selectedIndex]) {
            void onLaunch(filteredCatalog[selectedIndex].applicationId);
          }
          e.preventDefault();
          break;
        case "Escape":
          if (onClose) onClose();
          e.preventDefault();
          break;
      }
    };

    const eventTarget = globalThis as unknown as {
      addEventListener?: (
        type: "keydown",
        listener: (event: globalThis.KeyboardEvent & { readonly key: string }) => void,
      ) => void;
      removeEventListener?: (
        type: "keydown",
        listener: (event: globalThis.KeyboardEvent & { readonly key: string }) => void,
      ) => void;
    };
    if (typeof eventTarget.addEventListener === "function") {
      eventTarget.addEventListener("keydown", handleKeyDown);
      return () => {
        eventTarget.removeEventListener?.("keydown", handleKeyDown);
      };
    }
    return undefined;
  }, [
    open,
    filteredCatalog,
    selectedIndex,
    contextMenu.visible,
    onClose,
    onLaunch,
    width,
  ]);

  // Reset selection when search changes or launcher opens
  useEffect(() => {
    setSelectedIndex(0);
  }, [searchQuery, open]);

  const handleContextMenu = (e: ContextMenuEvent, entry: DesktopShellCatalogEntry) => {
    e.preventDefault();

    const items: MenuItem[] = [
      {
        id: "open",
        label: "Open",
        onAction: () => {
          void onLaunch(entry.applicationId);
          setContextMenu(dismissContextMenu());
        },
      },
      {
        id: "pin",
        label: "Pin to Dock",
        onAction: () => {
          // In a real implementation this would call an API
          // For now we just dismiss
          setContextMenu(dismissContextMenu());
        },
      },
    ];

    setContextMenu(
      createContextMenuState({ x: e.nativeEvent.pageX, y: e.nativeEvent.pageY }, items),
    );
  };

  if (!open) return null;

  return (
    <View
      accessibilityLabel="Application launcher"
      accessibilityRole="menu"
      style={[styles.overlay, { width, height }]}
    >
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={() => {
          setContextMenu(dismissContextMenu());
          if (onClose && !contextMenu.visible) onClose();
        }}
      />
      <View style={styles.launcherCard}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={() => {
            setContextMenu(dismissContextMenu());
          }}
        />
        {/* Specular top highlight */}
        <View style={styles.specularLine} />

        <View style={styles.header}>
          <View style={styles.titleContainer}>
            <Text style={styles.titleDiamond}>◇</Text>
            <Text style={styles.headerTitle}>Applications</Text>
          </View>
          {onClose !== undefined ? (
            <Pressable
              accessibilityLabel="Close launcher"
              accessibilityRole="button"
              onPress={onClose}
              style={({ pressed }) => [styles.closeButton, pressed && styles.pressed]}
            >
              <Text style={styles.closeButtonText}>✕</Text>
            </Pressable>
          ) : null}
        </View>

        <View style={styles.searchContainer}>
          <TextInput
            accessibilityLabel="Search applications"
            autoFocus
            onChangeText={setSearchQuery}
            placeholder="Search applications…"
            placeholderTextColor={SevynShellTheme.colors.secondary}
            style={styles.searchInput}
            value={searchQuery}
          />
          {searchQuery.length > 0 ? (
            <Pressable
              accessibilityLabel="Clear search"
              accessibilityRole="button"
              onPress={() => {
                setSearchQuery("");
              }}
              style={styles.searchClearButton}
            >
              <Text style={styles.searchClearButtonText}>✕</Text>
            </Pressable>
          ) : null}
        </View>

        <ScrollView
          contentContainerStyle={styles.gridContainer}
          showsVerticalScrollIndicator={false}
          style={styles.scroller}
        >
          {filteredCatalog.length === 0 ? (
            <View style={styles.emptyState}>
              <Text style={styles.emptyStateIcon}>🔍</Text>
              <Text style={styles.emptyStateTitle}>No applications found</Text>
              <Text style={styles.emptyStateSubtitle}>
                No applications matching "{searchQuery}". Try a different search term.
              </Text>
            </View>
          ) : (
            <View style={styles.grid}>
              {filteredCatalog.map((entry, index) => {
                const iconLabel = getIconLabel(entry.label);
                const isSelected = index === selectedIndex;
                return (
                  <WebPressable
                    key={entry.applicationId}
                    accessibilityLabel={`Launch ${entry.label}`}
                    accessibilityRole="button"
                    onPress={() => {
                      void onLaunch(entry.applicationId);
                    }}
                    onContextMenu={(e) => {
                      handleContextMenu(e, entry);
                    }}
                    style={({ pressed }) => [
                      styles.tile,
                      isSelected && styles.tileSelected,
                      pressed && styles.tilePressed,
                    ]}
                  >
                    <View style={styles.tileIcon}>
                      <Text style={styles.tileIconText}>{iconLabel}</Text>
                    </View>
                    <Text numberOfLines={1} style={styles.tileLabel}>
                      {entry.label}
                    </Text>
                    {entry.running ? <View style={styles.runningIndicator} /> : null}
                  </WebPressable>
                );
              })}
            </View>
          )}

          {onResetDesktop !== undefined ? (
            <View style={styles.footer}>
              <Pressable
                accessibilityLabel="Reset Desktop"
                accessibilityRole="button"
                onPress={onResetDesktop}
                style={({ pressed }) => [styles.resetButton, pressed && styles.pressed]}
              >
                <Text style={styles.resetButtonText}>Reset Desktop</Text>
              </Pressable>
            </View>
          ) : null}
        </ScrollView>
      </View>
      {renderContextMenu(contextMenu, SevynShellTheme)}
    </View>
  );
}

function getIconLabel(label: string): string {
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
  const words = label.trim().split(/\s+/u).filter(Boolean);
  return (
    words
      .slice(0, 2)
      .map((word) => word.slice(0, 1).toLocaleUpperCase())
      .join("") || "•"
  );
}

const styles = StyleSheet.create({
  overlay: {
    alignItems: "center",
    backgroundColor: SevynShellTheme.colors.overlay,
    backdropBlur: 28,
    bottom: 0,
    justifyContent: "center",
    left: 0,
    padding: SevynShellTheme.spacing.lg,
    position: "absolute",
    right: 0,
    top: 0,
    zIndex: 900,
  },
  launcherCard: {
    backgroundColor: SevynShellTheme.colors.launcherSurface,
    borderColor: SevynShellTheme.colors.launcherBorder,
    borderRadius: 28,
    borderWidth: 1,
    backdropBlur: 20,
    height: "85%",
    maxWidth: 760,
    overflow: "hidden",
    padding: SevynShellTheme.spacing.xl,
    position: "relative",
    shadowColor: SevynShellTheme.shadows.floating.shadowColor,
    shadowOffset: SevynShellTheme.shadows.floating.shadowOffset,
    shadowOpacity: SevynShellTheme.shadows.floating.shadowOpacity,
    shadowRadius: SevynShellTheme.shadows.floating.shadowRadius,
    width: "100%",
  },
  specularLine: {
    backgroundColor: SevynShellTheme.colors.glassSpecular,
    height: 1,
    left: 32,
    position: "absolute",
    right: 32,
    top: 0,
  },
  header: {
    alignItems: "center",
    flexDirection: "row",
    height: 44,
    justifyContent: "space-between",
    marginBottom: SevynShellTheme.spacing.md,
  },
  titleContainer: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
  },
  titleDiamond: {
    color: SevynShellTheme.colors.gold,
    fontSize: 16,
    fontWeight: "700",
  },
  headerTitle: {
    color: SevynShellTheme.colors.primary,
    fontSize: SevynShellTheme.typography.heading - 4,
    fontWeight: "800",
    letterSpacing: 0.5,
  },
  closeButton: {
    alignItems: "center",
    backgroundColor: "rgba(255, 255, 255, 0.06)",
    borderColor: "rgba(255, 255, 255, 0.12)",
    borderRadius: 12,
    borderWidth: 1,
    height: 36,
    justifyContent: "center",
    width: 36,
  },
  closeButtonText: {
    color: SevynShellTheme.colors.secondary,
    fontSize: 16,
    fontWeight: "600",
  },
  searchContainer: {
    alignItems: "center",
    flexDirection: "row",
    marginBottom: SevynShellTheme.spacing.lg,
    position: "relative",
    width: "100%",
  },
  searchInput: {
    backgroundColor: SevynShellTheme.colors.launcherSearchBackground,
    borderColor: SevynShellTheme.colors.launcherSearchBorder,
    borderRadius: 16,
    borderWidth: 1,
    color: SevynShellTheme.colors.primary,
    flex: 1,
    fontSize: SevynShellTheme.typography.body,
    height: 50,
    paddingHorizontal: SevynShellTheme.spacing.md + 2,
    paddingRight: 40,
  },
  searchClearButton: {
    alignItems: "center",
    height: 32,
    justifyContent: "center",
    position: "absolute",
    right: 10,
    width: 32,
  },
  searchClearButtonText: {
    color: SevynShellTheme.colors.muted,
    fontSize: 14,
    fontWeight: "700",
  },
  emptyState: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: SevynShellTheme.spacing.xxl,
    width: "100%",
  },
  emptyStateIcon: {
    fontSize: 36,
    marginBottom: SevynShellTheme.spacing.sm,
  },
  emptyStateTitle: {
    color: SevynShellTheme.colors.primary,
    fontSize: SevynShellTheme.typography.title,
    fontWeight: "700",
    marginBottom: SevynShellTheme.spacing.xs,
  },
  emptyStateSubtitle: {
    color: SevynShellTheme.colors.secondary,
    fontSize: SevynShellTheme.typography.body,
    textAlign: "center",
  },
  scroller: {
    flex: 1,
  },
  gridContainer: {
    alignItems: "center",
    paddingBottom: SevynShellTheme.spacing.xl,
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: SevynShellTheme.launcher.gridGap,
    justifyContent: "flex-start",
    width: "100%",
  },
  tile: {
    alignItems: "center",
    backgroundColor: SevynShellTheme.colors.launcherTile,
    borderColor: SevynShellTheme.colors.launcherTileBorder,
    borderRadius: 20,
    borderWidth: 1,
    height: SevynShellTheme.launcher.tileHeight,
    justifyContent: "center",
    padding: SevynShellTheme.spacing.xs,
    position: "relative",
    width: SevynShellTheme.launcher.minimumTileWidth,
  },
  tileSelected: {
    backgroundColor: SevynShellTheme.colors.launcherTileHover,
    borderColor: SevynShellTheme.colors.launcherTileHoverBorder,
    transform: [{ scale: 1.03 }],
  },
  tilePressed: {
    backgroundColor: "rgba(255, 255, 255, 0.12)",
    transform: [{ scale: 0.96 }],
  },
  tileIcon: {
    alignItems: "center",
    backgroundColor: SevynShellTheme.colors.accentSoft,
    borderColor: SevynShellTheme.colors.accentGlow,
    borderRadius: 16,
    borderWidth: 1,
    height: SevynShellTheme.launcher.iconSize,
    justifyContent: "center",
    marginBottom: SevynShellTheme.spacing.xs + 2,
    width: SevynShellTheme.launcher.iconSize,
  },
  tileIconText: {
    color: "#FFFFFF",
    fontSize: 16,
    fontWeight: "700",
  },
  tileLabel: {
    color: SevynShellTheme.colors.primary,
    fontSize: 12.5,
    fontWeight: "600",
    letterSpacing: 0.2,
    textAlign: "center",
  },
  runningIndicator: {
    backgroundColor: SevynShellTheme.colors.gold,
    borderRadius: SevynShellTheme.radius.round,
    bottom: 6,
    height: 3.5,
    position: "absolute",
    width: 16,
  },
  footer: {
    alignItems: "center",
    marginTop: SevynShellTheme.spacing.xl,
  },
  resetButton: {
    backgroundColor: "rgba(255, 255, 255, 0.05)",
    borderColor: "rgba(255, 255, 255, 0.12)",
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: SevynShellTheme.spacing.md + 4,
    paddingVertical: SevynShellTheme.spacing.xs + 2,
  },
  resetButtonText: {
    color: SevynShellTheme.colors.secondary,
    fontSize: SevynShellTheme.typography.caption,
    fontWeight: "600",
    letterSpacing: 0.3,
  },
  pressed: {
    opacity: 0.65,
    transform: [{ scale: 0.97 }],
  },
});
