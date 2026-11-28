"use strict";
// ContextMenu — the reusable context-menu popup (gap unit 9, audit #12).
//
// The renderer dispatches a right-click to the hit view's
// onContextMenu({nativeEvent:{x, y, button}}) instead of onPress
// (see sevyn-renderer.js); the consumer opens this component at that
// position. The later units render it — Files right-click (unit 10),
// desktop right-click (unit 11, which also moves the "New folder" /
// "New text file" actions into the menu and removes the desktop
// buttons), dock right-click (unit 12) — so this file is the
// primitive only: it wires no app menu itself.
//
//   <ContextMenu x={ev.nativeEvent.x} y={ev.nativeEvent.y}
//     items={[{id, label, icon?, disabled?, onSelect?}, {id, separator: true}]}
//     onDismiss={() => setMenu(null)} />
//
// Render it as the LAST child of the root view so it draws (and
// hit-tests) above everything else. Behaviour:
//   - Anchored near the pointer, clamped to the surface so the whole
//     popup stays on-screen (uses the renderer's surface-size store).
//   - Item rows: label + optional icon glyph; disabled items are
//     dimmed and never activate; a {separator: true} item draws a
//     divider row instead of an action.
//   - Dismiss on click-away (a full-surface transparent overlay sits
//     under the panel), on a right-click outside the panel, on Esc /
//     Tab, or on selecting an enabled item.
//   - Keyboard navigation while open: Down/Right moves the highlight
//     to the next enabled item (wrapping, skipping disabled and
//     separator rows), Up/Left to the previous, Enter/Space activates
//     the highlighted item. The component owns those keys through the
//     renderer's setContextMenuKeyHandler slot while mounted, so they
//     never move the caret or the focus ring behind the menu.
//
// The component is plain JS (React.createElement with the string host
// types, like the renderer tests) so both the apps bundle and the
// shell bundle can import it from here without a host.ts dependency:
//   const { ContextMenu } = require("../../rn/renderer/context-menu");
// Types live in ./context-menu.d.ts.

const React = require("react");
const { useState, useLayoutEffect, useSyncExternalStore } = React;
const renderer = require("./sevyn-renderer");
const { tokens } = require("./tokens");

// Geometry and dark colors come from ./tokens (the manifest's one
// shared source, polish surface (a)). Literals that stay are the ones
// whose manifest value differs from today's code — those change in
// their own surface's PR, not here (see ROW_HEIGHT and the highlight
// / label colors below).

const MENU_WIDTH = tokens.menu.width;
const ROW_HEIGHT = 32; // Manifest menu.rowHeight is 28 (surface (d)
// changes it); 32 is today's measured value — do NOT migrate yet.
const MENU_PADDING = tokens.menu.padding;
const SEPARATOR_HEIGHT = tokens.menu.separatorHeight; // 1px rule + 4px margins either side

function itemHeight(item) {
  return item.separator ? SEPARATOR_HEIGHT : ROW_HEIGHT;
}

function firstEnabledIndex(items) {
  for (let i = 0; i < items.length; i++) {
    if (!items[i].separator && !items[i].disabled) return i;
  }
  return -1;
}

