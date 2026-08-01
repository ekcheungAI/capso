#!/usr/bin/env python3
"""Build Capso's icon set from the hand-drawn SVG mark.

Single source of truth is capso-lid.svg — the capsule lid seen from above. The
two lockups and every PNG, .ico and .icns below are composed or rendered from it,
so the geometry can never drift between sizes. Re-run this after editing the SVG.

    python3 drafts/brand/mark/build_icons.py

Plate is bone, mark is ink — there is no accent colour in this brand. Bone is
also the right choice for a browser tab specifically: an ink plate would sit at
almost exactly the luminance of Chrome's dark tab strip and vanish into it,
whereas a dark glyph on a light plate is the higher-contrast direction at 16px
and survives both light and dark chrome.

Rasterisation goes through headless Chrome because it is the only SVG renderer
present on this machine (no rsvg-convert, cairosvg, ImageMagick or Inkscape).
Pillow handles .ico packing; iconutil handles .icns.
"""
import json
import re
import shutil
import struct
import subprocess
import sys
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
OUT = HERE / "out"
CHROME = Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")

# Read from the same file the apps do. Hard-coding these was how the icon set
# ended up a palette behind the product last time.
TOKENS = json.loads((HERE / "../tokens.generated.json").resolve().read_text())
BONE = TOKENS["color"]["light"]["background"]
INK = TOKENS["color"]["light"]["foreground"]

# Plate geometry, in a 1024 canvas.
#   web  — full bleed; a favicon has no pixels to waste
#   mac  — Apple leaves ~10% margin around an 824 squircle
WEB_BOX, WEB_R = 950, 228          # mark viewBox scale, plate corner radius
MAC_PLATE, MAC_PLATE_R = 824, 185
MAC_BOX = 680


def lid_inner(uid: str = "") -> str:
    """Pull the mask and drawing group out of the canonical lid.

    The mask id has to be namespaced per instance: two copies sharing one id in
    a single document silently resolve to the first, which drops the notch.
    """
    src = (HERE / "capso-lid.svg").read_text()
    src = re.sub(r"<!--.*?-->", "", src, flags=re.S)
    body = src[src.index(">", src.index("<svg")) + 1: src.rindex("</svg>")]
    if uid:
        body = (body.replace('id="capso-notch"', f'id="cn{uid}"')
                    .replace("url(#capso-notch)", f"url(#cn{uid})"))
    return body.strip()


