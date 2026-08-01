#!/usr/bin/env python3
"""Logotype specimen + the colour decision, built from the shipped mark."""
import re
from pathlib import Path

ROOT = Path("/Users/ek/Desktop/ekOS/20_projects/Capso/drafts/brand")
R = ROOT / "renders-rack"
INK, PAPER = "rgb(20,19,18)", "rgb(251,249,245)"
BBOX = (612, 612, 829, 829)


def L(h):
    h = h.lstrip("#")
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    c = [v / 12.92 if v <= .03928 else ((v + .055) / 1.055) ** 2.4 for v in c]
    return .2126 * c[0] + .7152 * c[1] + .0722 * c[2]


def cr(a, b):
    l1, l2 = L(a), L(b)
    return (max(l1, l2) + .05) / (min(l1, l2) + .05)


def pair_for(hues):
    """Find, per hue family, a light-mode and dark-mode value that both pass."""
    out = []
    for name, light, darks in hues:
        best = None
        for d in darks:
            if cr(d, "#141312") >= 4.5:
                best = d
                break
        out.append((name, light, cr(light, "#fbf9f5"), best, cr(best, "#141312") if best else 0))
    return out


PAIRS = pair_for([
    ("Sorted green", "#2f6b4f", ["#4f9e79", "#5aab84", "#66b790"]),
    ("Brass", "#8f6512", ["#c99a3a", "#d4a94a", "#dcb45c"]),
    ("Ink blue", "#2c4a7c", ["#6f93cf", "#7fa0d8", "#8aabe0"]),
    ("Terracotta", "#c2461f", ["#e8683a", "#ef7c52"]),
])

_c = {}


def mark(size: int, fg="#141312") -> str:
    if "s" not in _c:
        raw = (R / "R1-lid-a.svg").read_text()
        b = re.sub(r'<path[^>]*d="M 0 0 L 2048 0 L 2048 2048 L 0 2048 L 0 0 z"\s*/>', "", raw, count=1)
        _c["s"] = b[b.index(">", b.index("<svg")) + 1:].replace("</svg>", "").strip()
    s = _c["s"].replace(f'fill="{INK}"', f'fill="{fg}"').replace(f'fill="{PAPER}"', 'fill="none"')
    x, y, w, h = BBOX
    return (f'<svg viewBox="{x} {y} {w} {h}" width="{size}" height="{size}" aria-hidden="true" '
            f'style="display:block;flex:none">{s}</svg>')


FACES = [
    ("Fraunces", "'Fraunces',serif", 600, "-0.03em",
     "Variable serif with optical sizing. Warm, slightly odd, unmistakable.",
     "Archive and craft. The most memorable of these, and the least likely to be mistaken for another tool.", True),
    ("Instrument Serif", "'Instrument Serif',serif", 400, "-0.02em",
     "High-contrast display serif, very light footprint.",
     "Editorial and calm. Elegant, but thin strokes weaken at small sizes and in dark mode.", False),
    ("Newsreader", "'Newsreader',serif", 500, "-0.02em",
     "Text serif built for reading on screen.",
     "Bookish and quiet. Reads as a library, which fits 'never lose a thought'.", False),
    ("Optima", "Optima,'Optima nova',serif", 600, "-0.01em",
     "Humanist flared sans. On every Mac already.",
     "Precise and warm at once — the two things the positioning needs. Underused in software.", True),
    ("Instrument Sans", "'Instrument Sans',sans-serif", 600, "-0.03em",
     "Contemporary grotesque with subtle character in the a and s.",
     "Modern tool. Safe, clean, slightly anonymous.", False),
    ("DM Sans", "'DM Sans',sans-serif", 700, "-0.04em",
     "Geometric, low contrast, friendly.",
     "Approachable and soft. Leans consumer rather than instrument.", False),
    ("Space Grotesk", "'Space Grotesk',sans-serif", 600, "-0.03em",
     "Grotesque with engineered quirks.",
     "Technical and a bit knowing. Fights the 'forgiving' half of the brief.", False),
    ("Inter Tight", "'Inter Tight',sans-serif", 600, "-0.04em",
     "The default of modern software.",
     "Correct and completely forgettable. Included so you can see the baseline it has to beat.", False),
]


def specimen(f) -> str:
    name, stack, wt, ls, desc, verdict, rec = f
    cls = "spec rec" if rec else "spec"
    tag = '<span class="tag">shortlist</span>' if rec else ""
    return f"""<div class="{cls}">
  <div class="sh"><h3>{name}</h3>{tag}</div>
  <div class="lock">{mark(38)}<span style="font-family:{stack};font-weight:{wt};letter-spacing:{ls}">Capso</span></div>
  <div class="lock sm">{mark(20)}<span style="font-family:{stack};font-weight:{wt};letter-spacing:{ls};font-size:21px">Capso</span></div>
  <p class="d">{desc}</p>
  <p class="v">{verdict}</p>
</div>"""


