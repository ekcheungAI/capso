#!/usr/bin/env python3
"""Compose the Capso OG / share card (1200x630).

    python3 drafts/brand/mark/build_og.py

Rendered as HTML through headless Chrome rather than drawn with Pillow. That is
what lets the card use the real wordmark: Fraunces is fetched from Google Fonts
at render time, so the brand typeface appears in the output without a font file
being vendored into the repo. Pillow could only ever have given us a system
serif standing in for it.

Fraunces is SIL OFL 1.1 — commercial use, embedding and redistribution are all
permitted. Reserved Font Name, so a modified cut may not be called Fraunces; we
do not modify it.

The card sits in the marketing register (clay ground, espresso type), not the
product one — see GUIDELINES.html. Ratios are asserted below rather than
eyeballed.
"""
import json
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / "out"
CHROME = Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")

W, H = 1200, 630
# Same source of truth as every app surface — see packages/shared/src/tokens.json.
TOKENS = json.loads((HERE / "../tokens.generated.json").resolve().read_text())
CLAY = TOKENS["marketing"]["clay"]
ESPRESSO = TOKENS["marketing"]["espresso"]
SAND = TOKENS["marketing"]["sand"]
MUTED = TOKENS["marketing"]["muted"]
INTENTS = list(TOKENS["intent"].values())


def lum(h: str) -> float:
    h = h.lstrip("#")
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    c = [v / 12.92 if v <= .03928 else ((v + .055) / 1.055) ** 2.4 for v in c]
    return .2126 * c[0] + .7152 * c[1] + .0722 * c[2]


def ratio(a: str, b: str) -> float:
    l1, l2 = lum(a), lum(b)
    return (max(l1, l2) + .05) / (min(l1, l2) + .05)


def lid_inner(uid: str) -> str:
    src = re.sub(r"<!--.*?-->", "", (HERE / "capso-lid.svg").read_text(), flags=re.S)
    body = src[src.index(">", src.index("<svg")) + 1: src.rindex("</svg>")]
    return (body.replace('id="capso-notch"', f'id="cn{uid}"')
                .replace("url(#capso-notch)", f"url(#cn{uid})").strip())


def lid(size: int, color: str, uid: str) -> str:
    return (f'<svg viewBox="0 0 24 24" width="{size}" height="{size}" aria-hidden="true" '
            f'style="display:block;flex:none;color:{color}">{lid_inner(uid)}</svg>')


def rack() -> str:
    """A filled rack on the right — the product's own metaphor, held still.

    Each slot carries one intent hue, which is the honest picture of what the
    app looks like: neutral furniture, colour only where a capture is.
    """
    slots = "".join(
        f'<div class="slot">{lid(58, ESPRESSO, f"r{i}")}'
        f'<span class="dot" style="background:{c}"></span></div>'
        for i, c in enumerate(INTENTS))
    return f'<div class="rack">{slots}</div>'


def html() -> str:
    return f"""<meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,600;1,9..144,600&display=block" rel="stylesheet">
<style>
*{{box-sizing:border-box;margin:0}}
html,body{{width:{W}px;height:{H}px;overflow:hidden}}
body{{background:{CLAY};color:{ESPRESSO};display:flex;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,system-ui,sans-serif;
  -webkit-font-smoothing:antialiased}}
.left{{flex:1;padding:64px 0 64px 72px;display:flex;flex-direction:column}}
.lock{{display:flex;align-items:center;gap:16px;font-family:'Fraunces',serif;
  font-weight:600;font-size:38px;letter-spacing:-.035em;line-height:1}}
h1{{font-family:'Fraunces',serif;font-weight:600;font-size:74px;line-height:1.02;
  letter-spacing:-.042em;margin-top:auto}}
h1 em{{font-style:italic}}
.sub{{font-size:23px;color:{MUTED};margin-top:26px;max-width:24ch;line-height:1.45}}
.foot{{display:flex;align-items:center;gap:12px;margin-top:auto;font-size:17px;color:{MUTED}}}
kbd{{font:15px ui-monospace,Menlo,monospace;background:{SAND};border-radius:7px;padding:5px 9px}}
.right{{width:392px;display:grid;place-items:center}}
.rack{{background:{SAND};border-radius:26px;padding:26px 0;width:150px;
  display:flex;flex-direction:column;align-items:center;gap:22px;
  box-shadow:0 24px 60px rgb(49 27 15/.16)}}
.slot{{position:relative;display:grid;place-items:center}}
.dot{{position:absolute;right:-19px;top:50%;margin-top:-4px;
  width:8px;height:8px;border-radius:99px;display:block}}
</style>
<div class="left">
  <div class="lock">{lid(40, ESPRESSO, "hd")}Capso</div>
  <h1>You’re not organised.<br/><em>Capso is.</em></h1>
  <p class="sub">Every screenshot read, filed, and findable by a sentence.</p>
  <div class="foot"><kbd>⌃</kbd><kbd>⇧</kbd><kbd>C</kbd><span>and it’s handled.</span></div>
</div>
<div class="right">{rack()}</div>
"""


def main() -> int:
    if not CHROME.exists():
        print(f"error: Chrome not found at {CHROME}", file=sys.stderr)
        return 1
    OUT.mkdir(exist_ok=True)

    for name, fg, bg, floor in [("espresso on clay", ESPRESSO, CLAY, 4.5),
                                ("muted on clay", MUTED, CLAY, 4.5),
                                ("espresso on sand", ESPRESSO, SAND, 4.5)]:
        r = ratio(fg, bg)
        assert r >= floor, f"{name} is {r:.2f}:1, below {floor}"
        print(f"  {name:20s} {r:5.2f}:1")

    page = OUT / "_og.html"
    page.write_text(html())
    out = OUT / "og-image.png"
    subprocess.run(
        [str(CHROME), "--headless", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
         # the font has to arrive before the shot; display:block above stops
         # Chrome painting a fallback serif in the meantime
         "--virtual-time-budget=6000", "--force-device-scale-factor=1",
         f"--screenshot={out}", f"--window-size={W},{H}", f"file://{page}"],
        check=True, capture_output=True,
    )
    page.unlink(missing_ok=True)
    print(f"\nwrote {out} ({out.stat().st_size:,} bytes, {W}x{H})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