function ContextMenu(props) {
  const items = props.items || [];
  const onDismiss = props.onDismiss;
  const menuWidth = props.width || MENU_WIDTH;
  const size = useSyncExternalStore(
    renderer.subscribeSurfaceSize,
    renderer.getSurfaceSizeSnapshot,
  );
  const [highlight, setHighlight] = useState(() => firstEnabledIndex(items));

  // Menu height is exact — every row has a fixed height — so the
  // clamp needs no measurement pass.
  let menuHeight = MENU_PADDING * 2;
  for (const item of items) menuHeight += itemHeight(item);
  const left = Math.max(0, Math.min(props.x, size.width - menuWidth));
  const top = Math.max(0, Math.min(props.y, size.height - menuHeight));

  function moveHighlight(dir) {
    setHighlight((prev) => {
      if (items.length === 0) return -1;
      // Start from the current highlight (or just outside the list
      // when nothing is highlighted) and walk, wrapping, until an
      // enabled item is found; a full loop with no hit keeps the
      // current highlight (all items disabled / separators).
      let next = prev;
      for (let step = 0; step < items.length; step++) {
        next = (next + dir + items.length) % items.length;
        if (!items[next].separator && !items[next].disabled) return next;
      }
      return prev;
    });
  }

  function activateHighlighted() {
    const item = items[highlight];
    if (!item || item.separator || item.disabled) return;
    if (item.onSelect) item.onSelect();
    if (onDismiss) onDismiss();
  }

  function onMenuKey(ev) {
    switch (ev.key) {
      case 108: // Down
      case 106: // Right
        moveHighlight(1);
        return true;
      case 103: // Up
      case 105: // Left
        moveHighlight(-1);
        return true;
      case 28: // Enter
      case 57: // Space
        activateHighlighted();
        return true;
      case 1: // Escape
      case 15: // Tab
        // Tab dismisses instead of moving focus onto the invisible
        // overlay (the overlay is a Pressable, so it is focusable).
        if (onDismiss) onDismiss();
        return true;
      default:
        return false;
    }
  }

  // Re-register after every commit so the handler always closes over
  // the latest highlight/items; the cleanup clears the slot on
  // unmount so keys stop coming here once the menu is gone.
  useLayoutEffect(() => {
    renderer.setContextMenuKeyHandler(onMenuKey);
    return () => renderer.setContextMenuKeyHandler(null);
  });

  const rows = items.map((item, i) => {
    if (item.separator) {
      return React.createElement("View", {
        key: item.id,
        style: {
          height: 1,
          backgroundColor: tokens.color.dark.border,
          marginTop: tokens.menu.padding,
          marginBottom: tokens.menu.padding,
        },
      });
    }
    const rowStyle = {
      flexDirection: "row",
      alignItems: "center",
      height: ROW_HEIGHT,
      borderRadius: tokens.menu.rowRadius,
      paddingLeft: tokens.menu.labelPadX,
      paddingRight: tokens.menu.labelPadX,
    };
    // Highlight stays #3b82f6: the manifest retires the blue for the
    // accent fill in surface (d); that PR changes this line.
    if (i === highlight) rowStyle.backgroundColor = "#3b82f6";
    // Label stays #ffffff / disabled #6b7280: the manifest's dark
    // textPrimary is #FAFAFA (a value change) and its dark muted is
    // #9CA3AF — neither is today's value, so neither migrates here.
    const labelColor = item.disabled ? "#6b7280" : "#ffffff";
    return React.createElement(
      "Pressable",
      {
        key: item.id,
        testID: "context-menu-item-" + item.id,
        onPress: item.disabled
          ? undefined
          : () => {
              if (item.onSelect) item.onSelect();
              if (onDismiss) onDismiss();
            },
        style: rowStyle,
      },
      item.icon
        ? React.createElement(
            "Text",
            {
              style: {
                fontSize: tokens.type.menuLabel.size,
                color: labelColor,
                width: tokens.menu.iconSlot,
              },
            },
            item.icon,
          )
        : null,
      React.createElement(
        "Text",
        { style: { fontSize: tokens.type.menuLabel.size, color: labelColor } },
        item.label,
      ),
    );
  });

  return React.createElement(
    "View",
    {
      style: {
        position: "absolute",
        left: 0,
        top: 0,
        width: size.width,
        height: size.height,
      },
    },
    // Click-away overlay, rendered first so the panel is topmost. A
    // Pressable with no background still emits a transparent hit
    // rect (sevyn-renderer.js emitInstance), so any press outside
    // the panel dismisses; a right-click outside does the same
    // through onContextMenu. Clicks on the panel itself fall through
    // its (non-pressable) background to this overlay, so dead space
    // inside the panel dismisses too.
    React.createElement("Pressable", {
      testID: "context-menu-overlay",
      onPress: onDismiss,
      onContextMenu: onDismiss,
      style: {
        position: "absolute",
        left: 0,
        top: 0,
        width: size.width,
        height: size.height,
      },
    }),
    React.createElement(
      "View",
      {
        testID: "context-menu",
        style: {
          position: "absolute",
          left,
          top,
          width: menuWidth,
          backgroundColor: tokens.color.dark.surface,
          borderRadius: tokens.menu.radius,
          padding: MENU_PADDING,
        },
      },
      rows,
    ),
  );
}

module.exports = { ContextMenu, MENU_WIDTH, ROW_HEIGHT };
