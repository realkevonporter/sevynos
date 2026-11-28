#!/usr/bin/env python3
"""Build the SevynOS Layout Manifest mockups: HTML sources + headless-Chromium PNGs.

Every mockup is precise HTML/CSS (exact px metrics from tokens.json) rendered
with the Playwright headless shell. Before-panels use real pixels cropped from
the Genesis desktop screenshot (desktop.png) or faithful re-renders of the
current spec where no live pixels exist.
"""
import os, subprocess, sys
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.expanduser("~/workspace/sevynos-layout-manifest")
MOCK = os.path.join(ROOT, "mockups")
SRC = os.path.join(MOCK, "src")
HS = os.path.expanduser("~/.cache/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell")
DESKTOP = os.path.expanduser("~/workspace/sevynos-genesis-screendump-test/desktop.png")
FROST = os.path.join(SRC, "frost-photo.png")

os.makedirs(SRC, exist_ok=True)

FONT = "DejaVu Sans, sans-serif"  # unquoted on purpose: style attributes use single
# quotes, and a quoted family name ('DejaVu Sans') inside a single-quoted
# style attribute terminates the attribute early, silently dropping every
# declaration after the font shorthand (colors, margins). Unquoted multi-word
# family names are valid CSS (<family-name> = <custom-ident>+).

# --- palette (from tokens.json) ---
DARK = dict(bg="#06080F", surface="#1F2937", elevated="#1F2937", sunken="#111827",
            appbody="#111827", topbar="#15151C", primary="#FAFAFA", secondary="#D1D5DB",
            muted="#9CA3AF", border="#4B5563", hover="#374151")
LIGHT = dict(bg="#F2F2F7", surface="#FFFFFF", elevated="#FFFFFF", sunken="#F2F2F7",
             appbody="#F9FAFB", topbar="#F2F2F7", primary="#14141A", secondary="#6B7280",
             muted="#9CA3AF", border="#E5E7EB", hover="#F3F4F6")
ACCENTS = {
    "neutral": ("#14141A", "#FAFAFA", "#14141A", "#FFFFFF", "#14141A"),
    "violet":  ("#5B5BD6", "#8B8BFF", "#5B5BD6", "#FFFFFF", "#14141A"),
    "coral":   ("#FF6B4A", "#FF8563", "#B24B34", "#000000", "#14141A"),
    "teal":    ("#0EA5A5", "#2EC4C4", "#0A7373", "#000000", "#14141A"),
    "rose":    ("#E84A7A", "#F472A0", "#A23455", "#000000", "#14141A"),
    "sky":     ("#0284C7", "#38BDF8", "#015C8B", "#000000", "#14141A"),
}
# (light_fill, dark_fill, text_light, onfill_light, onfill_dark)

# Dock glass, mirrored for the top bar (Dock.tsx: DOCK_GLASS etc. — fill
# #ffffff1f, edge #ffffff14, highlight #ffffff40, shade #00000033).
# Dark mode takes the dock's exact values. Light mode adapts them
# (decision 9, open — recommended): the dock's 12% white is invisible
# on light wallpaper, so the light bar is a 70% white tint with a black
# 8% hairline bottom edge and a pure-white top highlight.
GLASS_DARK = dict(fill="#ffffff1f", edge="#ffffff14", highlight="#ffffff40", shade="#00000033")
GLASS_LIGHT = dict(fill="#ffffffb3", edge="#00000014", highlight="#ffffff", shade="#00000033")

def bar_over_backdrop(mode, bar_html, w, h):
    """A wallpaper backdrop strip with a bar over it, so a translucent
    bar reads as translucent. Dark: the cosmic gradient. Light: the
    real frost photo, cover-fit."""
    if mode == "dark":
        bg = ("background:#0b0620;"
              "background-image:radial-gradient(circle at 22% 12%, rgba(217,70,239,0.28) 0%, transparent 42%),"
              "radial-gradient(circle at 82% 88%, rgba(45,212,191,0.22) 0%, transparent 42%),"
              "radial-gradient(circle at 58% 48%, rgba(139,92,246,0.20) 0%, transparent 38%),"
              "linear-gradient(rgba(139,156,254,0.08) 0%, rgba(139,156,254,0.08) 100%);"
              f"background-size:{w}px {h}px")
        return (f"<div style='position:relative;width:{w}px;height:{h}px;overflow:hidden;{bg}'>"
                f"<div style='position:relative;z-index:2'>{bar_html}</div></div>")
    return (f"<div style='position:relative;width:{w}px;height:{h}px;overflow:hidden'>"
            f"<img src='file://{FROST}' style='position:absolute;left:0;top:0;width:{w}px;height:{h}px;object-fit:cover'>"
            f"<div style='position:relative;z-index:2'>{bar_html}</div></div>")

def tag(text, color="#5B5BD6"):
    return (f'<span style="display:inline-block;background:{color};color:#fff;'
            f'font:700 11px {FONT};padding:3px 8px;border-radius:4px;'
            f'letter-spacing:0.06em">{text}</span>')

def tag_gray(text):
    return tag(text, "#6B7280")

def page(title, sub, body, w, h, page_bg="#E8E8EC"):
    return f"""<!DOCTYPE html><html><head><meta charset="utf-8"><style>
* {{ box-sizing: border-box; margin: 0; padding: 0; }}
html,body {{ width:{w}px; height:{h}px; overflow:hidden; background:{page_bg};
  font-family:{FONT}; }}
.sheet {{ width:{w}px; height:{h}px; padding:24px; }}
h1 {{ font:700 20px {FONT}; color:#14141A; }}
.sub {{ font:400 13px {FONT}; color:#6B7280; margin:6px 0 18px 0; }}
.panel-label {{ font:700 11px {FONT}; letter-spacing:0.08em; color:#6B7280; margin-bottom:8px; }}
.row {{ display:flex; gap:24px; }}
</style></head><body><div class="sheet">
<h1>{title}</h1><div class="sub">{sub}</div>
{body}
</div></body></html>"""

def window_header(mode, controls="right", accent="violet", width=800, bar_h=40, radius=10):
    c = DARK if mode == "dark" else LIGHT
    fill_l, fill_d, _, on_l, on_d = ACCENTS[accent]
    btn = ("<div style='display:flex;gap:0'>"
           "<div style='width:28px;height:28px;border-radius:6px;display:flex;align-items:center;justify-content:center;color:{p};font-size:16px'>—</div>"
           "<div style='width:28px;height:28px;border-radius:6px;display:flex;align-items:center;justify-content:center;color:{p};font-size:14px'>▢</div>"
           "<div style='width:28px;height:28px;border-radius:6px;display:flex;align-items:center;justify-content:center;color:{p};font-size:15px'>✕</div></div>").format(p=c["primary"])
    icon = ("<div style='width:20px;height:20px;border-radius:5px;background:#111827;"
            "color:#fff;display:flex;align-items:center;justify-content:center;"
            "font:700 12px " + FONT + ";margin-right:8px;border:1px solid #374151'>T</div>")
    title = f"<div style='font:700 16px {FONT};color:{c['primary']};flex:1'>Terminal</div>"
    controls_html = btn
    if controls == "left":
        inner = (f"<div style='display:flex;align-items:center;padding-left:12px'>{controls_html}</div>"
                 f"<div style='display:flex;align-items:center;flex:1;padding-left:12px'>{icon}{title}</div>")
    else:
        inner = (f"<div style='display:flex;align-items:center;flex:1;padding-left:16px'>{icon}{title}</div>"
                 f"<div style='display:flex;align-items:center;padding-right:12px'>{controls_html}</div>")
    shadow = ("0 16px 48px rgba(0,0,0,0.45)" if mode == "dark" else "0 16px 48px rgba(0,0,0,0.20)")
    return (f"<div style='width:{width}px;border-radius:{radius}px {radius}px 0 0;"
            f"overflow:hidden;box-shadow:{shadow}'>"
            f"<div style='display:flex;height:{bar_h}px;background:{c['appbody']};"
            f"border-bottom:1px solid {c['border']}'>{inner}</div>"
            f"<div style='height:120px;background:{c['appbody']};padding:16px;'>"
            f"<div style='font:400 14px {FONT};color:{c['secondary']};margin-bottom:8px'>sevyn Terminal — the sevyn CLI only. No bash.</div>"
            f"<div style='font:400 14px {FONT};color:{c['secondary']}'>sevyn&gt; <span style='color:{c['muted']}'>type a sevyn command</span></div>"
            f"</div></div>")

