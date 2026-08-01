#!/usr/bin/env python3
"""Capso brand review — mascot verdict, colour combinations, guidelines."""
import re
from pathlib import Path

ROOT = Path("/Users/ek/Desktop/ekOS/20_projects/Capso/drafts/brand")
INK, PAPER = "rgb(20,19,18)", "rgb(251,249,245)"
BB = (612, 612, 829, 829)
_c = {}


def L(h):
    h = h.lstrip("#")
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    c = [v / 12.92 if v <= .03928 else ((v + .055) / 1.055) ** 2.4 for v in c]
    return .2126 * c[0] + .7152 * c[1] + .0722 * c[2]


def cr(a, b):
    l1, l2 = L(a), L(b)
    return (max(l1, l2) + .05) / (min(l1, l2) + .05)


def mark(size, fg="#141312"):
    if "s" not in _c:
        raw = (ROOT / "renders-rack" / "R1-lid-a.svg").read_text()
        b = re.sub(r'<path[^>]*d="M 0 0 L 2048 0 L 2048 2048 L 0 2048 L 0 0 z"\s*/>', "", raw, count=1)
        _c["s"] = b[b.index(">", b.index("<svg")) + 1:].replace("</svg>", "").strip()
    s = _c["s"].replace(f'fill="{INK}"', f'fill="{fg}"').replace(f'fill="{PAPER}"', 'fill="none"')
    x, y, w, h = BB
    return (f'<svg viewBox="{x} {y} {w} {h}" width="{size}" height="{size}" aria-hidden="true" '
            f'style="display:block;flex:none">{s}</svg>')


# Four candidate systems. Each is (name, paper, ink, muted, signal, signal-ink, verdict, note)
DARK_PAIR = {"#2f6b4f": "#4f9e79", "#8f6512": "#c99a3a", "#c2461f": "#e8683a", "#141312": "#ededea"}

COMBOS = [
    ("Ink + Sorted green", "#fbf9f5", "#141312", "#6b6a64", "#2f6b4f", "#ffffff", "recommended",
     "Green is the colour of filed, done, handled. It says the promise rather than decorating it."),
    ("Ink + Brass", "#fbf9f5", "#141312", "#6b6a64", "#8f6512", "#ffffff", "warm alternative",
     "Closer to the metallic capsule lids in your references. Warmer, slightly more luxury, less semantic."),
    ("Ink + Terracotta", "#fbf9f5", "#141312", "#6b6a64", "#c2461f", "#ffffff", "incumbent",
     "What ships today. Energetic and faintly urgent — wrong note for a product that promises calm."),
    ("Ink only", "#fbf9f5", "#141312", "#6b6a64", "#141312", "#fbf9f5", "purist",
     "No signal colour at all; the captures carry every hue. Maximum restraint, but nothing to mark a state with."),
]

INTENTS = [("Reference", "#4a6fa5"), ("Inspiration", "#5b7a4b"), ("Competitor", "#8f5c80"),
           ("Hook", "#6a5ba8"), ("Idea", "#3e7a75"), ("Bug", "#a8465c")]


def combo(c):
    name, paper, ink, muted, sig, sigink, verdict, note = c
    dots = "".join(f'<span class="d" style="background:{h}" title="{n}"></span>' for n, h in INTENTS)
    dark = DARK_PAIR[sig]
    on_paper = cr(sig, paper)
    on_ink = cr(dark, "#141312")          # the DARK partner on the dark ground
    white = cr(sigink, sig)
    cls = "combo rec" if verdict == "recommended" else "combo"
    return f"""<div class="{cls}">
  <div class="ch"><h3>{name}</h3><span class="tag">{verdict}</span></div>
  <div class="ui" style="--p:{paper};--i:{ink};--m:{muted};--s:{sig};--si:{sigink}">
    <div class="bar">{mark(17, ink)}<b>Capso</b><span class="sp"></span><span class="pill">Capture</span></div>
    <div class="body">
      <div class="strip"><span class="dot"></span>3 captures need a project</div>
      <div class="cards">
        <div class="c"><div class="im"></div><p><i style="background:{INTENTS[0][1]}"></i>Pricing toggle</p></div>
        <div class="c"><div class="im"></div><p><i style="background:{INTENTS[1][1]}"></i>Empty state</p></div>
        <div class="c"><div class="im"></div><p><i style="background:{INTENTS[5][1]}"></i>Overlay bug</p></div>
      </div>
    </div>
  </div>
  <div class="sws">
    <span class="sw" style="background:{paper};border-color:rgb(0 0 0/.12)"></span>
    <span class="sw" style="background:{ink}"></span>
    <span class="sw" style="background:{sig}"></span>
    <span class="dots">{dots}</span>
  </div>
  <p class="note">{note}</p>
  <p class="nums">light <code>{sig}</code> on paper <b>{on_paper:.2f}</b> · dark <code>{dark}</code> on ink <b>{on_ink:.2f}</b> · label <b>{white:.2f}</b></p>
</div>"""