def lockup(kind: str) -> str:
    if kind == "web":
        scale = WEB_BOX / 24
        off = (1024 - WEB_BOX) / 2
        plate = f'<rect x="0" y="0" width="1024" height="1024" rx="{WEB_R}" fill="{BONE}"/>'
    elif kind == "mac":
        scale = MAC_BOX / 24
        off = (1024 - MAC_BOX) / 2
        p = (1024 - MAC_PLATE) / 2
        plate = (f'<rect x="{p}" y="{p}" width="{MAC_PLATE}" height="{MAC_PLATE}" '
                 f'rx="{MAC_PLATE_R}" fill="{BONE}"/>')
    else:
        raise ValueError(kind)
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024" role="img" aria-label="Capso">
{plate}
<g transform="translate({off:g},{off:g}) scale({scale:g})" color="{INK}">
{lid_inner(kind)}
</g>
</svg>
"""


def tray_svg() -> str:
    """macOS menu-bar template: pure black + alpha, the system recolours it."""
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" role="img" aria-label="Capso">
<g color="#000000">
{lid_inner("tray")}
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


def ico_frames(path: Path) -> list[tuple[int, int]]:
    """Read an .ico's directory table directly, without decoding the images.

    Pillow reports only a deduplicated `info["sizes"]`, which hides duplicate
    frames — exactly the failure this guards against.
    """
    d = path.read_bytes()
    count = struct.unpack("<H", d[4:6])[0]
    out = []
    for i in range(count):
        e = d[6 + i * 16: 22 + i * 16]
        out.append((e[0] or 256, e[1] or 256))
    return out


def pack_ico(dest: Path, sizes: list[int]) -> None:
    """Pack an .ico from one natively-rendered PNG per size.

    Pillow 12.2's ICO writer cannot be trusted to resize for us, and passing a
    single base image plus `append_images` silently corrupts the output. Two
    separate faults in IcoImagePlugin._save combine:

      1. The `for provided_im in provided_ims: ... else:` block reuses the loop
         variable after it has fallen through, so a size with no exact match is
         resized from the LAST provided image rather than the base one. Append a
         16px master and every other size is built from that 16px master.
      2. That resize is `frame.thumbnail(size)`, which never upscales — so the
         frames come out 16x16 regardless of what was asked for.

    Together they produced a Tauri icon.ico containing seven 16x16 frames. The
    fix is to give the writer an exact-size image for every requested size so
    the buggy branch is unreachable, then assert the directory table.
    """
    imgs = {s: Image.open(OUT / f"icon-{s}.png").convert("RGBA") for s in sizes}
    for s, im in imgs.items():
        assert im.size == (s, s), f"icon-{s}.png is {im.size}"
    base = imgs[max(sizes)]
    base.save(dest, format="ICO", sizes=[(s, s) for s in sizes],
              append_images=[imgs[s] for s in sizes])

    got = ico_frames(dest)
    want = [(s, s) for s in sorted(sizes)]
    assert got == want, f"{dest.name}: packed {got}, wanted {want}"

    # The 16px frame must be the hinted master byte-for-byte, not a downscale.
    with Image.open(dest) as ico:
        ico.size = (16, 16)
        ico.load()
        a = list(ico.convert("RGBA").getdata())
    b = list(imgs[16].getdata())
    assert a == b, f"{dest.name}: 16px frame is not the hinted master"
    print(f"  {dest.name}: {len(got)} frames {[s for s, _ in got]}, 16px hinted")


def qa_sheet() -> None:
    """Small-size proof sheet: every icon at 1x beside a 12x pixelated blow-up.

    The 16px row is the one that matters — it is the only size drawn on its own
    grid, and the sheet is how we check the hinted master still beats a
    downscale rather than assuming it does.
    """
    rows = [16, 32, 48, 128]
    pad, gap, zoom = 24, 20, 12
    w = pad * 2 + 128 + gap + 16 * zoom
    h = pad * 2 + sum(max(s, 16 * zoom) for s in rows) + gap * (len(rows) - 1)
    sheet = Image.new("RGB", (w, h), BONE)
    y = pad
    for s in rows:
        one = Image.open(OUT / f"icon-{s}.png").convert("RGBA")
        big = one.resize((16 * zoom, 16 * zoom), Image.NEAREST)
        band = max(s, 16 * zoom)
        sheet.paste(one, (pad, y + (band - s) // 2), one)
        sheet.paste(big, (pad + 128 + gap, y), big)
        y += band + gap
    sheet.save(OUT / "icon-qa-sheet.png")


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

    # --- web + extension ------------------------------------------------
    # Every size Chrome can draw natively, it should: rendering the SVG at the
    # target size beats resampling a larger raster, and it is also what keeps
    # the .ico packing below honest (see pack_ico).
    for s in (24, 32, 48, 64, 128, 180, 192, 256, 512, 1024):
        render(web, OUT / f"icon-{s}.png", s)

    # 16px comes from its own hinted master — see capso-icon-16.svg for why.
    render(HERE / "capso-icon-16.svg", OUT / "icon-16.png", 16)

    pack_ico(OUT / "favicon.ico", [16, 32, 48])
    # Tauri .ico wants the larger set Windows actually asks for
    pack_ico(OUT / "icon.ico", [16, 24, 32, 48, 64, 128, 256])

    # --- macOS .icns ----------------------------------------------------
    iconset = OUT / "capso.iconset"
    if iconset.exists():
        shutil.rmtree(iconset)
    iconset.mkdir()
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

    # --- menu-bar template ----------------------------------------------
    for px, name in [(22, "trayTemplate.png"), (44, "trayTemplate@2x.png")]:
        render(tray, OUT / name, px)

    qa_sheet()

    (OUT / "_shot.html").unlink(missing_ok=True)
    for stray in OUT.glob("capso-*.svg"):
        stray.unlink()
    shutil.rmtree(iconset)

    print(f"\nwrote {len(list(OUT.glob('*')))} files to {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