def topbar(mode, height=32, show_menus=True, show_control=True):
    """The manifest top bar: 32px, dock glass over the wallpaper, no
    Power (it moved into the SevynOS logo menu, tweak 4), control
    icon at the right end (tweak 5). The glass is the dock's exact
    treatment: translucent fill + 1px edge ring (visible as the bottom
    border — the top and sides are screen edges) + 1px top highlight
    + 1px bottom shade."""
    c = DARK if mode == "dark" else LIGHT
    g = GLASS_DARK if mode == "dark" else GLASS_LIGHT
    left_menus = ""
    if show_menus:
        left_menus = (f"<div style='display:flex;gap:16px;margin-left:20px;'>"
                      f"<span style='font:400 13px {FONT};color:{c['primary']}'>File</span>"
                      f"<span style='font:400 13px {FONT};color:{c['primary']}'>Edit</span>"
                      f"<span style='font:400 13px {FONT};color:{c['primary']}'>View</span>"
                      f"</div>")
    # Control Center icon: two drawn sliders (the tray font has no such
    # glyph — like the Wi-Fi/battery/volume symbols, it is a drawn
    # symbol). 28x28 hit area, radius 6.
    ic = c["primary"]
    control = ""
    if show_control:
        control = (f"<div style='width:28px;height:28px;border-radius:6px;margin-left:16px;"
                   f"display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px'>"
                   f"<div style='position:relative;width:16px;height:2px;background:{ic};border-radius:1px'>"
                   f"<div style='position:absolute;left:9px;top:-3px;width:8px;height:8px;border-radius:4px;background:{ic}'></div></div>"
                   f"<div style='position:relative;width:16px;height:2px;background:{ic};border-radius:1px'>"
                   f"<div style='position:absolute;left:3px;top:-3px;width:8px;height:8px;border-radius:4px;background:{ic}'></div></div></div>")
    return (f"<div style='position:relative;display:flex;align-items:center;height:{height}px;width:100%;"
            f"background:{g['fill']};border-bottom:1px solid {g['edge']};padding:0 16px;'>"
            f"<div style='position:absolute;left:0;right:0;top:0;height:1px;background:{g['highlight']}'></div>"
            f"<div style='position:absolute;left:0;right:0;bottom:1px;height:1px;background:{g['shade']}'></div>"
            f"<span style='font:700 16px {FONT};color:{c['primary']}'>SevynOS</span>"
            f"<span style='font:700 13px {FONT};color:{c['primary']};margin-left:20px'>Terminal</span>"
            f"{left_menus}"
            f"<div style='flex:1'></div>"
            f"<span style='font:400 13px {FONT};color:{c['secondary']}'>Wi-Fi</span>"
            f"<div style='display:flex;align-items:center;margin-left:16px'>"
            f"<div style='position:relative;width:28px;height:14px;border:1px solid {c['secondary']};border-radius:2px'>"
            f"<div style='position:absolute;left:2px;top:2px;width:16px;height:9px;background:{c['primary']}'></div></div>"
            f"<span style='font:400 13px {FONT};color:{c['secondary']};margin-left:6px'>82%</span></div>"
            f"<span style='font:400 13px {FONT};color:{c['secondary']};margin-left:16px'>Vol 50</span>"
            f"<span style='font:400 13px {FONT};color:{c['secondary']};margin-left:16px'>9:41</span>"
            f"{control}</div>")

def topbar_today(mode):
    """The bar as it ships today (48px, opaque #15151C, Power pill at
    the right end, no app name/menus/clock) — the BEFORE reference for
    the decision-topbar mockup. Power: 64x36 #26262e, label 13 #d1d5db."""
    return (f"<div style='display:flex;align-items:center;height:48px;width:100%;"
            f"background:#15151C;padding:0 16px;'>"
            f"<span style='font:700 16px {FONT};color:#ffffff'>SevynOS</span>"
            f"<div style='flex:1'></div>"
            f"<span style='font:400 13px {FONT};color:#D1D5DB'>Wi-Fi</span>"
            f"<span style='font:400 13px {FONT};color:#D1D5DB;margin-left:16px'>Vol 50</span>"
            f"<div style='width:64px;height:36px;margin-left:16px;border-radius:6px;background:#26262E;"
            f"display:flex;align-items:center;justify-content:center'>"
            f"<span style='font:400 13px {FONT};color:#D1D5DB'>Power</span></div></div>")

MENU_ITEMS = [
    ("New Window", "\u2318N", False, False, False),
    ("Open\u2026", "\u2318O", False, False, False),
    (None, None, True, False, False),
    ("Cut", "\u2318X", False, False, False),
    ("Copy", "\u2318C", False, False, False),
    ("Paste", "\u2318V", False, False, False),
    (None, None, True, False, False),
    ("Get Info", "", False, True, False),
    (None, None, True, False, False),
    ("Close Window", "\u2318W", False, False, True),
]

def menu(mode, style="after", accent="violet"):
    c = DARK if mode == "dark" else LIGHT
    fill_l, fill_d, _, on_l, on_d = ACCENTS[accent]
    row_h = 28 if style == "after" else 32
    hl = fill_d if mode == "dark" else fill_l
    hl_label = on_d if mode == "dark" else on_l
    if style == "before":
        hl, hl_label = "#3B82F6", "#FFFFFF"
    rows = []
    for i, (label, sc, sep, check, disabled) in enumerate(MENU_ITEMS):
        if sep:
            rows.append(f"<div style='height:1px;background:{c['border']};margin:4px 0'></div>")
            continue
        is_hl = (label == "Copy")
        bg = hl if is_hl else "transparent"
        fg = hl_label if is_hl else (c["muted"] if disabled else c["primary"])
        sc_html = ""
        if style == "after" and sc:
            sc_color = hl_label if is_hl else c["muted"]  # shortcut follows the row: onFill on highlight
            sc_html = (f"<span style='font:400 13px {FONT};color:{sc_color};"
                       f"margin-left:auto;padding-left:24px'>{sc}</span>")
        check_html = ""
        if style == "after" and check:
            check_html = (f"<span style='font:400 14px {FONT};color:{hl};"
                          f"width:20px'>\u2713</span>")
        rows.append(
            f"<div style='display:flex;align-items:center;height:{row_h}px;"
            f"border-radius:6px;background:{bg};padding:0 10px;'>"
            f"{check_html}<span style='font:400 14px {FONT};color:{fg}'>{label}</span>{sc_html}</div>")
    shadow = ("0 8px 24px rgba(0,0,0,0.35)" if mode == "dark" else "0 8px 24px rgba(0,0,0,0.15)")
    return (f"<div style='width:220px;background:{c['surface']};border-radius:8px;"
            f"padding:4px;box-shadow:{shadow};border:1px solid {c['border']}'>"
            + "".join(rows) + "</div>")

def render(html_path, png_path, w, h):
    cmd = [HS, "--headless", "--disable-gpu", "--no-sandbox",
           "--allow-file-access-from-files", "--force-device-scale-factor=1",
           "--hide-scrollbars", f"--screenshot={png_path}",
           f"--window-size={w},{h}", f"file://{html_path}"]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if not os.path.exists(png_path):
        print("RENDER FAIL", png_path, r.stdout[-300:], r.stderr[-300:])
        return False
    return True

def write_page(name, html, w, h):
    p = os.path.join(SRC, name + ".html")
    with open(p, "w") as f:
        f.write(html)
    ok = render(p, os.path.join(MOCK, name + ".png"), w, h)
    print(("OK " if ok else "FAIL ") + name + ".png")
    return ok

# --- page builders ---

def build_windows(mode):
    c = DARK if mode == "dark" else LIGHT
    before_img = "file://" + os.path.join(MOCK, "before-window-header.png")
    bar = "40px bar \u00b7 28px controls \u00b7 radius 10 \u00b7 controls stay RIGHT (decided)"
    body = f"""
<div class="panel-label">BEFORE — TODAY &nbsp;{tag_gray("REAL PIXELS")}</div>
<div style="margin-bottom:6px"><img src="{before_img}" style="width:800px;height:44px;display:block;border-radius:0;box-shadow:0 4px 16px rgba(0,0,0,0.30)"></div>
<div style="font:400 13px {FONT};color:#6B7280;margin-bottom:20px">44px bar, controls on the RIGHT, square corners (radius 0), no shadow. Cropped from the real Genesis desktop screenshot.</div>
<div class="panel-label">AFTER — MANIFEST &nbsp;{tag("PROPOSAL")}</div>
{window_header(mode, controls="right")}
<div style="font:400 13px {FONT};color:#6B7280;margin-top:10px">{bar}. Title stays 16 bold + 20px app icon. Chrome stays neutral in both modes.</div>
"""
    return page(f"Windows — {mode} mode",
                "Title bar: 44px \u2192 40px \u00b7 corner radius 0 \u2192 10 \u00b7 controls stay right (decision 1, decided)",
                body, 1200, 600)

