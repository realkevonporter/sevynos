import {
  createContext,
  createElement,
  forwardRef,
  useContext,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  NativeImage,
  NativeText,
  View,
  type NativeComponentProps,
} from "./primitives.js";
import type { BrowserEngineSnapshot, SevynBrowserEngine } from "./services.js";
import { getNativeAdapters } from "./native-adapter-contracts.js";

export interface WebViewNavigation extends BrowserEngineSnapshot {
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
}
export interface WebViewSource {
  readonly uri: string;
}
export interface WebViewHandle {
  goBack(): void;
  goForward(): void;
  reload(): void;
  stopLoading(): void;
  injectJavaScript(script: string): void;
}
export interface WebViewProps extends Omit<NativeComponentProps, "source"> {
  readonly source: WebViewSource;
  readonly onLoadStart?: () => void;
  readonly onLoadEnd?: () => void;
  readonly onError?: (event: {
    readonly nativeEvent: { readonly description: string };
  }) => void;
  readonly onNavigationStateChange?: (navigation: WebViewNavigation) => void;
}

type EngineFactory = () => SevynBrowserEngine;
const EngineFactoryContext = createContext<EngineFactory | undefined>(undefined);

export function SevynWebViewEngineProvider(props: {
  readonly createEngine: EngineFactory;
  readonly children?: ReactNode;
}): ReactElement {
  return createElement(
    EngineFactoryContext.Provider,
    { value: props.createEngine },
    props.children,
  );
}

const WebViewComponent = forwardRef<WebViewHandle, WebViewProps>((props, ref) => {
  const createEngine = useContext(EngineFactoryContext);
  const engineRef = useRef<SevynBrowserEngine | undefined>(undefined);
  if (engineRef.current === undefined) {
    const nativeWebViewAdapter = getNativeAdapters().webview;
    const factory =
      createEngine ??
      (nativeWebViewAdapter === undefined
        ? undefined
        : () => nativeWebViewAdapter.createEngine());
    if (factory !== undefined) engineRef.current = factory();
  }
  const engine = engineRef.current;
  const [snapshot, setSnapshot] = useState<BrowserEngineSnapshot | undefined>(
    engine?.snapshot(),
  );
  const update = (operation: () => Promise<BrowserEngineSnapshot>): void => {
    props.onLoadStart?.();
    void operation()
      .then((next) => {
        setSnapshot(next);
        props.onNavigationStateChange?.({ ...next, canGoBack: true, canGoForward: true });
        props.onLoadEnd?.();
      })
      .catch((error: unknown) =>
        props.onError?.({
          nativeEvent: {
            description: error instanceof Error ? error.message : String(error),
          },
        }),
      );
  };
  useImperativeHandle(ref, () => ({
    goBack: () => {
      if (engine !== undefined) update(() => engine.back());
    },
    goForward: () => {
      if (engine !== undefined) update(() => engine.forward());
    },
    reload: () => {
      if (engine !== undefined) update(() => engine.reload());
    },
    stopLoading: () => undefined,
    injectJavaScript: () => undefined,
  }));
  useEffect(() => {
    if (engine === undefined) return;
    const unsubscribe = engine.subscribe(() => {
      setSnapshot(engine.snapshot());
    });
    update(() => engine.navigate(props.source.uri));
    return () => {
      unsubscribe();
      void engine.close();
    };
  }, [engine, props.source.uri]);

  if (engine === undefined)
    return View({
      ...(props as unknown as NativeComponentProps),
      children: NativeText({ text: "WebView requires a Sevyn browser engine provider." }),
    });
  if (snapshot?.pixels === undefined)
    return View({
      ...(props as unknown as NativeComponentProps),
      children: NativeText({ text: snapshot?.error ?? "Loading…" }),
    });
  return NativeImage({
    ...(props as unknown as NativeComponentProps),
    source: { width: snapshot.width, height: snapshot.height, pixels: snapshot.pixels },
    onPointerDown: (event) => {
      void engine.pointerDown(event.x, event.y, event.button);
    },
    onPointerUp: (event) => {
      update(() => engine.pointerUp(event.x, event.y, event.button));
    },
    onWheel: (event) => {
      update(() => engine.scroll(event.x, event.y, event.deltaY, event.deltaX));
    },
    onKeyDown: (event) => {
      update(() => engine.key(event.key, event.code, event));
    },
  });
});
WebViewComponent.displayName = "WebView";
export const WebView = WebViewComponent;
export default WebView;
