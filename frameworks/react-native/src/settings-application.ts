import {
  Button,
  Card,
  Heading,
  Icon,
  Separator,
  Text,
  type ComponentEnvironment,
} from "./components.js";
import {
  freezeSurface,
  type NativeApplicationSurfaceSnapshot,
  type NativeBounds,
  type NativeControlAction,
  type NativeInteractionState,
  type NativeRenderCommand,
  type SevynIconName,
} from "./surface.js";
import { resolveSevynColors } from "./tokens.js";

export interface SevynSettingsModel {
  readonly theme: "dark" | "light" | "system";
  readonly accentColor: string;
  readonly taskbarPosition: "bottom" | "top" | "left" | "right";
  readonly taskbarBehavior: "always-visible" | "auto-hide";
  readonly displayLayout: "side-by-side" | "vertical" | "offset";
  readonly workspaceCount: number;
  readonly cursorSize: number;
  readonly reducedMotion: boolean;
  readonly restorePreviousSession: boolean;
}

interface SettingsEntry {
  readonly action: NativeControlAction;
  readonly icon: SevynIconName;
  readonly label: string;
  readonly detail: string;
  readonly value: (settings: SevynSettingsModel) => string;
}
const entries: readonly SettingsEntry[] = Object.freeze([
  {
    action: "theme",
    icon: "appearance",
    label: "Appearance",
    detail: "Choose how system surfaces respond to light.",
    value: (s) => s.theme,
  },
  {
    action: "accent",
    icon: "color",
    label: "Accent",
    detail: "A personal highlight used for focus and selection.",
    value: (s) => s.accentColor,
  },
  {
    action: "taskbar-position",
    icon: "controls",
    label: "Taskbar position",
    detail: "Place shell controls around the usable display.",
    value: (s) => s.taskbarPosition,
  },
  {
    action: "taskbar-behavior",
    icon: "controls",
    label: "Taskbar behavior",
    detail: "Keep controls visible or reveal them on demand.",
    value: (s) => s.taskbarBehavior,
  },
  {
    action: "display-layout",
    icon: "display",
    label: "Display layout",
    detail: "Arrange the simulated Genesis displays.",
    value: (s) => s.displayLayout,
  },
  {
    action: "workspace-count",
    icon: "workspace",
    label: "Workspaces",
    detail: "Organize running windows across focused spaces.",
    value: (s) => String(s.workspaceCount),
  },
  {
    action: "cursor-size",
    icon: "pointer",
    label: "Cursor size",
    detail: "Scale the system pointer while preserving precision.",
    value: (s) => `${String(s.cursorSize)}×`,
  },
  {
    action: "reduced-motion",
    icon: "motion",
    label: "Reduced motion",
    detail: "Remove nonessential transitions and springs.",
    value: (s) => (s.reducedMotion ? "On" : "Off"),
  },
  {
    action: "restore-session",
    icon: "history",
    label: "Restore previous session",
    detail: "Return to your applications after launch.",
    value: (s) => (s.restorePreviousSession ? "On" : "Off"),
  },
]);