def build_topbar(mode):
    c = DARK if mode == "dark" else LIGHT
    before_img = "file://" + os.path.join(MOCK, "before-topbar-right.png")
    after = bar_over_backdrop(mode, topbar(mode, height=32), 960, 200)
    body = f"""
<div class="panel-label">BEFORE — TODAY &nbsp;{tag_gray("REAL PIXELS")}</div>
<div style="margin-bottom:6px"><img src="{before_img}" style="width:960px;height:96px;display:block;box-shadow:0 4px 16px rgba(0,0,0,0.30)"></div>
<div style="font:400 13px {FONT};color:#6B7280;margin-bottom:20px">48px bar (shown 2\u00d7, right side only — the tray as it ships today: Wi-Fi, battery, volume, Power). No clock, no app name, no app menus.</div>
<div class="panel-label">AFTER — MANIFEST &nbsp;{tag("PROPOSAL")}</div>
{after}
<div style="font:400 13px {FONT};color:#6B7280;margin-top:10px">32px bar \u00b7 glass, not opaque — the dock's tint over the wallpaper (the wallpaper shows through the bar) \u00b7 left: SevynOS mark + active app name + app menus \u00b7 right: tray + clock + control icon (Power moved into the SevynOS logo menu).</div>
"""
    return page(f"Top bar — {mode} mode",
                "Height: 48px \u2192 32px \u00b7 glass like the dock \u00b7 Power out, control icon in",
                body, 1200, 520)

def build_menu(mode):
    body = f"""
<div class="row">
<div>
<div class="panel-label">BEFORE — TODAY &nbsp;{tag_gray("CURRENT SPEC, RE-RENDERED")}</div>
{menu(mode, style="before")}
<div style="font:400 13px {FONT};color:#6B7280;margin-top:10px;width:220px">32px rows, blue <span style="color:#3B82F6;font-weight:700">#3B82F6</span> highlight, no shortcuts, no checkmarks.</div>
</div>
<div>
<div class="panel-label">AFTER — MANIFEST &nbsp;{tag("PROPOSAL")}</div>
{menu(mode, style="after")}
<div style="font:400 13px {FONT};color:#6B7280;margin-top:10px;width:220px">28px rows, <b>accent</b> highlight, shortcuts right-aligned, checkmark slot, \u22643 groups.</div>
</div>
<div style="flex:1;padding-left:24px">
<div class="panel-label">WHAT CHANGED</div>
<div style="font:400 14px {FONT};color:#14141A;line-height:1.9">
\u2022 Row height 32 \u2192 28<br>
\u2022 Highlight blue \u2192 accent fill + onFill label<br>
\u2022 Shortcuts right-aligned (new)<br>
\u2022 Checkmark slot (new)<br>
\u2022 Submenu arrow \u203a (new)<br>
\u2022 Max 3 groups, hide unavailable items
</div></div>
</div>
"""
    return page(f"Popup menu — {mode} mode",
                "One component for context menus and dropdowns: 220 wide \u00b7 radius 8 \u00b7 padding 4",
                body, 1200, 560)

def build_dialog(mode):
    c = DARK if mode == "dark" else LIGHT
    fill_l, fill_d, _, on_l, on_d = ACCENTS["violet"]
    acc = fill_d if mode == "dark" else fill_l
    acc_label = on_d if mode == "dark" else on_l
    danger = "#EF4444" if mode == "dark" else "#DC2626"
    shadow = ("0 12px 32px rgba(0,0,0,0.45)" if mode == "dark" else "0 12px 32px rgba(0,0,0,0.18)")
    # BEFORE: current inline confirm, re-rendered on the light app body (as it ships today)
    before = f"""
<div style="width:520px;background:#F9FAFB;border-radius:12px;padding:20px;border:1px solid #E5E7EB">
<div style="font:400 14px {FONT};color:#374151">God mode gives the AI full access to this device:</div>
<div style="font:400 14px {FONT};color:#374151;margin-top:4px">\u2013 install and uninstall apps &nbsp;\u2013 reboot the device</div>
<div style="display:flex;gap:12px;margin-top:12px">
<div style="width:120px;height:36px;border-radius:8px;background:#B45309;display:flex;align-items:center;justify-content:center"><span style="font:700 15px {FONT};color:#fff">Confirm</span></div>
<div style="width:120px;height:36px;border-radius:8px;background:#E5E7EB;display:flex;align-items:center;justify-content:center"><span style="font:400 15px {FONT};color:#111827">Cancel</span></div>
</div></div>
<div style="font:400 13px {FONT};color:#6B7280;margin-top:10px;width:520px">Inline expansion inside Settings. Confirm FIRST, Cancel second — reversed vs Apple. No overlay, no Esc, no modal.</div>
"""
    # AFTER: alert modal on a dimmed desktop + sheet attached to a mini window
    alert = f"""
<div style="width:360px;background:{c['surface']};border-radius:12px;padding:20px;box-shadow:{shadow};border:1px solid {c['border']}">
<div style="width:48px;height:48px;border-radius:24px;background:{danger};display:flex;align-items:center;justify-content:center;margin:0 auto 12px auto"><span style="font:700 24px {FONT};color:#fff">!</span></div>
<div style="font:700 16px {FONT};color:{c['primary']};text-align:center">Delete this file?</div>
<div style="font:400 14px {FONT};color:{c['secondary']};text-align:center;margin-top:8px;line-height:1.4">Notes.txt will be permanently deleted. This cannot be undone.</div>
<div style="display:flex;gap:12px;margin-top:20px;justify-content:flex-end">
<div style="min-width:96px;height:36px;border-radius:6px;background:{c['hover']};display:flex;align-items:center;justify-content:center;padding:0 16px"><span style="font:400 14px {FONT};color:{c['primary']}">Cancel</span></div>
<div style="min-width:96px;height:36px;border-radius:6px;background:{danger};display:flex;align-items:center;justify-content:center;padding:0 16px"><span style="font:700 14px {FONT};color:#fff">Delete</span></div>
</div></div>
"""
    sheet = f"""
<div style="width:520px;border-radius:10px 10px 0 0;overflow:hidden;box-shadow:{shadow}">
<div style="height:40px;background:{c['appbody']};display:flex;align-items:center;padding:0 16px;border-bottom:1px solid {c['border']}"><span style="font:700 16px {FONT};color:{c['primary']}">Files</span></div>
<div style="background:{c['surface']};padding:16px 20px 20px 20px">
<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
<span style="font:400 14px {FONT};color:{c['secondary']}">Cancel</span>
<span style="font:700 16px {FONT};color:{c['primary']}">New Folder</span>
<span style="font:700 14px {FONT};color:{acc}">Done</span></div>
<div style="height:36px;border-radius:6px;background:{c['sunken']};display:flex;align-items:center;padding:0 12px"><span style="font:400 14px {FONT};color:{c['muted']}">Folder name</span></div>
</div></div>
<div style="font:400 13px {FONT};color:#6B7280;margin-top:10px;width:520px">Sheet — attached to the parent window, Cancel leading / Done trailing. Esc = Cancel.</div>
"""
    body = f"""
<div class="panel-label">BEFORE — TODAY &nbsp;{tag_gray("CURRENT PATTERN, RE-RENDERED")}</div>
{before}
<div class="panel-label" style="margin-top:20px">AFTER — MANIFEST &nbsp;{tag("PROPOSAL")}</div>
<div class="row">
<div>{alert}<div style="font:400 13px {FONT};color:#6B7280;margin-top:10px;width:360px">Alert — 360 wide, radius 12, Cancel leading / Delete trailing, Esc = Cancel, Return = default.</div></div>
<div>{sheet}</div>
</div>
"""
    return page(f"Dialog boxes — {mode} mode",
                "No modal dialog system exists today — alerts and sheets are new; the inline confirm survives as the third kind",
                body, 1200, 760)

def build_decision_controls():
    panels = ""
    for mode in ("dark", "light"):
        for side in ("left", "right"):
            label = f"{mode} \u00b7 controls {side.upper()}" + (" \u2014 today" if side == "left" else " \u2014 DECIDED")
            panels += (f"<div style='margin-bottom:20px'><div class='panel-label'>{label}</div>"
                       f"{window_header(mode, controls=side, width=1120)}</div>")
    body = panels + """<div style="font:400 13px """ + FONT + """;color:#6B7280">Left matches macOS muscle memory and frees the right end for per-app toolbar actions; it costs a host-constant change plus the four custom title bars. Right costs nothing and matches Windows users.</div>"""
    return page("Decision 1 — window controls: left vs right",
                "Same 28px buttons, same 40px bar — only the side changes. Decided: RIGHT (Kevon, 2026-11-28).",
                body, 1200, 760)

