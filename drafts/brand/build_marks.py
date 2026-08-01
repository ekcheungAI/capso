#!/usr/bin/env python3
"""Build the precision-mark board.

Marks are recoloured here rather than in CSS because Recraft emits inline `fill=`
presentation attributes; substituting once in Python is more predictable than
fighting specificity, and it lets the same mark render in five palettes.
"""
import re
from pathlib import Path

ROOT = Path("/Users/ek/Desktop/ekOS/20_projects/Capso/drafts/brand")
R = ROOT / "renders-marks"

INK, PAPER = "rgb(20,19,18)", "rgb(251,249,245)"

MARKS = {
    "M1-split": "Severed capsule",
    "M2-stack": "Offset stack",
    "M3-nest": "Nested captures",
    "M4-cnotch": "C / aperture",
    "M5-marquee": "Marquee",
}

# Deliberately not privileging terracotta. Monochrome first.
PALETTES = {
    "mono":      ("#141312", "#fbf9f5"),
    "mono-dark": ("#f4f1ea", "#141312"),
    "violet":    ("#5b4bd8", "#fbf9f5"),
    "teal":      ("#0f6b5f", "#fbf9f5"),
    "terracotta":("#c2461f", "#fbf9f5"),
}

_cache: dict[str, str] = {}


def inner(name: str) -> str:
    if name in _cache:
        return _cache[name]
    raw = (R / f"{name}.svg").read_text()
    body = re.sub(r'<path[^>]*fill="rgb\(251,249,245\)"[^>]*d="M 0 0 L 1024 0[^"]*"\s*/>', "", raw, count=1)
    s = body[body.index(">", body.index("<svg")) + 1:].replace("</svg>", "").strip()
    _cache[name] = s
    return s


# Measured by rasterising each mark and reading its ink bounds — scraping path
# coordinates with a regex does not work, because path data carries relative
# commands and Bezier control points that are not on the curve.
# Note the source viewBox is 0 0 2048 2048 with a width="1024" attribute — the
# attribute is not the coordinate space, and assuming it was halved every box.
BBOX = {
    "M1-split-a":   (481.4, 481.4, 1085.3, 1085.3),
    "M2-stack-b":   (513.3, 513.3, 1021.4, 1021.4),
    "M3-nest-a":    (340.0, 340.0, 1368.0, 1368.0),
    "M4-cnotch-b":  (481.4, 481.4, 1085.3, 1085.3),
    "M5-marquee-a": (654.6, 654.6, 738.7, 738.7),
}


def bbox(name: str) -> tuple[float, float, float, float]:
    return BBOX.get(name, (0, 0, 2048, 2048))


def mark(name: str, size: int, pal: str = "mono", tight: bool = True) -> str:
    fg, bg = PALETTES[pal]
    s = inner(name).replace(f'fill="{INK}"', f'fill="{fg}"').replace(f'fill="{PAPER}"', f'fill="{bg}"')
    vb = "%.1f %.1f %.1f %.1f" % bbox(name) if tight else "0 0 1024 1024"
    return (f'<svg viewBox="{vb}" width="{size}" height="{size}" aria-hidden="true" '
            f'style="display:block">{s}</svg>')


def reduction(name: str, pal: str = "mono") -> str:
    cells = "".join(
        f'<div class="ic"><div class="icb" style="width:{max(px,34)}px;height:{max(px,34)}px">'
        f'{mark(name, px, pal)}</div><span>{px}</span></div>'
        for px in (128, 48, 32, 16)
    )
    return f'<div class="icons">{cells}</div>'


