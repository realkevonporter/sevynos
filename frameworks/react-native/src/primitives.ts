import {
  Children,
  cloneElement,
  createElement,
  isValidElement,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactElement,
  type ReactNode,
} from "react";
import type {
  NativeBitmapSource,
  NativeElementType,
  NativeProps,
  NativeStyle,
} from "./native-types.js";
import { getNativeAdapters } from "./native-adapter-contracts.js";

export type NativeComponentProps = NativeProps & {
  readonly children?: ReactNode;
  readonly ref?: unknown;
};

/**
 * Recursively flattens a style prop that may be an object, an array
 * (possibly nested), or falsy. This ensures `style={[a, b]}` and
 * `style={[a, [b, c]]}` are correctly merged before reaching Yoga,
 * which cannot handle array styles.
 */
function flattenStyleRecursive(style: unknown): Record<string, unknown> | undefined {
  if (!style) return undefined;
  if (Array.isArray(style)) {
    const result: Record<string, unknown> = {};
    for (const item of style) {
      const flattened = flattenStyleRecursive(item);
      if (flattened) Object.assign(result, flattened);
    }
    return resolveLogicalProps(result);
  }
  if (typeof style === "object") {
    return resolveLogicalProps(style as Record<string, unknown>);
  }
  return undefined;
}

/**
 * Resolve logical (RTL-aware) style properties to physical ones.
 * Based on the `direction` style or default LTR.
 */
function resolveLogicalProps(style: Record<string, unknown>): Record<string, unknown> {
  const direction = style["direction"];
  // In RTL, start=end and left=right are swapped.
  const isRTL = direction === "rtl";
  const result = { ...style };

  // Helper to get logical value, preferring the logical prop over physical.
  const resolve = (logical: string, physicalLTR: string, physicalRTL: string): void => {
    const value = result[logical];
    if (value !== undefined) {
      const physical = isRTL ? physicalRTL : physicalLTR;
      // Only set if physical not already explicitly set (physical wins).
      if (result[physical] === undefined) {
        result[physical] = value;
      }
      delete result[logical];
    }
  };

  resolve("start", "left", "right");
  resolve("end", "right", "left");
  resolve("marginStart", "marginLeft", "marginRight");
  resolve("marginEnd", "marginRight", "marginLeft");
  resolve("paddingStart", "paddingLeft", "paddingRight");
  resolve("paddingEnd", "paddingRight", "paddingLeft");
  resolve("borderStartWidth", "borderLeftWidth", "borderRightWidth");
  resolve("borderEndWidth", "borderRightWidth", "borderLeftWidth");

  return result;
}

function element(type: NativeElementType, props: NativeComponentProps): ReactElement {
  const { style, ...rest } = props;
  const flattenedStyle = flattenStyleRecursive(style);
  // Handle display: "none" at the framework level by not rendering.
  // The host may also handle it, but this ensures consistent behavior.
  const display = flattenedStyle?.["display"];
  if (display === "none") {
    return null as unknown as ReactElement;
  }
  return createElement(
    type,
    {
      ...rest,
      ...(flattenedStyle !== undefined ? { style: flattenedStyle } : {}),
      role: props.role ?? props.accessibilityRole,
      label: props.label ?? props.accessibilityLabel,
      // Map testID to id for host test hooks.
      ...(props.testID !== undefined && props.id === undefined
        ? { id: props.testID }
        : {}),
    },
    props.children,
  );
}
export const View = (props: NativeComponentProps): ReactElement => element("view", props);
export const NativeText = (props: NativeComponentProps): ReactElement =>
  element("text", props);
export const Text = NativeText;

export const NativeImage = (props: NativeComponentProps): ReactElement =>
  element("image", props);
export type ImageSourcePropType =
  | NativeBitmapSource
  | { readonly uri: string; readonly width?: number; readonly height?: number }
  | number;