def build_decision_topbar():
    panels = ""
    for mode in ("dark", "light"):
        for h in (32, 48):
            label = f"{mode} \u00b7 {h}px" + (" \u2014 DECIDED" if h == 32 else " \u2014 today")
            # 48px "today" keeps the opaque bar + Power as it ships;
            # 32px shows the glass bar with menus + control icon.
            bar = topbar(mode, height=h) if h == 32 else topbar_today(mode)
            panels += f"<div style='margin-bottom:20px'><div class='panel-label'>{label}</div>{bar_over_backdrop(mode, bar, 1120, 96)}</div>"
    body = panels + """<div style="font:400 13px """ + FONT + """;color:#6B7280">32px reclaims 16px of vertical space and matches macOS proportions; it requires shrinking the pills/buttons to 28px and retouching the m9-check coordinates. 48px needs no work. The 32px panels also show the dock-glass bar (tweak 3) and the control icon where Power was (tweaks 4–5).</div>"""
    return page("Decision 2 — top-bar height: 32px vs 48px",
                "Apple is 24pt. SevynOS needs 32px for its labeled tray items; 48px wastes a full row. Decided: 32px (Kevon, 2026-11-28).",
                body, 1200, 760)

def build_accent_strip():
    cells = ""
    for mode in ("light", "dark"):
        for aid, (fl, fd, tl, ol, od) in ACCENTS.items():
            fill = fl if mode == "light" else fd
            onfill = ol if mode == "light" else od
            text = tl if mode == "light" else fd
            c = LIGHT if mode == "light" else DARK
            cells += f"""
<div style="width:196px;flex-shrink:0">
<div style="font:700 12px {FONT};color:#14141A;margin-bottom:6px">{aid.title()} \u00b7 {mode}</div>
<div style="font:400 11px {FONT};color:#6B7280;margin-bottom:8px">fill {fill}</div>
<div style="border:1px solid {c['border']};border-radius:8px;overflow:hidden;margin-bottom:8px">
<div style="height:32px;background:{c['appbody']};display:flex;align-items:center;padding:0 8px">
<span style="font:700 12px {FONT};color:{c['primary']}">Terminal</span></div>
<div style="height:28px;background:{fill};display:flex;align-items:center;padding:0 10px">
<span style="font:400 13px {FONT};color:{onfill}">Copy</span>
<span style="font:400 12px {FONT};color:{onfill};margin-left:auto;opacity:0.75">\u2318C</span></div>
<div style="background:{c['surface']};padding:10px;display:flex;justify-content:flex-end">
<div style="height:28px;border-radius:6px;background:{fill};display:flex;align-items:center;padding:0 12px"><span style="font:700 12px {FONT};color:{onfill}">Save</span></div></div>
<div style="background:{c['surface']};padding:0 10px 10px 10px"><span style="font:400 12px {FONT};color:{text}">A link in {aid}</span></div>
</div></div>"""
    body = f"""
<div style="display:flex;gap:12px;flex-wrap:wrap">{cells}</div>
<div style="font:400 13px {FONT};color:#6B7280;margin-top:8px">One accent, two modes. Fill, label-on-fill, and link text per accent — all contrast-verified (see MANIFEST.md \u00a77). Chrome stays neutral; accent never touches window bars or body text.</div>
"""
    return page("Accent system — all six accents, both modes",
                "Same palette as Tokrah. Default: violet. Label on fill: white on violet/neutral (light), true black elsewhere (light), ink #14141A (dark).",
                body, 1280, 980)

def build_windows_coral_dark():
    c = DARK
    fill_d = ACCENTS["coral"][1]
    body = f"""
<div class="panel-label">CORAL, DARK MODE — THE SYSTEM IN CONTEXT &nbsp;{tag("PROPOSAL")}</div>
<div style="width:800px;border-radius:10px 10px 0 0;overflow:hidden;box-shadow:0 16px 48px rgba(0,0,0,0.45)">
<div style="height:40px;background:{c['appbody']};display:flex;align-items:center;padding-left:16px;padding-right:12px;border-bottom:1px solid {c['border']}">
<span style="font:700 16px {FONT};color:{c['primary']}">Files</span>
<span style="color:{c['primary']};font-size:15px;margin-left:auto">\u2014&nbsp;&nbsp;\u25a2&nbsp;&nbsp;\u2715</span></div>
<div style="background:{c['appbody']};padding:12px 16px">
<div style="display:flex;align-items:center;height:32px;border-radius:6px;background:{fill_d};padding:0 12px;margin-bottom:4px"><span style="font:400 14px {FONT};color:#14141A">Notes.txt</span><span style="font:400 12px {FONT};color:#14141A;margin-left:auto;opacity:0.7">12 KB</span></div>
<div style="display:flex;align-items:center;height:32px;border-radius:6px;padding:0 12px;margin-bottom:4px"><span style="font:400 14px {FONT};color:{c['primary']}">Photos</span></div>
<div style="display:flex;align-items:center;height:32px;border-radius:6px;padding:0 12px"><span style="font:400 14px {FONT};color:{c['primary']}">Music</span></div>
<div style="display:flex;gap:12px;margin-top:16px;align-items:center">
<div style="height:36px;border-radius:6px;background:{fill_d};display:flex;align-items:center;padding:0 16px"><span style="font:700 14px {FONT};color:#000000">Open</span></div>
<span style="font:400 14px {FONT};color:{fill_d}">Show in folder</span></div>
</div></div>
<div style="font:400 13px {FONT};color:#6B7280;margin-top:10px">Chrome stays neutral; coral appears only as selection, the primary button, and the link. Same window in violet is the default.</div>
"""
    return page("Windows — Coral accent, dark mode",
                "The accent system in context: selection, primary action, and link — nothing else takes the color.",
                body, 1200, 560)

def thumb_styles():
    """Thumbnail swatches for the 7 wallpaper styles (CSS approximations of the variants)."""
    return {
        "default": "background:#06080F",
        "cosmic": ("background:#0b0620;"
                   "background-image:radial-gradient(circle at 25% 20%, rgba(217,70,239,0.5) 0%, transparent 45%),"
                   "radial-gradient(circle at 80% 85%, rgba(45,212,191,0.45) 0%, transparent 45%),"
                   "radial-gradient(circle at 60% 50%, rgba(139,92,246,0.4) 0%, transparent 40%)"),
        "minimal": "background:#090b11",
        "macos": ("background:#0c0a26;"
                  "background-image:radial-gradient(circle at 20% 15%, rgba(249,115,22,0.55) 0%, transparent 45%),"
                  "radial-gradient(circle at 85% 30%, rgba(217,70,239,0.5) 0%, transparent 45%),"
                  "radial-gradient(circle at 55% 85%, rgba(139,92,246,0.5) 0%, transparent 45%)"),
        "macos-light": ("background:#eef1fb;"
                        "background-image:radial-gradient(circle at 20% 15%, rgba(249,115,22,0.35) 0%, transparent 45%),"
                        "radial-gradient(circle at 85% 30%, rgba(217,70,239,0.28) 0%, transparent 45%),"
                        "radial-gradient(circle at 55% 85%, rgba(139,92,246,0.28) 0%, transparent 45%)"),
        "frost": "background:#7d9bb8",
        "solid": "background:#090b11",
    }

