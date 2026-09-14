import type {
  NativeBounds,
  NativeControlAction,
  NativeInteractionState,
  NativeRenderCommand,
  SevynIconName,
} from "./surface.js";
import { sevynTokens, type SevynSemanticColors } from "./tokens.js";

export interface ComponentEnvironment {
  readonly colors: SevynSemanticColors;
  readonly reducedMotion: boolean;
}
export interface ComponentProps {
  readonly id: string;
  readonly bounds: NativeBounds;
  readonly environment: ComponentEnvironment;
}

export function Text(
  props: ComponentProps & {
    readonly text: string;
    readonly tone?: "primary" | "secondary" | "muted";
    readonly style?: keyof typeof sevynTokens.typography;
    readonly align?: "start" | "center" | "end";
  },
): NativeRenderCommand {
  const typography = sevynTokens.typography[props.style ?? "body"];
  const color =
    props.tone === "secondary"
      ? props.environment.colors.textSecondary
      : props.tone === "muted"
        ? props.environment.colors.textMuted
        : props.environment.colors.text;
  return Object.freeze({
    kind: "text",
    id: props.id,
    bounds: props.bounds,
    text: props.text,
    color,
    size: typography.size,
    weight: typography.weight,
    ...(props.align === undefined ? {} : { align: props.align }),
  });
}
export const Heading = (
  props: ComponentProps & { readonly text: string },
): NativeRenderCommand => Text({ ...props, text: props.text, style: "title" });
export function Button(
  props: ComponentProps & {
    readonly action: NativeControlAction;
    readonly label: string;
    readonly value: string;
    readonly state?: NativeInteractionState;
  },
): NativeRenderCommand {
  return Object.freeze({
    kind: "control",
    id: props.id,
    bounds: props.bounds,
    action: props.action,
    label: props.label,
    value: props.value,
    state: props.state ?? "idle",
    accent: props.environment.colors.accent,
    foreground: props.environment.colors.text,
    background: props.environment.colors.surfaceRaised,
    radius: sevynTokens.radius.sm,
  });
}
export const IconButton = (
  props: ComponentProps & {
    readonly icon: SevynIconName;
    readonly action: NativeControlAction;
    readonly label: string;
  },
): readonly NativeRenderCommand[] =>
  Object.freeze([
    Icon({ ...props, icon: props.icon }),
    Button({ ...props, action: props.action, label: props.label, value: "" }),
  ]);
export const Icon = (
  props: ComponentProps & { readonly icon: SevynIconName },
): NativeRenderCommand =>
  Object.freeze({
    kind: "icon",
    id: props.id,
    bounds: props.bounds,
    icon: props.icon,
    color: props.environment.colors.textSecondary,
  });
export const Card = (props: ComponentProps): NativeRenderCommand =>
  Object.freeze({
    kind: "material",
    id: props.id,
    bounds: props.bounds,
    color: props.environment.colors.material,
    radius: sevynTokens.radius.md,
    borderColor: props.environment.colors.border,
    shadow: {
      color: props.environment.colors.shadow,
      blur: sevynTokens.shadow.low.blur,
      y: sevynTokens.shadow.low.y,
    },
  });
export const Separator = (props: ComponentProps): NativeRenderCommand =>
  Object.freeze({
    kind: "separator",
    id: props.id,
    bounds: props.bounds,
    color: props.environment.colors.separator,
  });

export const TextInput = Button;
export const Toggle = Button;
export const SegmentedControl = Button;
export const Slider = Button;
export const List = Card;
export const SettingsRow = Card;
export const Sidebar = Card;
export const Toolbar = Card;
export const Menu = Card;
export const Dialog = Card;
export const Sheet = Card;
export const ProgressIndicator = Card;
export const ScrollContainer = Card;
export const EmptyState = Card;
export const WindowContentLayout = Card;
