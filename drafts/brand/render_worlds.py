#!/usr/bin/env python3
"""Render the six colour worlds as standalone 2x PNGs for inline viewing.

    python3 drafts/brand/render_worlds.py

Reuses the mock and palette definitions from build_options.py so the images can
never disagree with the board. One PNG per pair of worlds, rendered at
device-scale 2 so the small type in the mock is actually legible.
"""
import subprocess
from pathlib import Path

import build_options as B

ROOT = B.ROOT
OUT = ROOT / "renders-worlds"
OUT.mkdir(exist_ok=True)
CHROME = Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")

W = 1160
PAGE = """<title>worlds</title>
<style>
*{{box-sizing:border-box}}
body{{margin:0;background:#efece6;padding:26px;width:%dpx;
  font:15px/1.6 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;color:#1f1f1e;
  -webkit-font-smoothing:antialiased}}
.row{{display:grid;grid-template-columns:1fr 1fr;gap:26px}}
h3{{font-size:17px;font-weight:600;margin:14px 0 6px}}
.hex{{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px}}
.hex code{{font:11px ui-monospace,Menlo,monospace;color:#6f6a62;
  border:1px solid rgb(31 31 30/.16);border-radius:5px;padding:1px 6px}}
.note{{font-size:13px;color:#6f6a62;margin:0;line-height:1.5}}
.frame{{border:1px solid rgb(31 31 30/.16);border-radius:14px;overflow:hidden}}
%s
</style>
%s
""" % (W, "", "")

# pull the mock CSS straight out of the board so the two cannot drift
_css = B.HTML[B.HTML.index("/* ---- the mock ---- */"):B.HTML.index("/* ---- type specimens ---- */")]
MOCK_CSS = _css.replace("{{", "{").replace("}}", "}")


def block(w) -> str:
    key, name, bg, su, ink, mu, ac, note = w
    line = f"rgb({int(ink[1:3],16)} {int(ink[3:5],16)} {int(ink[5:7],16)} / .12)"
    hexes = "".join(f"<code>{h}</code>" for h in [bg, su, ink, mu] + ([ac] if ac else []))
    return (f'<div><div class="frame" style="--bg:{bg};--su:{su};--ink:{ink};--mu:{mu};'
            f'--line:{line};--btnink:{bg}">{B.app_mock(key, ink, ac)}</div>'
            f'<h3>{name}</h3><div class="hex">{hexes}</div>'
            f'<p class="note">{note}</p></div>')


def main() -> int:
    pairs = [B.WORLDS[0:2], B.WORLDS[2:4], B.WORLDS[4:6]]
    for i, pair in enumerate(pairs, 1):
        body = f'<div class="row">{"".join(block(w) for w in pair)}</div>'
        html = (f"<title>worlds {i}</title><style>*{{box-sizing:border-box}}"
                f"body{{margin:0;background:#efece6;padding:26px;width:{W}px;"
                f"font:15px/1.6 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;"
                f"color:#1f1f1e;-webkit-font-smoothing:antialiased}}"
                f".row{{display:grid;grid-template-columns:1fr 1fr;gap:26px}}"
                f"h3{{font-size:17px;font-weight:600;margin:14px 0 6px}}"
                f".hex{{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px}}"
                f".hex code{{font:11px ui-monospace,Menlo,monospace;color:#6f6a62;"
                f"border:1px solid rgb(31 31 30/.16);border-radius:5px;padding:1px 6px}}"
                f".note{{font-size:13px;color:#6f6a62;margin:0;line-height:1.5}}"
                f".frame{{border:1px solid rgb(31 31 30/.16);border-radius:14px;overflow:hidden}}"
                f"{MOCK_CSS}</style>{body}")
        page = OUT / f"_w{i}.html"
        page.write_text(html)
        png = OUT / f"worlds-{i}.png"
        subprocess.run(
            [str(CHROME), "--headless", "--disable-gpu", "--hide-scrollbars",
             "--force-device-scale-factor=2", "--virtual-time-budget=4000",
             f"--screenshot={png}", f"--window-size={W},520", f"file://{page}"],
            check=True, capture_output=True)
        page.unlink()
        # trim the unused window height rather than shipping dead space
        from PIL import Image, ImageChops
        im = Image.open(png).convert("RGB")
        bb = ImageChops.difference(im, Image.new("RGB", im.size, im.getpixel((2, 2)))).convert("L").getbbox()
        pad = 52  # the 26px body padding at 2x
        im.crop((0, 0, im.width, min(im.height, bb[3] + pad))).save(png)
        print(f"wrote {png.name} {Image.open(png).size}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