def build_wallpaper(mode):
    c = DARK if mode == "dark" else LIGHT
    thumbs = thumb_styles()
    order = [("Cosmic", "cosmic", mode == "dark"), ("Default", "default", False),
             ("macOS", "macos", False), ("macOS Light", "macos-light", False),
             ("Frost", "frost", mode == "light"), ("Minimal", "minimal", False),
             ("Solid", "solid", False)]
    grid = ""
    for label, key, selected in order:
        ring = (f"box-shadow:0 0 0 2px {ACCENTS['violet'][1] if mode=='dark' else ACCENTS['violet'][0]};"
                if selected else f"border:1px solid {c['border']};")
        check = ("<div style='position:absolute;top:6px;right:6px;width:20px;height:20px;border-radius:10px;"
                 f"background:{ACCENTS['violet'][1] if mode=='dark' else ACCENTS['violet'][0]};"
                 "display:flex;align-items:center;justify-content:center'>"
                 "<span style='font:700 12px " + FONT + ";color:#fff'>\u2713</span></div>") if selected else ""
        grid += (f"<div style='width:160px;margin-bottom:10px'>"
                 f"<div style='position:relative;width:160px;height:88px;border-radius:8px;{thumbs[key]};{ring}'>"
                 f"{check}</div>"
                 f"<div style='font:400 12px {FONT};color:{c['secondary']};margin-top:6px'>{label}</div></div>")
    swatches = ""
    for aid, (fl, fd, _, _, _) in ACCENTS.items():
        fill = fd if mode == "dark" else fl
        sel = (f"box-shadow:0 0 0 2px {c['surface']}, 0 0 0 4px {fill};" if aid == "violet" else "")
        swatches += (f"<div style='width:36px;height:36px;border-radius:8px;background:{fill};"
                     f"margin-right:8px;{sel}'></div>")
    mode_seg = ""
    for m in ("Light", "Dark"):
        active = (m.lower() == mode)
        bg = (ACCENTS['violet'][1] if mode == "dark" else ACCENTS['violet'][0]) if active else "transparent"
        fg = ("#14141A" if mode == "dark" else "#FFFFFF") if active else c["secondary"]
        mode_seg += (f"<div style='flex:1;height:32px;border-radius:6px;background:{bg};"
                     f"display:flex;align-items:center;justify-content:center'>"
                     f"<span style='font:700 13px {FONT};color:{fg}'>{m}</span></div>")
    panel = f"""
<div style="position:absolute;top:32px;right:0;bottom:0;width:420px;background:{c['surface']};
border-left:1px solid {c['border']};padding:20px;overflow:hidden">
<div style="font:700 18px {FONT};color:{c['primary']}">Appearance</div>
<div style="font:700 12px {FONT};color:{c['muted']};letter-spacing:0.08em;margin:20px 0 8px">MODE</div>
<div style="display:flex;background:{c['sunken']};border-radius:8px;padding:4px">{mode_seg}</div>
<div style="font:700 12px {FONT};color:{c['muted']};letter-spacing:0.08em;margin:20px 0 8px">ACCENT</div>
<div style="display:flex">{swatches}</div>
<div style="font:700 12px {FONT};color:{c['muted']};letter-spacing:0.08em;margin:20px 0 8px">WALLPAPER</div>
<div style="display:flex;flex-wrap:wrap;gap:12px">{grid}</div>
<div style="font:400 12px {FONT};color:{c['muted']};margin-top:8px;line-height:1.5">Hover a thumbnail to preview it live — click to keep it. The desktop behind this panel is already showing the preview.</div>
</div>"""
    if mode == "dark":
        backdrop = ("background:#0b0620;"
                    "background-image:radial-gradient(circle at 22% 12%, rgba(217,70,239,0.28) 0%, transparent 42%),"
                    "radial-gradient(circle at 82% 88%, rgba(45,212,191,0.22) 0%, transparent 42%),"
                    "radial-gradient(circle at 58% 48%, rgba(139,92,246,0.20) 0%, transparent 38%),"
                    "linear-gradient(rgba(139,156,254,0.08) 0%, rgba(139,156,254,0.08) 100%);"
                    "background-size:1280px 800px")
        dock = ""
    else:
        backdrop = ""
        dock = ""
    desk = f"""
<div style="position:relative;width:1280px;height:800px;overflow:hidden;{backdrop}">
{f'<img src="file://{FROST}" style="position:absolute;left:0;top:0;width:1280px;height:800px;object-fit:cover">' if mode=='light' else ''}
{f'<div style="position:relative;z-index:2">{topbar(mode, height=32)}</div>'}
<div style="position:absolute;left:50%;bottom:16px;transform:translateX(-50%);display:flex;gap:8px;background:rgba(255,255,255,0.12);border-radius:24px;padding:8px">
{''.join(f"<div style='width:48px;height:48px;border-radius:11px;background:{col}'></div>" for col in ['#3B82F6','#8B5CF6','#EF4444','#10B981','#F59E0B','#0EA5A5'])}
</div>
{panel}
</div>"""
    return (f"<!DOCTYPE html><html><head><meta charset='utf-8'><style>"
            f"*{{box-sizing:border-box;margin:0;padding:0}}html,body{{width:1280px;height:800px;overflow:hidden;font-family:{FONT}}}</style></head>"
            f"<body>{desk}</body></html>")

# --- tweak 1: desktop icons (grid + S/M/L) ---

DESKTOP_TILE_COLORS = {"folder": "#F5A623", "image": "#E0448C", "video": "#8B5CF6",
                       "audio": "#10B981", "code": "#0EA5C9", "document": "#3B82F6",
                       "archive": "#E8930C", "file": "#64748B"}
DESKTOP_ENTRIES = [("Photos", "folder"), ("Notes.txt", "document"), ("Music", "folder"),
                   ("screenshot.png", "image"), ("demo.mp4", "video"),
                   ("Quarterly report.pdf", "document"), ("todo.md", "document"),
                   ("archive.zip", "archive")]
# S/M/L: medium is today's measured geometry (104x92 tile, 48 icon,
# 12 label, gaps 18/16); small and large scale from it on the 4pt grid.
ICON_SIZES = {
    "small": dict(label="Small", tile_w=80, tile_h=72, icon=36, radius=6, mono=18,
                  label_size=11, gap_x=14, gap_y=12, pad_top=6, label_mt=4),
    "medium": dict(label="Medium — today", tile_w=104, tile_h=92, icon=48, radius=8, mono=24,
                   label_size=12, gap_x=18, gap_y=16, pad_top=8, label_mt=6),
    "large": dict(label="Large", tile_w=128, tile_h=112, icon=64, radius=10, mono=32,
                  label_size=13, gap_x=24, gap_y=20, pad_top=10, label_mt=8),
}

def desktop_surface(mode, w, h, inner):
    """A wallpaper desktop surface with absolutely-positioned content
    over it (icons, bars, panels). Dark: cosmic gradient. Light: the
    real frost photo, cover-fit."""
    if mode == "dark":
        bg = ("background:#0b0620;"
              "background-image:radial-gradient(circle at 22% 12%, rgba(217,70,239,0.28) 0%, transparent 42%),"
              "radial-gradient(circle at 82% 88%, rgba(45,212,191,0.22) 0%, transparent 42%),"
              "radial-gradient(circle at 58% 48%, rgba(139,92,246,0.20) 0%, transparent 38%),"
              "linear-gradient(rgba(139,156,254,0.08) 0%, rgba(139,156,254,0.08) 100%);"
              f"background-size:{w}px {h}px")
        return f"<div style='position:relative;width:{w}px;height:{h}px;overflow:hidden;{bg}'>{inner}</div>"
    return (f"<div style='position:relative;width:{w}px;height:{h}px;overflow:hidden'>"
            f"<img src='file://{FROST}' style='position:absolute;left:0;top:0;width:{w}px;height:{h}px;object-fit:cover'>"
            f"{inner}</div>")

