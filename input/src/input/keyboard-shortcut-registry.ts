export interface KeyboardShortcut {
  readonly id: string;
  readonly keys: ShortcutKeys;
  readonly label: string;
  readonly category: "system" | "window" | "editing" | "navigation" | "application";
  readonly action: () => void;
  readonly enabled?: boolean;
}

export interface ShortcutKeys {
  readonly key: string;
  readonly ctrl?: boolean;
  readonly alt?: boolean;
  readonly shift?: boolean;
  readonly meta?: boolean;
}

/**
 * Centralized registry for keyboard shortcuts in SevynOS.
 */
export class KeyboardShortcutRegistry {
  private readonly _shortcuts = new Map<string, KeyboardShortcut>();

  constructor() {
    this._registerDefaults();
  }

  /**
   * Register a new keyboard shortcut.
   * @param shortcut The shortcut to register.
   * @returns A function to unregister the shortcut.
   */
  register(shortcut: KeyboardShortcut): () => void {
    this._shortcuts.set(shortcut.id, shortcut);
    return () => {
      this.unregister(shortcut.id);
    };
  }

  /**
   * Remove a shortcut by its ID.
   * @param id The ID of the shortcut to remove.
   */
  unregister(id: string): void {
    this._shortcuts.delete(id);
  }

  /**
   * Try to handle a keyboard event.
   * @param event The keyboard event properties to match against.
   * @returns True if a shortcut matched and its action was executed.
   */
  handleKeyDown(event: {
    key: string;
    ctrlKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
    metaKey: boolean;
  }): boolean {
    const key = event.key.toLowerCase();

    for (const shortcut of this._shortcuts.values()) {
      if (shortcut.enabled === false) {
        continue;
      }

      const matchKey = shortcut.keys.key.toLowerCase() === key;
      const matchCtrl = !!shortcut.keys.ctrl === event.ctrlKey;
      const matchAlt = !!shortcut.keys.alt === event.altKey;
      const matchShift = !!shortcut.keys.shift === event.shiftKey;

      // Some platforms may emit "Meta" for the key itself while also having metaKey true or false.
      // We will match metaKey but if the key itself is Meta, we also consider it.
      let matchMeta = !!shortcut.keys.meta === event.metaKey;
      if (shortcut.keys.key.toLowerCase() === "meta" && key === "meta") {
        matchMeta = true;
      }

      if (matchKey && matchCtrl && matchAlt && matchShift && matchMeta) {
        shortcut.action();
        return true;
      }
    }

    return false;
  }

  /**
   * List all registered shortcuts.
   * @returns A read-only array of all registered shortcuts.
   */
  listShortcuts(): readonly KeyboardShortcut[] {
    return Object.freeze(Array.from(this._shortcuts.values()));
  }

  /**
   * Find a shortcut by its ID.
   * @param id The ID of the shortcut.
   * @returns The keyboard shortcut, if found.
   */
  getShortcut(id: string): KeyboardShortcut | undefined {
    return this._shortcuts.get(id);
  }

  /**
   * Format a shortcut for display.
   * @param keys The shortcut keys to format.
   * @returns The formatted string representation (e.g., "Ctrl+C").
   */
  static formatShortcut(keys: ShortcutKeys): string {
    const parts: string[] = [];
    if (keys.ctrl) parts.push("Ctrl");
    if (keys.alt) parts.push("Alt");
    if (keys.shift) parts.push("Shift");
    if (keys.meta) parts.push("Super");

    let k = keys.key;
    if (k.length === 1) {
      k = k.toUpperCase();
    }

    // Formatting tweaks for well-known keys
    if (k.toLowerCase() === "meta") {
      if (parts.includes("Super")) {
        return parts.join("+");
      }
      k = "Super";
    }

    parts.push(k);
    return parts.join("+");
  }

  private _registerDefaults(): void {
    const noop = (): void => {
      void 0;
    };

    this.register({
      id: "system.copy",
      label: "Copy",
      category: "system",
      action: noop,
      keys: { key: "c", ctrl: true },
    });
    this.register({
      id: "system.cut",
      label: "Cut",
      category: "system",
      action: noop,
      keys: { key: "x", ctrl: true },
    });
    this.register({
      id: "system.paste",
      label: "Paste",
      category: "system",
      action: noop,
      keys: { key: "v", ctrl: true },
    });
    this.register({
      id: "system.select-all",
      label: "Select All",
      category: "system",
      action: noop,
      keys: { key: "a", ctrl: true },
    });
    this.register({
      id: "system.undo",
      label: "Undo",
      category: "system",
      action: noop,
      keys: { key: "z", ctrl: true },
    });
    this.register({
      id: "system.redo",
      label: "Redo",
      category: "system",
      action: noop,
      keys: { key: "z", ctrl: true, shift: true },
    });
    this.register({
      id: "system.save",
      label: "Save",
      category: "system",
      action: noop,
      keys: { key: "s", ctrl: true },
    });

    this.register({
      id: "window.close",
      label: "Close Window",
      category: "window",
      action: noop,
      keys: { key: "F4", alt: true },
    });
    this.register({
      id: "window.switcher",
      label: "Window Switcher",
      category: "window",
      action: noop,
      keys: { key: "Tab", alt: true },
    });
    this.register({
      id: "window.snap-left",
      label: "Snap Window Left",
      category: "window",
      action: noop,
      keys: { key: "ArrowLeft", meta: true },
    });
    this.register({
      id: "window.snap-right",
      label: "Snap Window Right",
      category: "window",
      action: noop,
      keys: { key: "ArrowRight", meta: true },
    });
    this.register({
      id: "window.maximize",
      label: "Maximize Window",
      category: "window",
      action: noop,
      keys: { key: "ArrowUp", meta: true },
    });
    this.register({
      id: "window.minimize",
      label: "Minimize Window",
      category: "window",
      action: noop,
      keys: { key: "ArrowDown", meta: true },
    });

    this.register({
      id: "system.show-desktop",
      label: "Show Desktop",
      category: "system",
      action: noop,
      keys: { key: "d", meta: true },
    });
    this.register({
      id: "system.lock",
      label: "Lock System",
      category: "system",
      action: noop,
      keys: { key: "l", meta: true },
    });
    this.register({
      id: "system.launcher",
      label: "Open Launcher",
      category: "system",
      action: noop,
      keys: { key: "Meta" },
    });
    this.register({
      id: "system.screenshot",
      label: "Take Screenshot",
      category: "system",
      action: noop,
      keys: { key: "PrintScreen" },
    });
  }
}
