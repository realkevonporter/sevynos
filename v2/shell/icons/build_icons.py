#!/usr/bin/env python3
"""Build the SevynOS app-icon set (direction C — App-icon style).

Draws every glyph as a white-on-transparent mask at 4x supersample with
PIL, downscales with LANCZOS, and saves PNGs. No external assets.

Direction C (Kevon, 2026-11-10): full-bleed rounded-square icon with a
vertical gradient built from the app's tile colour + white filled glyph
(iOS/macOS-like). The icon replaces the dock tile background; the
monogram letter stays rendered underneath as a fallback for apps with
no staged icon (the host painter silently skips a missing file).

Surfaces (all shipped at exactly their display size — the host painter
is nearest-neighbour, so a 2x asset would alias):
  icons/<id>.png            80x80, radius 12  — dock tile (matches Dock.tsx)
  icons/large/<id>.png      72x72, radius 18  — EmptyState tile (App.tsx)
  icons/hero/<id>.png       96x96, radius 20  — fallback screen tile (App.tsx)
  icons/small/<id>.png      40x40, radius 8   — Store list row (App.tsx)
  icons/title/<id>.png      20x20, glyph only — window title bar
  icons/symbols/*.png       exact surface size — close, plus, up,
                            chevrons, wifi, battery, volume

Regenerate: python3 v2/shell/icons/build_icons.py   (from the repo root)
"""
import math
import os

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = HERE  # icons land next to this script: v2/shell/icons/

SS = 4  # supersample factor; all glyph coords are in 64-space
SIZE = 64

# App id -> tile colour. The 12 stock apps match v2/shell/src/apps.ts;
# video-calls / voice-calls are the M10 working titles (M10 plan §3:
# video-calls #7c3aed, voice-calls #0d9488) — their icons are staged
# now so the dock shows them the moment M10 lands.
APPS = {
    "files": "#3b82f6",
    "terminal": "#111827",
    "browser": "#0ea5e9",
    "settings": "#6b7280",
    "music": "#ec4899",
    "photos": "#f59e0b",
    "calendar": "#ef4444",
    "notes": "#eab308",
    "calculator": "#8b5cf6",
    "camera": "#14b8a6",
    "messages": "#22c55e",
    "store": "#f97316",
    "video-calls": "#7c3aed",
    "voice-calls": "#0d9488",
}


def hexrgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def lighten(rgb, f):
    return tuple(min(255, int(c + (255 - c) * f)) for c in rgb)


def darken(rgb, f):
    return tuple(max(0, int(c * (1 - f))) for c in rgb)


def new_mask():
    return Image.new("L", (SIZE * SS, SIZE * SS), 0)


def mask_to_rgba(mask, size):
    m = mask.resize((size, size), Image.LANCZOS)
    rgba = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    white = Image.new("RGBA", (size, size), (255, 255, 255, 255))
    rgba.paste(white, (0, 0), m)
    return rgba


def finish(mask, size=SIZE):
    return mask_to_rgba(mask, size)


# ---------------------------------------------------------------- glyphs
# Each takes an ImageDraw on a 4x mask (coords in 64-space * SS).
# Filled style: solid white shapes; "erased" parts (fill=0) let the
# tile gradient show through (display strips, key dots, lens holes).

def g_terminal(d, w):
    # ">" chevron + "_" underscore
    s = SS
    d.line([(20 * s, 20 * s), (32 * s, 32 * s), (20 * s, 44 * s)],
           fill=255, width=w, joint="curve")
    d.line([(37 * s, 44 * s), (52 * s, 44 * s)], fill=255, width=w)


def g_files(d, w):
    # folder: tab + body (filled: solid silhouette)
    s = SS
    d.rounded_rectangle([(10 * s, 24 * s), (54 * s, 50 * s)],
                        radius=4 * s, fill=255)
    d.rectangle([(10 * s, 18 * s), (28 * s, 27 * s)], fill=255)


def g_browser(d, w):
    # globe: solid disc, meridian + equator erased
    s = SS
    d.ellipse([(12 * s, 12 * s), (52 * s, 52 * s)], fill=255)
    d.ellipse([(23 * s, 12 * s), (41 * s, 52 * s)], outline=0, width=3 * s)
    d.line([(12 * s, 32 * s), (52 * s, 32 * s)], fill=0, width=3 * s)