export interface ImageProps extends Omit<NativeComponentProps, "source"> {
  readonly source?: ImageSourcePropType | readonly ImageSourcePropType[];
  readonly resizeMode?: "cover" | "contain" | "stretch" | "repeat" | "center";
  readonly onLoad?: () => void;
  readonly onError?: (error: Error) => void;
}
const imageCache = new Map<string, NativeBitmapSource>();
const imageRequests = new Map<string, Promise<NativeBitmapSource>>();
function loadImage(uri: string): Promise<NativeBitmapSource> {
  const cached = imageCache.get(uri);
  if (cached !== undefined) return Promise.resolve(cached);
  const active = imageRequests.get(uri);
  if (active !== undefined) return active;
  const adapter = getNativeAdapters().image;
  if (adapter === undefined)
    return Promise.reject(new Error("Image loading is unavailable on this host."));
  const request = adapter.load(uri).then(
    (bitmap) => {
      imageCache.set(uri, bitmap);
      imageRequests.delete(uri);
      return bitmap;
    },
    (error: unknown) => {
      imageRequests.delete(uri);
      throw error;
    },
  );
  imageRequests.set(uri, request);
  return request;
}
function imageSource(source: ImageProps["source"]): ImageSourcePropType | undefined {
  return Array.isArray(source)
    ? (source as readonly ImageSourcePropType[])[0]
    : (source as ImageSourcePropType | undefined);
}
function isBitmap(source: ImageSourcePropType | undefined): source is NativeBitmapSource {
  return source !== undefined && typeof source === "object" && "pixels" in source;
}
function ImageView(props: ImageProps): ReactElement {
  const selected = imageSource(props.source);
  const uri =
    typeof selected === "object" && "uri" in selected ? selected.uri : undefined;
  const [bitmap, setBitmap] = useState<NativeBitmapSource | undefined>(() =>
    isBitmap(selected) ? selected : uri === undefined ? undefined : imageCache.get(uri),
  );
  useEffect(() => {
    if (isBitmap(selected)) {
      setBitmap(selected);
      props.onLoad?.();
      return;
    }
    if (uri === undefined) return;
    let cancelled = false;
    void loadImage(uri).then(
      (loaded) => {
        if (cancelled) return;
        setBitmap(loaded);
        props.onLoad?.();
      },
      (error: unknown) => {
        if (!cancelled)
          props.onError?.(
            error instanceof Error ? error : new Error("Image load failed."),
          );
      },
    );
    return () => {
      cancelled = true;
    };
  }, [selected, uri]);
  const { source: _source, onLoad: _onLoad, onError: _onError, ...nativeProps } = props;
  void _source;
  void _onLoad;
  void _onError;
  return NativeImage({
    ...nativeProps,
    // Forward resizeMode to the host image element.
    ...(props.resizeMode !== undefined ? { resizeMode: props.resizeMode } : {}),
    ...(bitmap === undefined ? {} : { source: bitmap }),
  });
}
export const Image = Object.assign(ImageView, {
  getSize: (
    uri: string,
    success: (width: number, height: number) => void,
    failure?: (error: Error) => void,
  ): void => {
    void loadImage(uri).then(
      (bitmap) => {
        success(bitmap.width, bitmap.height);
      },
      (error: unknown) =>
        failure?.(error instanceof Error ? error : new Error("Image load failed.")),
    );
  },
  getSizeWithHeaders: (
    uri: string,
    _headers: Record<string, string>,
    success: (width: number, height: number) => void,
    failure?: (error: Error) => void,
  ): void => {
    Image.getSize(uri, success, failure);
  },
  prefetch: async (uri: string): Promise<boolean> => {
    await loadImage(uri);
    return true;
  },
  queryCache: (uris: readonly string[]): Promise<Record<string, "memory">> =>
    Promise.resolve(
      Object.fromEntries(
        uris.filter((uri) => imageCache.has(uri)).map((uri) => [uri, "memory" as const]),
      ),
    ),
  resolveAssetSource: (source: ImageSourcePropType | undefined) => source ?? null,
});

export interface PressableState {
  readonly pressed: boolean;
}

export type PressableStyleProp =
  NativeProps["style"] | ((state: PressableState) => NativeProps["style"]);

export interface PressableProps extends Omit<NativeComponentProps, "style" | "children"> {
  readonly style?: PressableStyleProp;
  readonly children?: ReactNode | ((state: PressableState) => ReactNode);
  readonly onPressIn?: () => void;
  readonly onPressOut?: () => void;
  readonly onLongPress?: () => void;
  readonly delayLongPress?: number;
}

function resolvePressableStyle(
  style: PressableStyleProp | undefined,
  state: PressableState,
): NativeProps["style"] {
  if (typeof style === "function") {
    return style(state);
  }
  return style;
}

function resolvePressableChildren(
  children: PressableProps["children"],
  state: PressableState,
): ReactNode {
  if (typeof children === "function") {
    return children(state);
  }
  return children;
}

