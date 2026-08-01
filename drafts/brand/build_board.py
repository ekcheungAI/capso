#!/usr/bin/env python3
"""Build the Capso mascot review board from the Recraft SVG marks.

Recolouring happens here rather than in CSS because the marks carry inline
`fill=` presentation attributes, and doing the substitution once in Python is
more predictable than fighting specificity across three palettes.
"""
import re
from pathlib import Path

ROOT = Path("/Users/ek/Desktop/ekOS/20_projects/Capso/drafts/brand")
REND = ROOT / "renders"

# Source colours as Recraft emitted them.
TERRA, CREAM, INK, EAR = "rgb(232,104,58)", "rgb(250,250,248)", "rgb(20,20,18)", "rgb(83,47,40)"

# Real tokens from apps/web/app/globals.css:3-20
PALETTES = {
    # name:        (accent,     paper,     ink,       ear)
    "brand":       ("#e8683a", "#ffffff", "#141412", "#8c3f28"),
    "dark":        ("#e8683a", "#1c1c19", "#ededea", "#8c3f28"),
    # Silhouette treatments: body collapses to one colour, eyes knock out to the
    # plate colour behind so the face still reads. A flat fill loses it entirely.
    "mono":        ("#141412", "#141412", "#fafaf8", "#fafaf8"),
    "mono-invert": ("#ededea", "#ededea", "#141412", "#141412"),
    "sil-light":   ("#fafaf8", "#fafaf8", "#e8683a", "#e8683a"),
    "espresso":    ("#8c4a2f", "#ffffff", "#141412", "#5c2f1d"),
    "matcha":      ("#5f7a4a", "#ffffff", "#141412", "#3d5230"),
    "ink-blue":    ("#3d5a80", "#ffffff", "#141412", "#27405e"),
}

MARKS = {
    "A": ("A1-capsule.svg", "The Capsule"),
    "B": ("B3-archivist.svg", "The Archivist"),
    "C": ("C2-glyph.svg", "The Glyph"),
}

# Recraft centres each mark inside a 2048 canvas with a lot of dead space, so a
# raw 16px render only draws ~6px of glyph. Measured bounds (via getBBox in the
# browser) are normalised to a padded square here so the size labels are honest.
BOUNDS = {
    "A": (651, 606, 746, 833),
    "B": (574, 679, 896, 693),
    "C": (699, 684, 650, 680),
}
PAD = 0.09


def viewbox(key: str) -> str:
    x, y, w, h = BOUNDS[key]
    side = max(w, h) * (1 + PAD * 2)
    cx, cy = x + w / 2, y + h / 2
    return f"{cx - side / 2:.1f} {cy - side / 2:.1f} {side:.1f} {side:.1f}"

_cache: dict[str, str] = {}


def load(fname: str) -> str:
    """Read an SVG and strip its opaque background rect so it composites."""
    if fname in _cache:
        return _cache[fname]
    raw = (REND / fname).read_text()
    # The first path is always the full-canvas background rect.
    body = re.sub(
        r'<path[^>]*d="M 0 0 L 2048 0 L 2048 2048 L 0 2048 L 0 0 z"\s*/>',
        "", raw, count=1,
    )
    inner = body[body.index(">", body.index("<svg")) + 1:].replace("</svg>", "").strip()
    _cache[fname] = inner
    return inner


def mark(key: str, size: int, palette: str = "brand", cls: str = "") -> str:
    fname, _ = MARKS[key]
    inner = load(fname)
    accent, paper, ink, ear = PALETTES[palette]
    for src, dst in ((TERRA, accent), (CREAM, paper), (INK, ink), (EAR, ear)):
        inner = inner.replace(f'fill="{src}"', f'fill="{dst}"')
    return (
        f'<svg class="{cls}" viewBox="{viewbox(key)}" width="{size}" height="{size}" '
        f'aria-hidden="true" style="display:block">{inner}</svg>'
    )