CANDIDATES = [
    {
        "key": "M3-nest", "v": "a", "rank": "1",
        "name": "Nested captures", "verdict": "most memorable",
        "body": """Concentric contours resolving into a capsule. It reads as strata — layers of
        what you saved — and, unintentionally but usefully, as a fingerprint. Of everything
        generated this session it is the one most likely to make someone say <em>that's clean</em>.""",
        "pro": ["Genuinely distinctive; nothing in the category looks like it",
                "The layer reading is exactly what a memory product is",
                "Beautiful large — a real hero mark"],
        "con": ["11 paths and hairline strokes — the inner rings close up below ~32px",
                "Needs a simplified 2-ring variant for the favicon, so it is two assets"],
    },
    {
        "key": "M4-cnotch", "v": "b", "rank": "2",
        "name": "C / aperture", "verdict": "most confident",
        "body": """A solid disc with a rectangular bite taken out of the right side. It is a C, it
        is a screen being lifted out, and it is one shape. <strong>Two paths, 1,144 bytes</strong> —
        that is the signature of a resolved mark, and it is the whole reason Vercel's triangle works.""",
        "pro": ["Reduces perfectly — the notch survives at 16px because it is huge relative to the form",
                "Instantly recognisable in a favicon row or a tab strip",
                "Works as a pure silhouette, so the tray template is free",
                "Smallest, simplest, boldest thing here"],
        "con": ["A notched circle is not unheard of — closer to prior art than the nested mark",
                "Says less about memory; it says capture"],
    },
    {
        "key": "M5-marquee", "v": "a", "rank": "3",
        "name": "Marquee", "verdict": "most literal",
        "body": """Four selection corners around a capsule held in negative space. It is literally
        the gesture — the drag-to-select marquee every screenshot begins with.""",
        "pro": ["The most on-the-nose meaning of any mark here, in a good way",
                "Corner brackets are a natural motion device: they could snap in on capture"],
        "con": ["Five separate elements — busiest of the three at small size",
                "Selection brackets are common UI furniture, so it risks reading as a control rather than a brand"],
    },
]

OTHERS = [
    ("M1-split", "a", "Severed capsule", "Reads as a divided disc rather than a capsule; the offset is too subtle to carry the idea."),
    ("M2-stack", "b", "Offset stack", "Bold and strange, but the diagonal slices read closer to a coffee bean than to filed captures."),
]


def cand_block(c: dict) -> str:
    n = f"{c['key']}-{c['v']}"
    pro = "".join(f"<li>{p}</li>" for p in c["pro"])
    con = "".join(f"<li>{p}</li>" for p in c["con"])
    return f"""<article class="cand">
  <div class="hd"><div><span class="rank">{c['rank']}</span><h3>{c['name']}</h3></div>
    <span class="tag">{c['verdict']}</span></div>
  <div class="cg">
    <div class="hero">{mark(n, 168)}</div>
    <div>
      <p>{c['body']}</p>
      <div class="pc"><div><h4>Holds up</h4><ul class="pro">{pro}</ul></div>
        <div><h4>Costs</h4><ul>{con}</ul></div></div>
    </div>
  </div>
  <div class="tests">
    <div><h4>Reduction</h4>{reduction(n)}</div>
    <div><h4>On dark</h4><div class="dk">{reduction(n,'mono-dark')}</div></div>
  </div>
</article>"""


others_html = "".join(
    f'<div class="oth"><div class="obox">{mark(f"{k}-{v}", 84)}</div>'
    f'<div><b>{label}</b><p>{why}</p></div></div>'
    for k, v, label, why in OTHERS
)

def colour_strip(n: str) -> str:
    cells = ""
    for pal, label, note in [
        ("mono", "Ink only", "no accent at all"),
        ("mono-dark", "Ink, inverted", "same mark, dark ground"),
        ("violet", "#5b4bd8", "electric, tool-like"),
        ("teal", "#0f6b5f", "calm, archival"),
        ("terracotta", "#c2461f", "what is shipping now"),
    ]:
        bg = PALETTES[pal][1]
        cells += (f'<div class="cs"><div class="csb" style="background:{bg}">{mark(n,64,pal)}</div>'
                  f'<b>{label}</b><span>{note}</span></div>')
    return f'<div class="csr">{cells}</div>'


