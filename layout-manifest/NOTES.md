# Layout Manifest — notes

## Sources

### Repo files read (SevynOS main `b39efe47`, fetched via the GitHub API 2026-11-27)

| File                                                            | What was measured                                                                                                                                                                                             |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `v2/shell/src/Shell.tsx`                                        | Top bar 48px, `#15151c`, pad 16; power menu 200w, top 48, right 16, radius 12, rows 44, `#1f2937`; AI button/sidebar ownership                                                                                |
| `v2/shell/src/StatusTray.tsx`                                   | Tray gaps 16, labels 13 `#d1d5db`, battery 28×14, pills 36 high radius 6, Power 64×36 radius 6 `#26262e`; GOD `#b45309`, RELAY `#1e40af`, SCREEN `#991b1b`                                                    |
| `v2/shell/src/Dock.tsx`                                         | Tiles 40–64, gap 8, pad 8, bottom margin 8, side margin 24, dot 6, radius 24; glass `#ffffff1f` / edge `#ffffff14` / highlight `#ffffff40` / shade `#00000033`; no magnification                              |
| `v2/shell/src/DesktopIcons.tsx`                                 | Tiles 104×92, gaps 18/16, top 22, icon 48×48 radius 8, label 12; desktop right-click menu (unit 11)                                                                                                           |
| `v2/shell/src/AiSidebar.tsx`                                    | Sidebar 360 wide, top 48, `#111827`, header 48 `#1f2937`; input 36 `#1f2937`; Send `#5B5BD6` radius 6                                                                                                         |
| `v2/shell/src/AiButton.tsx`                                     | 56px violet disc, right/bottom 16                                                                                                                                                                             |
| `v2/shell/src/Wallpaper.tsx`                                    | Wallpaper paints behind the top bar; shell re-reads the setting on render — "picking a new style applies when Settings closes"                                                                                |
| `v2/shell/src/wallpaper-variants.ts`                            | 7 styles (default/solid/cosmic/minimal/macos/macos-light/frost); 8 solid colors; bases: cosmic `#0b0620`, macos `#0c0a26`, macos-light `#eef1fb`, frost `#0c0a26` + photo, default `#06080F`                  |
| `v2/shell/src/apps.ts`                                          | App list / single-instance flags                                                                                                                                                                              |
| `v2/apps/src/App.tsx`                                           | Window header template: 44px, pad 16/12, icon 20×20 gap 8, title 16 bold white, close 28×28 radius 6; body `#f9fafb`                                                                                          |
| `v2/apps/src/window-buttons.tsx`                                | Min/max 28×28 radius 6; "three 28px buttons at the right end of the 44px title bar, inside the 12px right padding"                                                                                            |
| `v2/apps/src/Settings.tsx`                                      | Appearance: wallpaper buttons 120×36 radius 8 (active `#111827`/inactive `#e5e7eb`), swatches 44×44 radius 8 with ✓; god/relay confirms inline, buttons 120×36, Confirm first; "Applies when Settings closes" |
| `v2/rn/renderer/context-menu.js`                                | Menu 220w, rows 32, padding 4, radius 8, row radius 6, separator 1px `#4b5563` + 4px margins, highlight `#3b82f6`, label 14, icon slot 20, clamp to surface, keyboard nav                                     |
| `v2/rn/host/wayland.h:508-520`                                  | `kTitleBarHeight = 44`, `kCloseZoneWidth = 100`, `kResizeEdge = 8`, `kMinWidth = 480`, `kMinHeight = 320`                                                                                                     |
| `~/workspace/sevynos-standard-os-gap/GAP_AUDIT.md` (2026-11-26) | 60 checked: 15 present, 1 partial, 44 missing; window/dialog/menu evidence                                                                                                                                    |
| `~/workspace/sevynos-standard-os-gap/PROGRESS.md`               | Units 1–12 merged, unit 13 (#198) open; context-menu primitive #184, Files #186, desktop #187, dock #189                                                                                                      |
| `~/workspace/tokrah/tokrah/utils/accent.ts`                     | Six accents with light/dark fills + textLight variants + measured WCAG ratios + onFill rule (white on violet/neutral light, black elsewhere; ink `#14141A` on all dark fills)                                 |
| `~/workspace/sevynos-genesis-screendump-test/desktop.png`       | Real Genesis desktop, main `041749b7` — before-reference crops for the window header and top bar                                                                                                              |

### Apple sources checked (2026-11-27, via web search)

| Claim                                                                                                                                                                      | Source                                                                                                                                                                          | Confidence                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Menu bar 24pt; Tahoe bar completely transparent                                                                                                                            | HIG-derived guides (saglitzdesign-mcp macOS Tahoe guide; laramarcodes design-and-accessibility, verified 2026-06-21); `NSMenu menuBarHeight` returns 24 on Sonoma (MacScripter) | High — three independent sources agree                                                                                                                                                                                       |
| Traffic lights 12×12pt, 7pt from leading edge, 6pt spacing, top-left, never hide/reposition                                                                                | swiftui-platform-rules skill; macos-design-guidelines skill                                                                                                                     | High — consistent across sources                                                                                                                                                                                             |
| Title bar 22pt standard / 28pt large; unified toolbar 52pt / 38pt compact                                                                                                  | swiftui-platform-rules skill                                                                                                                                                    | Medium-high                                                                                                                                                                                                                  |
| Window corner radius 10pt; min window 400×300pt                                                                                                                            | swiftui-platform-rules skill                                                                                                                                                    | Medium-high                                                                                                                                                                                                                  |
| Menus required: App, File, Edit, View, Window, Help, in order; every action in the menu bar                                                                                | Apple HIG (developer.apple.com/design/human-interface-guidelines/menus); macos-design-guidelines skill                                                                          | High — HIG itself                                                                                                                                                                                                            |
| Context menus: hide unavailable items (except Cut/Copy/Paste may dim); ≤3 groups; avoid exceeding window height; most-used near pointer                                    | Apple HIG context-menus page (developer.apple.com)                                                                                                                              | High — HIG itself                                                                                                                                                                                                            |
| Alerts: title + optional text + ≤3 buttons; default trailing, Cancel leading; destructive style; verb titles, no "Yes/No"                                                  | Apple HIG alerts page (developer.apple.com)                                                                                                                                     | High — HIG itself                                                                                                                                                                                                            |
| Sheets: Cancel/Done placement; attached to parent window                                                                                                                   | HIG research notes (sheets page updated 2026-03-24); HIG sheets guidance                                                                                                        | Medium-high                                                                                                                                                                                                                  |
| Esc = cancel/dismiss, Return = default                                                                                                                                     | HIG-derived references (terriann apple-hig-macos.md)                                                                                                                            | Medium-high                                                                                                                                                                                                                  |
| Layout: 20pt window margins, 20pt section spacing, 8pt control spacing, 12pt button spacing, list rows 22–28pt, sidebar 200–240pt, body 13pt min 10pt, min control 28×28pt | HIG-derived references (terriann; architrave apple.md)                                                                                                                          | Medium — consistent across sources, not the HIG text itself                                                                                                                                                                  |
| Liquid Glass: floating functional layer (toolbars, sidebars, menus); standard materials structure content; content scrolls under bars                                      | HIG-derived Tahoe guides (saglitzdesign-mcp; laramarcodes)                                                                                                                      | Medium-high                                                                                                                                                                                                                  |
| Menu corner radius 12pt; menu item height 44pt                                                                                                                             | it-influentials "Apple HIG design system" page                                                                                                                                  | **Low — iOS-leaning; NOT used as a verified Apple value.** The manifest cites 12pt for dialog radius as a secondary source only, and does not use the 44pt menu-row figure (macOS rows are 22–28pt per the verified sources) |

**What Apple does not publish:** menu-item row height, alert/sheet widths, animation durations, menu corner radius. Where the HIG is silent the manifest says so and marks the SevynOS value a proposal.

## Decisions deferred (not silently picked)

See MANIFEST.md §11 — all nine decided (decision 9, top-bar glass in light mode, decided 2026-11-28 by Kevon's mockup confirmation). In addition:

- **Auto mode (follow time/sunset):** deferred; Light/Dark manual switch only in v1.
- **Per-app accent/mode override:** deferred (decision 7); system-wide only in v1.
- **App-menu content:** the top-bar zone is reserved; which menus each app gets (File/Edit/View/…) is a per-app decision for the build, not this manifest.
- **True drop shadows:** the renderer/compositor cannot draw shadows today; the manifest specifies them as target values and the dock's edge-ring technique as the interim.
- **Dedicated light wallpaper:** `macos-light` is the light pairing today; a purpose-built light wallpaper is a follow-up asset.
- **Per-folder Files view:** deferred; the `filesView` setting is global in v1 (Finder's per-folder model can follow).
- **Sleep in the system menu:** deferred; no suspend path exists in the tree.
- **Brightness / Bluetooth in Control Center:** future-gated — brightness on a backlight writer, Bluetooth on a Bluetooth service existing. Wi-Fi toggle is future-gated on a network-control verb.

## What this manifest deliberately does NOT cover

- The dock (already specified in `Dock.tsx` — radius 24, glass, tiles 40–64; out of scope except z-order, the AI button, and the glass the top bar now mirrors).
- Desktop icons and Files views — **now specified** (MANIFEST.md §3a/§3b, extension 2026-11-28); previously out of scope.
- Other app internals (Browser/Settings content layouts keep their own patterns; only the shared chrome — header, menus, dialogs — is specified here).
- The lock screen (gap unit 32 — stops at PR for Kevon's word; z-order 900 is reserved for it).
- Notifications, quick settings, volume OSD (gap units 28–30 — they will slot into the z-order and token system defined here when built).

## Mockups — build & verification record (2026-11-28 ~04:00 EST)

**Tooling.** `mockups/build_mockups.py` — one Python builder, all pages HTML/CSS,
screenshotted with the Playwright headless shell
`~/.cache/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell`
(Chrome for Testing 159.0.8154.6). `/opt/meta-chromium/chrome` refuses to start
("Hatch WebGL domain policy is required for browser startup") and was not used.
No AI image generation anywhere in the mockups — every pixel is HTML/CSS except the
real Genesis desktop screenshot crops (before) and the real frost photo asset.
HTML sources live in `mockups/src/` next to the PNGs; re-render with
`python3 mockups/build_mockups.py` (rebuilds all 24 PNGs + the contact sheet).

**Inventory (24 PNGs + contact sheet, all in `mockups/`).**

| File                                                                        | What it shows                                                                                                                                                                       |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mockup-windows-dark.png` / `mockup-windows-light.png`                      | Terminal window before (real Genesis crop, 44px bar, controls right, radius 0) vs after (40px bar, controls left, radius 10), both modes                                            |
| `mockup-topbar-dark.png` / `mockup-topbar-light.png`                        | Top bar before (real tray crop, 48px, no clock/app/menus) vs after (32px glass over the wallpaper, mark + app + menus, tray + clock + control icon, no Power), both modes           |
| `mockup-menu-dark.png` / `mockup-menu-light.png`                            | Context menu before (current spec re-rendered, 32px rows, blue highlight, no shortcuts) vs after (28px rows, accent highlight, right-aligned shortcuts, checkmark slot), both modes |
| `mockup-dialog-dark.png` / `mockup-dialog-light.png`                        | Dialogs before (current inline confirm, re-rendered) vs after (360px alert + sheet attached to parent window, Apple button order), both modes                                       |
| `mockup-decision-controls.png`                                              | Decision 1: controls LEFT (recommended) vs RIGHT (today), dark + light                                                                                                              |
| `mockup-decision-topbar.png`                                                | Decision 2: top bar 32px (recommended) vs 48px (today), dark + light — 32px panels show the glass bar + control icon, 48px panels show the opaque bar + Power as it ships           |
| `mockup-accent-strip.png`                                                   | All six accents × both modes — window header + menu row + dialog button row per cell                                                                                                |
| `mockup-windows-coral-dark.png`                                             | Second accent in context: Files window in Coral, dark mode                                                                                                                          |
| `mockup-wallpaper-dark.png` / `mockup-wallpaper-light.png`                  | Appearance panel (mode + accent + 7-thumb grid) over the live desktop — cosmic behind in dark, real frost photo behind in light                                                     |
| `mockup-desktop-icons-dark.png` / `mockup-desktop-icons-light.png`          | Desktop icon grid in S/M/L, both modes — one icon selected in each size                                                                                                             |
| `mockup-files-list-dark.png` / `mockup-files-list-light.png`                | Files list view: before (today's name-only rows, re-rendered) vs after (Size + Modified columns, toggle, accent selection), both modes                                              |
| `mockup-files-grid-dark.png` / `mockup-files-grid-light.png`                | Files grid view: before (no grid view exists) vs after (96×108 cells, 64px tiles), both modes                                                                                       |
| `mockup-system-menu-dark.png` / `mockup-system-menu-light.png`              | System menu open under the SevynOS logo (System Settings… / Restart / Shut Down), both modes                                                                                        |
| `mockup-control-center-dark.png` / `mockup-control-center-light.png`        | Control Center panel open under the control icon (mode + volume live; brightness + Bluetooth dimmed with SOON), both modes                                                          |
| `contact-sheet.png`                                                         | All nine surfaces × both modes on one page (1224×3742)                                                                                                                              |
| `before-window-header.png`, `before-topbar-right.png`, `before-topband.png` | Raw crops from the real Genesis desktop screenshot (`~/workspace/sevynos-genesis-screendump-test/desktop.png`) used as the before references                                        |

**Two rendering bugs found by viewing the PNGs and fixed in the builder.**

1. **Single-quote collision (broke every mockup's first render).** `FONT` was
   `"'DejaVu Sans', sans-serif"` and style attributes use single quotes, so
   `style='font:700 16px 'DejaVu Sans', sans-serif;color:#FAFAFA;...'` terminated
   the attribute at the first inner quote — every declaration after the font
   shorthand (colors, `margin-left:auto`) was silently dropped. Symptom: dark
   text on dark surfaces, shortcuts glued to labels instead of right-aligned.
   Fix: `FONT = "DejaVu Sans, sans-serif"` (unquoted multi-word family names are
   valid CSS). Verified by re-render + 2× zoom crops of the window header and menu.
2. **Stacking: frost photo buried the top bar (wallpaper-light only).** The frost
   `<img>` is `position:absolute`; the top-bar div was non-positioned, so the photo
   painted over it — the mockup showed the photo asset's own baked-in top bar
   ("9:04 AM") instead of the manifest's 32px bar. Fix: wrap the top bar in
   `position:relative;z-index:2`. The baked-in desktop icons (Files/Terminal) in
   the frost asset remain visible behind the panel, which is the intended effect.

**Also fixed during verification.** Highlighted menu-row shortcuts now use the
onFill color instead of muted gray (muted on violet was low-contrast); wallpaper
thumbnails shrunk 160×100 → 160×88 so all 7 fit the panel (`tokens.json`
`wallpaper.thumbnailHeight` updated to match).

**Verification.** Every PNG was viewed after the final render (windows/menu at 2×
zoom crops for the two fixed bugs; topbar, accent strip, both wallpaper mockups,
both decision mockups, and the contact sheet at full size). Light variants were
verified via the contact sheet plus the full-size light wallpaper/topbar renders;
they share the same builders as the dark variants verified at full size.

## Extension round — tweaks 1–5 (2026-11-28 ~03:00–08:00 EST)

Kevon ordered five tweaks after the 8 decisions; the extension folds them into
the manifest (text + tokens + mockups), repo landing still on hold. Sources
grounded for this round (all SevynOS main `fe0277ba`):

| File                                                                          | What was measured                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `v2/shell/src/DesktopIcons.tsx`                                               | Grid exists: `desktopColumns(surfaceWidth)` = floor((width−48)/(104+18)), tiles 104×92, gaps 18/16, left 24, top 22, icon 48×48 r8, monogram 24 bold, label 12; no size choice, no selection state                                                                                                                                      |
| `v2/apps/files/Files.tsx` (fetched via GitHub API, sha `8f3e46d1`, 691 lines) | List-only: 36px rows, 24×24 tile r6 + 14px name, selected `#dbeafe`; header comment lists "grid/list toggle" as out of scope; `formatBytes` exists in `files/src/volumes.ts`; no view switcher anywhere                                                                                                                                 |
| `v2/shell/src/Dock.tsx`                                                       | Dock glass, exact: fill `#ffffff1f`, edge `#ffffff14`, highlight `#ffffff40`, shade `#00000033`, radius 24 — the top bar mirrors these four values                                                                                                                                                                                      |
| `v2/shell/src/Shell.tsx` + `StatusTray.tsx`                                   | Logo is static `<Text>SevynOS</Text>` (NOT a pressable); Power is the tray's only pressable (64×36 `#26262e`); power verbs are `sevyn poweroff` / `sevyn reboot` via trusted exec                                                                                                                                                       |
| `v2/services/statusd.c` (30,358 bytes, sha `5ef36cfc`)                        | Six snapshot keys: battery, wifi (read-only, first wireless interface operstate), volume (default 50, no sysfs source, SET on `/run/sevyn-status.sock`), ai.god_mode, ai.relay, ai.screen                                                                                                                                               |
| `v2/audio/audiod.c` (34,107 bytes)                                            | `VOLUME <0..100>` verb on `/run/sevyn-audio.sock` — the volume slider is live-capable                                                                                                                                                                                                                                                   |
| Tree-wide grep                                                                | **Bluetooth: zero hits** (no BlueZ, no daemon) — toggle is future, gated on a Bluetooth service. **Brightness/backlight: zero hits** — future, gated on a backlight writer. **Suspend/sleep: zero hits** (only `nanosleep` in statusd.c) — no Sleep in the system menu. **Log Out: no concept** — one account, no session to log out of |

**Mockup fixes found by viewing the PNGs in this round.**

1. **The frost asset is a desktop composite, not a photo.** `frosty-forest-mockup.png`
   (the wallpaper-round asset) has a baked-in top bar ("9:04 AM", Wi-Fi, battery),
   Files/Terminal desktop icons, dock, and AI button. The old opaque bar hid its
   top bar, so this never showed — the new glass bar let it bleed through
   (garbled tray text in wallpaper-light; ghost "Terminal" label in
   system-menu-light; ghost icons/dock/AI button in control-center-light). Fix:
   cropped a clean band (y 240–680, below the Terminal label, above the AI
   button) to `mockups/src/frost-photo.png` (1280×440) and pointed `FROST` at it.
   The original composite is untouched in `~/workspace/sevynos-wallpaper/`.
2. **Desktop icon labels unreadable on light wallpaper.** White 11–13px labels over
   the bright frost photo washed out ("archive.zip", "todo.md"). Fix: label
   `text-shadow: 0 1px 3px rgba(0,0,0,0.45)` in the builder, and the shadow is now
   a spec'd token (`desktopIcons.labelShadow`).
3. **Files sidebar capacity wrapped.** "210 GB · 126 GB free" broke to two lines
   in the 168px sidebar. Fix: capacity strings shortened to "126 GB free" /
   "18 GB free".
4. **Decision-topbar page clipped.** The four backdrop strips (96px each) outgrew
   the 560px page — the 4th panel's backdrop was cut. Fix: page 560 → 760, and
   the `main()` jobs-list height (which is what the headless-shell window size
   actually follows) 560 → 760. Builder lesson: the page height lives in TWO
   places (`page()` call inside the builder function AND the jobs tuple in
   `main()`); both must match or the screenshot clips.

**Verification (this round).** All 10 new + 4 changed mockups viewed at full size
after the final render, plus the contact sheet: topbar dark/light (glass reads
over both backdrops), desktop-icons dark/light (three sizes, selection tint,
labels legible after the shadow fix), files list/grid dark/light (toggle active
segment correct in each view, Size/Modified columns aligned, sidebar no longer
wraps), system-menu dark/light (menu drops under the logo, no ghosts after the
frost crop), control-center dark/light (panel anchored under the icon, brightness

- Bluetooth dimmed with SOON), decision-topbar (all four panels + footer visible
  after the height fix), wallpaper-light (tray text clean after the frost crop).

## Decision log

- **Decision 1 — window-controls side: DECIDED RIGHT (Kevon, 2026-11-28 ~02:30 EST).** Left was the draft's recommendation; Kevon kept controls on the right. Applied 2026-11-28: MANIFEST.md §11 (7 open, 1 decided) + windows section + gap list; tokens.json `window.controlsSide = "right"`; builder `window_header` default flipped to right, windows/coral-dark/decision-controls mockups re-rendered (all 14 PNGs + contact sheet rebuilt, `python3 mockups/build_mockups.py` — all OK). Verified by viewing mockup-windows-dark.png: after-state shows — ▢ ✕ at the right end, caption "controls stay RIGHT (decided)".
- **Decision 2 — top-bar height: DECIDED 32px (Kevon, 2026-11-28 ~02:33 EST).** Applied 2026-11-28: MANIFEST.md §11 (6 open, 2 decided) + top-bar height/pills rows marked decided (tokens.json `topbar.height` was already 32 — the proposal value, no change needed); builder decision-topbar labels flipped RECOMMENDED → DECIDED; all mockups re-rendered. Verified by viewing mockup-decision-topbar.png: 32px — DECIDED in both modes.
- **Decision 3 — app menus: DECIDED build with the polish (Kevon, 2026-11-28 ~02:37 EST).** Applied 2026-11-28: MANIFEST.md §11 (5 open, 3 decided) + top-bar left-zone/gap/gap-list rows; builder `topbar()` RESERVED tag removed, menu labels muted → primary (they are real now, not placeholders); all mockups re-rendered. Verified by viewing mockup-topbar-dark.png: File/Edit/View in primary text, no RESERVED tag. Note: no tokens.json change — menus use existing text/size tokens. The menu feature (registry + per-app menus + shortcuts) rides with the top-bar surface in implementation. (Builder note: the RESERVED-tag removal initially dropped the `f"` prefix and broke the build with a SyntaxError; fixed by restoring `f"</div>")` — verify syntax with `python3 -c compile(...)` after any string surgery in the builder.)
- **Decision 4 — dialog button order: DECIDED Apple (Cancel leading, default trailing) (Kevon, 2026-11-28 ~02:40 EST).** Applied 2026-11-28: MANIFEST.md §11 (4 open, 4 decided) + dialog buttons/button-order/gap-list rows; tokens.json `dialog.buttonOrder = "cancel-leading"` (new key). No mockup re-render needed — the dialog mockups already showed the after-state in Apple order (verified by viewing mockup-dialog-dark.png: Cancel leading / Delete trailing; sheet Cancel leading / Done trailing). Remaining "open decision" references in MANIFEST.md are only decisions 5 and 6, still open.
- **Decision 5 — wallpaper mode-switch: DECIDED auto-switch with fallback (Kevon, 2026-11-28 ~02:42 EST).** Applied 2026-11-28: MANIFEST.md §11 (3 open, 5 decided) + mode-switch rule row; tokens.json `wallpaper.modeSwitch = "auto"` (new key; modeTag/modeFallback already encoded the rule). No mockup re-render — the rule is behavioral, not visual; the wallpaper mockups already show the picker over the live desktop (verified by viewing mockup-wallpaper-light.png: frost photo live behind the Appearance panel, Frost selected).
- **Decision 6 — wallpaper hover-preview: DECIDED hover-preview (Kevon, 2026-11-28 ~02:43 EST).** Applied 2026-11-28: MANIFEST.md §11 (2 open, 6 decided) + hover-preview row; tokens.json `wallpaper.hoverPreview = true` (new key). No mockup re-render — the wallpaper mockups already depict hover-preview (footer: "Hover a thumbnail to preview it live — click to keep it").
- **Decision 7 — per-app accent/mode override: DECIDED deferred (Kevon, 2026-11-28 ~02:44 EST).** Applied 2026-11-28: MANIFEST.md §11 (1 open, 7 decided) + accent behavior line; tokens.json `accent.perAppOverride = false` (new key; written via json.dump indent=2 sort_keys — this also normalized two pre-existing indent quirks in the wallpaper object, `modeFallback`/`modeTag` 2→4 spaces, and added the missing trailing newline; JSON semantics unchanged, verified by diff). No mockup re-render — there is no per-app UI in the mockups.
- **Decision 8 — corner-radius mechanism: DECIDED compositor rounds the windows (Kevon, 2026-11-28 ~02:46 EST).** Applied 2026-11-28: MANIFEST.md §11 (all 8 decided) + windows corner-radius row; tokens.json `window.cornerRadiusMechanism = "compositor"` (new key). No mockup re-render — the mockups already draw 10px corners; the mechanism is a build choice, not a visual one. **All 8 manifest decisions are now decided.** Next step: land the manifest in the repo on Kevon's word, then implement per surface, one PR each.
- **Extension — tweaks 1–5 (Kevon, 2026-11-28 ~02:50–02:53 EST, "No" — not the full set, more may arrive).** Applied 2026-11-28: (1) desktop icons S/M/L + selection + size control (MANIFEST.md §3a; tokens.json `desktopIcons`; mockups desktop-icons dark/light); (2) Files grid/list toggle + Size/Modified columns + accent selection + global `filesView` (MANIFEST.md §3b; tokens.json `files`; mockups files-list/files-grid dark/light); (3) top bar gets the dock's glass (MANIFEST.md §2 color row + §4 background row; tokens.json `topbar.glass`; `color.*.topbar` opaque tokens deleted as dead; all top-bar mockups re-rendered over backdrops); (4) Power out of the bar into the SevynOS-logo system menu (MANIFEST.md §5a + §4 right-zone + decision-2 m9 note rewritten; tokens.json `topbar.powerButtonWidth/Height` deleted as dead; mockups system-menu dark/light); (5) Control Center icon + panel (MANIFEST.md §4a; tokens.json `controlCenter`; mockups control-center dark/light). Gap list (§10) updated for all five; §8 Appearance gains the icon-size control. All 24 PNGs + contact sheet re-rendered and viewed (see the extension verification record above). Repo landing still ON HOLD — Kevon: "Not yet — a few more tweaks first."
- **Decision 9 — top-bar glass in light mode: DECIDED mode-adapted (Kevon, 2026-11-28 ~03:09 EST, by confirming the mockups — "Yes — start building").** Dark takes the dock's exact four glass values; light takes the same technique with adapted opacities (fill white 70% `#ffffffb3`, edge black 8% `#00000014`, highlight pure white, shade `#00000033`) — the literal 12% white was rejected as nearly invisible over light wallpaper. The mockups render the decided version. Recorded in MANIFEST.md §11 as decided decision 9.