def g_settings(d, w):
    # gear: 8 teeth + disc, centre hole erased
    s = SS
    cx, cy = 32 * s, 32 * s
    for k in range(8):
        a = math.radians(k * 45)
        a1, a2 = a - 0.20, a + 0.20
        pts = [
            (cx + 13 * s * math.cos(a1), cy + 13 * s * math.sin(a1)),
            (cx + 13 * s * math.cos(a2), cy + 13 * s * math.sin(a2)),
            (cx + 21 * s * math.cos(a2), cy + 21 * s * math.sin(a2)),
            (cx + 21 * s * math.cos(a1), cy + 21 * s * math.sin(a1)),
        ]
        d.polygon(pts, fill=255)
    d.ellipse([(17 * s, 17 * s), (47 * s, 47 * s)], fill=255)
    d.ellipse([(25 * s, 25 * s), (39 * s, 39 * s)], fill=0)


def g_calculator(d, w):
    # calculator body, display strip + 3x2 keys erased
    s = SS
    d.rounded_rectangle([(12 * s, 10 * s), (52 * s, 54 * s)],
                        radius=5 * s, fill=255)
    d.rectangle([(18 * s, 16 * s), (46 * s, 24 * s)], fill=0)
    for x in (18, 29, 40):
        for y in (30, 40):
            d.rectangle([(x * s, y * s), ((x + 7) * s, (y + 7) * s)], fill=0)


def g_camera(d, w):
    # camera body + top bump, lens hole erased, lens dot kept
    s = SS
    d.rectangle([(24 * s, 13 * s), (40 * s, 21 * s)], fill=255)
    d.rounded_rectangle([(10 * s, 20 * s), (54 * s, 50 * s)],
                        radius=6 * s, fill=255)
    d.ellipse([(25 * s, 26 * s), (39 * s, 40 * s)], fill=0)
    d.ellipse([(30 * s, 31 * s), (34 * s, 35 * s)], fill=255)


def g_messages(d, w):
    # speech bubble + tail, three typing dots erased
    s = SS
    d.rounded_rectangle([(10 * s, 14 * s), (54 * s, 44 * s)],
                        radius=9 * s, fill=255)
    d.polygon([(18 * s, 42 * s), (32 * s, 42 * s), (18 * s, 54 * s)],
              fill=255)
    for x in (18, 29, 40):
        d.ellipse([(x * s, 26 * s), ((x + 6) * s, 32 * s)], fill=0)


def g_video_calls(d, w):
    # video camera: body + lens wedge
    s = SS
    d.rounded_rectangle([(8 * s, 18 * s), (38 * s, 46 * s)],
                        radius=5 * s, fill=255)
    d.polygon([(38 * s, 24 * s), (52 * s, 15 * s), (52 * s, 49 * s),
               (38 * s, 40 * s)], fill=255)


def g_voice_calls(d, w):
    # telephone handset: thick C arc, flared ends
    s = SS
    d.arc([(15 * s, 11 * s), (49 * s, 53 * s)], 90, 270,
          fill=255, width=8 * s)
    d.ellipse([(26 * s, 5 * s), (38 * s, 17 * s)], fill=255)
    d.ellipse([(26 * s, 47 * s), (38 * s, 59 * s)], fill=255)


def g_music(d, w):
    # eighth note: head + stem + flag
    s = SS
    d.ellipse([(13 * s, 40 * s), (26 * s, 53 * s)], fill=255)
    d.rectangle([(23 * s, 14 * s), (27 * s, 44 * s)], fill=255)
    d.polygon([(27 * s, 14 * s), (45 * s, 20 * s), (45 * s, 31 * s),
               (27 * s, 26 * s)], fill=255)


def g_photos(d, w):
    # landscape: sun + mountains
    s = SS
    d.ellipse([(38 * s, 18 * s), (50 * s, 30 * s)], fill=255)
    d.polygon([(10 * s, 52 * s), (26 * s, 30 * s), (35 * s, 43 * s),
               (43 * s, 33 * s), (54 * s, 52 * s)], fill=255)


def g_store(d, w):
    # shopping bag: body + handle arc
    s = SS
    d.rounded_rectangle([(14 * s, 22 * s), (50 * s, 54 * s)],
                        radius=4 * s, fill=255)
    d.arc([(22 * s, 10 * s), (42 * s, 30 * s)], 180, 360,
          fill=255, width=5 * s)


