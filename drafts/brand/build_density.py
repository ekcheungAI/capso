#!/usr/bin/env python3
"""How does each ground hold up under a real screenful of captures?

    python3 drafts/brand/build_density.py

The colour board cheated. Its three capture cards were 13%-tint pastel washes,
which flatter every ground equally. Real captures are not that: they are white
docs, near-black editors, saturated marketing pages and photographs, all in one
grid.

So this builds twelve synthetic captures spanning that actual distribution,
fills a full home screen with them, and renders it on each candidate ground.
Then it measures two things that matter and cannot be judged by eye:

  1. Ground / white separation. Most captures are white-ish. If the ground is
     also white-ish, the card edge disappears and the grid becomes one sheet.
  2. Where the colour on screen actually comes from. Counts chromatic pixels
     inside the capture area versus in the interface chrome.
"""
import subprocess
from pathlib import Path

from PIL import Image

ROOT = Path("/Users/ek/Desktop/ekOS/20_projects/Capso/drafts/brand")
OUT = ROOT / "renders-density"
TILES = OUT / "tiles"
CHROME = Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")

# last field is the chrome accent — what the interface itself is allowed to colour.
GROUNDS = [
    ("bone", "Bone &amp; Ink", "#f4f0eb", "#faf8f4", "#1f1f1e", "#6f6a62", None),
    ("paper", "Paper &amp; Graphite", "#f4f4f2", "#fafafa", "#26262b", "#6c6c72", None),
    ("oat", "Oat &amp; Cocoa", "#f2ece1", "#f9f5ee", "#2b211a", "#736759", None),
    ("porcelain", "Porcelain &amp; Slate", "#f6f7f8", "#fdfdfe", "#1b222b", "#666e79", None),
    ("indigo", "Bone + one accent", "#f4f0eb", "#faf8f4", "#1f1f1e", "#6f6a62", "#3d4a8f"),
]

INTENTS = ["#4a6fa5", "#5b7a4b", "#8f5c80", "#6a5ba8", "#3e7a75", "#a8465c"]

TW, TH = 420, 300  # tile render size


def L(h: str) -> float:
    h = h.lstrip("#")
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    c = [v / 12.92 if v <= .03928 else ((v + .055) / 1.055) ** 2.4 for v in c]
    return .2126 * c[0] + .7152 * c[1] + .0722 * c[2]


def cr(a: str, b: str) -> float:
    l1, l2 = L(a), L(b)
    return (max(l1, l2) + .05) / (min(l1, l2) + .05)


def shot(fp: Path, body: str, size=(TW, TH)) -> None:
    page = OUT / "_t.html"
    page.write_text(f"<style>*{{box-sizing:border-box;margin:0}}"
                    f"body{{width:{size[0]}px;height:{size[1]}px;overflow:hidden;"
                    f"font:11px/1.45 -apple-system,BlinkMacSystemFont,system-ui,sans-serif}}"
                    f"</style>{body}")
    subprocess.run([str(CHROME), "--headless", "--disable-gpu", "--hide-scrollbars",
                    "--virtual-time-budget=2500", "--force-device-scale-factor=1",
                    f"--screenshot={fp}", f"--window-size={size[0]},{size[1]}",
                    f"file://{page}"], check=True, capture_output=True)


def bars(n, w0, col, gap=9, h=7):
    return "".join(f'<div style="height:{h}px;border-radius:3px;background:{col};'
                   f'width:{int(w0 - i * 7)}%;margin-bottom:{gap}px"></div>' for i in range(n))


