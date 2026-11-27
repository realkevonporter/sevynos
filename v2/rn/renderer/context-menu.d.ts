// Type declarations for the context-menu primitive (gap unit 9,
// audit #12). The implementation is plain JS (./context-menu.js);
// TSX consumers (apps, shell) import from here.

import type * as React from "react";

export interface ContextMenuItem {
  id: string;
  label: string;
  // Glyph rendered left of the label (e.g. an icon character).
  icon?: string;
  // Dimmed and never activates — keyboard navigation skips it.
  disabled?: boolean;
  // Renders a divider row instead of an action; `label` is ignored.
  separator?: boolean;
  // Fired on left-click or Enter/Space on the highlighted row; the
  // menu dismisses right after. Required unless separator/disabled.
  onSelect?: () => void;
}

export interface ContextMenuProps {
  // Pointer position the menu anchors on (from
  // onContextMenu's nativeEvent). Clamped to the surface.
  x: number;
  y: number;
  items: ContextMenuItem[];
  onDismiss: () => void;
  // Popup width in pixels; default 220.
  width?: number;
}

export function ContextMenu(props: ContextMenuProps): React.ReactElement;

export const MENU_WIDTH: number;
export const ROW_HEIGHT: number;