export function composeSettingsApplication(options: {
  readonly bounds: NativeBounds;
  readonly settings: SevynSettingsModel;
  readonly systemAppearance?: "light" | "dark";
  readonly focused?: boolean;
  readonly interaction?: Partial<Record<NativeControlAction, NativeInteractionState>>;
}): NativeApplicationSurfaceSnapshot {
  const appearance =
    options.settings.theme === "system"
      ? (options.systemAppearance ?? "dark")
      : options.settings.theme;
  const colors = resolveSevynColors(appearance, options.settings.accentColor);
  const environment: ComponentEnvironment = {
    colors,
    reducedMotion: options.settings.reducedMotion,
  };
  const { bounds } = options;
  const compact = bounds.width < 560;
  const sidebarWidth = compact ? bounds.width - 32 : 184;
  const contentX = compact ? bounds.x + 16 : bounds.x + sidebarWidth + 32;
  const contentY = compact ? bounds.y + 102 : bounds.y + 22;
  const contentWidth = compact ? bounds.width - 32 : bounds.width - sidebarWidth - 48;
  const commands: NativeRenderCommand[] = [];
  commands.push(Card({ id: "settings.background", bounds, environment }));
  commands.push(
    Card({
      id: "settings.sidebar",
      bounds: {
        x: bounds.x + 12,
        y: bounds.y + 12,
        width: sidebarWidth,
        height: compact ? 74 : bounds.height - 24,
      },
      environment,
    }),
  );
  commands.push(
    Heading({
      id: "settings.brand",
      bounds: {
        x: bounds.x + 28,
        y: bounds.y + 24,
        width: sidebarWidth - 32,
        height: 28,
      },
      environment,
      text: "Settings",
    }),
  );
  commands.push(
    Text({
      id: "settings.scope",
      bounds: {
        x: bounds.x + 28,
        y: bounds.y + 53,
        width: sidebarWidth - 32,
        height: 18,
      },
      environment,
      text: compact ? "System · Personal" : "SEVYNOS SYSTEM",
      tone: "muted",
      style: "micro",
    }),
  );
  if (!compact) {
    const sections = [
      ["appearance", "Appearance"],
      ["display", "Displays"],
      ["workspace", "Workspaces"],
      ["motion", "Accessibility"],
    ] as const;
    sections.forEach(([icon, label], index) => {
      const y = bounds.y + 104 + index * 46;
      commands.push(
        Icon({
          id: `sidebar.${icon}.icon`,
          bounds: { x: bounds.x + 28, y, width: 18, height: 18 },
          environment,
          icon,
        }),
      );
      commands.push(
        Text({
          id: `sidebar.${icon}.label`,
          bounds: { x: bounds.x + 56, y: y - 1, width: 112, height: 20 },
          environment,
          text: label,
          tone: index === 0 ? "primary" : "secondary",
          style: "label",
        }),
      );
    });
  }
  commands.push(
    Heading({
      id: "settings.heading",
      bounds: { x: contentX, y: contentY, width: contentWidth, height: 30 },
      environment,
      text: "Desktop & Experience",
    }),
  );
  commands.push(
    Text({
      id: "settings.intro",
      bounds: { x: contentX, y: contentY + 32, width: contentWidth, height: 20 },
      environment,
      text: "Make Genesis feel distinctly yours. Changes apply immediately.",
      tone: "secondary",
    }),
  );
  const rowTop = contentY + 70;
  const rowHeight = 62;
  entries.forEach((entry, index) => {
    const y = rowTop + index * rowHeight;
    if (y + rowHeight > bounds.y + bounds.height - 8) return;
    if (index === 0 || index === 4 || index === 7)
      commands.push(
        Text({
          id: `section.${String(index)}`,
          bounds: { x: contentX, y: y - 16, width: contentWidth, height: 14 },
          environment,
          text:
            index === 0
              ? "APPEARANCE"
              : index === 4
                ? "DISPLAYS & WORKSPACES"
                : "ACCESSIBILITY & SESSION",
          tone: "muted",
          style: "micro",
        }),
      );
    commands.push(
      Icon({
        id: `${entry.action}.icon`,
        bounds: { x: contentX + 2, y: y + 13, width: 20, height: 20 },
        environment,
        icon: entry.icon,
      }),
    );
    commands.push(
      Text({
        id: `${entry.action}.label`,
        bounds: {
          x: contentX + 32,
          y: y + 7,
          width: Math.max(80, contentWidth - 184),
          height: 20,
        },
        environment,
        text: entry.label,
        style: "label",
      }),
    );
    commands.push(
      Text({
        id: `${entry.action}.detail`,
        bounds: {
          x: contentX + 32,
          y: y + 29,
          width: Math.max(80, contentWidth - 184),
          height: 18,
        },
        environment,
        text: entry.detail,
        tone: "muted",
        style: "caption",
      }),
    );
    commands.push(
      Button({
        id: `${entry.action}.control`,
        bounds: { x: contentX + contentWidth - 132, y: y + 10, width: 126, height: 34 },
        environment,
        action: entry.action,
        label: entry.label,
        value: entry.value(options.settings),
        state:
          options.interaction?.[entry.action] ??
          (options.focused && index === 0 ? "focused" : "idle"),
      }),
    );
    commands.push(
      Separator({
        id: `${entry.action}.separator`,
        bounds: { x: contentX + 30, y: y + 56, width: contentWidth - 30, height: 1 },
        environment,
      }),
    );
  });
  return freezeSurface({
    kind: "sevyn-native-surface",
    application: "settings",
    appearance,
    colors,
    reducedMotion: options.settings.reducedMotion,
    commands,
  });
}

export function composeComponentGallery(options: {
  readonly bounds: NativeBounds;
  readonly appearance: "light" | "dark";
  readonly reducedMotion: boolean;
}): NativeApplicationSurfaceSnapshot {
  const colors = resolveSevynColors(options.appearance);
  const environment = { colors, reducedMotion: options.reducedMotion };
  const commands: NativeRenderCommand[] = [
    Card({ id: "gallery.background", bounds: options.bounds, environment }),
    Heading({
      id: "gallery.heading",
      bounds: {
        x: options.bounds.x + 24,
        y: options.bounds.y + 22,
        width: 300,
        height: 30,
      },
      environment,
      text: "Sevyn Component Gallery",
    }),
  ];
  const states = ["idle", "hovered", "focused", "pressed", "disabled"] as const;
  states.forEach((state, index) =>
    commands.push(
      Button({
        id: `gallery.${state}`,
        bounds: {
          x: options.bounds.x + 24,
          y: options.bounds.y + 78 + index * 48,
          width: 210,
          height: 36,
        },
        environment,
        action: "theme",
        label: "Button",
        value: state,
        state,
      }),
    ),
  );
  return freezeSurface({
    kind: "sevyn-native-surface",
    application: "gallery",
    appearance: options.appearance,
    colors,
    reducedMotion: options.reducedMotion,
    commands,
  });
}
