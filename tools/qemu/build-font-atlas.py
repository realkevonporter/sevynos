#!/usr/bin/env python3
import base64
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: build-font-atlas.py OUTPUT")
    output = Path(sys.argv[1])
    font_candidates = (
        Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
        Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
    )
    font_path = next((path for path in font_candidates if path.exists()), None)
    if font_path is None:
        raise SystemExit("DejaVu Sans was not found")
    characters = "".join(chr(code) for code in range(32, 127))
    characters += "•…→←↑↓×·—–✓●○◇⌂⟳◀▶⚡⚙▌📁🏷🗑✨🌐⌨➕➖"
    atlas: dict[str, object] = {"family": "DejaVu Sans", "sizes": {}}
    sizes: dict[str, object] = atlas["sizes"]  # type: ignore[assignment]
    for size in range(8, 33):
        font = ImageFont.truetype(str(font_path), size=size)
        ascent, descent = font.getmetrics()
        glyphs: dict[str, object] = {}
        for character in characters:
            left, top, right, bottom = font.getbbox(character, anchor="ls")
            width = max(1, right - left)
            height = max(1, bottom - top)
            image = Image.new("L", (width, height), 0)
            ImageDraw.Draw(image).text((-left, -top), character, font=font, fill=255, anchor="ls")
            glyphs[character] = {
                "advance": round(font.getlength(character), 3),
                "left": left,
                "top": top,
                "width": width,
                "height": height,
                "alpha": base64.b64encode(image.tobytes()).decode("ascii"),
            }
        sizes[str(size)] = {
            "ascent": ascent,
            "descent": descent,
            "glyphs": glyphs,
        }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(atlas, separators=(",", ":")), encoding="utf-8")


if __name__ == "__main__":
    main()