# ------------------------------------------------------------------ tiles
# Twelve captures spanning what people actually screenshot. Percentages are the
# rough shape of a designer/founder's roll: mostly bright product UI, a solid
# minority of dark tooling, a few saturated marketing pages, one or two photos.
def tiles() -> list[str]:
    t = []
    # 1 white SaaS dashboard
    t.append(f'<div style="background:#fff;height:100%;display:flex">'
             f'<div style="width:78px;background:#fafafa;border-right:1px solid #ececec;padding:12px">'
             f'{bars(6, 80, "#e6e6e6", 11, 6)}</div>'
             f'<div style="flex:1;padding:16px">{bars(2, 46, "#1a1a1a", 10, 11)}'
             f'<div style="display:flex;gap:9px;margin:14px 0">'
             + "".join('<div style="flex:1;height:56px;border:1px solid #eee;border-radius:7px"></div>'
                       for _ in range(3)) + f'</div>{bars(5, 92, "#efefef")}</div></div>')
    # 2 dark code editor
    t.append(f'<div style="background:#0d1117;height:100%;padding:14px;'
             f'font:10px ui-monospace,Menlo,monospace;color:#9aa5b1">'
             + "".join(f'<div style="margin-bottom:7px"><span style="color:#c678dd">'
                       f'{"const" if i%3 else "return"}</span> <span style="color:#61afef">'
                       f'fn{i}</span> <span style="color:#98c379">"{"x"*(4+i%7)}"</span></div>'
                       for i in range(11)) + '</div>')
    # 3 saturated marketing landing
    t.append('<div style="height:100%;background:linear-gradient(135deg,#5b21b6,#db2777 60%,#f59e0b);'
             'padding:26px;color:#fff;display:flex;flex-direction:column;justify-content:center">'
             '<div style="font-size:27px;font-weight:700;letter-spacing:-.03em;line-height:1.1">'
             'Ship faster<br/>than ever</div>'
             '<div style="margin-top:14px;background:#fff;color:#111;border-radius:999px;'
             'padding:8px 18px;width:fit-content;font-weight:600">Start free</div></div>')
    # 4 documentation, near-blank white
    t.append(f'<div style="background:#fff;height:100%;padding:20px 26px">'
             f'{bars(1, 55, "#111", 14, 13)}{bars(7, 96, "#eaeaea", 10, 7)}</div>')
    # 5 figma / canvas grey
    t.append('<div style="background:#2c2c2c;height:100%;position:relative">'
             '<div style="height:26px;background:#1e1e1e"></div>'
             '<div style="position:absolute;left:60px;top:60px;width:150px;height:100px;'
             'background:#fff;border:1px solid #0d99ff"></div>'
             '<div style="position:absolute;left:238px;top:96px;width:96px;height:64px;'
             'background:#ffd7d7"></div></div>')
    # 6 photo-heavy
    t.append('<div style="height:100%;background:'
             'radial-gradient(circle at 28% 32%,#ffb37a,transparent 46%),'
             'radial-gradient(circle at 72% 66%,#2f6f8f,transparent 52%),#123040"></div>')
    # 7 white pricing table
    t.append('<div style="background:#fff;height:100%;padding:16px;display:flex;gap:9px">'
             + "".join(f'<div style="flex:1;border:{"2px solid #111" if i==1 else "1px solid #eaeaea"};'
                       f'border-radius:9px;padding:11px"><div style="font-size:19px;font-weight:700">'
                       f'${9+i*20}</div>{bars(4, 88, "#eee", 7, 5)}</div>' for i in range(3)) + '</div>')
    # 8 dark analytics
    t.append('<div style="background:#111318;height:100%;padding:16px;color:#e6e8ec">'
             '<div style="font-size:13px;font-weight:600;margin-bottom:12px">Revenue</div>'
             '<div style="display:flex;align-items:flex-end;gap:6px;height:120px">'
             + "".join(f'<div style="flex:1;height:{22+((i*29)%78)}%;border-radius:3px;'
                       f'background:#3b82f6"></div>' for i in range(11)) + '</div></div>')
    # 9 bright green fintech
    t.append('<div style="height:100%;background:#e8f6ec;padding:22px">'
             '<div style="font-size:24px;font-weight:700;color:#0d5c33">$12,480</div>'
             '<div style="color:#3f7a5a;margin-top:5px">+18.2% this month</div>'
             '<div style="margin-top:18px;height:70px;border-radius:9px;background:'
             'linear-gradient(180deg,#8fd6a8,#e8f6ec)"></div></div>')
    # 10 white social feed
    t.append(f'<div style="background:#fff;height:100%;padding:14px">'
             + "".join('<div style="display:flex;gap:9px;padding:10px 0;'
                       'border-bottom:1px solid #f0f0f0">'
                       '<div style="width:26px;height:26px;border-radius:99px;background:#dfe3e8;'
                       'flex:none"></div><div style="flex:1">'
                       + bars(2, 90, "#eee", 6, 6) + '</div></div>' for _ in range(4)) + '</div>')
    # 11 near-black terminal
    t.append('<div style="background:#000;height:100%;padding:14px;color:#3ad35c;'
             'font:10px ui-monospace,Menlo,monospace">'
             + "".join(f'<div style="margin-bottom:6px">$ {"npm run build" if i%2 else "✓ 12 passed"}'
                       f'</div>' for i in range(9)) + '</div>')
    # 12 orange-red ecommerce
    t.append('<div style="height:100%;background:#fff;display:flex;flex-direction:column">'
             '<div style="height:150px;background:linear-gradient(120deg,#ff6a3d,#ffb03d)"></div>'
             '<div style="padding:14px">'
             '<div style="font-size:15px;font-weight:700">Everyday Tote</div>'
             '<div style="color:#e0452a;font-weight:700;margin-top:5px">$68.00</div></div></div>')
    return t


CARD_TITLES = [
    "Stripe — billing dashboard", "Neovim config — LSP setup", "Framer — hero animation",
    "Next.js docs — caching", "Figma — capsule rack sketch", "Reference — warm light",
    "Linear — pricing tiers", "Posthog — revenue chart", "Wise — monthly summary",
    "X — thread on memory apps", "Build log — extension zip", "Baggu — product page",
]