HTML = f"""<title>Capso — precision marks</title>
<style>
:root{{--paper:#fbf9f5;--surface:#fff;--ink:#141312;--muted:#6b6a64;--line:rgb(20 19 18/.11);--accent:#141312}}
@media (prefers-color-scheme:dark){{:root{{--paper:#141312;--surface:#1c1c19;--ink:#ededea;--muted:#9a9890;--line:rgb(237 237 234/.13);--accent:#ededea}}}}
:root[data-theme=dark]{{--paper:#141312;--surface:#1c1c19;--ink:#ededea;--muted:#9a9890;--line:rgb(237 237 234/.13);--accent:#ededea}}
:root[data-theme=light]{{--paper:#fbf9f5;--surface:#fff;--ink:#141312;--muted:#6b6a64;--line:rgb(20 19 18/.11);--accent:#141312}}
*{{box-sizing:border-box}}
body{{margin:0;background:var(--paper);color:var(--ink);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,system-ui,sans-serif;-webkit-font-smoothing:antialiased}}
.w{{max-width:1000px;margin:0 auto;padding:56px 24px 100px}}
h1{{font-size:34px;letter-spacing:-.03em;margin:0 0 10px;font-weight:600;line-height:1.12}}
h2{{font-size:22px;letter-spacing:-.02em;margin:0 0 8px;font-weight:600}}
h3{{font-size:19px;margin:0;font-weight:600;letter-spacing:-.015em;display:inline}}
h4{{font-size:10.5px;margin:0 0 10px;font-weight:600;text-transform:uppercase;letter-spacing:.09em;color:var(--muted)}}
p{{margin:0 0 12px;max-width:68ch}}
.lede{{color:var(--muted);font-size:16.5px}}
code{{font:.86em ui-monospace,Menlo,monospace;background:color-mix(in srgb,var(--ink) 7%,transparent);padding:2px 6px;border-radius:4px}}
hr{{border:0;border-top:1px solid var(--line);margin:46px 0}}
section{{margin-bottom:44px}}
.rule{{border-left:3px solid var(--ink);padding:4px 0 4px 18px;margin:20px 0}}
.rule p{{margin:0}}
.cand{{border:1px solid var(--line);border-radius:16px;padding:24px;margin-bottom:20px;background:var(--surface)}}
.hd{{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:18px;flex-wrap:wrap}}
.rank{{display:inline-grid;place-items:center;width:22px;height:22px;border-radius:99px;background:var(--ink);color:var(--paper);font-size:11px;font-weight:600;margin-right:9px;vertical-align:2px}}
.tag{{font-size:11px;border:1px solid var(--line);border-radius:999px;padding:4px 11px;color:var(--muted);white-space:nowrap}}
.cg{{display:grid;grid-template-columns:200px 1fr;gap:26px;align-items:start}}
.hero{{display:grid;place-items:center;background:var(--paper);border:1px solid var(--line);border-radius:12px;padding:16px;min-height:200px}}
.pc{{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:14px}}
.pc ul{{margin:0;padding-left:16px;font-size:12.5px;color:var(--muted)}}
.pc li{{margin-bottom:4px}}
.pro li::marker{{color:var(--ink)}}
.tests{{display:grid;grid-template-columns:1fr 1fr;gap:22px;margin-top:22px;padding-top:20px;border-top:1px solid var(--line)}}
.icons{{display:flex;align-items:flex-end;gap:14px;flex-wrap:wrap}}
.ic{{display:grid;justify-items:center;gap:5px}}
.icb{{display:grid;place-items:center}}
.ic span{{font-size:10px;color:var(--muted)}}
.dk{{background:#141312;border-radius:10px;padding:14px}}
.dk .ic span{{color:#9a9890}}
.oth{{display:grid;grid-template-columns:110px 1fr;gap:16px;align-items:center;padding:14px 0;border-top:1px solid var(--line)}}
.obox{{display:grid;place-items:center;background:var(--paper);border:1px solid var(--line);border-radius:10px;padding:10px}}
.oth p{{margin:2px 0 0;font-size:13px;color:var(--muted)}}
.csr{{display:flex;gap:12px;flex-wrap:wrap;margin-top:12px}}
.cs{{display:grid;justify-items:center;gap:5px}}
.csb{{padding:16px;border:1px solid var(--line);border-radius:12px}}
.cs b{{font-size:12px;font-weight:600}}
.cs span{{font-size:10.5px;color:var(--muted)}}
.rec{{border:1px solid var(--ink);border-radius:16px;padding:26px 28px;background:var(--surface)}}
.two{{display:grid;grid-template-columns:1fr 1fr;gap:22px}}
@media(max-width:800px){{.cg,.tests,.pc,.two{{grid-template-columns:1fr}}.w{{padding:32px 16px 70px}}}}
</style>

<div class="w">
<h1>Precision marks — no colour, no face</h1>
<p class="lede">You said you wanted something that reads as clean and very nicely built. That target
and "fun mascot" pull in opposite directions, so I dropped both of my anchors: the colour and the
character. These are judged on form alone.</p>

<hr/>

<section>
<h2>Why I dropped the colour</h2>
<div class="rule"><p>I anchored on <code>#e8683a</code> because it was already in the repo — and
your own <code>15_DESIGN_SYSTEM_AND_UX.md:109</code> calls it <em>"placeholder, pick against real
screenshots."</em> I deepened it, shipped it, then built an argument to defend it. The
"orange is rare inside screenshots" reasoning is real but only matters at large areas; in a
restrained brand it barely applies. That was rationalisation, not design.</p></div>
<p>The brands that read the way you described — Linear, Vercel, Raycast, Stripe — are near
monochrome and almost never mascot-led. They signal quality through geometric precision and
typography. So: form first, colour last, and colour genuinely open.</p>
</section>

<hr/>

<section>
<h2>The three that work</h2>
{"".join(cand_block(c) for c in CANDIDATES)}
</section>

<section>
<h4>Generated and rejected</h4>
{others_html}
</section>

<hr/>

<section>
<h2>Colour, held open</h2>
<p>The leading mark in five positions. Terracotta is included for comparison, not because it has
earned its place.</p>
{colour_strip("M4-cnotch-b")}
<p style="margin-top:18px;font-size:13.5px;color:var(--muted)">My honest read: <strong>ink only is
the strongest</strong>. A monochrome mark with immaculate spacing is the most reliable "nicely
built" signal in software, and it leaves the accent free to mean something functional in the UI
rather than decorative in the logo. If one accent is wanted, violet is the sharpest of these and
avoids the blue that dominates the screenshots your users capture.</p>
</section>

<hr/>

<section>
<div class="rec">
<h4>Recommendation</h4>
<p style="font-size:21px;font-weight:600;letter-spacing:-.015em;margin-bottom:12px">
The notched disc, in ink. Nested captures as the runner-up if you want beauty over bluntness.</p>
<div class="two">
  <div><p style="margin:0"><strong>Why the notch:</strong> two paths and 1,144 bytes. It survives
  16px without a special master, works as a flat silhouette so the macOS tray template is free, and
  is unmistakable in a tab strip. That combination is rare and it is exactly what "well built"
  looks like in a mark.</p></div>
  <div><p style="margin:0"><strong>Why nested is close:</strong> it is the more beautiful object and
  the better story — strata of what you saved. It loses only on reduction: hairline rings close up
  below 32px, so it needs a simplified favicon variant. If you would rather have the more memorable
  mark and accept two assets, take it instead. That is a legitimate trade, not a mistake.</p></div>
</div>
<p style="margin:16px 0 0;font-size:13.5px;color:var(--muted)">Both are generated concepts. Whichever
you pick gets hand-redrawn on a grid before anything ships — but unlike the mascot rounds, these are
close enough to be worth drawing.</p>
</div>
</section>
</div>
"""

out = ROOT / "board-marks.html"
out.write_text(HTML)
print(f"wrote {out} ({len(HTML):,} bytes)")