def tile(key: str, size: int, palette: str = "brand", plate: str = "paper") -> str:
    """A mark on an icon plate — how a favicon or app icon actually ships."""
    bg = {"paper": PALETTES[palette][1], "accent": PALETTES[palette][0]}[plate]
    # On an accent plate the mark reduces to a light silhouette — the standard
    # app-icon treatment, and the only one that stays legible at 16px.
    inner_pal = palette if plate == "paper" else "sil-light"
    radius = max(3, round(size * 0.22))
    border = "box-shadow:inset 0 0 0 1px rgb(0 0 0 / .10);" if plate == "paper" else ""
    return (
        f'<div style="width:{size}px;height:{size}px;border-radius:{radius}px;background:{bg};'
        f'{border}display:grid;place-items:center;overflow:hidden">'
        f"{mark(key, round(size * 0.76), inner_pal)}</div>"
    )


def icon_row(key: str, palette: str = "brand", plate: str | None = None) -> str:
    """The reduction test: does the silhouette survive to favicon size?"""
    cells = []
    for px in (128, 64, 32, 16):
        art = tile(key, px, palette, plate) if plate else mark(key, px, palette)
        cells.append(
            f'<div class="ic"><div class="ic-box" style="width:{max(px,32)}px;height:{max(px,32)}px">'
            f"{art}</div><span>{px}px</span></div>"
        )
    return f'<div class="icons">{"".join(cells)}</div>'


def overlay(key: str) -> str:
    """Pixel-accurate replica of the real post-capture overlay.

    Geometry taken from apps/web/components/capture.tsx:286-298 —
    w-64 (256px), rounded-xl (12px), ring-1 ring-line, image h-28 (112px),
    p-3, text-[11px]. This is the product's signature moment.
    """
    return f"""<div class="ov">
  <div class="ov-shot"><div class="ov-shot-bar"></div><div class="ov-shot-l" style="width:70%"></div>
    <div class="ov-shot-l" style="width:45%"></div><div class="ov-shot-l" style="width:58%"></div>
    <div class="ov-shot-cta"></div></div>
  <div class="ov-body">
    <div class="ov-row">
      <div class="ov-mark splitter">
        <div class="half top">{mark(key, 20)}</div>
        <div class="half bot">{mark(key, 20)}</div>
      </div>
      <p class="ov-txt">Analysing…</p>
    </div>
  </div>
</div>"""


def palette_row(key: str) -> str:
    out = []
    for p in ("brand", "espresso", "matcha", "ink-blue"):
        accent = PALETTES[p][0]
        out.append(
            f'<div class="pal"><div class="pal-chip">{mark(key, 56, p)}</div>'
            f'<code>{accent}</code><span>{p}</span></div>'
        )
    return f'<div class="pals">{"".join(out)}</div>'


# ---------------------------------------------------------------- content