def chroma_mask(im: Image.Image, thresh: int = 26):
    """Pixels whose max-min channel spread exceeds thresh — i.e. actually coloured."""
    px = im.convert("RGB").load()
    w, h = im.size
    out = []
    for y in range(0, h, 2):
        row = []
        for x in range(0, w, 2):
            r, g, b = px[x, y]
            row.append((max(r, g, b) - min(r, g, b)) > thresh)
        out.append(row)
    return out


def main() -> int:
    OUT.mkdir(exist_ok=True)
    TILES.mkdir(exist_ok=True)
    for i, body in enumerate(tiles()):
        shot(TILES / f"t{i}.png", body)
    (OUT / "_t.html").unlink(missing_ok=True)
    print(f"rendered {len(tiles())} capture tiles")

    print("\nGround / white separation — most captures are white-ish:")
    for _, name, bg, *_ in GROUNDS[:4]:
        print(f"  {name.replace('&amp;','&'):22s} vs #ffffff  {cr(bg, '#ffffff'):.3f}:1")

    cards = ""
    for i, title in enumerate(CARD_TITLES):
        hue = INTENTS[i % 6]
        cards += (f'<div class="c"><img src="tiles/t{i}.png" alt="">'
                  f'<div class="ct"><span class="dot" style="background:{hue}"></span>'
                  f'<b>{title}</b></div></div>')

    for key, name, bg, su, ink, mu, ac in GROUNDS:
        cta = ac or ink
        line = f"rgb({int(ink[1:3],16)} {int(ink[3:5],16)} {int(ink[5:7],16)} / .13)"
        page = OUT / f"_{key}.html"
        page.write_text(f"""<style>
*{{box-sizing:border-box;margin:0}}
body{{width:1180px;height:700px;overflow:hidden;background:{bg};color:{ink};display:grid;
  grid-template-columns:186px 1fr;
  font:13px/1.55 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;-webkit-font-smoothing:antialiased}}
aside{{border-right:1px solid {line};padding:20px 16px;display:flex;flex-direction:column;gap:17px}}
.wm{{font-size:19px;font-weight:600;letter-spacing:-.025em}}
nav,.pl{{display:flex;flex-direction:column;gap:9px;align-items:flex-start}}
nav .on{{background:{cta};color:{bg};border-radius:7px;padding:2px 9px;margin:-2px -9px}}
.cta{{background:{cta};color:{bg};border-radius:999px;padding:9px 20px;font-weight:500;align-self:flex-end;margin-top:2px}}
.ph{{font-size:10px;letter-spacing:.11em;text-transform:uppercase;color:{mu}}}
.pl span{{display:flex;justify-content:space-between}}
.pl i{{font-style:normal;color:{mu}}}
main{{padding:18px 20px;display:flex;flex-direction:column;gap:13px;min-width:0}}
.sb{{border:1px solid {line};background:{su};border-radius:10px;padding:11px 14px;color:{mu}}}
.cards{{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:13px}}
.c{{background:{su};border:1px solid {line};border-radius:10px;overflow:hidden;min-width:0}}
.c img{{display:block;width:100%;height:112px;object-fit:cover;object-position:top left}}
.ct{{display:flex;align-items:center;gap:6px;padding:8px 9px;font-size:11.5px;min-width:0}}
.ct b{{font-weight:400;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}}
.dot{{width:6px;height:6px;border-radius:9px;flex:none;display:block}}
</style>
<aside><div class="wm">Capso</div>
<nav><span>Inbox</span><span class="on">All captures</span><span>Search</span><span>Memory</span></nav>
<div class="ph">Projects</div>
<div class="pl"><span>Pricing page redesign<i>3</i></span><span>Onboarding teardown<i>5</i></span>
<span>Q3 launch<i>3</i></span></div></aside>
<main><div class="sb">Search your memory…</div><div class="cards">{cards}</div><div class="cta">Capture</div></main>""")
        png = OUT / f"full-{key}.png"
        subprocess.run([str(CHROME), "--headless", "--disable-gpu", "--hide-scrollbars",
                        "--virtual-time-budget=4000", "--force-device-scale-factor=2",
                        f"--screenshot={png}", "--window-size=1180,700", f"file://{page}"],
                       check=True, capture_output=True)
        page.unlink()

    print("\nWhere the colour on screen comes from (chromatic pixels, sampled):")
    for key, name, *_ in GROUNDS:
        im = Image.open(OUT / f"full-{key}.png")
        w, h = im.size
        m = chroma_mask(im)
        total = sum(sum(r) for r in m)
        # capture area starts after the 186px rail and the 18+search+13 header,
        # doubled for the 2x render
        x0, y0 = int(186 * w / 1180), int(80 * h / 760)
        inside = sum(1 for yi, row in enumerate(m) for xi, v in enumerate(row)
                     if v and xi * 2 >= x0 and yi * 2 >= y0)
        pct = 100 * inside / total if total else 0
        print(f"  {name.replace('&amp;','&'):22s} {pct:5.1f}% of coloured pixels are inside captures")
    print(f"\nwrote {len(GROUNDS)} full screens to {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
