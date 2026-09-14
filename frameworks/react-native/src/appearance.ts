/**
 * Appearance — provides access to the user's appearance preferences.
 *
 * On SevynOS, this bridges to the system theme setting.
 * Applications can subscribe to theme changes.
 */

export type ColorSchemeName = "dark" | "light" | null;

let currentColorScheme: ColorSchemeName = "dark";
const appearanceListeners = new Set<
  (preferences: { colorScheme: ColorSchemeName }) => void
>();

export const Appearance = Object.freeze({
  /**
   * Returns the current color scheme preference.
   */
  getColorScheme(): ColorSchemeName {
    return currentColorScheme;
  },

  /**
   * Programmatically set the color scheme.
   * This triggers all change listeners.
   */
  setColorScheme(scheme: ColorSchemeName): void {
    if (currentColorScheme === scheme) return;
    currentColorScheme = scheme;
    const payload = Object.freeze({ colorScheme: scheme });
    for (const listener of appearanceListeners) {
      listener(payload);
    }
  },

  /**
   * Subscribe to appearance changes.
   */
  addChangeListener(listener: (preferences: { colorScheme: ColorSchemeName }) => void): {
    remove: () => void;
  } {
    appearanceListeners.add(listener);
    return {
      remove(): void {
        appearanceListeners.delete(listener);
      },
    };
  },
});
