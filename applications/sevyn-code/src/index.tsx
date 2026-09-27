/**
 * Sevyn Code — the SevynOS integrated development environment.
 *
 * This is a thin shell around the code-server workbench, which runs on the
 * host bound to 127.0.0.1 and is streamed here via CDP screencast. The app
 * displays the workbench pixels and forwards input events (pointer, keyboard,
 * wheel) back through the browser engine.
 *
 * The integrated terminal launches the Sevyn CLI as its default shell —
 * there is no bash, no Linux shell. Everything goes through SevynOS.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import {
  NativeImage,
  StyleSheet,
  Text,
  View,
  type BrowserEngineSnapshot,
  type SevynBrowserEngine,
  type SevynApplicationManifest,
} from "@sevynos/react-native";

export const sevynCodeManifest: SevynApplicationManifest = {
  manifestVersion: 1,
  id: "org.sevynos.sevyn-code",
  name: "Sevyn Code",
  version: "1.0.0",
  runtime: "react-native",
  applicationKey: "SevynCode",
  developer: "SevynOS",
  icon: "icons/sevyn-code.svg",
  entrypoint: "dist/index.js",
  minimumSevynOSVersion: "0.1.0",
  permissions: ["network"],
  services: ["sevyn-code"],
  windowModes: ["standard", "fullscreen"],
  instanceMode: "single",
};

interface SevynCodePointerEvent {
  readonly x: number;
  readonly y: number;
  readonly button?: number;
}

interface SevynCodeWheelEvent {
  readonly x: number;
  readonly y: number;
  readonly deltaY: number;
  readonly deltaX?: number;
}

interface SevynCodeKeyboardEvent {
  readonly key: string;
  readonly code: string;
  readonly shift: boolean;
  readonly alt: boolean;
  readonly control: boolean;
  readonly meta: boolean;
}

interface SevynCodeAppProps {
  /**
   * The browser engine streaming the code-server workbench.
   * When undefined, the app renders an unavailable state instead of crashing.
   */
  readonly engine?: SevynBrowserEngine | undefined;
}

export function SevynCodeApp({ engine }: SevynCodeAppProps): JSX.Element {
  if (!engine) {
    return (
      <View style={styles.container}>
        <View style={styles.loadingOverlay}>
          <Text style={styles.loadingTitle}>Sevyn Code</Text>
          <Text style={styles.loadingText}>
            The development environment is unavailable. The host did not provide a browser
            engine.
          </Text>
        </View>
      </View>
    );
  }

  return <SevynCodeWorkspace engine={engine} />;
}

function SevynCodeWorkspace({
  engine,
}: {
  readonly engine: SevynBrowserEngine;
}): JSX.Element {
  const [snapshot, setSnapshot] = useState<BrowserEngineSnapshot>(() =>
    engine.snapshot(),
  );
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    setSnapshot(engine.snapshot());
    const unsubscribe = engine.subscribe(() => {
      const snap = engine.snapshot();
      setSnapshot(snap);
      if (snap.ready && !snap.loading) setConnected(true);
    });
    return unsubscribe;
  }, [engine]);

  const lastClickRef = useRef<{ x: number; y: number; time: number } | null>(null);
  const clickCountRef = useRef(0);
  const skipUpRef = useRef(false);

  const handlePointerDown = useCallback(
    (event: SevynCodePointerEvent) => {
      const now = Date.now();
      const last = lastClickRef.current;
      if (
        last &&
        now - last.time < 500 &&
        Math.abs(event.x - last.x) < 8 &&
        Math.abs(event.y - last.y) < 8
      ) {
        // Multi-click: clickCount 2 = double (select word), 3 = triple (select line)
        clickCountRef.current = Math.min(clickCountRef.current + 1, 3);
        lastClickRef.current = null;
        skipUpRef.current = true;
        void engine.click(event.x, event.y, clickCountRef.current);
      } else {
        clickCountRef.current = 1;
        lastClickRef.current = { x: event.x, y: event.y, time: now };
        skipUpRef.current = false;
        void engine.pointerDown(event.x, event.y, event.button ?? 0);
      }
    },
    [engine],
  );

  const handlePointerUp = useCallback(
    (event: SevynCodePointerEvent) => {
      // Skip the up event when the down was consumed by a multi-click
      // (engine.click already sent a complete down+up pair)
      if (skipUpRef.current) {
        skipUpRef.current = false;
        return;
      }
      void engine.pointerUp(event.x, event.y, event.button ?? 0);
    },
    [engine],
  );

  const handlePointerMove = useCallback(
    (event: SevynCodePointerEvent) => {
      void engine.pointerMove(event.x, event.y);
    },
    [engine],
  );

  const handleWheel = useCallback(
    (event: SevynCodeWheelEvent) => {
      void engine.scroll(event.x, event.y, event.deltaY, event.deltaX ?? 0);
    },
    [engine],
  );

  const handleKey = useCallback(
    (event: SevynCodeKeyboardEvent) => {
      void engine.key(event.key, event.code, {
        shift: event.shift,
        alt: event.alt,
        control: event.control,
        meta: event.meta,
      });
    },
    [engine],
  );

  return (
    <View style={styles.container}>
      {!connected && (
        <View style={styles.loadingOverlay}>
          <Text style={styles.loadingTitle}>Sevyn Code</Text>
          <Text style={styles.loadingText}>Starting the development environment…</Text>
        </View>
      )}
      {snapshot.pixels && (
        <NativeImage
          key="sevyn-code-workbench"
          id="sevyn-code.workbench"
          role="button"
          label="Sevyn Code workbench"
          source={{
            width: snapshot.width,
            height: snapshot.height,
            pixels: snapshot.pixels,
          }}
          style={styles.workbench}
          onPointerDown={handlePointerDown}
          onPointerUp={handlePointerUp}
          onPointerMove={handlePointerMove}
          onWheel={handleWheel}
          onKeyDown={handleKey}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#1e1e1e",
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#1e1e1e",
  },
  loadingTitle: {
    fontSize: 24,
    fontWeight: "700",
    color: "#ffffff",
    marginBottom: 8,
  },
  loadingText: {
    fontSize: 14,
    color: "#8b949e",
  },
  workbench: {
    flex: 1,
  },
});
