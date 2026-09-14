/**
 * PixelRatio — provides access to the device pixel density and font scaling.
 *
 * On SevynOS desktop, the pixel ratio is typically 1.0 unless the user has
 * configured a HiDPI display scale factor.
 */

let devicePixelRatio = 1;
let fontScaleFactor = 1;

export const PixelRatio = Object.freeze({
  /**
   * Returns the device pixel density.
   * On SevynOS desktop this defaults to 1 (standard density).
   */
  get(): number {
    return devicePixelRatio;
  },

  /**
   * Returns the scaling factor for font sizes.
   */
  getFontScale(): number {
    return fontScaleFactor;
  },

  /**
   * Converts a layout size (dp) to pixel size (px).
   */
  getPixelSizeForLayoutSize(layoutSize: number): number {
    return Math.round(layoutSize * devicePixelRatio);
  },

  /**
   * Rounds a layout size to the nearest value that maps cleanly to pixels.
   */
  roundToNearestPixel(layoutSize: number): number {
    const ratio = devicePixelRatio;
    return Math.round(layoutSize * ratio) / ratio;
  },

  /**
   * Host API — set the pixel ratio when the display is configured.
   * Applications should not call this directly.
   */
  _setPixelRatio(ratio: number): void {
    devicePixelRatio = Math.max(1, ratio);
  },

  /**
   * Host API — set the font scale when accessibility settings change.
   * Applications should not call this directly.
   */
  _setFontScale(scale: number): void {
    fontScaleFactor = Math.max(0.5, scale);
  },
});