HTML = f"""<title>Capso — brand review</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600&display=swap" rel="stylesheet">
<style>
:root{{--paper:#fbf9f5;--surface:#fff;--ink:#141312;--muted:#6b6a64;--line:rgb(20 19 18/.11);--green:#2f6b4f}}
@media (prefers-color-scheme:dark){{:root{{--paper:#141312;--surface:#1c1c19;--ink:#ededea;--muted:#9a9890;--line:rgb(237 237 234/.13);--green:#4f9e79}}}}
:root[data-theme=dark]{{--paper:#141312;--surface:#1c1c19;--ink:#ededea;--muted:#9a9890;--line:rgb(237 237 234/.13);--green:#4f9e79}}
:root[data-theme=light]{{--paper:#fbf9f5;--surface:#fff;--ink:#141312;--muted:#6b6a64;--line:rgb(20 19 18/.11);--green:#2f6b4f}}
*{{box-sizing:border-box}}
body{{margin:0;background:var(--paper);color:var(--ink);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,system-ui,sans-serif;-webkit-font-smoothing:antialiased}}
.w{{max-width:1040px;margin:0 auto;padding:56px 24px 100px}}
h1{{font-size:36px;letter-spacing:-.03em;margin:0 0 10px;font-weight:600;line-height:1.1}}
h2{{font-size:23px;letter-spacing:-.02em;margin:0 0 8px;font-weight:600}}
h3{{font-size:15.5px;margin:0;font-weight:600}}
h4{{font-size:10.5px;margin:0 0 11px;font-weight:600;text-transform:uppercase;letter-spacing:.09em;color:var(--muted)}}
p{{margin:0 0 13px;max-width:70ch}}
.lede{{color:var(--muted);font-size:16.5px}}
code{{font:.84em ui-monospace,Menlo,monospace;background:color-mix(in srgb,var(--ink) 7%,transparent);padding:2px 5px;border-radius:4px}}
hr{{border:0;border-top:1px solid var(--line);margin:48px 0}}
section{{margin-bottom:46px}}
img{{max-width:100%;display:block;border-radius:12px}}
.quote{{border-left:3px solid var(--green);padding:6px 0 6px 20px;margin:22px 0;font-size:19px;letter-spacing:-.01em;max-width:60ch}}
.verdict{{border:1px solid var(--green);border-radius:16px;padding:26px 28px;background:color-mix(in srgb,var(--green) 6%,var(--surface))}}
.big{{font-size:22px;font-weight:600;letter-spacing:-.015em;margin:0 0 12px}}
.lock{{display:flex;align-items:center;gap:14px;font-family:'Fraunces',serif;font-weight:600;font-size:44px;letter-spacing:-.035em;line-height:1}}
.combos{{display:grid;grid-template-columns:1fr 1fr;gap:18px}}
.combo{{border:1px solid var(--line);border-radius:14px;padding:18px;background:var(--surface)}}
.combo.rec{{border-color:var(--green);border-width:2px}}
.ch{{display:flex;justify-content:space-between;align-items:center;margin-bottom:13px}}
.tag{{font-size:10px;text-transform:uppercase;letter-spacing:.08em;border:1px solid var(--line);border-radius:999px;padding:3px 9px;color:var(--muted)}}
.combo.rec .tag{{background:var(--green);color:#fff;border-color:transparent;font-weight:600}}
.ui{{border-radius:10px;overflow:hidden;background:var(--p);color:var(--i);border:1px solid rgb(0 0 0/.10);font-size:11px}}
.ui .bar{{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid rgb(0 0 0/.09)}}
.ui .bar b{{font-size:12px}}
.sp{{flex:1}}
.pill{{background:var(--s);color:var(--si);border-radius:999px;padding:3px 10px;font-size:10px;font-weight:500}}
.ui .body{{padding:10px}}
.strip{{display:flex;align-items:center;gap:7px;border:1px solid rgb(0 0 0/.09);border-radius:7px;padding:6px 9px;margin-bottom:9px;font-size:10.5px}}
.strip .dot{{width:6px;height:6px;border-radius:99px;background:var(--s)}}
.cards{{display:grid;grid-template-columns:1fr 1fr 1fr;gap:7px}}
.c{{border:1px solid rgb(0 0 0/.09);border-radius:7px;overflow:hidden}}
.c .im{{height:32px;background:rgb(0 0 0/.05)}}
.c p{{margin:0;padding:5px 6px;font-size:9.5px;display:flex;align-items:center;gap:5px;color:var(--m)}}
.c i{{width:6px;height:6px;border-radius:99px;flex:none}}
.sws{{display:flex;align-items:center;gap:6px;margin-top:12px}}
.sw{{width:26px;height:26px;border-radius:7px;border:1px solid transparent;display:block}}
.dots{{display:flex;gap:3px;margin-left:6px}}
.dots .d{{width:11px;height:11px;border-radius:99px;display:block}}
.note{{font-size:12.5px;color:var(--muted);margin:10px 0 4px}}
.nums{{font-size:11px;color:var(--muted);margin:0;font-family:ui-monospace,Menlo,monospace}}
.nums b{{color:var(--ink)}}
.two{{display:grid;grid-template-columns:1fr 1fr;gap:22px}}
.rules{{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:14px}}
.rules ul{{margin:6px 0 0;padding-left:17px;font-size:13px;color:var(--muted)}}
.rules li{{margin-bottom:6px}}
.do li::marker{{color:var(--green)}}
.box{{border:1px solid var(--line);border-radius:16px;padding:24px 26px;background:var(--surface)}}
.next{{counter-reset:s;list-style:none;padding:0;margin:14px 0 0}}
.next li{{counter-increment:s;position:relative;padding-left:30px;margin-bottom:9px;font-size:13.5px}}
.next li::before{{content:counter(s);position:absolute;left:0;top:1px;width:20px;height:20px;border-radius:999px;background:var(--green);color:#fff;font-size:11px;display:grid;place-items:center;font-weight:600}}
@media(max-width:840px){{.combos,.two,.rules{{grid-template-columns:1fr}}.w{{padding:32px 16px 70px}}}}
</style>

<div class="w">
<div class="lock" style="margin-bottom:22px">{mark(46)}Capso</div>
<h1>Brand review</h1>
<p class="lede">The verdict on the mascot, the colour systems side by side in the real UI, and the
rules that follow from both.</p>
<div class="quote">You're not organised. The AI organises. You never lose a train of thought.</div>

<hr/>

<section>
<h2>Mascot: no — and here is the evidence rather than an opinion</h2>
<p>I tested it properly rather than asserting. Two facts decided it.</p>
<p><strong>First, your own references.</strong> Five sets now — the drawer, the box, two wall racks,
the vertical holder. Not one contains a character. They are all <em>objects, ordered</em>. That is
the emotional register you keep reaching for.</p>
<p><strong>Second, the Mobbin evidence.</strong> Almost nobody ships a mascot inside a working
interface. Alan's bear is on the login screen, Gusto's pig is a loading state, Homerun's dog is a
thank-you. Duolingo is the exception and Duolingo is a game.</p>
<div class="verdict">
  <p class="big">No character. The mark itself carries the life.</p>
  <p style="margin-bottom:16px">This is the 2026 "living brand element" idea done correctly for a
  professional tool: the logo has <strong>states</strong> rather than a face. And these map exactly
  onto the four states already in <code>capture.tsx:268-275</code> — loading, suggestion, confirmed,
  timeout.</p>
  <img src="renders-system/F4-state-a.webp" alt="Four states of the mark" style="max-width:560px">
  <p style="margin:14px 0 0;font-size:13px;color:var(--muted)">At rest · listening · understood ·
  filed. Same geometry throughout, only the interior changes. It can be animated with the existing
  <code>--dur-panel</code> tokens and needs no new dependency.</p>
</div>
</section>

<hr/>

<section>
<h2>The feeling</h2>
<img src="renders-system/F1-feel-a.png" alt="Wall rack in raking daylight">
<p style="margin-top:14px;font-size:13.5px;color:var(--muted)">Quiet order. Neutral holder, one
green among the metals, light doing the work. This is the photographic register — calm and
expensive, never busy. Note the brand does not appear in it at all.</p>
</section>

<section>
<h2>Chaos in, order out</h2>
<img src="renders-system/F2-flow-b.webp" alt="Scattered rectangles resolving into a grid" style="max-width:720px">
<p style="margin-top:14px;font-size:13.5px;color:var(--muted)">Your positioning line as a diagram,
and the single most useful graphic device in the system. It is the landing page hero, the onboarding
explainer and the empty state — one idea, reused.</p>
</section>

<hr/>

<section>
<h2>Colour combinations, in the actual UI</h2>
<p>Each system applied to the same interface, with measured contrast underneath. The six intent
dots are constant across all four — they are the content's colour, not the brand's.</p>
<div class="combos">{"".join(combo(c) for c in COMBOS)}</div>
</section>

<hr/>

<section>
<h2>Brand elements</h2>
<div class="two">
  <img src="renders-system/F3-elem-a.webp" alt="Element sheet">
  <div>
    <h4>A small utility set</h4>
    <p style="font-size:13.5px">Disc, ring, dot row, rule with terminal, rounded square, bracket
    pair, stacked lines, plus. All on the same stroke weight and grid as the mark.</p>
    <p style="font-size:13.5px;margin:0">These are what fill the gaps a mascot would otherwise be
    asked to fill — dividers, empty states, loading, section marks. Restrained, reusable, and they
    never compete with a screenshot.</p>
  </div>
</div>
</section>

<hr/>

<section>
<h2>The rules</h2>
<div class="rules">
  <div><h4>Do</h4><ul class="do">
    <li>Let the captures carry the colour. The interface stays ink on paper</li>
    <li>Use the signal green only when the product speaks — confirm, focus, filed</li>
    <li>Keep the mark's four states tied to real product states, never decorative</li>
    <li>Set the wordmark in Fraunces; keep the system sans in the UI</li>
    <li>Photograph objects in order, never illustrate a character</li>
    <li>Show empty slots — an unfilled ring is information, not a blank</li>
  </ul></div>
  <div><h4>Don't</h4><ul>
    <li>No face, no eyes, no creature. Ever</li>
    <li>No gradient meshes, no sparkles for AI, no glow</li>
    <li>Never put the signal colour on a capture card — it competes</li>
    <li>No second accent. One signal, or the system stops meaning anything</li>
    <li>Don't texture the working UI. Grain belongs to marketing if anywhere</li>
    <li>Never use intent colours as text, only as dots — they are tuned for 3:1, not 4.5</li>
  </ul></div>
</div>
</section>

<hr/>

<section>
<div class="box" style="border-color:var(--green)">
<h4>The full recommendation</h4>
<div class="lock" style="font-size:36px;margin-bottom:18px">{mark(38)}Capso</div>
<table style="width:100%;border-collapse:collapse;font-size:13.5px">
<tr><td style="padding:7px 0;border-bottom:1px solid var(--line);width:130px"><b>Mark</b></td>
<td style="padding:7px 0;border-bottom:1px solid var(--line)">Capsule lid seen from above, which also reads as a C. Four states, no face</td></tr>
<tr><td style="padding:7px 0;border-bottom:1px solid var(--line)"><b>Wordmark</b></td>
<td style="padding:7px 0;border-bottom:1px solid var(--line)">Fraunces 600, or Optima if you want zero font dependency</td></tr>
<tr><td style="padding:7px 0;border-bottom:1px solid var(--line)"><b>Ground</b></td>
<td style="padding:7px 0;border-bottom:1px solid var(--line)"><code>#fbf9f5</code> paper · <code>#141312</code> ink</td></tr>
<tr><td style="padding:7px 0;border-bottom:1px solid var(--line)"><b>Signal</b></td>
<td style="padding:7px 0;border-bottom:1px solid var(--line)">Sorted green <code>#2f6b4f</code> light · <code>#4f9e79</code> dark</td></tr>
<tr><td style="padding:7px 0;border-bottom:1px solid var(--line)"><b>Content</b></td>
<td style="padding:7px 0;border-bottom:1px solid var(--line)">Six intent dots, already shipping in <code>INTENT_COLOR</code></td></tr>
<tr><td style="padding:7px 0"><b>System</b></td>
<td style="padding:7px 0">The rack — filled lid is filed, empty ring still needs you</td></tr>
</table>
<h4 style="margin-top:24px">To ship it</h4>
<ol class="next">
  <li>Hand-redraw the lid mark on a grid — ring weight, notch width, gap</li>
  <li>Swap <code>--accent</code> to the green pair; <code>--accent-ink</code> already handles the label flip</li>
  <li>Regenerate the icon set with <code>build_icons.py</code> from the one SVG</li>
  <li>Add Fraunces to the marketing surfaces only, never the app bundle</li>
  <li>Amend <code>15_DESIGN_SYSTEM_AND_UX.md:79-84</code> — the "no mascot" rule now matches the decision rather than contradicting it</li>
</ol>
</div>
</section>
</div>
"""

out = ROOT / "board-review.html"
out.write_text(HTML)
print(f"wrote {out} ({len(HTML):,} bytes)")
for n, p, i, m, s, si, v, _ in COMBOS:
    print(f"  {n:<22} light {s} {cr(s,p):.2f}   dark {DARK_PAIR[s]} {cr(DARK_PAIR[s],'#141312'):.2f}   label {cr(si,s):.2f}")
