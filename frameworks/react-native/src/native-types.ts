import type { ReactNode } from "react";
import type {
  NativeBounds,
  NativeControlAction,
  NativeInteractionState,
  SevynIconName,
} from "./surface.js";
export type { NativeBounds } from "./surface.js";

export type NativeElementType =
  | "view"
  | "text"
  | "image"
  | "button"
  | "input"
  | "toggle"
  | "slider"
  | "segment"
  | "select"
  | "icon"
  | "scroll"
  | "overlay";
export type Dimension = number | `${number}%`;
export type FlexDirection = "row" | "column";
export type Align = "start" | "center" | "end" | "stretch";
export type Justify = "start" | "center" | "end" | "space-between";
export interface NativeEdges {
  readonly top?: number;
  readonly right?: number;
  readonly bottom?: number;
  readonly left?: number;
  readonly horizontal?: number;
  readonly vertical?: number;
  readonly all?: number;
}
export interface NativeStyle {
  readonly direction?: FlexDirection;
  readonly flexDirection?: "row" | "column" | "row-reverse" | "column-reverse";
  readonly align?: Align;
  readonly alignItems?: "flex-start" | "flex-end" | "center" | "stretch" | "baseline";
  readonly alignSelf?:
    "auto" | "flex-start" | "flex-end" | "center" | "stretch" | "baseline";
  readonly justify?: Justify;
  readonly justifyContent?:
    | "flex-start"
    | "flex-end"
    | "center"
    | "space-between"
    | "space-around"
    | "space-evenly";
  readonly gap?: number;
  readonly rowGap?: number;
  readonly columnGap?: number;
  readonly padding?: number | NativeEdges;
  readonly paddingHorizontal?: number;
  readonly paddingVertical?: number;
  readonly paddingTop?: number;
  readonly paddingRight?: number;
  readonly paddingBottom?: number;
  readonly paddingLeft?: number;
  readonly margin?: number | NativeEdges;
  readonly marginHorizontal?: number;
  readonly marginVertical?: number;
  readonly marginTop?: number;
  readonly marginRight?: number;
  readonly marginBottom?: number;
  readonly marginLeft?: number;
  readonly width?: Dimension;
  readonly height?: Dimension;
  readonly minWidth?: number;
  readonly maxWidth?: number;
  readonly minHeight?: number;
  readonly maxHeight?: number;
  readonly flex?: number;
  readonly flexGrow?: number;
  readonly flexShrink?: number;
  readonly flexBasis?: number | string;
  readonly flexWrap?: "nowrap" | "wrap" | "wrap-reverse";
  readonly position?: "relative" | "absolute";
  readonly left?: number;
  readonly top?: number;
  readonly right?: number;
  readonly bottom?: number;
  readonly overflow?: "visible" | "hidden" | "scroll";
  readonly scrollOffset?: number;
  readonly backgroundColor?: string;
  readonly color?: string;
  readonly borderColor?: string;
  readonly borderWidth?: number;
  readonly borderStyle?: "solid" | "dotted" | "dashed";
  readonly borderTopWidth?: number;
  readonly borderRightWidth?: number;
  readonly borderBottomWidth?: number;
  readonly borderLeftWidth?: number;
  readonly borderTopColor?: string;
  readonly borderRightColor?: string;
  readonly borderBottomColor?: string;
  readonly borderLeftColor?: string;
  readonly radius?: number;
  readonly borderRadius?: number;
  readonly borderTopLeftRadius?: number;
  readonly borderTopRightRadius?: number;
  readonly borderBottomLeftRadius?: number;
  readonly borderBottomRightRadius?: number;
  readonly borderStartStartRadius?: number;
  readonly borderStartEndRadius?: number;
  readonly borderEndStartRadius?: number;
  readonly borderEndEndRadius?: number;
  readonly opacity?: number;
  readonly elevation?: number;
  readonly shadowColor?: string;
  readonly shadowOffset?: { readonly width: number; readonly height: number };
  readonly shadowOpacity?: number;
  readonly shadowRadius?: number;
  readonly scale?: number;
  readonly translateX?: number;
  readonly translateY?: number;
  readonly fontSize?: number;
  readonly fontWeight?: number | string;
  readonly fontFamily?: string;
  readonly fontStyle?: "normal" | "italic";
  readonly lineHeight?: number;
  readonly letterSpacing?: number;
  readonly textAlign?: "auto" | "left" | "right" | "center" | "justify";
  readonly wrap?: boolean;
  readonly textDecorationLine?:
    "none" | "underline" | "line-through" | "underline line-through";
  readonly zIndex?: number;
  readonly aspectRatio?: number | string;
  readonly transform?: readonly Record<string, unknown>[];
}
export interface NativeBitmapSource {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
}
export interface AccessibilityProps {
  readonly role?:
    | "application"
    | "button"
    | "checkbox"
    | "dialog"
    | "heading"
    | "list"
    | "listitem"
    | "menu"
    | "menuitem"
    | "slider"
    | "status"
    | "tab"
    | "textbox";
  readonly label?: string;
  readonly description?: string;
  readonly disabled?: boolean;
  readonly selected?: boolean;
  readonly checked?: boolean;
  readonly focusOrder?: number;
}
export interface NativePointerEvent {
  readonly x: number;
  readonly y: number;
  readonly pointerId: number;
  readonly button: number;
}
export interface NativeKeyboardEvent {
  readonly key: string;
  readonly code: string;
  readonly shift: boolean;
  readonly alt: boolean;
  readonly control: boolean;
  readonly meta: boolean;
}
export interface NativeWheelEvent {
  readonly x: number;
  readonly y: number;
  readonly deltaX: number;
  readonly deltaY: number;
}
export interface NativeTouchPoint {
  readonly touchId: number;
  readonly x: number;
  readonly y: number;
  readonly pressure?: number;
}
export interface NativeTouchEvent {
  readonly touches: readonly NativeTouchPoint[];
  readonly changedTouches: readonly NativeTouchPoint[];
}
export interface NativeEventHandlers {
  readonly onPointerEnter?: (event: NativePointerEvent) => void;
  readonly onPointerLeave?: (event: NativePointerEvent) => void;
  readonly onPointerDown?: (event: NativePointerEvent) => void;
  readonly onPointerMove?: (event: NativePointerEvent) => void;
  readonly onPointerUp?: (event: NativePointerEvent) => void;
  readonly onContextMenu?: (event: NativePointerEvent) => void;
  readonly onStartShouldSetResponder?: (event: NativePointerEvent) => boolean;
  readonly onMoveShouldSetResponder?: (event: NativePointerEvent) => boolean;
  readonly onResponderGrant?: (event: NativePointerEvent) => void;
  readonly onResponderMove?: (event: NativePointerEvent) => void;
  readonly onResponderRelease?: (event: NativePointerEvent) => void;
  readonly onResponderTerminate?: (event: NativePointerEvent) => void;
  readonly onWheel?: (event: NativeWheelEvent) => void;
  readonly onTouchStart?: (event: NativeTouchEvent) => void;
  readonly onTouchMove?: (event: NativeTouchEvent) => void;
  readonly onTouchEnd?: (event: NativeTouchEvent) => void;
  readonly onTouchCancel?: (event: NativeTouchEvent) => void;
  readonly onPress?: () => void;
  readonly onFocus?: () => void;
  readonly onBlur?: () => void;
  readonly onKeyDown?: (event: NativeKeyboardEvent) => void;
  readonly onKeyUp?: (event: NativeKeyboardEvent) => void;
  readonly onTextInput?: (text: string) => void;
  readonly onChangeText?: (text: string) => void;
  readonly onSelectionChange?: (selection: {
    readonly start: number;
    readonly end: number;
  }) => void;
  readonly onSubmitEditing?: (text: string) => void;
  readonly onValueChange?: (value: string | number | boolean) => void;
  readonly onScroll?: (offset: number) => void;
  readonly onDismiss?: () => void;
  readonly onRefresh?: () => void;
}
export interface NativeProps extends AccessibilityProps, NativeEventHandlers {
  readonly accessibilityRole?: AccessibilityProps["role"];
  readonly accessibilityLabel?: string;
  readonly id?: string;
  readonly key?: string;
  readonly style?: NativeStyle;
  readonly children?: ReactNode;
  readonly text?: string;
  readonly value?: string | number | boolean;
  readonly defaultValue?: string | number | boolean;
  readonly placeholder?: string;
  readonly placeholderTextColor?: string;
  readonly multiline?: boolean;
  readonly secureTextEntry?: boolean;
  readonly editable?: boolean;
  readonly caretHidden?: boolean;
  readonly maxLength?: number;
  readonly selection?: { readonly start: number; readonly end: number };
  readonly selectionColor?: string;
  readonly showsVerticalScrollIndicator?: boolean;
  readonly showsHorizontalScrollIndicator?: boolean;
  readonly refreshing?: boolean;
  readonly source?: NativeBitmapSource;
  readonly checked?: boolean;
  readonly defaultChecked?: boolean;
  readonly selectedIndex?: number;
  readonly defaultSelectedIndex?: number;
  readonly options?: readonly string[];
  readonly minimumValue?: number;
  readonly maximumValue?: number;
  readonly step?: number;
  readonly action?: NativeControlAction;
  readonly interactionState?: NativeInteractionState;
  readonly icon?: SevynIconName;
  readonly modal?: boolean;
  readonly focusTrap?: boolean;
  readonly breakpoint?: { readonly compact: number; readonly compactStyle: NativeStyle };
}
export interface NativeTextNode {
  readonly kind: "raw-text";
  id: string;
  text: string;
  hidden: boolean;
  parent?: NativeHostNode;
}
export interface NativeHostNode {
  readonly kind: "host";
  id: string;
  type: NativeElementType;
  props: NativeProps;
  children: NativeChild[];
  hidden: boolean;
  dirty: boolean;
  revision: number;
  parent?: NativeHostNode;
}
export type NativeChild = NativeHostNode | NativeTextNode;
export interface AccessibilityNode {
  readonly id: string;
  readonly role: NonNullable<AccessibilityProps["role"]>;
  readonly label: string;
  readonly description?: string;
  readonly disabled: boolean;
  readonly selected: boolean;
  readonly checked?: boolean;
  readonly focusOrder: number;
  readonly bounds: NativeBounds;
  readonly children: readonly AccessibilityNode[];
}
export interface NativeRuntimeSnapshot {
  readonly revision: number;
  readonly commands: readonly import("./surface.js").NativeRenderCommand[];
  readonly accessibility: readonly AccessibilityNode[];
  readonly focusId?: string;
  readonly overlays: readonly string[];
  readonly changedNodeIds: readonly string[];
}
