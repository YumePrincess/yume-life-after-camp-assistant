#!/usr/bin/env python3
"""Compose the branded, deterministic overlay on the generated glass art."""

from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
OUT = Path(__import__("sys").argv[1])
SIZE = (900, 560)


def font(size: int, bold: bool = False):
    candidates = [
        "/System/Library/Fonts/SFNS.ttf" if not bold else "/System/Library/Fonts/SFNSBold.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
    ]
    for candidate in candidates:
        try:
            return ImageFont.truetype(candidate, size=size)
        except OSError:
            pass
    return ImageFont.load_default()


base = Image.open(ROOT / "DMGBackgroundBase.png").convert("RGBA")
ratio = max(SIZE[0] / base.width, SIZE[1] / base.height)
resized = base.resize((round(base.width * ratio), round(base.height * ratio)), Image.Resampling.LANCZOS)
left = (resized.width - SIZE[0]) // 2
top = (resized.height - SIZE[1]) // 2
canvas = resized.crop((left, top, left + SIZE[0], top + SIZE[1]))

glass = Image.new("RGBA", SIZE, (0, 0, 0, 0))
draw = ImageDraw.Draw(glass)
draw.rounded_rectangle((42, 28, 858, 132), radius=30, fill=(4, 18, 24, 178), outline=(255, 255, 255, 48), width=2)
draw.rounded_rectangle((55, 168, 845, 500), radius=38, fill=(2, 14, 20, 82), outline=(255, 255, 255, 32), width=2)
glass = glass.filter(ImageFilter.GaussianBlur(0.25))
canvas.alpha_composite(glass)

logo = Image.open(ROOT / "BrandLogo.png").convert("RGBA")
logo.thumbnail((82, 82), Image.Resampling.LANCZOS)
canvas.alpha_composite(logo, (72, 38))

draw = ImageDraw.Draw(canvas)
draw.text((174, 52), "Yume Life After Mac Agent", font=font(28, True), fill=(248, 249, 246, 255))
draw.text((176, 91), "Yume Internet LLC.", font=font(16, False), fill=(229, 176, 91, 255))

# Direction cue remains language-neutral; Finder places the App and Applications
# icons at either side of it.
gold = (232, 181, 92, 225)
draw.line((382, 338, 518, 338), fill=gold, width=5)
draw.polygon(((518, 338), (496, 323), (496, 353)), fill=gold)
draw.ellipse((443, 321, 477, 355), outline=(255, 255, 255, 70), width=2)
draw.text((450, 463), "DRAG TO INSTALL", anchor="mm", font=font(14, True), fill=(235, 238, 236, 190))
draw.text((450, 528), "Copyright © 2026 Yume Internet LLC.", anchor="mm", font=font(12), fill=(225, 230, 228, 150))

OUT.parent.mkdir(parents=True, exist_ok=True)
canvas.convert("RGB").save(OUT, quality=95)