def g_calendar(d, w):
    # calendar page: rings + header band + date squares erased
    s = SS
    d.rectangle([(20 * s, 8 * s), (24 * s, 16 * s)], fill=255)
    d.rectangle([(40 * s, 8 * s), (44 * s, 16 * s)], fill=255)
    d.rounded_rectangle([(12 * s, 14 * s), (52 * s, 52 * s)],
                        radius=5 * s, fill=255)
    d.rectangle([(12 * s, 24 * s), (52 * s, 27 * s)], fill=0)
    for x, y in ((19, 33), (29, 33), (39, 33), (19, 43)):
        d.rectangle([(x * s, y * s), ((x + 6) * s, (y + 6) * s)], fill=0)


def g_notes(d, w):
    # notepad page, three ruled lines erased
    s = SS
    d.rounded_rectangle([(14 * s, 10 * s), (50 * s, 54 * s)],
                        radius=4 * s, fill=255)
    d.rectangle([(20 * s, 20 * s), (44 * s, 23 * s)], fill=0)
    d.rectangle([(20 * s, 28 * s), (44 * s, 31 * s)], fill=0)
    d.rectangle([(20 * s, 36 * s), (38 * s, 39 * s)], fill=0)


GLYPHS = {
    "terminal": g_terminal,
    "files": g_files,
    "browser": g_browser,
    "settings": g_settings,
    "calculator": g_calculator,
    "camera": g_camera,
    "messages": g_messages,
    "video-calls": g_video_calls,
    "voice-calls": g_voice_calls,
    "music": g_music,
    "photos": g_photos,
    "store": g_store,
    "calendar": g_calendar,
    "notes": g_notes,
}


def draw_glyph(app):
    """White filled glyph on transparent bg, 64x64."""
    mask = new_mask()
    d = ImageDraw.Draw(mask)
    # Terminal + files are stroked shapes in the sample script; at
    # filled weight they draw with a thick stroke.
    if app == "terminal":
        g_terminal(d, int(8 * SS))
    elif app == "files":
        g_files(d, int(8 * SS))
    else:
        GLYPHS[app](d, 0)
    return finish(mask)


def appicon(app, size, radius):
    """Full-bleed rounded-square icon: gradient + white glyph."""
    base = hexrgb(APPS[app])
    top = lighten(base, 0.22)
    bot = darken(base, 0.14)
    grad = Image.new("RGB", (1, size))
    px = grad.load()
    for y in range(size):
        t = y / (size - 1)
        px[0, y] = tuple(int(top[i] + (bot[i] - top[i]) * t) for i in range(3))
    grad = grad.resize((size, size))
    amask = Image.new("L", (size * SS, size * SS), 0)
    ImageDraw.Draw(amask).rounded_rectangle(
        [(0, 0), (size * SS - 1, size * SS - 1)], radius=radius * SS, fill=255)
    amask = amask.resize((size, size), Image.LANCZOS)
    icon = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    icon.paste(grad, (0, 0), amask)
    # Glyph fills 56/64 of the tile at 80px; scale proportionally.
    gs = round(size * 56 / 80)
    glyph = draw_glyph(app).resize((gs, gs), Image.LANCZOS)
    off = (size - gs) // 2
    icon.alpha_composite(glyph, (off, off))
    return icon


# ---------------------------------------------------------------- symbols
# White glyphs on transparent bg, drawn at exact display size.
# Each takes an ImageDraw on a 4x mask in the symbol's own pixel space.

def s_close(d, w):
    s = SS
    d.line([(3 * s, 3 * s), (13 * s, 13 * s)], fill=255, width=3 * s)
    d.line([(13 * s, 3 * s), (3 * s, 13 * s)], fill=255, width=3 * s)


def s_plus(d, w):
    s = SS
    d.line([(8 * s, 3 * s), (8 * s, 13 * s)], fill=255, width=3 * s)
    d.line([(3 * s, 8 * s), (13 * s, 8 * s)], fill=255, width=3 * s)


def s_up(d, w):
    s = SS
    d.line([(8 * s, 5 * s), (8 * s, 13 * s)], fill=255, width=3 * s)
    d.line([(8 * s, 3 * s), (4 * s, 8 * s)], fill=255, width=3 * s)
    d.line([(8 * s, 3 * s), (12 * s, 8 * s)], fill=255, width=3 * s)