export function Pressable(props: PressableProps): ReactElement {
  const [pressed, setPressed] = useState(false);
  const state: PressableState = { pressed };
  const resolvedStyle = resolvePressableStyle(props.style, state);
  // Omit style/children from restProps (they're resolved above).
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { style: _style, children: _children, ...restProps } = props;

  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearLongPressTimer = useCallback(() => {
    if (longPressTimer.current !== null) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  const handlePressIn = useCallback(() => {
    setPressed(true);
    props.onPressIn?.();
    // Start long-press timer.
    if (props.onLongPress) {
      clearLongPressTimer();
      const delay = props.delayLongPress ?? 500;
      longPressTimer.current = setTimeout(() => {
        longPressTimer.current = null;
        props.onLongPress?.();
      }, delay);
    }
  }, [props.onPressIn, props.onLongPress, props.delayLongPress, clearLongPressTimer]);

  const handlePressOut = useCallback(() => {
    setPressed(false);
    clearLongPressTimer();
    props.onPressOut?.();
  }, [props.onPressOut, clearLongPressTimer]);

  // Clear timer on unmount.
  useEffect(() => {
    return clearLongPressTimer;
  }, [clearLongPressTimer]);

  return element("button", {
    ...restProps,
    ...(resolvedStyle !== undefined ? { style: resolvedStyle } : {}),
    onPressIn: handlePressIn,
    onPressOut: handlePressOut,
    role: props.role ?? props.accessibilityRole ?? "button",
    children: resolvePressableChildren(props.children, state),
  });
}

export const Button = (
  props: Omit<NativeComponentProps, "children" | "label"> & {
    readonly title: string;
    readonly color?: string | undefined;
    readonly onPress: () => void;
  },
): ReactElement =>
  Pressable({
    ...props,
    label: props.title,
    style: {
      minHeight: 40,
      paddingHorizontal: 16,
      paddingVertical: 10,
      backgroundColor: props.color ?? "#D7AC57",
      radius: 8,
      ...(props.style ?? {}),
    },
    children: NativeText({
      text: props.title,
      style: { textAlign: "center", fontWeight: 600 },
    }),
  });

export const TouchableOpacity = (
  props: NativeComponentProps & { readonly activeOpacity?: number },
): ReactElement =>
  element("button", {
    ...props,
    role: props.role ?? "button",
  });

export const TouchableHighlight = (props: NativeComponentProps): ReactElement =>
  element("button", {
    ...props,
    role: props.role ?? "button",
  });

export interface TextInputHandle {
  focus(): void;
  blur(): void;
  clear(): void;
  isFocused(): boolean;
}
export type NativeTextInputMethods = TextInputHandle;

export interface TextInputProps extends NativeComponentProps {
  readonly onChange?: (event: {
    readonly nativeEvent: { readonly text: string };
  }) => void;
  readonly onChangeText?: (text: string) => void;
  readonly returnKeyType?: "done" | "go" | "next" | "search" | "send" | "default";
  readonly autoFocus?: boolean;
  readonly placeholder?: string;
  readonly secureTextEntry?: boolean;
  readonly multiline?: boolean;
  readonly editable?: boolean;
  readonly maxLength?: number;
  readonly keyboardType?:
    "default" | "email-address" | "numeric" | "phone-pad" | "number-pad";
}

export const NativeTextInput = (props: TextInputProps): ReactElement => {
  const ref = (props as { ref?: unknown }).ref;
  if (ref && typeof ref === "object" && "current" in ref) {
    ref.current = {
      focus: () => undefined,
      blur: () => undefined,
      clear: () => undefined,
      isFocused: () => false,
    };
  }
  const { autoFocus, ...restProps } = props;
  // autoFocus: focus on mount. The host handles the actual focus via the prop.
  return element("input", {
    ...restProps,
    ...(autoFocus !== undefined ? { autoFocus } : {}),
    // React Native TextInput is intrinsically focusable. Requiring every app to
    // duplicate that fact with accessibilityRole made otherwise-valid inputs
    // ignore pointer and keyboard focus in the SevynOS host.
    role: props.role ?? props.accessibilityRole ?? "textbox",
  });
};
export const TextInput = NativeTextInput;

export const NativeToggle = (props: NativeComponentProps): ReactElement =>
  element("toggle", {
    ...props,
    role: props.role ?? props.accessibilityRole ?? "checkbox",
  });
export const Switch = NativeToggle;

export const NativeSlider = (props: NativeComponentProps): ReactElement =>
  element("slider", {
    ...props,
    role: props.role ?? props.accessibilityRole ?? "slider",
  });
export const NativeSegmentedControl = (props: NativeComponentProps): ReactElement =>
  element("segment", props);
export const NativeSelect = (props: NativeComponentProps): ReactElement =>
  element("select", props);
export const NativeIcon = (props: NativeComponentProps): ReactElement =>
  element("icon", props);

export interface ScrollViewHandle {
  scrollTo(options?: { x?: number; y?: number; animated?: boolean }): void;
  scrollToEnd(options?: { animated?: boolean }): void;
  flashScrollIndicators(): void;
}
export type NativeScrollViewMethods = ScrollViewHandle;

export interface NativeScrollEvent {
  readonly nativeEvent: {
    readonly contentOffset: { readonly x: number; readonly y: number };
    readonly contentSize: { readonly width: number; readonly height: number };
    readonly layoutMeasurement: { readonly width: number; readonly height: number };
  };
}

export interface ScrollViewProps extends NativeComponentProps {
  readonly horizontal?: boolean;
  readonly contentContainerStyle?: NativeStyle;
  readonly onScroll?: (event: NativeScrollEvent) => void;
  readonly onContentSizeChange?: (width: number, height: number) => void;
  readonly scrollEventThrottle?: number;
  readonly refreshControl?: ReactElement | null;
}

export const NativeScrollView = (props: ScrollViewProps): ReactElement => {
  const ref = (props as { ref?: unknown }).ref;
  if (ref && typeof ref === "object" && "current" in ref) {
    ref.current = {
      scrollTo: () => undefined,
      scrollToEnd: () => undefined,
      flashScrollIndicators: () => undefined,
    };
  }
  const {
    refreshControl,
    contentContainerStyle,
    horizontal,
    onScroll,
    onContentSizeChange,
    scrollEventThrottle,
    ...restProps
  } = props;
  void onContentSizeChange;
  void scrollEventThrottle;
  const controlProps = refreshControl?.props as
    { readonly refreshing?: boolean; readonly onRefresh?: () => void } | undefined;
  const innerChildren = refreshControl
    ? [
        refreshControl,
        ...(Array.isArray(props.children)
          ? (props.children as readonly ReactNode[])
          : props.children == null
            ? []
            : [props.children]),
      ]
    : props.children;
  // Wrap children in a content container for contentContainerStyle.
  const children =
    contentContainerStyle === undefined
      ? innerChildren
      : element("view", {
          style: contentContainerStyle,
          children: innerChildren,
        });
  return element("scroll", {
    ...restProps,
    ...(horizontal !== undefined ? { horizontal } : {}),
    ...(onScroll !== undefined ? { onScroll } : {}),
    ...(controlProps?.onRefresh === undefined
      ? {}
      : { onRefresh: controlProps.onRefresh }),
    ...(controlProps?.refreshing === undefined
      ? {}
      : { refreshing: controlProps.refreshing }),
    children,
  });
};
export const ScrollView = NativeScrollView;

export const NativeOverlay = (props: NativeComponentProps): ReactElement =>
  element("overlay", props);
export const Modal = NativeOverlay;

export const SafeAreaView = (props: NativeComponentProps): ReactElement =>
  element("view", {
    ...props,
    style: { flexGrow: 1, ...(props.style ?? {}) },
  });

export const ActivityIndicator = (
  props: NativeComponentProps & {
    readonly size?: "small" | "large" | number;
    readonly color?: string | undefined;
  },
): ReactElement =>
  element("view", {
    ...props,
    style: {
      width:
        typeof props.size === "number" ? props.size : props.size === "large" ? 36 : 20,
      height:
        typeof props.size === "number" ? props.size : props.size === "large" ? 36 : 20,
      radius: 18,
      borderColor: props.color ?? "#D7AC57",
      borderWidth: 2,
      ...(props.style ?? {}),
    },
  });

export interface FlatListProps<ItemT> extends NativeComponentProps {
  readonly data: readonly ItemT[] | null | undefined;
  readonly renderItem: (info: { item: ItemT; index: number }) => ReactElement | null;
  readonly keyExtractor?: (item: ItemT, index: number) => string;
  readonly ItemSeparatorComponent?: () => ReactElement | null;
  readonly ListEmptyComponent?: (() => ReactElement | null) | ReactElement | null;
  readonly ListHeaderComponent?: (() => ReactElement | null) | ReactElement | null;
  readonly ListFooterComponent?: (() => ReactElement | null) | ReactElement | null;
  readonly horizontal?: boolean;
  readonly numColumns?: number;
  readonly columnWrapperStyle?: NativeProps["style"];
  readonly initialNumToRender?: number;
  readonly initialScrollIndex?: number;
  readonly maxToRenderPerBatch?: number;
  readonly windowSize?: number;
  readonly estimatedItemSize?: number;
  readonly getItemLayout?: (
    data: readonly ItemT[] | null | undefined,
    index: number,
  ) => { readonly length: number; readonly offset: number; readonly index: number };
  readonly onEndReached?: (info: { readonly distanceFromEnd: number }) => void;
  readonly onEndReachedThreshold?: number;
}

export function FlatList<ItemT>(props: FlatListProps<ItemT>): ReactElement {
  const numColumns = Math.max(1, Math.floor(props.numColumns ?? 1));
  if (numColumns <= 1) {
    return createElement(VirtualizedList<ItemT>, {
      ...props,
      getItem: (data, index) => data[index] as ItemT,
      getItemCount: (data) => data?.length ?? 0,
    });
  }
  // Multi-column: chunk data into rows, each row renders its items horizontally.
  const data = props.data ?? [];
  const rowCount = Math.ceil(data.length / numColumns);
  const rows: { readonly items: readonly { item: ItemT; index: number }[] }[] = [];
  for (let r = 0; r < rowCount; r++) {
    const items: { item: ItemT; index: number }[] = [];
    for (let c = 0; c < numColumns; c++) {
      const index = r * numColumns + c;
      if (index < data.length) {
        items.push({ item: data[index] as ItemT, index });
      }
    }
    rows.push({ items });
  }
  // Omit props that are overridden for the row-based list.
  const {
    data: _data,
    renderItem: _renderItem,
    keyExtractor: _keyExtractor,
    getItemLayout: _getItemLayout,
    ...rowListProps
  } = props;
  void _data;
  void _renderItem;
  void _keyExtractor;
  void _getItemLayout;
  return createElement(
    VirtualizedList<{ readonly items: readonly { item: ItemT; index: number }[] }>,
    {
      ...rowListProps,
      data: rows,
      getItem: (d, i) =>
        d[i] as { readonly items: readonly { item: ItemT; index: number }[] },
      getItemCount: (d) => d?.length ?? 0,
      keyExtractor: (row, rowIndex) => {
        if (props.keyExtractor) {
          const extractor = props.keyExtractor;
          return row.items.map(({ item, index }) => extractor(item, index)).join(":");
        }
        return `row-${String(rowIndex)}`;
      },
      renderItem: ({ item: row }) => {
        const rowStyle: Record<string, unknown> = { flexDirection: "row" };
        if (props.columnWrapperStyle && typeof props.columnWrapperStyle === "object") {
          Object.assign(rowStyle, props.columnWrapperStyle);
        }
        return element("view", {
          style: rowStyle,
          children: row.items.map(({ item, index }) => props.renderItem({ item, index })),
        });
      },
    },
  );
}

/**
 * TouchableWithoutFeedback — pressable area without visual feedback.
 * Maps to the native button type with no default highlight behavior.
 */
export const TouchableWithoutFeedback = (props: NativeComponentProps): ReactElement =>
  element("button", {
    ...props,
    role: props.role ?? "button",
  });

/**
 * ImageBackground — View with a background image.
 * Renders children on top of an image.
 */
export const ImageBackground = (
  props: NativeComponentProps & {
    readonly source?: ImageSourcePropType;
    readonly resizeMode?: "cover" | "contain" | "stretch" | "center";
    readonly imageStyle?: NativeProps["style"];
  },
): ReactElement => {
  const { source, resizeMode, imageStyle, children, ...viewProps } = props;
  const bgStyle = {
    position: "absolute" as const,
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
    ...(imageStyle ?? {}),
  };
  return element("view", {
    ...viewProps,
    style: {
      position: "relative",
      ...(viewProps.style ?? {}),
    },
    children: [
      createElement(Image, {
        key: "__bg",
        ...(source != null ? { source } : {}),
        ...(resizeMode === undefined ? {} : { resizeMode }),
        style: bgStyle,
      }),
      ...Children.toArray(children),
    ],
  });
};

/**
 * KeyboardAvoidingView — adjusts its height/position when the virtual keyboard shows.
 * On SevynOS desktop, this is a pass-through View since there is no virtual keyboard.
 */
export const KeyboardAvoidingView = (
  props: NativeComponentProps & {
    readonly behavior?: "height" | "position" | "padding";
    readonly keyboardVerticalOffset?: number;
    readonly contentContainerStyle?: Record<string, unknown>;
    readonly enabled?: boolean;
  },
): ReactElement => {
  const enabled = props.enabled !== false;
  const [reportedKeyboardHeight, setReportedKeyboardHeight] = useState(
    keyboardAvoidanceHeight,
  );
  useEffect(() => {
    keyboardAvoidanceListeners.add(setReportedKeyboardHeight);
    return () => {
      keyboardAvoidanceListeners.delete(setReportedKeyboardHeight);
    };
  }, []);
  const keyboardHeight = enabled ? reportedKeyboardHeight : 0;
  const offset = Math.max(0, keyboardHeight - (props.keyboardVerticalOffset ?? 0));
  const adjustment =
    props.behavior === "height"
      ? {
          maxHeight: Math.max(
            0,
            ((typeof props.style?.height === "number" ? props.style.height : 0) ||
              keyboardHeight) - offset,
          ),
        }
      : props.behavior === "position"
        ? { translateY: -offset }
        : { paddingBottom: offset };
  return element("view", {
    ...props,
    style: { flexGrow: 1, ...(props.style ?? {}), ...(offset > 0 ? adjustment : {}) },
  });
};

let keyboardAvoidanceHeight = 0;
const keyboardAvoidanceListeners = new Set<(height: number) => void>();
export function setKeyboardAvoidanceHeight(height: number): void {
  keyboardAvoidanceHeight = Math.max(0, height);
  for (const listener of keyboardAvoidanceListeners) listener(keyboardAvoidanceHeight);
}

/**
 * StatusBar — controls the appearance of the status bar.
 * On SevynOS desktop, this is a no-op since there is no mobile status bar.
 * Apps can safely import and call it without crashing.
 */
export interface StatusBarProps extends NativeComponentProps {
  readonly barStyle?: "default" | "light-content" | "dark-content";
  readonly hidden?: boolean;
  readonly backgroundColor?: string;
  readonly translucent?: boolean;
  readonly animated?: boolean;
  readonly networkActivityIndicatorVisible?: boolean;
}
export interface StatusBarState {
  readonly barStyle: "default" | "light-content" | "dark-content";
  readonly hidden: boolean;
  readonly backgroundColor: string;
  readonly translucent: boolean;
  readonly networkActivityIndicatorVisible: boolean;
}
let statusBarState: StatusBarState = Object.freeze({
  barStyle: "default",
  hidden: false,
  backgroundColor: "transparent",
  translucent: false,
  networkActivityIndicatorVisible: false,
});
const statusBarListeners = new Set<(state: StatusBarState) => void>();
function updateStatusBar(update: Partial<StatusBarState>): void {
  statusBarState = Object.freeze({ ...statusBarState, ...update });
  for (const listener of statusBarListeners) listener(statusBarState);
}
function StatusBarView(props: StatusBarProps): ReactElement | null {
  useEffect(() => {
    updateStatusBar({
      ...(props.barStyle === undefined ? {} : { barStyle: props.barStyle }),
      ...(props.hidden === undefined ? {} : { hidden: props.hidden }),
      ...(props.backgroundColor === undefined
        ? {}
        : { backgroundColor: props.backgroundColor }),
      ...(props.translucent === undefined ? {} : { translucent: props.translucent }),
      ...(props.networkActivityIndicatorVisible === undefined
        ? {}
        : { networkActivityIndicatorVisible: props.networkActivityIndicatorVisible }),
    });
  }, [
    props.backgroundColor,
    props.barStyle,
    props.hidden,
    props.networkActivityIndicatorVisible,
    props.translucent,
  ]);
  return null;
}
export const StatusBar = Object.assign(StatusBarView, {
  setBarStyle: (barStyle: StatusBarState["barStyle"], _animated?: boolean) => {
    void _animated;
    updateStatusBar({ barStyle });
  },
  setHidden: (hidden: boolean, _animation?: "none" | "fade" | "slide") => {
    void _animation;
    updateStatusBar({ hidden });
  },
  setBackgroundColor: (backgroundColor: string, _animated?: boolean) => {
    void _animated;
    updateStatusBar({ backgroundColor });
  },
  setTranslucent: (translucent: boolean) => {
    updateStatusBar({ translucent });
  },
  setNetworkActivityIndicatorVisible: (networkActivityIndicatorVisible: boolean) => {
    updateStatusBar({ networkActivityIndicatorVisible });
  },
  currentHeight: 24,
  getState: (): StatusBarState => statusBarState,
  addChangeListener: (listener: (state: StatusBarState) => void) => {
    statusBarListeners.add(listener);
    return { remove: () => statusBarListeners.delete(listener) };
  },
});

/**
 * StatusBar as a component — renders nothing but accepts props.
 */
export const StatusBarComponent = StatusBar;

/**
 * RefreshControl — pull-to-refresh indicator.
 * On SevynOS desktop this is a no-op component.
 * Apps can pass it to ScrollView's refreshControl prop.
 */
export const RefreshControl = (
  props: NativeComponentProps & {
    readonly refreshing: boolean;
    readonly onRefresh?: () => void;
    readonly colors?: readonly string[];
    readonly tintColor?: string;
    readonly title?: string;
    readonly titleColor?: string;
    readonly progressBackgroundColor?: string;
    readonly progressViewOffset?: number;
    readonly size?: number;
    readonly enabled?: boolean;
  },
): ReactElement =>
  element("view", {
    ...props,
    role: "application",
    label: props.title ?? (props.refreshing ? "Refreshing" : "Pull to refresh"),
    style: {
      height: props.refreshing ? Math.max(28, props.size ?? 32) : 0,
      overflow: "hidden",
      align: "center",
      justify: "center",
      backgroundColor: props.progressBackgroundColor ?? "transparent",
      ...(props.style ?? {}),
    },
    children: props.refreshing
      ? ActivityIndicator({
          size: props.size ?? "small",
          ...((props.tintColor ?? props.colors?.[0]) === undefined
            ? {}
            : { color: props.tintColor ?? props.colors?.[0] }),
        })
      : undefined,
  });

/**
 * Section type for SectionList.
 */
export interface SectionListSection<ItemT> {
  readonly data: readonly ItemT[];
  readonly key?: string;
  readonly renderItem?: (info: { item: ItemT; index: number }) => ReactElement | null;
  readonly ItemSeparatorComponent?: () => ReactElement | null;
  readonly keyExtractor?: (item: ItemT, index: number) => string;
}

/**
 * SectionList — a performant interface for rendering sectioned lists.
 */
export interface SectionListProps<ItemT> extends NativeComponentProps {
  readonly sections: readonly SectionListSection<ItemT>[];
  readonly renderItem: (info: {
    item: ItemT;
    index: number;
    section: SectionListSection<ItemT>;
  }) => ReactElement | null;
  readonly renderSectionHeader?: (info: {
    section: SectionListSection<ItemT>;
  }) => ReactElement | null;
  readonly renderSectionFooter?: (info: {
    section: SectionListSection<ItemT>;
  }) => ReactElement | null;
  readonly keyExtractor?: (item: ItemT, index: number) => string;
  readonly SectionSeparatorComponent?: () => ReactElement | null;
  readonly ItemSeparatorComponent?: () => ReactElement | null;
  readonly ListEmptyComponent?: (() => ReactElement | null) | ReactElement | null;
  readonly ListHeaderComponent?: (() => ReactElement | null) | ReactElement | null;
  readonly ListFooterComponent?: (() => ReactElement | null) | ReactElement | null;
  readonly stickySectionHeadersEnabled?: boolean;
  readonly initialNumToRender?: number;
  readonly maxToRenderPerBatch?: number;
  readonly windowSize?: number;
  readonly estimatedItemSize?: number;
  readonly onEndReached?: (info: { readonly distanceFromEnd: number }) => void;
  readonly onEndReachedThreshold?: number;
}

export function SectionList<ItemT>(props: SectionListProps<ItemT>): ReactElement {
  const allEmpty = props.sections.every((s) => s.data.length === 0);
  if (allEmpty) {
    return createElement(VirtualizedList<never>, {
      ...props,
      data: [],
      renderItem: () => null,
      getItem: () => {
        throw new RangeError("Cannot read an item from an empty SectionList.");
      },
      getItemCount: () => 0,
    });
  }

  type SectionEntry =
    | {
        readonly kind: "header" | "footer";
        readonly section: SectionListSection<ItemT>;
        readonly key: string;
      }
    | {
        readonly kind: "item";
        readonly section: SectionListSection<ItemT>;
        readonly item: ItemT;
        readonly index: number;
        readonly key: string;
      }
    | {
        readonly kind: "item-separator" | "section-separator";
        readonly section: SectionListSection<ItemT>;
        readonly key: string;
      };
  const entries: SectionEntry[] = [];
  props.sections.forEach((section, sectionIndex) => {
    const sectionKey = section.key ?? `section-${String(sectionIndex)}`;
    if (props.renderSectionHeader)
      entries.push({ kind: "header", section, key: `${sectionKey}:header` });
    section.data.forEach((item, itemIndex) => {
      const itemKey =
        (section.keyExtractor ?? props.keyExtractor)?.(item, itemIndex) ??
        String(itemIndex);
      entries.push({
        kind: "item",
        section,
        item,
        index: itemIndex,
        key: `${sectionKey}:item:${itemKey}`,
      });
      const separator = section.ItemSeparatorComponent ?? props.ItemSeparatorComponent;
      if (separator && itemIndex < section.data.length - 1)
        entries.push({
          kind: "item-separator",
          section,
          key: `${sectionKey}:separator:${itemKey}`,
        });
    });
    if (props.renderSectionFooter)
      entries.push({ kind: "footer", section, key: `${sectionKey}:footer` });
    if (props.SectionSeparatorComponent && sectionIndex < props.sections.length - 1)
      entries.push({
        kind: "section-separator",
        section,
        key: `${sectionKey}:section-separator`,
      });
  });

  return createElement(VirtualizedList<SectionEntry>, {
    ...props,
    data: entries,
    getItem: (data, index) => {
      const entry = data[index];
      if (entry === undefined)
        throw new RangeError("Cannot read an item outside the SectionList bounds.");
      return entry;
    },
    getItemCount: (data) => data?.length ?? 0,
    keyExtractor: (entry) => entry.key,
    renderItem: ({ item: entry }) => {
      switch (entry.kind) {
        case "header":
          return props.renderSectionHeader?.({ section: entry.section }) ?? null;
        case "footer":
          return props.renderSectionFooter?.({ section: entry.section }) ?? null;
        case "item-separator": {
          const Separator =
            entry.section.ItemSeparatorComponent ?? props.ItemSeparatorComponent;
          return Separator ? createElement(Separator) : null;
        }
        case "section-separator":
          return props.SectionSeparatorComponent
            ? createElement(props.SectionSeparatorComponent)
            : null;
        case "item":
          return (entry.section.renderItem ?? props.renderItem)({
            item: entry.item,
            index: entry.index,
            section: entry.section,
          });
      }
    },
    ItemSeparatorComponent: () => null,
  });
}

/**
 * VirtualizedList — the underlying implementation for FlatList and SectionList.
 * Only the visible area and an overscan window are mounted. Spacer views retain
 * the complete content size so native scrolling and scrollbars stay accurate.
 */
export interface VirtualizedListProps<ItemT> extends NativeComponentProps {
  readonly data: readonly ItemT[] | null | undefined;
  readonly renderItem: (info: { item: ItemT; index: number }) => ReactElement | null;
  readonly getItem: (data: readonly ItemT[], index: number) => ItemT;
  readonly getItemCount: (data: readonly ItemT[] | null | undefined) => number;
  readonly keyExtractor?: (item: ItemT, index: number) => string;
  readonly ListEmptyComponent?: (() => ReactElement | null) | ReactElement | null;
  readonly ListHeaderComponent?: (() => ReactElement | null) | ReactElement | null;
  readonly ListFooterComponent?: (() => ReactElement | null) | ReactElement | null;
  readonly ItemSeparatorComponent?: () => ReactElement | null;
  readonly horizontal?: boolean;
  readonly initialNumToRender?: number;
  readonly initialScrollIndex?: number;
  readonly maxToRenderPerBatch?: number;
  readonly windowSize?: number;
  readonly estimatedItemSize?: number;
  readonly getItemLayout?: (
    data: readonly ItemT[] | null | undefined,
    index: number,
  ) => { readonly length: number; readonly offset: number; readonly index: number };
  readonly onEndReached?: (info: { readonly distanceFromEnd: number }) => void;
  readonly onEndReachedThreshold?: number;
}

export function VirtualizedList<ItemT>(props: VirtualizedListProps<ItemT>): ReactElement {
  const data = props.data ?? [];
  const count = props.getItemCount(data);
  const estimate = Math.max(1, props.estimatedItemSize ?? 48);
  const viewportDimension = props.horizontal ? props.style?.width : props.style?.height;
  const viewportSize =
    (typeof viewportDimension === "number" ? viewportDimension : undefined) ??
    estimate * Math.max(1, props.initialNumToRender ?? 10);
  const initialIndex = Math.min(
    Math.max(0, props.initialScrollIndex ?? 0),
    Math.max(0, count - 1),
  );
  const initialOffset =
    count === 0
      ? 0
      : (props.getItemLayout?.(data, initialIndex).offset ?? initialIndex * estimate);
  const [scrollOffset, setScrollOffset] = useState(initialOffset);
  const endReachedContentLength = useRef<number | undefined>(undefined);

  const layoutAt = useCallback(
    (index: number): { readonly length: number; readonly offset: number } => {
      if (index < 0) return { length: 0, offset: 0 };
      const measured = props.getItemLayout?.(
        data,
        Math.min(index, Math.max(0, count - 1)),
      );
      return measured ?? { length: estimate, offset: index * estimate };
    },
    [count, data, estimate, props.getItemLayout],
  );
  const contentLength =
    count === 0
      ? 0
      : (() => {
          const last = layoutAt(count - 1);
          return last.offset + last.length;
        })();
  const overscan = Math.max(0, (props.windowSize ?? 5) - 1) * viewportSize * 0.5;
  const windowStart = Math.max(0, scrollOffset - overscan);
  const windowEnd = Math.min(contentLength, scrollOffset + viewportSize + overscan);

  const indexAtOffset = (offset: number): number => {
    if (!props.getItemLayout)
      return Math.min(count, Math.max(0, Math.floor(offset / estimate)));
    let low = 0;
    let high = count;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const layout = layoutAt(middle);
      if (layout.offset + layout.length <= offset) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  const first = count === 0 ? 0 : Math.min(count - 1, indexAtOffset(windowStart));
  const requestedLast = count === 0 ? -1 : Math.min(count - 1, indexAtOffset(windowEnd));
  const minimumBatch = Math.max(
    1,
    props.maxToRenderPerBatch ?? props.initialNumToRender ?? 10,
  );
  const last =
    count === 0
      ? -1
      : Math.min(count - 1, Math.max(requestedLast, first + minimumBatch - 1));
  const listChildren: ReactNode[] = [];

  if (props.ListHeaderComponent) {
    listChildren.push(renderListComponent(props.ListHeaderComponent, "__header"));
  }

  if (count === 0 && props.ListEmptyComponent) {
    listChildren.push(renderListComponent(props.ListEmptyComponent, "__empty"));
  } else {
    const before = count === 0 ? 0 : layoutAt(first).offset;
    if (before > 0) listChildren.push(spacer("__before", before, props.horizontal));
    for (let i = first; i <= last; i++) {
      const item = props.getItem(data, i);
      const itemElement = props.renderItem({ item, index: i });
      const itemKey = props.keyExtractor?.(item, i) ?? defaultListKey(item, i);
      if (itemElement)
        listChildren.push(cloneElement(itemElement, { key: `item:${itemKey}` }));
      if (i < last && props.ItemSeparatorComponent) {
        listChildren.push(
          createElement(props.ItemSeparatorComponent, { key: `separator:${itemKey}` }),
        );
      }
    }
    const renderedEnd =
      last < 0
        ? 0
        : (() => {
            const layout = layoutAt(last);
            return layout.offset + layout.length;
          })();
    const after = Math.max(0, contentLength - renderedEnd);
    if (after > 0) listChildren.push(spacer("__after", after, props.horizontal));
  }

  if (props.ListFooterComponent) {
    listChildren.push(renderListComponent(props.ListFooterComponent, "__footer"));
  }

  const handleScroll = (event: NativeScrollEvent | number): void => {
    // Handle both the new event shape and legacy number offset (from host).
    const offset =
      typeof event === "number"
        ? event
        : props.horizontal
          ? event.nativeEvent.contentOffset.x
          : event.nativeEvent.contentOffset.y;
    setScrollOffset(Math.max(0, offset));
    // Send RN-compatible scroll event shape.
    const scrollEvent: NativeScrollEvent = {
      nativeEvent: {
        contentOffset: {
          x: props.horizontal ? Math.max(0, offset) : 0,
          y: props.horizontal ? 0 : Math.max(0, offset),
        },
        contentSize: {
          width: props.horizontal ? contentLength : viewportSize,
          height: props.horizontal ? viewportSize : contentLength,
        },
        layoutMeasurement: {
          width: props.horizontal ? viewportSize : viewportSize,
          height: props.horizontal ? viewportSize : viewportSize,
        },
      },
    };
    props.onScroll?.(scrollEvent);
    const distanceFromEnd = Math.max(0, contentLength - viewportSize - offset);
    const threshold = Math.max(0, props.onEndReachedThreshold ?? 2) * viewportSize;
    if (
      props.onEndReached &&
      distanceFromEnd <= threshold &&
      endReachedContentLength.current !== contentLength
    ) {
      endReachedContentLength.current = contentLength;
      props.onEndReached({ distanceFromEnd });
    }
  };

  return element("scroll", {
    ...props,
    onScroll: handleScroll,
    style: {
      overflow: "scroll",
      direction: props.horizontal ? "row" : "column",
      scrollOffset,
      ...(props.style ?? {}),
    },
    children: listChildren,
  });
}

type ListComponent = (() => ReactElement | null) | ReactElement;

function renderListComponent(component: ListComponent, key: string): ReactElement | null {
  return isValidElement(component)
    ? cloneElement(component, { key })
    : createElement(component as ComponentType, { key });
}

function spacer(key: string, size: number, horizontal = false): ReactElement {
  return element("view", {
    key,
    style: horizontal ? { width: size, height: 1 } : { height: size, width: 1 },
  });
}

function defaultListKey(item: unknown, index: number): string {
  if (typeof item === "object" && item !== null) {
    const candidate =
      (item as { readonly key?: unknown; readonly id?: unknown }).key ??
      (item as { readonly id?: unknown }).id;
    if (typeof candidate === "string" || typeof candidate === "number")
      return String(candidate);
  }
  return String(index);
}

export const TouchableNativeFeedback = Object.assign(
  (props: NativeComponentProps): ReactElement => Pressable(props),
  {
    SelectableBackground: () => ({
      type: "themeAttr",
      attribute: "selectableItemBackground",
    }),
    SelectableBackgroundBorderless: () => ({
      type: "themeAttr",
      attribute: "selectableItemBackgroundBorderless",
    }),
    Ripple: (color: string, borderless = false, radius?: number) => ({
      type: "RippleAndroid",
      color,
      borderless,
      ...(radius === undefined ? {} : { rippleRadius: radius }),
    }),
  },
);

export const Touchable = Object.freeze({
  Mixin: Object.freeze({}),
  renderDebugView: () => null,
});

export const DrawerLayoutAndroid = (
  props: NativeComponentProps & {
    readonly renderNavigationView?: () => ReactElement | null;
    readonly drawerWidth?: number;
    readonly drawerPosition?: "left" | "right";
  },
): ReactElement =>
  View({
    ...props,
    children: props.children,
  });

export const InputAccessoryView = (props: NativeComponentProps): ReactElement =>
  View(props);

export const ProgressBarAndroid = (
  props: NativeComponentProps & {
    readonly animating?: boolean;
    readonly color?: string;
    readonly progress?: number;
  },
): ReactElement =>
  props.animating === false
    ? View({ ...props, style: { height: 0, ...(props.style ?? {}) } })
    : ActivityIndicator({
        ...props,
        ...(props.color === undefined ? {} : { color: props.color }),
      });

export const VirtualizedSectionList = SectionList;
export const unstable_NativeText = NativeText;
export const unstable_NativeView = View;
export const unstable_VirtualView = View;
export const experimental_LayoutConformance = View;