def desktop_icon_grid(mode, size_key, w=1120, selected=1):
    """One size's grid: same columns formula as DesktopIcons.tsx
    (floor((w-48)/pitch)), margins 24 left / 22 top, row-major fill.
    Returns (html, height). The selected icon takes the accent tint."""
    s = ICON_SIZES[size_key]
    pitch_x = s["tile_w"] + s["gap_x"]
    pitch_y = s["tile_h"] + s["gap_y"]
    cols = max(1, (w - 48) // pitch_x)
    rows = (len(DESKTOP_ENTRIES) + cols - 1) // cols
    h = 22 + rows * pitch_y - s["gap_y"] + 16
    icons = ""
    for i, (name, kind) in enumerate(DESKTOP_ENTRIES):
        row, col = divmod(i, cols)
        x = 24 + col * pitch_x
        y = 22 + row * pitch_y
        sel = (i == selected)
        sel_bg = ("background:rgba(91,91,214,0.15);" if mode == "light"
                  else "background:rgba(139,139,255,0.20);") if sel else ""
        bold = "font-weight:700;" if sel else ""
        icons += (f"<div style='position:absolute;left:{x}px;top:{y}px;width:{s['tile_w']}px;"
                  f"height:{s['tile_h']}px;border-radius:8px;{sel_bg}display:flex;flex-direction:column;"
                  f"align-items:center;padding-top:{s['pad_top']}px'>"
                  f"<div style='width:{s['icon']}px;height:{s['icon']}px;border-radius:{s['radius']}px;"
                  f"background:{DESKTOP_TILE_COLORS[kind]};display:flex;align-items:center;justify-content:center'>"
                  f"<span style='font:700 {s['mono']}px {FONT};color:#ffffff'>{name[0].upper()}</span></div>"
                  f"<div style='font:400 {s['label_size']}px {FONT};color:#ffffff;margin-top:{s['label_mt']}px;"
                  f"text-align:center;line-height:1.2;text-shadow:0 1px 3px rgba(0,0,0,0.45);{bold}'>{name}</div></div>")
    return desktop_surface(mode, w, h, icons), h

def build_desktop_icons(mode):
    panels = ""
    for key in ("small", "medium", "large"):
        s = ICON_SIZES[key]
        strip, _ = desktop_icon_grid(mode, key)
        panels += (f"<div class='panel-label'>{s['label'].upper()} \u00b7 {s['tile_w']}\u00d7{s['tile_h']} TILE \u00b7 "
                   f"{s['icon']}PX ICON \u00b7 LABEL {s['label_size']}</div>{strip}"
                   f"<div style='font:400 13px {FONT};color:#6B7280;margin:10px 0 20px 0'>"
                   f"Pitch {s['tile_w'] + s['gap_x']}\u00d7{s['tile_h'] + s['gap_y']} \u00b7 margins 24 left, 22 top \u00b7 "
                   f"selected icon (Notes.txt) takes the accent tint + bold label.</div>")
    body = panels + ("""<div style="font:400 13px """ + FONT + """;color:#6B7280">Today there is one size only — medium, no choice, no selection state. """
                   """The size lives in Settings \u2192 Appearance (segmented S / M / L beside the wallpaper grid) and in the desktop right-click menu (Icon Size \u25b8 Small / Medium / Large) — both write the same setting.</div>""")
    return page(f"Desktop icons — {mode} mode",
                "Grid layout \u00b7 three sizes \u00b7 selection state",
                body, 1200, 980)

# --- tweak 2: Files (grid / list) ---

FILES_ENTRIES = [("Photos", "folder", None, None), ("Notes.txt", "document", "12 KB", "Nov 27"),
                 ("Music", "folder", None, None), ("Quarterly report.pdf", "document", "2.4 MB", "Nov 26"),
                 ("screenshot.png", "image", "1.1 MB", "Nov 25"), ("demo.mp4", "video", "48 MB", "Nov 24")]

def _files_toggle(mode, view):
    """Segmented grid/list control, right end of the Files toolbar.
    64x28, radius 6; active segment is the raised one. Icons drawn
    (list: 3 lines; grid: 2x2 squares) — no glyph font exists."""
    c = DARK if mode == "dark" else LIGHT
    cont_bg = "#1F2937" if mode == "dark" else "#E5E7EB"
    act_bg = "#374151" if mode == "dark" else "#FFFFFF"
    act_fg = "#FAFAFA" if mode == "dark" else "#14141A"
    list_icon = (f"<div style='display:flex;flex-direction:column;gap:3px'>"
                 + "".join(f"<div style='width:16px;height:2px;background:{act_fg if view=='list' else c['muted']};border-radius:1px'></div>" for _ in range(3)) + "</div>")
    grid_icon = (f"<div style='display:grid;grid-template-columns:7px 7px;gap:2px'>"
                 + "".join(f"<div style='width:7px;height:7px;border-radius:1px;background:{act_fg if view=='grid' else c['muted']}'></div>" for _ in range(4)) + "</div>")
    def seg(active, icon):
        bg = act_bg if active else "transparent"
        return (f"<div style='width:30px;height:24px;border-radius:4px;background:{bg};"
                f"display:flex;align-items:center;justify-content:center'>{icon}</div>")
    return (f"<div style='display:flex;align-items:center;background:{cont_bg};border-radius:6px;"
            f"padding:2px;margin-left:auto'>{seg(view == 'list', list_icon)}{seg(view == 'grid', grid_icon)}</div>")

def _files_window(mode, view):
    """A Files window, 960x560, manifest chrome: 40px header, 32px path
    bar, 36px toolbar (Cut/Copy/Paste/Delete + view toggle), 168px
    Devices sidebar, listing, 28px status bar."""
    c = DARK if mode == "dark" else LIGHT
    sel_bg = "rgba(91,91,214,0.12)" if mode == "light" else "rgba(139,139,255,0.20)"
    bar_bg = "#E5E7EB" if mode == "light" else "#1F2937"
    tool_bg = "#F3F4F6" if mode == "light" else "#111827"
    side_bg = "#F3F4F6" if mode == "light" else "#111827"
    btn_act_bg = "#FFFFFF" if mode == "light" else "#374151"
    btn_act_fg = "#111827" if mode == "light" else "#FAFAFA"
    btn_in_bg = "#E5E7EB" if mode == "light" else "#1F2937"
    shadow = ("0 16px 48px rgba(0,0,0,0.45)" if mode == "dark" else "0 16px 48px rgba(0,0,0,0.20)")
    header = (f"<div style='display:flex;height:40px;background:{c['appbody']};align-items:center;"
              f"padding:0 16px 0 12px;border-bottom:1px solid {c['border']}'>"
              f"<div style='width:20px;height:20px;border-radius:5px;background:#3B82F6;color:#fff;"
              f"display:flex;align-items:center;justify-content:center;font:700 12px {FONT};margin-right:8px'>F</div>"
              f"<span style='font:700 16px {FONT};color:{c['primary']};flex:1'>Files</span>"
              f"<span style='color:{c['primary']};font-size:15px'>\u2014&nbsp;&nbsp;\u25a2&nbsp;&nbsp;\u2715</span></div>")
    pathbar = (f"<div style='height:32px;background:{bar_bg};display:flex;align-items:center;padding:0 12px'>"
               f"<span style='font:400 14px {FONT};color:{c['secondary']}'>/data</span></div>")
    btns = ""
    for label, active in (("Cut", True), ("Copy", True), ("Paste", True), ("Delete", True)):
        bg = btn_act_bg if active else btn_in_bg
        fg = btn_act_fg if active else c["muted"]
        btns += (f"<div style='height:28px;padding:0 12px;margin-right:8px;border-radius:6px;background:{bg};"
                 f"display:flex;align-items:center'><span style='font:400 13px {FONT};color:{fg}'>{label}</span></div>")
    toolbar = (f"<div style='display:flex;height:36px;background:{tool_bg};align-items:center;padding:0 12px'>"
               f"{btns}{_files_toggle(mode, view)}</div>")
    vols = ""
    for label, cap, selected in (("Internal Drive", "126 GB free", True),
                                 ("USB Drive", "18 GB free", False)):
        bg = sel_bg if selected else "transparent"
        vols += (f"<div style='display:flex;align-items:center;background:{bg};border-radius:6px;"
                 f"padding:4px;margin-top:8px'>"
                 f"<div style='width:24px;height:24px;border-radius:6px;background:#64748B;display:flex;"
                 f"align-items:center;justify-content:center;margin-right:8px'>"
                 f"<span style='font:400 14px {FONT};color:#fff'>\u25a0</span></div>"
                 f"<div><div style='font:400 13px {FONT};color:{c['primary']}'>{label}</div>"
                 f"<div style='font:400 11px {FONT};color:{c['muted']}'>{cap}</div></div></div>")
    sidebar = (f"<div style='width:168px;background:{side_bg};padding:8px 8px 8px 12px;flex-shrink:0'>"
               f"<div style='font:700 13px {FONT};color:{c['secondary']}'>Devices</div>{vols}</div>")
    if view == "list":
        rows = (f"<div style='height:36px;display:flex;align-items:center;padding:0 4px'>"
                f"<span style='font:400 14px {FONT};color:{c['primary']}'>..</span></div>")
        for name, kind, size, mod in FILES_ENTRIES:
            sel = (name == "Notes.txt")
            bg = sel_bg if sel else "transparent"
            size_html = (f"<span style='width:80px;text-align:right;font:400 13px {FONT};color:{c['secondary']}'>"
                         f"{size if size else '\u2014'}</span>") if size is not None or kind == "folder" else ""
            mod_html = (f"<span style='width:96px;text-align:right;font:400 13px {FONT};color:{c['secondary']}'>"
                        f"{mod if mod else ''}</span>")
            rows += (f"<div style='height:36px;display:flex;align-items:center;background:{bg};"
                     f"border-radius:6px;padding:0 4px'>"
                     f"<div style='width:24px;height:24px;border-radius:6px;background:{DESKTOP_TILE_COLORS[kind]};"
                     f"display:flex;align-items:center;justify-content:center;margin-right:8px'>"
                     f"<span style='font:700 14px {FONT};color:#fff'>{name[0].upper()}</span></div>"
                     f"<span style='flex:1;font:400 14px {FONT};color:{c['primary']}'>{name}</span>"
                     f"{size_html}{mod_html}</div>")
        listing = (f"<div style='flex:1;background:{c['appbody']};padding:8px 12px'>{rows}</div>")
    else:
        cells = ""
        for name, kind, size, mod in FILES_ENTRIES:
            sel = (name == "Notes.txt")
            bg = sel_bg if sel else "transparent"
            cells += (f"<div style='width:96px;height:108px;border-radius:8px;background:{bg};"
                      f"display:flex;flex-direction:column;align-items:center;padding-top:8px'>"
                      f"<div style='width:64px;height:64px;border-radius:10px;background:{DESKTOP_TILE_COLORS[kind]};"
                      f"display:flex;align-items:center;justify-content:center'>"
                      f"<span style='font:700 28px {FONT};color:#fff'>{name[0].upper()}</span></div>"
                      f"<div style='font:400 13px {FONT};color:{c['primary']};margin-top:6px;text-align:center;"
                      f"line-height:1.2'>{name}</div></div>")
        listing = (f"<div style='flex:1;background:{c['appbody']};padding:12px;display:flex;"
                   f"flex-wrap:wrap;gap:12px;align-content:flex-start'>{cells}</div>")
    statusbar = (f"<div style='height:28px;background:{bar_bg};display:flex;align-items:center;padding:0 12px'>"
                 f"<span style='font:400 12px {FONT};color:{c['secondary']}'>Clipboard empty \u2014 Selected Notes.txt</span></div>")
    return (f"<div style='width:960px;border-radius:10px 10px 0 0;overflow:hidden;box-shadow:{shadow}'>"
            f"{header}{pathbar}{toolbar}"
            f"<div style='display:flex;height:416px'>{sidebar}{listing}</div>{statusbar}</div>")

def build_files(mode, view):
    c = DARK if mode == "dark" else LIGHT
    if view == "list":
        before = (f"<div style='width:960px'>"
                  f"<div style='height:36px;display:flex;align-items:center;background:#F9FAFB;border-radius:6px;padding:0 4px'>"
                  f"<div style='width:24px;height:24px;border-radius:6px;background:#F5A623;display:flex;align-items:center;justify-content:center;margin-right:8px'><span style='font:700 14px {FONT};color:#fff'>P</span></div>"
                  f"<span style='font:400 14px {FONT};color:#111827'>Photos</span></div>"
                  f"<div style='height:36px;display:flex;align-items:center;background:#DBEAFE;border-radius:6px;padding:0 4px'>"
                  f"<div style='width:24px;height:24px;border-radius:6px;background:#3B82F6;display:flex;align-items:center;justify-content:center;margin-right:8px'><span style='font:700 14px {FONT};color:#fff'>N</span></div>"
                  f"<span style='font:400 14px {FONT};color:#111827'>Notes.txt</span></div>"
                  f"<div style='height:36px;display:flex;align-items:center;background:#F9FAFB;border-radius:6px;padding:0 4px'>"
                  f"<div style='width:24px;height:24px;border-radius:6px;background:#F5A623;display:flex;align-items:center;justify-content:center;margin-right:8px'><span style='font:700 14px {FONT};color:#fff'>M</span></div>"
                  f"<span style='font:400 14px {FONT};color:#111827'>Music</span></div></div>"
                  f"<div style='font:400 13px {FONT};color:#6B7280;margin-top:10px'>Today: name only — no Size / Modified columns, no view toggle, selection is the blue #DBEAFE.</div>")
        before_label = "BEFORE — TODAY &nbsp;" + tag_gray("LIST ONLY, RE-RENDERED")
        after_cap = ("List view gains Size + Modified columns (right-aligned, 13 secondary) and the grid/list toggle "
                     "at the toolbar's right end. Selection is the accent tint now, not #DBEAFE.")
    else:
        before = (f"<div style='width:960px;height:120px;background:#F9FAFB;border-radius:8px;border:1px dashed #9CA3AF;"
                  f"display:flex;align-items:center;justify-content:center'>"
                  f"<span style='font:400 14px {FONT};color:#6B7280'>No grid view exists today — Files is list-only. "
                  f"(Files.tsx header: \u2018grid/list toggle\u2019 out of scope.)</span></div>")
        before_label = "BEFORE — TODAY &nbsp;" + tag_gray("NO GRID VIEW")
        after_cap = ("Grid view: 96\u00d7108 cells, 64px kind tiles, name below (2 lines max), 12px pitch. "
                     "Same entries, same selection, same toggle — the toggle is the only thing that changes the layout.")
    body = f"""
<div class="panel-label">{before_label}</div>
{before}
<div class="panel-label" style="margin-top:20px">AFTER — MANIFEST &nbsp;{tag("PROPOSAL")}</div>
{_files_window(mode, view)}
<div style="font:400 13px {FONT};color:#6B7280;margin-top:10px">{after_cap}</div>
"""
    return page(f"Files — {view} view, {mode} mode",
                "One toggle, two layouts \u00b7 the choice persists as a global setting",
                body, 1200, 900)

# --- tweak 4: SevynOS logo system menu ---

def system_menu(mode):
    """The system menu: standard menu geometry (220 wide, 28px rows,
    radius 8, padding 4) dropped under the SevynOS logo. Contents are
    only what exists today: System Settings (launches Settings),
    Restart, Shut Down — the power menu's two verbs, moved here."""
    c = DARK if mode == "dark" else LIGHT
    shadow = ("0 8px 24px rgba(0,0,0,0.35)" if mode == "dark" else "0 8px 24px rgba(0,0,0,0.15)")
    rows = ""
    for label in ("System Settings\u2026", None, "Restart", "Shut Down"):
        if label is None:
            rows += f"<div style='height:1px;background:{c['border']};margin:4px 0'></div>"
            continue
        rows += (f"<div style='display:flex;align-items:center;height:28px;border-radius:6px;"
                 f"padding:0 10px;'><span style='font:400 14px {FONT};color:{c['primary']}'>{label}</span></div>")
    return (f"<div style='width:220px;background:{c['surface']};border-radius:8px;padding:4px;"
            f"box-shadow:{shadow};border:1px solid {c['border']}'>{rows}</div>")

def build_system_menu(mode):
    inner = (f"<div style='position:relative;z-index:2'>{topbar(mode, height=32)}</div>"
             f"<div style='position:absolute;left:16px;top:40px;z-index:3'>{system_menu(mode)}</div>")
    strip = desktop_surface(mode, 960, 320, inner)
    body = f"""
<div class="panel-label">THE LOGO IS THE MENU &nbsp;{tag("PROPOSAL")}</div>
{strip}
<div style="font:400 13px {FONT};color:#6B7280;margin-top:10px">Clicking the SevynOS logo opens the system menu — the macOS Apple-menu model. Power actions live here now, not in the tray. Restart / Shut Down run the existing power verbs immediately, as the power menu does today. Sleep needs a suspend path (none in the tree — future). No Log Out: SevynOS has one account, no session to log out of.</div>
"""
    return page(f"System menu — {mode} mode",
                "Power leaves the top bar \u00b7 the SevynOS logo becomes the menu trigger",
                body, 1200, 640)

# --- tweak 5: Control Center panel ---

def _cc_slider(mode, pct, future=False):
    """A 4px track with an accent fill + 20px knob. Future rows render
    dimmed with a SOON tag instead of a live control."""
    c = DARK if mode == "dark" else LIGHT
    acc = ACCENTS["violet"][1] if mode == "dark" else ACCENTS["violet"][0]
    dim = "opacity:0.45;" if future else ""
    return (f"<div style='position:relative;height:20px;{dim}'>"
            f"<div style='position:absolute;left:0;right:0;top:8px;height:4px;border-radius:2px;background:{c['hover']}'></div>"
            f"<div style='position:absolute;left:0;top:8px;width:{pct}%;height:4px;border-radius:2px;background:{acc}'></div>"
            f"<div style='position:absolute;left:calc({pct}% - 10px);top:0;width:20px;height:20px;border-radius:10px;"
            f"background:{acc};box-shadow:0 1px 4px rgba(0,0,0,0.30)'></div></div>")

def _cc_toggle(mode, on=False, future=False):
    dim = "opacity:0.45;" if future else ""
    knob_left = "left:22px;" if on else "left:2px;"
    bg = ACCENTS["violet"][1] if (on and mode == "dark") else (ACCENTS["violet"][0] if on else "#6B7280")
    return (f"<div style='width:44px;height:24px;border-radius:12px;background:{bg};position:relative;{dim}'>"
            f"<div style='position:absolute;top:2px;{knob_left}width:20px;height:20px;border-radius:10px;"
            f"background:#ffffff'></div></div>")

def _cc_soon():
    return ("<span style='display:inline-block;background:#6B7280;color:#fff;font:700 10px " + FONT +
            ";padding:2px 6px;border-radius:4px;letter-spacing:0.06em'>SOON</span>")

def control_center_panel(mode):
    """320 wide, radius 12, surface fill — a panel, not a menu, so it
    takes the dialog shadow, not the menu width. Anchored under the
    control icon (top 40, right 16). Live rows: mode + volume.
    Future rows (no backend in the tree): brightness, Bluetooth."""
    c = DARK if mode == "dark" else LIGHT
    acc = ACCENTS["violet"][1] if mode == "dark" else ACCENTS["violet"][0]
    onfill = ACCENTS["violet"][4] if mode == "dark" else ACCENTS["violet"][3]
    shadow = ("0 12px 32px rgba(0,0,0,0.45)" if mode == "dark" else "0 12px 32px rgba(0,0,0,0.18)")
    seg = ""
    for m in ("Light", "Dark"):
        active = (m.lower() == mode)
        bg = acc if active else "transparent"
        fg = onfill if active else c["secondary"]
        seg += (f"<div style='flex:1;height:32px;border-radius:6px;background:{bg};display:flex;"
                f"align-items:center;justify-content:center'>"
                f"<span style='font:700 13px {FONT};color:{fg}'>{m}</span></div>")
    def label_row(label, right):
        return (f"<div style='display:flex;align-items:center;justify-content:space-between;margin-bottom:6px'>"
                f"<span style='font:400 13px {FONT};color:{c['primary']}'>{label}</span>{right}</div>")
    vol_value = (f"<span style='font:400 13px {FONT};color:{c['secondary']}'>50%</span>")
    return (f"<div style='width:320px;background:{c['surface']};border-radius:12px;padding:12px;"
            f"box-shadow:{shadow};border:1px solid {c['border']}'>"
            f"<div style='font:700 11px {FONT};letter-spacing:0.08em;color:{c['muted']};margin-bottom:8px'>APPEARANCE</div>"
            f"<div style='display:flex;background:{c['sunken']};border-radius:8px;padding:4px'>{seg}</div>"
            f"<div style='margin-top:14px'>{label_row('Volume', vol_value)}"
            f"{_cc_slider(mode, 50)}</div>"
            f"<div style='margin-top:14px'>{label_row('Brightness', _cc_soon())}"
            f"{_cc_slider(mode, 70, future=True)}</div>"
            f"<div style='display:flex;align-items:center;justify-content:space-between;height:44px;margin-top:10px'>"
            f"<span style='font:400 14px {FONT};color:{c['primary']}'>Wi-Fi</span>"
            f"<span style='font:400 13px {FONT};color:{c['secondary']}'>Connected</span></div>"
            f"<div style='display:flex;align-items:center;justify-content:space-between;height:44px'>"
            f"<span style='font:400 14px {FONT};color:{c['primary']}'>Bluetooth</span>"
            f"<span style='display:flex;align-items:center;gap:8px'>{_cc_soon()}{_cc_toggle(mode, on=False, future=True)}</span></div>"
            f"</div>")

def build_control_center(mode):
    dock_tiles = "".join(
        "<div style='width:48px;height:48px;border-radius:11px;background:" + col + "'></div>"
        for col in ['#3B82F6', '#8B5CF6', '#EF4444', '#10B981', '#F59E0B', '#0EA5A5'])
    inner = (f"<div style='position:relative;z-index:2'>{topbar(mode, height=32)}</div>"
             f"<div style='position:absolute;right:16px;top:40px;z-index:3'>{control_center_panel(mode)}</div>"
             f"<div style=\"position:absolute;left:50%;bottom:16px;transform:translateX(-50%);display:flex;gap:8px;background:rgba(255,255,255,0.12);border-radius:24px;padding:8px\">"
             f"{dock_tiles}"
             f"</div>")
    desk = desktop_surface(mode, 1280, 800, inner)
    return (f"<!DOCTYPE html><html><head><meta charset='utf-8'><style>"
            f"*{{box-sizing:border-box;margin:0;padding:0}}html,body{{width:1280px;height:800px;overflow:hidden;font-family:{FONT}}}</style></head>"
            f"<body>{desk}</body></html>")

def build_contact_sheet():
    names = [("Windows", "mockup-windows-dark.png", "mockup-windows-light.png"),
             ("Top bar", "mockup-topbar-dark.png", "mockup-topbar-light.png"),
             ("Popup menu", "mockup-menu-dark.png", "mockup-menu-light.png"),
             ("Dialogs", "mockup-dialog-dark.png", "mockup-dialog-light.png"),
             ("Desktop icons", "mockup-desktop-icons-dark.png", "mockup-desktop-icons-light.png"),
             ("Files — list", "mockup-files-list-dark.png", "mockup-files-list-light.png"),
             ("Files — grid", "mockup-files-grid-dark.png", "mockup-files-grid-light.png"),
             ("System menu", "mockup-system-menu-dark.png", "mockup-system-menu-light.png"),
             ("Control Center", "mockup-control-center-dark.png", "mockup-control-center-light.png")]
    W = 580
    font_title = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 22)
    font_label = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 15)
    font_small = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 12)
    thumbs = []
    for title, d, l in names:
        row = []
        for f in (d, l):
            im = Image.open(os.path.join(MOCK, f)).convert("RGB")
            w, h = im.size
            im = im.resize((W, int(h * W / w)), Image.LANCZOS)
            row.append(im)
        thumbs.append((title, row))
    label_h, gap, pad = 34, 16, 24
    col_w = W
    total_w = pad * 2 + col_w * 2 + gap
    heights = [max(r[0].size[1], r[1].size[1]) for _, r in thumbs]
    total_h = pad + 52 + sum(h + label_h + gap for h in heights) + pad
    sheet = Image.new("RGB", (total_w, total_h), "#E8E8EC")
    dr = ImageDraw.Draw(sheet)
    dr.text((pad, pad + 6), "SevynOS Layout Manifest — contact sheet", font=font_title, fill="#14141A")
    dr.text((pad, pad + 34), "Nine surfaces \u00d7 two modes \u00b7 windows \u00b7 top bar \u00b7 popup menus \u00b7 dialogs \u00b7 desktop icons \u00b7 files \u00b7 system menu \u00b7 control center",
            font=font_small, fill="#6B7280")
    y = pad + 52
    for (title, row), h in zip(thumbs, heights):
        for ci, im in enumerate(row):
            x = pad + ci * (col_w + gap)
            mode = "DARK" if ci == 0 else "LIGHT"
            dr.text((x, y), f"{title} — {mode}", font=font_label, fill="#14141A")
            sheet.paste(im, (x, y + label_h))
        y += h + label_h + gap
    out = os.path.join(MOCK, "contact-sheet.png")
    sheet.save(out)
    print("OK contact-sheet.png", sheet.size)

