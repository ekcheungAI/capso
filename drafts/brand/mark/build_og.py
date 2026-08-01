#!/usr/bin/env python3
"""Compose the Capso OG / share card (1200x630).

The card is generated procedurally rather than by an image model, following the
same deterministic-SVG approach already used in apps/web/lib/store/placeholder.ts:
a hue-seeded arrangement of fake screenshot cards. That keeps the brand mark
pixel-exact and the output reproducible.

The scattered-card background was originally going to come from gpt-image-2 via
the imagegen skill; that call is currently blocked by the sandbox classifier.
Swap `backdrop()` for the generated plate if that gets approved.

    python3 drafts/brand/mark/build_og.py
"""
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
OUT = HERE / "out"
CHROME = Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")

W, H = 1200, 630
BG, INK, MUTED, ACCENT, SURFACE = "#fafaf8", "#141412", "#6b6a64", "#e8683a", "#ffffff"
SF = "/System/Library/Fonts/SFNS.ttf"


def font(size: int, weight: int = 400) -> ImageFont.FreeTypeFont:
    f = ImageFont.truetype(SF, size)
    try:  # SFNS is variable; set the weight axis where Pillow supports it
        f.set_variation_by_axes([weight])
    except Exception:
        pass
    return f


def rounded(d: ImageDraw.ImageDraw, box, r, fill, outline=None, width=1) -> None:
    d.rounded_rectangle(box, radius=r, fill=fill, outline=outline, width=width)


def backdrop(img: Image.Image) -> None:
    """Scattered capture cards on the right, negative space on the left."""
    layer = Image.new("RGBA", (W * 2, H * 2), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    # (x, y, w, h, rotation, tinted)
    cards = [
        (1180, 120, 470, 330, -7, False),
        (1520, 330, 430, 300, 5, True),
        (1290, 560, 500, 350, -3, False),
        (1720, 90, 380, 270, 9, False),
    ]
    for x, y, w, h, rot, tint in cards:
        c = Image.new("RGBA", (w + 60, h + 60), (0, 0, 0, 0))
        cd = ImageDraw.Draw(c)
        cd.rounded_rectangle([30, 30, 30 + w, 30 + h], radius=28,
                             fill=(20, 20, 18, 26))  # soft shadow
        c = c.filter(__import__("PIL.ImageFilter", fromlist=["ImageFilter"]).GaussianBlur(18))
        cd = ImageDraw.Draw(c)
        body = ACCENT if tint else SURFACE
        cd.rounded_rectangle([30, 30, 30 + w, 30 + h], radius=24, fill=body,
                             outline=(20, 20, 18, 26), width=2)
        # a few content bars so it reads as a screenshot, not a blank rectangle
        bar = (250, 250, 248, 200) if tint else (20, 20, 18, 30)
        cd.rounded_rectangle([64, 70, 64 + int(w * 0.34), 92], radius=11, fill=bar)
        for i, frac in enumerate((0.62, 0.44, 0.54)):
            yy = 126 + i * 34
            cd.rounded_rectangle([64, yy, 64 + int(w * frac), yy + 16], radius=8, fill=bar)
        cd.rounded_rectangle([64, h - 40, 64 + 130, h - 4], radius=18,
                             fill=(250, 250, 248, 220) if tint else (232, 104, 58, 190))
        c = c.rotate(rot, resample=Image.BICUBIC, expand=True)
        layer.alpha_composite(c, (x, y))
    img.alpha_composite(layer.resize((W, H), Image.LANCZOS))


def mark(size: int) -> Image.Image:
    """Render the real icon at size, straight from the SVG source."""
    png = OUT / f"_og_mark_{size}.png"
    html = OUT / "_og.html"
    svg = HERE / "capso-icon-web.svg"
    html.write_text(
        f'<style>html,body{{margin:0;background:transparent}}'
        f'img{{display:block;width:{size}px;height:{size}px}}</style>'
        f'<img src="{svg.name}">'
    )
    import shutil
    shutil.copy(svg, OUT / svg.name)
    subprocess.run(
        [str(CHROME), "--headless", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
         f"--screenshot={png}", f"--window-size={size},{size}",
         "--default-background-color=00000000", f"file://{html}"],
        check=True, capture_output=True,
    )
    im = Image.open(png).convert("RGBA")
    png.unlink(missing_ok=True)
    html.unlink(missing_ok=True)
    (OUT / svg.name).unlink(missing_ok=True)
    return im


def main() -> int:
    OUT.mkdir(exist_ok=True)
    img = Image.new("RGBA", (W, H), BG)
    backdrop(img)

    # Left column gets a soft wash so type stays legible over any stray card.
    wash = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(wash).rectangle([0, 0, 700, H], fill=(250, 250, 248, 216))
    img.alpha_composite(wash)

    d = ImageDraw.Draw(img)
    m = mark(84)
    img.alpha_composite(m, (80, 92))
    d.text((184, 116), "Capso", font=font(58, 640), fill=INK)

    d.text((80, 248), "Everything you capture", font=font(60, 600), fill=INK)
    d.text((80, 318), "becomes a capsule.", font=font(60, 600), fill=ACCENT)

    d.text((80, 416), "Screenshot memory — capture, organise, retrieve.",
           font=font(27, 400), fill=MUTED)

    d.line([80, 496, 132, 496], fill=ACCENT, width=3)
    d.text((80, 520), "⌃⇧C  ·  every screenshot, searchable by a sentence",
           font=font(22, 400), fill=MUTED)

    out = OUT / "og-image.png"
    img.convert("RGB").save(out, quality=95)
    print(f"wrote {out} ({out.stat().st_size:,} bytes, {W}x{H})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
