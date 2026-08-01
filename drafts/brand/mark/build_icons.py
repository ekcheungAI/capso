#!/usr/bin/env python3
"""Build Capso's icon set from the hand-drawn SVG mark.

Single source of truth is capso-silhouette.svg. The two lockups and every PNG,
.ico and .icns below are composed or rendered from it, so the geometry can never
drift between sizes. Re-run this after editing the SVG.

    python3 drafts/brand/mark/build_icons.py

Rasterisation goes through headless Chrome because it is the only SVG renderer
present on this machine (no rsvg-convert, cairosvg, ImageMagick or Inkscape).
Pillow handles .ico packing; iconutil handles .icns.
"""
import re
import shutil
import subprocess
import sys
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
OUT = HERE / "out"
CHROME = Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")

ACCENT = "#e8683a"
CREAM = "#fafaf8"
INK = "#141412"

# Plate geometry, in a 1024 canvas.
#   web  — full bleed; a favicon has no pixels to waste
#   mac  — Apple leaves ~10% margin around an 824 squircle
WEB_BOX, WEB_R = 840, 228          # mark viewBox scale, plate corner radius
MAC_PLATE, MAC_PLATE_R = 824, 185
MAC_BOX = 680


def silhouette_inner() -> str:
    """Pull the <defs> and drawing group out of the canonical silhouette."""
    src = (HERE / "capso-silhouette.svg").read_text()
    body = src[src.index(">", src.index("<svg")) + 1: src.rindex("</svg>")]
    # Namespace the ids so two copies can coexist in one document if needed.
    return body.strip()


def lockup(kind: str) -> str:
    inner = silhouette_inner()
    if kind == "web":
        scale = WEB_BOX / 24
        off = (1024 - WEB_BOX) / 2
        plate = (f'<rect x="0" y="0" width="1024" height="1024" rx="{WEB_R}" fill="{ACCENT}"/>')
    elif kind == "mac":
        scale = MAC_BOX / 24
        off = (1024 - MAC_BOX) / 2
        p = (1024 - MAC_PLATE) / 2
        plate = (f'<rect x="{p}" y="{p}" width="{MAC_PLATE}" height="{MAC_PLATE}" '
                 f'rx="{MAC_PLATE_R}" fill="{ACCENT}"/>')
    else:
        raise ValueError(kind)
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024" role="img" aria-label="Capso">
{plate}
<g transform="translate({off:g},{off:g}) scale({scale:g})" color="{CREAM}">
{inner}
</g>
</svg>
"""


def tray_svg() -> str:
    """macOS menu-bar template: pure black + alpha, the system recolours it."""
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" role="img" aria-label="Capso">
<g color="#000000">
{silhouette_inner()}
</g>
</svg>
"""


def render(svg_path: Path, png_path: Path, size: int) -> None:
    """Rasterise one SVG at one size via headless Chrome, transparent background."""
    html = OUT / "_shot.html"
    html.write_text(
        f'<style>html,body{{margin:0;padding:0;background:transparent}}'
        f'img{{display:block;width:{size}px;height:{size}px}}</style>'
        f'<img src="{svg_path.name}">'
    )
    shutil.copy(svg_path, OUT / svg_path.name)
    subprocess.run(
        [str(CHROME), "--headless", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
         f"--screenshot={png_path}", f"--window-size={size},{size}",
         "--default-background-color=00000000", "--force-device-scale-factor=1",
         f"file://{html}"],
        check=True, capture_output=True,
    )


def main() -> int:
    if not CHROME.exists():
        print(f"error: Chrome not found at {CHROME}", file=sys.stderr)
        return 1
    OUT.mkdir(exist_ok=True)

    web = HERE / "capso-icon-web.svg"
    mac = HERE / "capso-icon-mac.svg"
    tray = HERE / "capso-tray.svg"
    web.write_text(lockup("web"))
    mac.write_text(lockup("mac"))
    tray.write_text(tray_svg())
    print("composed lockups: capso-icon-web.svg, capso-icon-mac.svg, capso-tray.svg")

    made: list[tuple[str, int]] = []

    # --- web + extension ------------------------------------------------
    for s in (32, 48, 128, 180, 192, 512, 1024):
        render(web, OUT / f"icon-{s}.png", s)
        made.append((f"icon-{s}.png", s))

    # 16px comes from its own hinted master — see capso-icon-16.svg for why.
    render(HERE / "capso-icon-16.svg", OUT / "icon-16.png", 16)
    made.append(("icon-16.png", 16))

    # favicon.ico — 16/32/48. append_images carries the hinted 16px master
    # through verbatim; letting Pillow downscale it from 48 would throw the
    # pixel hinting away, which is the whole point of that file.
    hinted16 = Image.open(OUT / "icon-16.png")
    Image.open(OUT / "icon-48.png").save(
        OUT / "favicon.ico", format="ICO",
        sizes=[(16, 16), (32, 32), (48, 48)],
        append_images=[hinted16],
    )

    # Tauri .ico wants the larger set Windows actually asks for
    Image.open(OUT / "icon-512.png").save(
        OUT / "icon.ico", format="ICO",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
        append_images=[hinted16],
    )

    # --- macOS .icns ----------------------------------------------------
    iconset = OUT / "capso.iconset"
    if iconset.exists():
        shutil.rmtree(iconset)
    iconset.mkdir()
    # (px, filename) pairs iconutil expects
    for px, name in [
        (16, "icon_16x16.png"), (32, "icon_16x16@2x.png"),
        (32, "icon_32x32.png"), (64, "icon_32x32@2x.png"),
        (128, "icon_128x128.png"), (256, "icon_128x128@2x.png"),
        (256, "icon_256x256.png"), (512, "icon_256x256@2x.png"),
        (512, "icon_512x512.png"), (1024, "icon_512x512@2x.png"),
    ]:
        render(mac, iconset / name, px)
    subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(OUT / "icon.icns")],
                   check=True)

    # Tauri's bundle.icon list
    for px, name in [(32, "32x32.png"), (128, "128x128.png"), (256, "128x128@2x.png")]:
        render(mac, OUT / name, px)
        made.append((name, px))

    # --- menu-bar template ----------------------------------------------
    for px, name in [(22, "trayTemplate.png"), (44, "trayTemplate@2x.png")]:
        render(tray, OUT / name, px)
        made.append((name, px))

    (OUT / "_shot.html").unlink(missing_ok=True)
    for stray in OUT.glob("capso-*.svg"):
        stray.unlink()
    shutil.rmtree(iconset)

    print(f"\nwrote {len(list(OUT.glob('*')))} files to {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
