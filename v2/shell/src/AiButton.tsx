// SevynOS v2 — the AI button (DESIGN.md §2.8, phase 1).
//
// Floating button, bottom-right corner of the desktop. Tap opens the
// AI sidebar (AiSidebar.tsx); press-and-hold is the quick ask, which
// lands in phase 2. The button is shell-owned, not an app window, and
// always reachable from any desktop state. It hides while the sidebar
// is open — the sidebar has its own close button.
//
// Visual: a violet disc with a white "AI" monogram (the dock tiles
// use text monograms too, so no new icon asset is needed).

import * as React from "react";
import { Text, Pressable } from "./host";

// 56px: distinct from the dock tiles (61px at 1024px, see
// shell-e2e-test.js — the tile filter excludes this size).
export const AI_BUTTON_SIZE = 56;

export function AiButton(props: { onPress(): void }): React.ReactElement {
  return (
    <Pressable
      testID="ai-button"
      onPress={props.onPress}
      style={{
        position: "absolute",
        right: 16,
        bottom: 16,
        width: AI_BUTTON_SIZE,
        height: AI_BUTTON_SIZE,
        borderRadius: AI_BUTTON_SIZE / 2,
        backgroundColor: "#5B5BD6",
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <Text
        style={{
          fontSize: 20,
          fontWeight: "bold",
          color: "#ffffff",
          textAlign: "center",
        }}
      >
        AI
      </Text>
    </Pressable>
  );
}