DIRECTIONS = [
    {
        "key": "A",
        "tag": "Direction A",
        "name": "The Capsule",
        "sub": "product-as-actor",
        "verdict": "recommended",
        "body": """A two-tone capsule with a seam across the middle and two dot eyes. It is the
        product metaphor wearing a face — the same move as Bibendum and the BiC Schoolboy, where
        <em>the product becomes the actor</em>. Grapheine names metaphorical coherence as the single
        strongest predictor of a mascot that lasts, and this is the only one of the three that has it.""",
        "reduction": """<strong>Fails bare below ~32px on a light background.</strong> The cream lower
        half dissolves into the page and only the orange cap survives. This is the direction’s one real
        weakness — the icon plate beside it is the fix, and it is how the icon would actually ship.""",
        "pros": [
            "Reads as medicine capsule <em>and</em> coffee pod — neither category claims it",
            "Collapses three unsolved problems into one asset: mascot, logo, app icon",
            "Seam doubles as a screenshot crop line, and the halves pull apart for the “Analysing…” state",
            "The mono silhouette holds cleanly, so the macOS tray template is solved",
            "Survives a rename — it is a capsule, not the letters C-A-P-S-O",
        ],
        "cons": [
            "Two-tone body needs an icon plate to survive small sizes — it cannot sit bare on a light page below 32px",
            "Pill shapes carry pharma association; the rounded-square proportion and crema palette are what pull it back",
            "The hairline outline is inconsistent in this render and would need redrawing by hand",
        ],
    },
    {
        "key": "B",
        "tag": "Direction B",
        "name": "The Archivist",
        "sub": "a creature that collects",
        "verdict": "viable, off-concept",
        "body": """A hamster whose cheek pouches are the storage metaphor. This is the third attempt —
        the first two put white pouches on an orange face and the pouches read unmistakably as two enormous
        googly eyes, with the real eyes stranded as dots above. Both failed renders are kept below as evidence.
        Matching the pouches to the body colour fixed it, and what is left is genuinely charming.""",
        "reduction": """<strong>The strongest reducer of the three.</strong> A solid single-colour
        shape with high-contrast eyes holds bare at every size tested, with no plate needed.""",
        "pros": [
            "Warmest and most shareable of the three — the most obvious sticker",
            "Reduces better than either alternative: solid fill, high-contrast eyes, no plate required",
        ],
        "cons": [
            "No link to the name. It would be an equally good mascot for any product",
            "Does not double as a logo, so the icon problem stays unsolved",
            "Reads closer to panda or frog than hamster once the cheeks match the body",
            "Needed three attempts to become legible — a signal the form is fighting the brief",
        ],
    },
    {
        "key": "C",
        "tag": "Direction C",
        "name": "The Glyph",
        "sub": "abstract shape with a face",
        "verdict": "safe, quiet",
        "body": """A squircle — the shape of a screenshot — with a seam and two eyes. The register of
        Brilliant’s “Koji” and Sora’s blob. It is the cleanest object here and the cheapest to rebuild by
        hand as CSS or inline SVG with no new dependency.""",
        "reduction": """Holds bare down to 32px. At 16px the seam disappears and it becomes a plain
        rounded square with two dots — legible, but no longer saying anything.""",
        "pros": [
            "Simplest silhouette; unambiguous at every size",
            "Sits most comfortably inside the existing restrained system",
            "Trivial to hand-rebuild as vector — no tracing needed",
        ],
        "cons": [
            "Single-colour, so it loses the two-tone capsule read entirely",
            "The seam sits low and reads as a closed mouth rather than a capsule join",
            "Least distinctive — closest to shapes already in use elsewhere",
        ],
    },
]

MOBBIN = [
    ("Duolingo", "Duo appears at ~48px on a dedicated onboarding step, and is otherwise absent from the working UI",
     "Full character"),
    ("Brilliant", "“Koji” is a ~32px gradient glyph with a face, shown once at onboarding and never in the lesson UI",
     "Abstract glyph"),
    ("Sora", "A small blob sits above the welcome copy at ~40px, then disappears entirely",
     "Abstract glyph"),
    ("Vanta", "The llama is large on onboarding side-panels but never enters the compliance dashboard",
     "Line character"),
    ("Alan", "A 3D creature carries onboarding and confirmation moments only",
     "3D character"),
    ("Typeform", "The dog appears in exactly one empty state, with a joke in the copy that references it",
     "Line character"),
]