def s_chevron_left(d, w):
    s = SS
    d.line([(11 * s, 4 * s), (5 * s, 12 * s)], fill=255, width=int(3.5 * s))
    d.line([(5 * s, 12 * s), (11 * s, 20 * s)], fill=255, width=int(3.5 * s))


def s_chevron_right(d, w):
    s = SS
    d.line([(5 * s, 4 * s), (11 * s, 12 * s)], fill=255, width=int(3.5 * s))
    d.line([(11 * s, 12 * s), (5 * s, 20 * s)], fill=255, width=int(3.5 * s))


def s_wifi(d, w):
    # Three arcs + dot, centred on (10, 13).
    s = SS
    for r in (5, 9, 13):
        d.arc([(10 - r) * s, (13 - r) * s, (10 + r) * s, (13 + r) * s],
              225, 315, fill=255, width=2 * s)
    d.ellipse([(8 * s, 11 * s), (12 * s, 14 * s)], fill=255)


def s_battery(d, w):
    # Outline only — the charge fill is a View sized by the tray.
    # Inner clear area: x 2..22, y 2..11 (fill: left 2, top 2, h 9).
    s = SS
    d.rounded_rectangle([(0, 0), (24 * s, 13 * s)], radius=3 * s,
                        outline=255, width=2 * s)
    d.rectangle([(25 * s, 5 * s), (27 * s, 9 * s)], fill=255)


def s_volume(d, w):
    # Speaker cone + two sound arcs.
    s = SS
    d.polygon([(1 * s, 6 * s), (7 * s, 6 * s), (13 * s, 2 * s),
               (13 * s, 14 * s), (7 * s, 10 * s), (1 * s, 10 * s)],
              fill=255)
    d.arc([(11 * s, 3 * s), (19 * s, 13 * s)], 315, 45,
          fill=255, width=2 * s)
    d.arc([(7 * s, -1 * s), (23 * s, 17 * s)], 315, 45,
          fill=255, width=2 * s)


SYMBOLS = {
    # name -> (width, height, draw fn)
    "close": (16, 16, s_close),
    "plus": (16, 16, s_plus),
    "up": (16, 16, s_up),
    "chevron-left": (16, 24, s_chevron_left),
    "chevron-right": (16, 24, s_chevron_right),
    "wifi": (20, 14, s_wifi),
    "battery": (28, 14, s_battery),
    "volume": (20, 16, s_volume),
}


def draw_symbol(name):
    w, h, fn = SYMBOLS[name]
    mask = Image.new("L", (w * SS, h * SS), 0)
    fn(ImageDraw.Draw(mask), 0)
    return mask_to_rgba(mask, w) if w == h else _resize_rgba(mask, w, h)


def _resize_rgba(mask, w, h):
    m = mask.resize((w, h), Image.LANCZOS)
    rgba = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    white = Image.new("RGBA", (w, h), (255, 255, 255, 255))
    rgba.paste(white, (0, 0), m)
    return rgba


def main():
    for sub in ("large", "hero", "small", "title", "symbols"):
        os.makedirs(os.path.join(OUT, sub), exist_ok=True)
    for app in APPS:
        appicon(app, 80, 12).save(os.path.join(OUT, app + ".png"))
        appicon(app, 72, 18).save(os.path.join(OUT, "large", app + ".png"))
        appicon(app, 96, 20).save(os.path.join(OUT, "hero", app + ".png"))
        appicon(app, 40, 8).save(os.path.join(OUT, "small", app + ".png"))
        draw_glyph(app).resize((20, 20), Image.LANCZOS).save(
            os.path.join(OUT, "title", app + ".png"))
    for name in SYMBOLS:
        draw_symbol(name).save(os.path.join(OUT, "symbols", name + ".png"))

    # Preview sheet: all 14 dock icons in a row on the dock bg.
    sheet = Image.new("RGBA", (14 * 80 + 13 * 8 + 16, 96), (16, 16, 20, 255))
    for i, app in enumerate(APPS):
        tile = Image.open(os.path.join(OUT, app + ".png"))
        sheet.alpha_composite(tile, (8 + i * 88, 8))
    sheet.convert("RGB").save(os.path.join(OUT, "preview-dock.png"))
    print("wrote", len(APPS), "dock icons + variants +",
          len(SYMBOLS), "symbols to", OUT)


if __name__ == "__main__":
    main()
