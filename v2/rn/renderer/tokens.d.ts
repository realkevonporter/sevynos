// Type declarations for the design tokens (polish surface (a)).
// The implementation is plain JS (./tokens.js); TSX consumers
// (apps, shell) import from here — the same JS + .d.ts split as
// context-menu.js / sevyn-renderer.js. Values are pinned to
// layout-manifest/tokens.json by test/tokens-test.js.

export interface ModePair {
  dark: string;
  light: string;
}

export interface Accent {
  dark: string;
  light: string;
  name: string;
  onFill: ModePair;
  textLight: string;
}

export interface AccentTokens {
  accents: { [key: string]: Accent };
  appliesTo: string[];
  default: string;
  neverAppliesTo: string[];
  note: string;
  perAppOverride: boolean;
}

export interface ModeColors {
  appBody: string;
  background: string;
  border: string;
  borderHairline: string;
  elevated: string;
  hover: string;
  sunken: string;
  surface: string;
  textMuted: string;
  textPrimary: string;
  textSecondary: string;
}

export interface ColorTokens {
  danger: {
    dark: string;
    light: string;
    textDark: string;
    textLight: string;
  };
  dark: ModeColors;
  fixed: {
    godBackground: string;
    godText: string;
    relayBackground: string;
    relayText: string;
    screenBackground: string;
    screenText: string;
  };
  light: ModeColors;
}

export interface ControlCenterTokens {
  anchorRight: number;
  anchorTop: number;
  iconHitArea: number;
  iconSize: number;
  padding: number;
  radius: number;
  rowGap: number;
  segmentedHeight: number;
  sliderKnob: number;
  sliderRowHeight: number;
  sliderTrackHeight: number;
  toggleHeight: number;
  toggleKnob: number;
  toggleRowHeight: number;
  toggleWidth: number;
  width: number;
}

export interface IconSize {
  gapX: number;
  gapY: number;
  icon: number;
  iconRadius: number;
  labelSize: number;
  tileHeight: number;
  tileWidth: number;
}

export interface DesktopIconsTokens {
  labelShadow: string;
  marginLeft: number;
  marginTop: number;
  selectionAlpha: { dark: number; light: number };
  sizes: {
    large: IconSize;
    medium: IconSize;
    small: IconSize;
  };
}

export interface DialogTokens {
  alertIconSize: number;
  alertPadding: number;
  alertRadius: number;
  alertWidth: number;
  buttonGap: number;
  buttonHeight: number;
  buttonMinWidth: number;
  buttonOrder: string;
  buttonRadius: number;
  maxButtons: number;
  sheetMarginX: number;
  sheetMaxWidth: number;
  sheetRadius: number;
}

export interface FilesTokens {
  gridCellHeight: number;
  gridCellWidth: number;
  gridIcon: number;
  gridIconRadius: number;
  gridLabelSize: number;
  gridPitch: number;
  listMetaSize: number;
  listModifiedWidth: number;
  listRowHeight: number;
  listSizeWidth: number;
  listTile: number;
  listTileRadius: number;
  selectionAlpha: { dark: number; light: number };
  toggleHeight: number;
  toggleWidth: number;
}

export interface MenuTokens {
  iconSlot: number;
  labelPadX: number;
  maxHeightFraction: number;
  maxWidth: number;
  minWidth: number;
  padding: number;
  radius: number;
  rowHeight: number;
  rowRadius: number;
  separatorHeight: number;
  width: number;
}

export interface MotionTokens {
  easing: string;
  hover: number;
  menuOpen: number;
  modeSwitch: number;
  sheetSlide: number;
  wallpaperChange: number;
  windowOpen: number;
}

export interface RadiiTokens {
  button: number;
  card: number;
  control: number;
  dialog: number;
  dock: number;
  input: number;
  menu: number;
  menuRow: number;
  pill: number;
  topbar: number;
  window: number;
}

export interface ShadowSet {
  dialog: string;
  menu: string;
  window: string;
}

export interface ShadowTokens {
  dark: ShadowSet;
  light: ShadowSet;
}

export interface SpacingTokens {
  buttonGap: number;
  controlGap: number;
  groupGap: number;
  scale: number[];
  sectionGap: number;
  windowMargin: number;
}

export interface TopbarTokens {
  glass: {
    edge: ModePair;
    fill: ModePair;
    highlight: ModePair;
    shade: ModePair;
  };
  height: number;
  itemGap: number;
  labelSize: number;
  padX: number;
  pillHeight: number;
  pillRadius: number;
}

export interface TypeStyle {
  lineHeight?: number;
  size: number;
  weight: string;
}

export interface TypeTokens {
  body: TypeStyle;
  caption: TypeStyle;
  dialogMessage: TypeStyle;
  dialogTitle: TypeStyle;
  menuLabel: TypeStyle;
  menuShortcut: TypeStyle;
  minimum: number;
  secondary: TypeStyle;
  windowTitle: TypeStyle;
}

export interface WallpaperTokens {
  hoverPreview: boolean;
  modeFallback: { [key: string]: string };
  modeSwitch: string;
  modeTag: { [key: string]: string };
  pickerWidth: number;
  styles: string[];
  swatchRadius: number;
  swatchSize: number;
  thumbnailGap: number;
  thumbnailHeight: number;
  thumbnailRadius: number;
  thumbnailWidth: number;
}

export interface WindowTokens {
  controlRadius: number;
  controlSize: number;
  controlZoneWidth: number;
  controlsSide: string;
  cornerRadius: number;
  cornerRadiusMechanism: string;
  defaultHeight: number;
  defaultWidth: number;
  minHeight: number;
  minWidth: number;
  resizeEdge: number;
  titleBarHeight: number;
  titleBarPadLeft: number;
  titleBarPadRight: number;
  titleIconGap: number;
  titleIconSize: number;
}

export interface ZOrderTokens {
  aiButton: number;
  aiSidebar: number;
  appWindows: number;
  contextMenus: number;
  desktopIcons: number;
  dialogs: number;
  dock: number;
  lockScreen: number;
  panels: number;
  topbar: number;
  wallpaper: number;
  wallpaperPicker: number;
}

export interface Tokens {
  accent: AccentTokens;
  color: ColorTokens;
  controlCenter: ControlCenterTokens;
  desktopIcons: DesktopIconsTokens;
  dialog: DialogTokens;
  files: FilesTokens;
  menu: MenuTokens;
  motion: MotionTokens;
  radii: RadiiTokens;
  shadow: ShadowTokens;
  spacing: SpacingTokens;
  topbar: TopbarTokens;
  type: TypeTokens;
  wallpaper: WallpaperTokens;
  window: WindowTokens;
  zOrder: ZOrderTokens;
}

// The single shared token source (./tokens.js). Deep-frozen there;
// consumers read, never mutate.
export const tokens: Tokens;