def direction_block(d: dict) -> str:
    pros = "".join(f"<li>{p}</li>" for p in d["pros"])
    cons = "".join(f"<li>{c}</li>" for c in d["cons"])
    vclass = {"recommended": "v-rec", "viable, off-concept": "v-mid", "safe, quiet": "v-mid"}[d["verdict"]]
    return f"""<article class="dir" id="dir-{d['key']}">
  <header class="dir-h">
    <div>
      <span class="tag">{d['tag']}</span>
      <h3>{d['name']} <span class="sub">— {d['sub']}</span></h3>
    </div>
    <span class="verdict {vclass}">{d['verdict']}</span>
  </header>

  <div class="dir-grid">
    <div class="hero">{mark(d['key'], 200)}</div>
    <div class="dir-copy">
      <p>{d['body']}</p>
      <div class="pc">
        <div><h4>Holds up</h4><ul class="pro">{pros}</ul></div>
        <div><h4>Costs</h4><ul class="con">{cons}</ul></div>
      </div>
    </div>
  </div>

  <div class="tests">
    <div class="test">
      <h4>Reduction test <span>— bare, on the page background</span></h4>
      {icon_row(d['key'])}
      <p class="note">{d['reduction']}</p>
    </div>
    <div class="test">
      <h4>On an icon plate <span>— how a favicon actually ships</span></h4>
      {icon_row(d['key'], 'brand', 'accent')}
      <p class="note">Reduced to a light silhouette on the accent tile. This is the
      treatment that holds at 16px, and the one to build the real icon set from.</p>
    </div>
    <div class="test">
      <h4>Dark mode <span>— the app is <code>prefers-color-scheme</code> driven</span></h4>
      <div class="darkbox">{icon_row(d['key'], 'dark')}</div>
    </div>
    <div class="test">
      <h4>Mono tray icon <span>— macOS template, required by tauri.conf.json</span></h4>
      <div class="monorow">
        <div class="mono-l">{mark(d['key'], 36, 'mono')}</div>
        <div class="mono-d">{mark(d['key'], 36, 'mono-invert')}</div>
      </div>
      <p class="note">Silhouette only — every internal colour collapses. All three survive this.</p>
    </div>
    <div class="test">
      <h4>In context <span>— the post-capture overlay, hover to split</span></h4>
      {overlay(d['key'])}
    </div>
  </div>

  <div class="test">
    <h4>Palette check <span>— is <code>#e8683a</code> still right?</span></h4>
    {palette_row(d['key'])}
  </div>
</article>"""


mobbin_rows = "".join(
    f"<tr><td><strong>{a}</strong></td><td>{n}</td><td><span class='pill'>{k}</span></td></tr>"
    for a, n, k in MOBBIN
)

dirs_html = "\n".join(direction_block(d) for d in DIRECTIONS)

failed = f"""<div class="failbox">
  <h4>Rejected renders — kept as evidence</h4>
  <div class="fails">
    <figure><img src="renders/A2-capsule.webp" alt="Cropped capsule render"/>
      <figcaption><strong>A2</strong> — render failure. Bottom half cropped, subject off-centre.</figcaption></figure>
    <figure><img src="renders/B1-archivist.webp" alt="Hamster with white cheek pouches"/>
      <figcaption><strong>B1</strong> — the white pouches read as giant eyes. Too detailed to reduce (9.3&nbsp;KB of path data).</figcaption></figure>
    <figure><img src="renders/B2-archivist.webp" alt="Second hamster attempt"/>
      <figcaption><strong>B2</strong> — same collision, plus detached feet.</figcaption></figure>
    <figure><img src="renders/C1-glyph.webp" alt="Pinched two-lobe glyph"/>
      <figcaption><strong>C1</strong> — the seam became a full pinch; the capsule read is gone.</figcaption></figure>
  </div>
</div>"""