pair_rows = "".join(
    f"<tr><td>{n}</td><td><code>{lt}</code> <span class='ok'>{a:.2f}</span></td>"
    f"<td><code>{dk}</code> <span class='ok'>{b:.2f}</span></td></tr>"
    for n, lt, a, dk, b in PAIRS
)

HTML = f"""<title>Capso — logotype and colour</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600&family=Instrument+Serif&family=Newsreader:wght@500&family=Instrument+Sans:wght@600&family=DM+Sans:wght@700&family=Space+Grotesk:wght@600&family=Inter+Tight:wght@600&display=swap" rel="stylesheet">
<style>
:root{{--paper:#fbf9f5;--surface:#fff;--ink:#141312;--muted:#6b6a64;--line:rgb(20 19 18/.11)}}
@media (prefers-color-scheme:dark){{:root{{--paper:#141312;--surface:#1c1c19;--ink:#ededea;--muted:#9a9890;--line:rgb(237 237 234/.13)}}}}
:root[data-theme=dark]{{--paper:#141312;--surface:#1c1c19;--ink:#ededea;--muted:#9a9890;--line:rgb(237 237 234/.13)}}
:root[data-theme=light]{{--paper:#fbf9f5;--surface:#fff;--ink:#141312;--muted:#6b6a64;--line:rgb(20 19 18/.11)}}
*{{box-sizing:border-box}}
body{{margin:0;background:var(--paper);color:var(--ink);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,system-ui,sans-serif;-webkit-font-smoothing:antialiased}}
.w{{max-width:1000px;margin:0 auto;padding:56px 24px 100px}}
h1{{font-size:34px;letter-spacing:-.03em;margin:0 0 10px;font-weight:600;line-height:1.12}}
h2{{font-size:22px;letter-spacing:-.02em;margin:0 0 8px;font-weight:600}}
h3{{font-size:15px;margin:0;font-weight:600}}
h4{{font-size:10.5px;margin:0 0 11px;font-weight:600;text-transform:uppercase;letter-spacing:.09em;color:var(--muted)}}
p{{margin:0 0 13px;max-width:68ch}}
.lede{{color:var(--muted);font-size:16.5px}}
code{{font:.84em ui-monospace,Menlo,monospace;background:color-mix(in srgb,var(--ink) 7%,transparent);padding:2px 5px;border-radius:4px}}
hr{{border:0;border-top:1px solid var(--line);margin:46px 0}}
section{{margin-bottom:44px}}
.quote{{border-left:3px solid var(--ink);padding:6px 0 6px 20px;margin:22px 0;font-size:19px;letter-spacing:-.01em;max-width:60ch}}
.specs{{display:grid;grid-template-columns:1fr 1fr;gap:16px}}
.spec{{border:1px solid var(--line);border-radius:14px;padding:20px 22px;background:var(--surface)}}
.spec.rec{{border-color:var(--ink)}}
.sh{{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}}
.tag{{font-size:10px;text-transform:uppercase;letter-spacing:.08em;background:var(--ink);color:var(--paper);border-radius:999px;padding:3px 9px;font-weight:600}}
.lock{{display:flex;align-items:center;gap:12px;font-size:40px;line-height:1;margin-bottom:10px}}
.lock.sm{{font-size:21px;gap:7px;margin-bottom:14px;opacity:.85}}
.d{{font-size:12.5px;color:var(--muted);margin:0 0 6px}}
.v{{font-size:13px;margin:0}}
table{{width:100%;border-collapse:collapse;font-size:13.5px;margin-top:10px}}
td,th{{text-align:left;padding:9px 10px;border-bottom:1px solid var(--line)}}
th{{font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted)}}
.ok{{font-size:11px;color:var(--muted)}}
.box{{border:1px solid var(--line);border-radius:16px;padding:24px 26px;background:var(--surface)}}
.final{{display:flex;align-items:center;gap:20px;flex-wrap:wrap;padding:30px;border-radius:16px;background:var(--surface);border:1px solid var(--line);margin-top:16px}}
.final .big{{display:flex;align-items:center;gap:16px;font-family:'Fraunces',serif;font-weight:600;font-size:56px;letter-spacing:-.035em;line-height:1}}
.dkf{{background:#141312;border-color:transparent;color:#ededea}}
.next{{counter-reset:s;list-style:none;padding:0;margin:14px 0 0}}
.next li{{counter-increment:s;position:relative;padding-left:30px;margin-bottom:9px;font-size:13.5px}}
.next li::before{{content:counter(s);position:absolute;left:0;top:1px;width:20px;height:20px;border-radius:999px;background:var(--ink);color:var(--paper);font-size:11px;display:grid;place-items:center;font-weight:600}}
@media(max-width:820px){{.specs{{grid-template-columns:1fr}}.w{{padding:32px 16px 70px}}}}
</style>

<div class="w">
<h1>Logotype and colour</h1>
<p class="lede">Set in real type, not rendered as images — so what you see is what would ship.</p>

<div class="quote">You're not organised. The AI organises. You never lose a train of thought.</div>
<p>That is the best brief you have given me, and it decides both questions. It asks for
<strong>precise and forgiving at the same time</strong> — competent enough that you trust it with
the filing, warm enough that it is not scolding you for being messy. Cold technical type fails the
second half. Cute type fails the first.</p>

<hr/>

<section>
<h2>Eight ways to set it</h2>
<p>Each shown at wordmark scale and at UI scale, locked with the capsule-lid mark.</p>
<div class="specs">{"".join(specimen(f) for f in FACES)}</div>
</section>

<hr/>

<section>
<div class="box" style="border-color:var(--ink)">
<h4>Type recommendation</h4>
<p style="font-size:20px;font-weight:600;letter-spacing:-.015em;margin-bottom:12px">Fraunces for
the wordmark. Keep the system sans for the interface.</p>
<p>It is the only one here that is <em>warm and precise at once</em> — the exact pair the
positioning asks for. It is also the only one nobody will mistake for another tool, and a serif
against a sans UI is the single cheapest way to look considered.</p>
<p style="margin:0"><strong>Optima is the real alternative</strong> and it is free — already on
every Mac, no webfont, no loading. If you would rather not carry a font dependency for the sake of
a wordmark, take Optima and lose very little.</p>
</div>
</section>

<hr/>

<section>
<h2>The main colour</h2>
<p>Every reference you have sent — the drawer, the box, the wall racks, all of them — has a
<strong>neutral holder and coloured capsules</strong>. White, chrome, charcoal, walnut. The rack is
never the colour. That is not a coincidence, it is what makes the contents legible.</p>
<div class="quote" style="font-size:17px">Capso's brand colour is ink. The collection is the colour.</div>
<p>Which means the accent is not the brand — it is one functional signal for when the product
itself is speaking: confirm, focus, "I filed this". Small, rare, and never competing with a
capture.</p>

<h4 style="margin-top:28px">An honest finding, against my own earlier argument</h4>
<p>I tested five signal colours as single values across both themes. <strong>Terracotta was the
only one that passed.</strong> Not because it is the nicest — because warm mid-orange happens to
sit in the narrow luminance band that clears contrast on a cream ground <em>and</em> a near-black
one. Brass failed on cream, green and blue failed on ink.</p>
<p>So my anchoring was partly wrong and partly lucky. But it only binds if the accent must be one
value. <strong>The product already ships a paired accent</strong> — <code>globals.css</code>
overrides <code>--accent</code> in dark mode — so the hue is genuinely free:</p>
<table>
<tr><th>Family</th><th>Light value</th><th>Dark value</th></tr>
{pair_rows}
</table>
<p style="margin-top:12px;font-size:13px;color:var(--muted)">Each pair passes AA on its own ground.
With pairing available, choose on meaning rather than on physics.</p>
<p style="margin-top:14px"><strong>On meaning, sorted green is the strongest.</strong> Green is the
colour of <em>filed, done, handled</em> — which is precisely the promise. Terracotta is energetic
and slightly urgent; for a product whose whole pitch is "relax, it is handled", that is the wrong
emotional note, whatever the contrast table says.</p>
</section>

<hr/>

<section>
<h4>The lockup</h4>
<div class="final"><div class="big">{mark(56)}Capso</div>
  <div style="font-size:13px;color:var(--muted);max-width:34ch">Fraunces 600, mark at cap height,
  gap equal to the counter of the C. Ink on paper.</div></div>
<div class="final dkf"><div class="big">{mark(56, "#ededea")}Capso</div>
  <div style="font-size:13px;color:#9a9890;max-width:34ch">Same lockup inverted. The mark holds
  because it is a silhouette with one counter, not a line drawing.</div></div>
</section>

<hr/>

<section>
<div class="box">
<h4>What I would lock now</h4>
<ol class="next">
  <li><strong>Mark</strong> — the capsule lid that reads as a C. Hand-redraw on a grid</li>
  <li><strong>Wordmark</strong> — Fraunces 600, or Optima if you want zero font dependency</li>
  <li><strong>Brand colour</strong> — ink <code>#141312</code> on paper <code>#fbf9f5</code>. The collection is the colour</li>
  <li><strong>Signal</strong> — sorted green paired, replacing terracotta, on meaning rather than contrast</li>
  <li><strong>System</strong> — the rack: filled lid = filed, empty ring = still needs you</li>
</ol>
<p style="margin:16px 0 0;font-size:13px;color:var(--muted)">Changing the signal colour is one line
in <code>globals.css</code> plus its dark override — the <code>--accent-ink</code> token already
handles the text-on-accent flip.</p>
</div>
</section>
</div>
"""

out = ROOT / "board-type.html"
out.write_text(HTML)
print(f"wrote {out} ({len(HTML):,} bytes)")
for n, lt, a, dk, b in PAIRS:
    print(f"  {n:<14} light {lt} {a:.2f}   dark {dk} {b:.2f}")
