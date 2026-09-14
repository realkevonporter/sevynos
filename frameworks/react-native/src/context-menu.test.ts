import { describe, it, expect, vi } from "vitest";
import {
  createContextMenuState,
  dismissContextMenu,
  isMenuSeparator,
  isMenuSubmenu,
  isMenuAction,
  contextMenuKeyHandler,
  renderContextMenu,
  type MenuItem,
  type MenuAction,
  type MenuSeparator,
  type MenuSubmenu,
} from "./context-menu.js";

describe("context-menu", () => {
  const mockAction1: MenuAction = {
    id: "action-1",
    label: "Copy",
    shortcut: "Ctrl+C",
    onAction: vi.fn(),
  };

  const mockAction2: MenuAction = {
    id: "action-2",
    label: "Paste",
    shortcut: "Ctrl+V",
    onAction: vi.fn(),
  };

  const mockSeparator: MenuSeparator = {
    kind: "separator",
  };

  const mockSubmenu: MenuSubmenu = {
    id: "submenu-1",
    label: "Sort By",
    items: [
      { id: "sort-name", label: "Name", onAction: vi.fn() },
      { id: "sort-date", label: "Date", onAction: vi.fn() },
    ],
  };

  const sampleItems: readonly MenuItem[] = [
    mockAction1,
    mockSeparator,
    mockAction2,
    mockSubmenu,
  ];

  it("identifies menu item kinds correctly", () => {
    expect(isMenuAction(mockAction1)).toBe(true);
    expect(isMenuSeparator(mockAction1)).toBe(false);
    expect(isMenuSubmenu(mockAction1)).toBe(false);

    expect(isMenuSeparator(mockSeparator)).toBe(true);
    expect(isMenuAction(mockSeparator)).toBe(false);
    expect(isMenuSubmenu(mockSeparator)).toBe(false);

    expect(isMenuSubmenu(mockSubmenu)).toBe(true);
    expect(isMenuAction(mockSubmenu)).toBe(false);
    expect(isMenuSeparator(mockSubmenu)).toBe(false);
  });

  it("creates initial context menu state", () => {
    const state = createContextMenuState({ x: 100, y: 200 }, sampleItems);
    expect(state.visible).toBe(true);
    expect(state.position).toEqual({ x: 100, y: 200 });
    expect(state.items).toEqual(sampleItems);
    expect(state.selectedIndex).toBe(-1);
  });

  it("dismisses context menu", () => {
    const state = dismissContextMenu();
    expect(state.visible).toBe(false);
    expect(state.items).toHaveLength(0);
    expect(state.selectedIndex).toBe(-1);
  });

  describe("contextMenuKeyHandler", () => {
    it("handles ArrowDown navigation and skips separators", () => {
      let state = createContextMenuState({ x: 0, y: 0 }, sampleItems);
      expect(state.selectedIndex).toBe(-1);

      state = contextMenuKeyHandler(state, "ArrowDown");
      expect(state.selectedIndex).toBe(0); // mockAction1

      state = contextMenuKeyHandler(state, "ArrowDown");
      expect(state.selectedIndex).toBe(2); // mockAction2 (skips separator at 1)

      state = contextMenuKeyHandler(state, "ArrowDown");
      expect(state.selectedIndex).toBe(3); // mockSubmenu

      // Boundary check
      state = contextMenuKeyHandler(state, "ArrowDown");
      expect(state.selectedIndex).toBe(3);
    });

    it("handles ArrowUp navigation and skips separators", () => {
      let state = createContextMenuState({ x: 0, y: 0 }, sampleItems);
      // set to last item
      state = { ...state, selectedIndex: 3 };

      state = contextMenuKeyHandler(state, "ArrowUp");
      expect(state.selectedIndex).toBe(2); // mockAction2

      state = contextMenuKeyHandler(state, "ArrowUp");
      expect(state.selectedIndex).toBe(0); // mockAction1 (skips separator at 1)

      // Boundary check
      state = contextMenuKeyHandler(state, "ArrowUp");
      expect(state.selectedIndex).toBe(0);
    });

    it("handles Enter to trigger onAction on selected item", () => {
      const actionFn = vi.fn();
      const items: readonly MenuItem[] = [
        { id: "test", label: "Test", onAction: actionFn },
      ];
      let state = createContextMenuState({ x: 0, y: 0 }, items);
      state = { ...state, selectedIndex: 0 };

      contextMenuKeyHandler(state, "Enter");
      expect(actionFn).toHaveBeenCalledTimes(1);
    });

    it("does not trigger onAction when item is disabled", () => {
      const actionFn = vi.fn();
      const items: readonly MenuItem[] = [
        { id: "test", label: "Test", disabled: true, onAction: actionFn },
      ];
      let state = createContextMenuState({ x: 0, y: 0 }, items);
      state = { ...state, selectedIndex: 0 };

      contextMenuKeyHandler(state, "Enter");
      expect(actionFn).not.toHaveBeenCalled();
    });

    it("dismisses on Escape", () => {
      const state = createContextMenuState({ x: 10, y: 10 }, sampleItems);
      const nextState = contextMenuKeyHandler(state, "Escape");
      expect(nextState.visible).toBe(false);
    });
  });

  describe("renderContextMenu", () => {
    const mockTheme = {
      colors: {
        glassStrong: "rgba(20, 20, 30, 0.9)",
        border: "rgba(255, 255, 255, 0.1)",
        primary: "#fff",
        muted: "#888",
        danger: "#f00",
        accentSoft: "rgba(215, 172, 87, 0.2)",
      },
      radius: {
        sm: 6,
        md: 10,
      },
      spacing: {
        xxs: 4,
        xs: 8,
        sm: 12,
      },
      typography: {
        body: 14,
        caption: 12,
      },
    };

    it("returns null if not visible", () => {
      const state = dismissContextMenu();
      expect(renderContextMenu(state, mockTheme)).toBeNull();
    });

    it("renders menu element with children when visible", () => {
      const state = createContextMenuState({ x: 50, y: 75 }, sampleItems);
      const element = renderContextMenu(state, mockTheme);
      expect(element).not.toBeNull();
      expect((element?.props as { role?: string } | undefined)?.role).toBe("menu");
    });
  });
});