def main():
    jobs = [
        ("mockup-windows-dark", build_windows("dark"), 1200, 600),
        ("mockup-windows-light", build_windows("light"), 1200, 600),
        ("mockup-topbar-dark", build_topbar("dark"), 1200, 520),
        ("mockup-topbar-light", build_topbar("light"), 1200, 520),
        ("mockup-menu-dark", build_menu("dark"), 1200, 560),
        ("mockup-menu-light", build_menu("light"), 1200, 560),
        ("mockup-dialog-dark", build_dialog("dark"), 1200, 760),
        ("mockup-dialog-light", build_dialog("light"), 1200, 760),
        ("mockup-decision-controls", build_decision_controls(), 1200, 760),
        ("mockup-decision-topbar", build_decision_topbar(), 1200, 760),
        ("mockup-accent-strip", build_accent_strip(), 1280, 980),
        ("mockup-windows-coral-dark", build_windows_coral_dark(), 1200, 560),
        ("mockup-wallpaper-dark", build_wallpaper("dark"), 1280, 800),
        ("mockup-wallpaper-light", build_wallpaper("light"), 1280, 800),
        ("mockup-desktop-icons-dark", build_desktop_icons("dark"), 1200, 980),
        ("mockup-desktop-icons-light", build_desktop_icons("light"), 1200, 980),
        ("mockup-files-list-dark", build_files("dark", "list"), 1200, 900),
        ("mockup-files-list-light", build_files("light", "list"), 1200, 900),
        ("mockup-files-grid-dark", build_files("dark", "grid"), 1200, 900),
        ("mockup-files-grid-light", build_files("light", "grid"), 1200, 900),
        ("mockup-system-menu-dark", build_system_menu("dark"), 1200, 640),
        ("mockup-system-menu-light", build_system_menu("light"), 1200, 640),
        ("mockup-control-center-dark", build_control_center("dark"), 1280, 800),
        ("mockup-control-center-light", build_control_center("light"), 1280, 800),
    ]
    for name, html, w, h in jobs:
        write_page(name, html, w, h)
    build_contact_sheet()
    print("DONE")

if __name__ == "__main__":
    main()