HTML = f"""<title>Capso — mascot &amp; light branding exploration</title>
<style>
:root {{
  --background:#fafaf8; --surface:#ffffff; --foreground:#141412;
  --muted:#6b6a64; --line:rgb(20 20 18 / 0.1); --accent:#e8683a;
  --ease-out-strong:cubic-bezier(0.23,1,0.32,1); --dur-panel:220ms;
}}
@media (prefers-color-scheme: dark) {{
  :root {{ --background:#141412; --surface:#1c1c19; --foreground:#ededea;
    --muted:#9a9890; --line:rgb(237 237 234 / 0.12); }}
}}
:root[data-theme="dark"] {{ --background:#141412; --surface:#1c1c19; --foreground:#ededea;
  --muted:#9a9890; --line:rgb(237 237 234 / 0.12); }}
:root[data-theme="light"] {{ --background:#fafaf8; --surface:#ffffff; --foreground:#141412;
  --muted:#6b6a64; --line:rgb(20 20 18 / 0.1); }}

* {{ box-sizing:border-box; }}
body {{ margin:0; background:var(--background); color:var(--foreground);
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,system-ui,sans-serif;
  font-size:14px; line-height:1.55; -webkit-font-smoothing:antialiased; }}
.wrap {{ max-width:1080px; margin:0 auto; padding:56px 24px 96px; }}
h1 {{ font-size:28px; letter-spacing:-0.02em; margin:0 0 8px; font-weight:600; }}
h2 {{ font-size:20px; letter-spacing:-0.01em; margin:0 0 4px; font-weight:600; }}
h3 {{ font-size:17px; margin:2px 0 0; font-weight:600; }}
h4 {{ font-size:12px; margin:0 0 10px; font-weight:600; text-transform:uppercase;
  letter-spacing:0.06em; color:var(--muted); }}
h4 span {{ text-transform:none; letter-spacing:0; font-weight:400; }}
p {{ margin:0 0 12px; }}
code {{ font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:0.9em;
  background:color-mix(in srgb, var(--foreground) 7%, transparent);
  padding:1px 5px; border-radius:4px; }}
.lede {{ color:var(--muted); font-size:15px; max-width:68ch; }}
hr {{ border:0; border-top:1px solid var(--line); margin:44px 0; }}
section {{ margin-bottom:44px; }}

.meta {{ display:flex; flex-wrap:wrap; gap:8px; margin:20px 0 0; }}
.meta span {{ font-size:11px; color:var(--muted); border:1px solid var(--line);
  border-radius:999px; padding:3px 10px; }}

.cards {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(210px,1fr)); gap:12px; }}
.card {{ border:1px solid var(--line); border-radius:12px; padding:14px 16px; background:var(--surface); }}
.card h5 {{ margin:0 0 6px; font-size:13px; font-weight:600; }}
.card p {{ margin:0; font-size:12.5px; color:var(--muted); }}

table {{ width:100%; border-collapse:collapse; font-size:13px; }}
td, th {{ text-align:left; padding:9px 10px; border-bottom:1px solid var(--line); vertical-align:top; }}
th {{ font-size:11px; text-transform:uppercase; letter-spacing:0.06em; color:var(--muted); font-weight:600; }}
.pill {{ font-size:11px; border:1px solid var(--line); border-radius:999px; padding:2px 8px;
  color:var(--muted); white-space:nowrap; }}
.scroll {{ overflow-x:auto; }}

.dir {{ border:1px solid var(--line); border-radius:16px; padding:24px; margin-bottom:24px;
  background:var(--surface); }}
.dir-h {{ display:flex; justify-content:space-between; align-items:flex-start; gap:16px;
  margin-bottom:18px; flex-wrap:wrap; }}
.tag {{ font-size:11px; text-transform:uppercase; letter-spacing:0.08em; color:var(--muted); }}
.sub {{ font-weight:400; color:var(--muted); font-size:14px; }}
.verdict {{ font-size:11px; border-radius:999px; padding:4px 11px; white-space:nowrap;
  border:1px solid var(--line); color:var(--muted); }}
.v-rec {{ background:var(--accent); color:#fff; border-color:transparent; font-weight:500; }}

.dir-grid {{ display:grid; grid-template-columns:220px 1fr; gap:28px; align-items:start; }}
.hero {{ display:grid; place-items:center; background:var(--background);
  border:1px solid var(--line); border-radius:12px; padding:20px; min-height:220px; }}
.pc {{ display:grid; grid-template-columns:1fr 1fr; gap:20px; margin-top:16px; }}
.pc ul {{ margin:0; padding-left:16px; font-size:12.5px; color:var(--muted); }}
.pc li {{ margin-bottom:5px; }}
.pro li::marker {{ color:var(--accent); }}

.tests {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr));
  gap:22px; margin-top:26px; padding-top:22px; border-top:1px solid var(--line); }}
.test {{ min-width:0; }}
.icons {{ display:flex; align-items:flex-end; gap:14px; flex-wrap:wrap; }}
.ic {{ display:grid; justify-items:center; gap:6px; }}
.ic-box {{ display:grid; place-items:center; }}
.ic span {{ font-size:10px; color:var(--muted); }}
.note {{ font-size:11.5px; color:var(--muted); margin:10px 0 0; line-height:1.5; }}
.note strong {{ color:var(--foreground); }}
.darkbox {{ background:#141412; border-radius:10px; padding:14px; }}
.darkbox .ic span {{ color:#9a9890; }}
.monorow {{ display:flex; gap:10px; }}
.mono-l {{ background:#fafaf8; padding:12px; border-radius:8px; border:1px solid var(--line); }}
.mono-d {{ background:#141412; padding:12px; border-radius:8px; }}

/* Overlay replica — capture.tsx:286-298 */
.ov {{ width:256px; border-radius:12px; overflow:hidden; background:var(--surface);
  box-shadow:0 12px 28px rgb(0 0 0 / 0.14); border:1px solid var(--line); }}
.ov-shot {{ height:112px; background:color-mix(in srgb, var(--foreground) 5%, var(--surface));
  padding:12px; display:flex; flex-direction:column; gap:6px; }}
.ov-shot-bar {{ height:8px; width:52px; border-radius:999px;
  background:color-mix(in srgb, var(--foreground) 16%, transparent); margin-bottom:4px; }}
.ov-shot-l {{ height:6px; border-radius:999px;
  background:color-mix(in srgb, var(--foreground) 11%, transparent); }}
.ov-shot-cta {{ height:14px; width:60px; border-radius:999px; background:var(--accent);
  opacity:.75; margin-top:6px; }}
.ov-body {{ padding:12px; }}
.ov-row {{ display:flex; align-items:center; gap:8px; }}
.ov-txt {{ font-size:11px; color:var(--muted); margin:0; animation:pulse 2s ease-in-out infinite; }}
@keyframes pulse {{ 50% {{ opacity:.5; }} }}

/* The halves pull apart — the free animation the capsule form gives you.
   Uses the app's own --dur-panel / --ease-out-strong, so this is shippable. */
.ov-mark {{ position:relative; width:20px; height:20px; flex:none; }}
.half {{ position:absolute; inset:0; transition:transform var(--dur-panel) var(--ease-out-strong); }}
.half.top {{ clip-path:inset(0 0 50% 0); }}
.half.bot {{ clip-path:inset(50% 0 0 0); }}
.ov:hover .half.top {{ transform:translateY(-3px); }}
.ov:hover .half.bot {{ transform:translateY(3px); }}
@media (prefers-reduced-motion: reduce) {{
  .half {{ transition:none; }} .ov-txt {{ animation:none; }}
}}

.pals {{ display:flex; gap:12px; flex-wrap:wrap; }}
.pal {{ display:grid; justify-items:center; gap:5px; }}
.pal-chip {{ padding:12px; border:1px solid var(--line); border-radius:10px; background:var(--surface); }}
.pal code {{ font-size:10px; }}
.pal span {{ font-size:10px; color:var(--muted); }}

.failbox {{ border:1px dashed var(--line); border-radius:14px; padding:20px; }}
.fails {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); gap:16px; }}
.fails figure {{ margin:0; }}
.fails img {{ width:100%; max-width:100%; border-radius:10px; border:1px solid var(--line); display:block; }}
.fails figcaption {{ font-size:11.5px; color:var(--muted); margin-top:7px; }}

.rec {{ border:1px solid var(--accent); border-radius:16px; padding:26px;
  background:color-mix(in srgb, var(--accent) 6%, var(--surface)); }}
.rec-head {{ display:flex; align-items:center; gap:16px; margin-bottom:14px; }}
.warn {{ border-left:3px solid var(--accent); padding:2px 0 2px 14px; color:var(--muted);
  font-size:13px; margin:14px 0; }}
.next {{ counter-reset:s; list-style:none; padding:0; margin:14px 0 0; }}
.next li {{ counter-increment:s; position:relative; padding-left:30px; margin-bottom:9px; font-size:13.5px; }}
.next li::before {{ content:counter(s); position:absolute; left:0; top:1px; width:20px; height:20px;
  border-radius:999px; background:var(--accent); color:#fff; font-size:11px;
  display:grid; place-items:center; font-weight:600; }}

@media (max-width:720px) {{
  .dir-grid {{ grid-template-columns:1fr; }}
  .pc {{ grid-template-columns:1fr; }}
  .wrap {{ padding:32px 16px 64px; }}
}}
</style>

<div class="wrap">
<h1>Capso — mascot &amp; light branding</h1>
<p class="lede">Three mascot directions, generated as true vector and tested against the surfaces they
would actually ship on. The question this board answers is <em>which direction</em>, not whether to build it.</p>
<div class="meta">
  <span>1 Aug 2026</span><span>8 marks generated · Recraft V4.1 vector</span>
  <span>20 of 177 credits · 157 left</span><span>No files under <code>apps/</code> touched</span>
</div>

<hr/>

<section>
<h2>The idea</h2>
<p class="lede" style="margin-bottom:18px">Everything you capture becomes a capsule.</p>
<p>A capsule is a small sealed container holding something concentrated, released later on purpose.
That is literally the product: <code>⌃⇧C</code> takes a messy pixel rectangle and seals it into OCR,
summary, type and project routing; weeks later you type a sentence and it opens. The name carries three
readings at once and none of them needs to win.</p>
<div class="cards">
  <div class="card"><h5>Medicine capsule</h5><p>Precision and dosage. One, and it works on you later.</p></div>
  <div class="card"><h5>Coffee pod</h5><p>Concentrate and ritual — the daily <code>⌃⇧C</code> habit. Crema is already the accent colour.</p></div>
  <div class="card"><h5>Time capsule</h5><p>The retrieval layer. Sealed now, opened when it matters.</p></div>
</div>
<p style="margin-top:16px">No document in the repo claims this etymology, so it is unclaimed. Keeping the mark
a <em>capsule</em> rather than the letters C-A-P-S-O also means the identity survives a rename — worth
noting given <code>MASTER_PLAN.md:61</code> records no trademark check has been run.</p>
</section>

<hr/>

<section>
<h2>Where it is allowed to appear</h2>
<p class="lede" style="margin-bottom:16px">Low-dose. Scarcity is the strategy — it is why the overlay moment lands.</p>
<div class="cards">
  <div class="card"><h5>✓ Appears — 5 surfaces</h5><p>App icon, favicon, extension and tray icons · the “Analysing…” overlay · first-run, once · the true zero state · OG image</p></div>
  <div class="card"><h5>✗ Never</h5><p>The other seven empty states · sidebar and nav chrome · beside AI responses · toasts and buttons · as a per-route spinner</p></div>
</div>
<p class="warn"><code>15_DESIGN_SYSTEM_AND_UX.md:79-84</code> currently reads “<strong>NO visual mascot/character
in MVP</strong>”, and <code>:71</code> bans illustrated empty states. This exploration knowingly overrides
the first. The low-dose rule is what keeps the override narrow — <code>:100</code>’s ban on decorative
sparkles on every surface still holds in full, and that doc needs an edit before any of this ships.</p>
</section>

<hr/>

<section>
<h2>What comparable products actually do</h2>
<p>Pulled from Mobbin. The pattern is consistent and it is the evidence for the low-dose rule: even
companies whose mascot <em>is</em> the brand keep it out of the working UI.</p>
<div class="scroll"><table>
<tr><th>Product</th><th>How the character is deployed</th><th>Type</th></tr>
{mobbin_rows}
</table></div>
<p style="margin-top:14px;color:var(--muted);font-size:13px">Across twenty empty states sampled, only four
carried a character at all — Typeform, Charma, Headspace and Reddit. The rest used generic object
illustration or nothing. Duolingo, the loudest mascot brand in software, does not put Duo in its
empty states.</p>
</section>

<hr/>

<section>
<h2>The three directions</h2>
{dirs_html}
</section>

<section>{failed}</section>

<hr/>

<section>
<div class="rec">
  <div class="rec-head">{mark("A", 64)}<div><h2>Recommendation: Direction A, the Capsule</h2>
    <p style="margin:0;color:var(--muted);font-size:13px">With one honest caveat.</p></div></div>
  <p>A is the only direction where the mascot, the logo and the app icon are the same object. That matters
  more than it sounds: Capso currently ships the Next.js default favicon, the <em>Tauri</em> default swirl
  in both the extension and the Mac app, and no toolbar icon at all. A single capsule mark closes all of
  those at once, and it is the only one of the three that means anything in relation to the name.</p>
  <p>B is the most charming object on this page and the weakest strategic choice — it would be an equally
  good mascot for a to-do app. C is the safest and the least memorable.</p>
  <p class="warn"><strong>Two caveats, both real.</strong> First, A is the weakest reducer here — bare on a
  light background below 32px its cream half dissolves and only the orange cap survives. The fix is the accent
  icon plate shown in its reduction row, which is how favicons and app icons ship anyway, but it does mean A
  is committed to a plate rather than floating free. Second, what is shown is a generated draft, not a finished
  mark: the outline weight is inconsistent and the eyes sit slightly high. It needs redrawing by hand before
  production. <em>The render is the decision, not the asset.</em></p>
  <h4 style="margin-top:20px">If A is approved</h4>
  <ol class="next">
    <li>Redraw A by hand as a clean, optically-corrected SVG on a 24px grid, with a tight bounding box</li>
    <li>Lock the accent-plate treatment as the canonical icon lockup, and settle whether the bare two-tone mark is allowed under 32px at all</li>
    <li>Save it as a Higgsfield <em>Element</em> — not a Soul — so later poses stay consistent</li>
    <li>Generate the icon set: favicon, extension 16/32/48/128, <code>action.default_icon</code>, Tauri <code>.icns</code>/<code>.ico</code>, mono tray template</li>
    <li>Amend <code>15_DESIGN_SYSTEM_AND_UX.md:79-84</code> so the mascot ban reflects the new decision</li>
    <li>Wire the split animation into the overlay using the existing <code>--dur-panel</code> and <code>--ease-out-strong</code> — no new dependency</li>
  </ol>
</div>
</section>

<hr/>
<section>
<h4>Sources</h4>
<p style="font-size:13px;color:var(--muted)">Grapheine, <em>Brand mascots from Bibendum to Benny the Bull</em> ·
The Brand Identity, <em>Mascot Magic</em> (8 identities, retrieved via browser) ·
Design Bootcamp, <em>Mascot: what it is and when a brand needs it</em> · Mobbin (screens and flows).<br/>
<strong>Design Week, <em>Brand mascots</em> — not retrieved.</strong> Blocked by Cloudflare on both
WebFetch and the in-app browser; the Chrome extension did not respond. The other three sources agree
closely, so the argument here does not rest on it.</p>
</section>
</div>
"""

out = ROOT / "board.html"
out.write_text(HTML)
print(f"wrote {out} ({len(HTML):,} bytes)")
