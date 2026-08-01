#!/usr/bin/env python3
"""Build the capsule-rack board."""
import re
from pathlib import Path

ROOT = Path("/Users/ek/Desktop/ekOS/20_projects/Capso/drafts/brand")
R = ROOT / "renders-rack"
INK, PAPER = "rgb(20,19,18)", "rgb(251,249,245)"

# Measured by rasterising and reading ink bounds. The source viewBox is 2048.
BBOX = {"R1-lid-a": (612, 612, 829, 829), "R2-grid-b": (513, 497, 1021, 1021)}
_c: dict[str, str] = {}


def inner(n: str) -> str:
    if n in _c:
        return _c[n]
    raw = (R / f"{n}.svg").read_text()
    body = re.sub(r'<path[^>]*d="M 0 0 L 2048 0 L 2048 2048 L 0 2048 L 0 0 z"\s*/>', "", raw, count=1)
    _c[n] = body[body.index(">", body.index("<svg")) + 1:].replace("</svg>", "").strip()
    return _c[n]


def mark(n: str, size: int, fg="#141312", bg="#fbf9f5") -> str:
    s = inner(n).replace(f'fill="{INK}"', f'fill="{fg}"').replace(f'fill="{PAPER}"', f'fill="{bg}"')
    x, y, w, h = BBOX.get(n, (0, 0, 2048, 2048))
    return (f'<svg viewBox="{x} {y} {w} {h}" width="{size}" height="{size}" aria-hidden="true" '
            f'style="display:block">{s}</svg>')


def reduction(n: str, fg="#141312", bg="#fbf9f5") -> str:
    return '<div class="icons">' + "".join(
        f'<div class="ic"><div class="icb" style="width:{max(px,34)}px;height:{max(px,34)}px">'
        f'{mark(n, px, fg, bg)}</div><span>{px}</span></div>' for px in (128, 48, 32, 16)
    ) + "</div>"


JEWEL = [("Gold", "#d4a94a", "8.46"), ("Cobalt", "#5a8ee0", "5.64"), ("Violet", "#a487e6", "6.35"),
         ("Emerald", "#4fb39a", "7.29"), ("Copper", "#dd9060", "7.28"), ("Crimson", "#e0697c", "5.73"),
         ("Slate", "#9fb0c4", "8.38")]
SHIPPED = [("Reference", "#4a6fa5"), ("Inspiration", "#5b7a4b"), ("Competitor", "#8f5c80"),
           ("Marketing hook", "#6a5ba8"), ("Content idea", "#3e7a75"), ("UX bug", "#a8465c")]


def swatches(items, bg, note_key=True):
    out = ""
    for it in items:
        name, hexv = it[0], it[1]
        extra = f'<em>{it[2]}:1</em>' if len(it) > 2 else ""
        out += (f'<div class="sw"><span class="dot" style="background:{hexv}"></span>'
                f'<b>{name}</b><code>{hexv}</code>{extra}</div>')
    return f'<div class="sws" style="background:{bg}">{out}</div>'


def rack(cols=8, rows=5, dark=True):
    """The system, drawn live: filled slots are filed captures, rings are unfiled."""
    import itertools
    hues = [h for _, h, _ in JEWEL]
    cells = ""
    seq = itertools.cycle(hues)
    empties = {3, 11, 19, 22, 30, 33, 37}
    for i in range(cols * rows):
        c = next(seq)
        if i in empties:
            cells += f'<span class="slot empty"></span>'
        else:
            cells += f'<span class="slot" style="background:{c}"></span>'
    return f'<div class="rack {"dk" if dark else ""}" style="--cols:{cols}">{cells}</div>'


HTML = f"""<title>Capso — the rack</title>
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
h3{{font-size:18px;margin:0 0 4px;font-weight:600;letter-spacing:-.01em}}
h4{{font-size:10.5px;margin:0 0 11px;font-weight:600;text-transform:uppercase;letter-spacing:.09em;color:var(--muted)}}
p{{margin:0 0 13px;max-width:68ch}}
.lede{{color:var(--muted);font-size:16.5px}}
code{{font:.84em ui-monospace,Menlo,monospace;background:color-mix(in srgb,var(--ink) 7%,transparent);padding:2px 5px;border-radius:4px}}
hr{{border:0;border-top:1px solid var(--line);margin:46px 0}}
section{{margin-bottom:44px}}
img{{max-width:100%;display:block;border-radius:12px}}
.rule{{border-left:3px solid var(--ink);padding:4px 0 4px 18px;margin:20px 0}}
.rule p{{margin:0}}
.box{{border:1px solid var(--line);border-radius:16px;padding:24px 26px;background:var(--surface)}}
.two{{display:grid;grid-template-columns:1fr 1fr;gap:22px;align-items:center}}
.mk{{display:grid;place-items:center;background:var(--paper);border:1px solid var(--line);border-radius:14px;padding:22px;min-height:210px}}
.mkd{{background:#141312;border-color:transparent}}
.tests{{display:grid;grid-template-columns:1fr 1fr;gap:22px;margin-top:20px;padding-top:18px;border-top:1px solid var(--line)}}
.icons{{display:flex;align-items:flex-end;gap:14px;flex-wrap:wrap}}
.ic{{display:grid;justify-items:center;gap:5px}}
.icb{{display:grid;place-items:center}}
.ic span{{font-size:10px;color:var(--muted)}}
.dk{{background:#141312;border-radius:10px;padding:14px}}
.dk .ic span{{color:#9a9890}}
.rack{{display:grid;grid-template-columns:repeat(var(--cols),1fr);gap:9px;padding:18px;border-radius:14px;background:var(--surface);border:1px solid var(--line)}}
.rack.dk{{background:#191817;border-color:transparent}}
.slot{{aspect-ratio:1;border-radius:99px;display:block}}
.rack.dk .slot.empty{{border:2px solid rgb(237 237 234/.38);background:transparent}}
.rack .slot.empty{{border:2px solid rgb(20 19 18/.28);background:transparent}}
.sws{{display:flex;flex-wrap:wrap;gap:10px;padding:16px;border-radius:14px;border:1px solid var(--line)}}
.sw{{display:grid;justify-items:center;gap:3px;min-width:96px}}
.dot{{width:30px;height:30px;border-radius:99px;display:block}}
.sw b{{font-size:12px;font-weight:600}}
.sw code{{font-size:10px;background:none;padding:0;opacity:.75}}
.sw em{{font-size:10px;font-style:normal;opacity:.6}}
.sws[style*="141312"]{{color:#ededea;border-color:rgb(237 237 234/.13)}}
table{{width:100%;border-collapse:collapse;font-size:13.5px;margin-top:8px}}
td,th{{text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top}}
th{{font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted)}}
.next{{counter-reset:s;list-style:none;padding:0;margin:14px 0 0}}
.next li{{counter-increment:s;position:relative;padding-left:30px;margin-bottom:9px;font-size:13.5px}}
.next li::before{{content:counter(s);position:absolute;left:0;top:1px;width:20px;height:20px;border-radius:999px;background:var(--ink);color:var(--paper);font-size:11px;display:grid;place-items:center;font-weight:600}}
@media(max-width:800px){{.two,.tests{{grid-template-columns:1fr}}.w{{padding:32px 16px 70px}}}}
</style>

<div class="w">
<h1>It isn't a character. It's the rack.</h1>
<p class="lede">All four of your references are the same satisfaction — capsules in an ordered
array, each a different jewel colour, held in a neutral shell. That is a much better brief than a
mascot, and it maps onto Capso almost exactly.</p>

<hr/>

<section>
<div class="rule"><p><strong>The grid is your masonry wall. The jewel lids are intent colours. The
neutral box is the UI.</strong> And the feeling you named — <em>everything is where it belongs</em>
— is what a full rack does that a pile of screenshots never will.</p></div>
<p>The OPRESSO mark in your first reference is also instructive: it is a capsule seen <em>from
above</em>, which is a ring. Top-down is the view that makes a capsule into a logo.</p>
</section>

<hr/>

<section>
<h2>The mark</h2>
<div class="two">
  <div class="mk">{mark("R1-lid-a", 190)}</div>
  <div>
    <h3>A capsule lid, which is also a C</h3>
    <p>Seen from overhead: the flange ring, the sealed centre, and one notch cut through the rim.
    The gap and the notch together make the ring read as a <strong>C</strong> — the initial and
    the object in one form, without drawing a letter.</p>
    <p style="margin:0">It solves what the notched disc from the last round could not: it says
    <em>capsule</em> and <em>Capso</em> at the same time, and it still reduces to a single
    silhouette.</p>
  </div>
</div>
<div class="tests">
  <div><h4>Reduction</h4>{reduction("R1-lid-a")}</div>
  <div><h4>On the dark shell</h4><div class="dk">{reduction("R1-lid-a", "#f4f1ea", "#141312")}</div></div>
</div>
</section>

<hr/>

<section>
<h2>The system — a rack that fills as you use it</h2>
<p>Every capture is a lid. Its colour is its intent. <strong>An empty ring is a slot not yet
filed</strong> — so the rack shows you, at a glance, both what you have and what still needs you.
That is the "insight" feeling you asked for, and it needs no chart.</p>
{rack(10, 4, dark=True)}
<p style="margin-top:14px;font-size:13px;color:var(--muted)">Drawn live in this page from the
palette below — not an image. The same grid is the app background, the OG card, the empty state and
the loading state.</p>
</section>

<hr/>

<section>
<h2>Colour — and a real constraint</h2>
<p>I sampled the jewel tones straight out of the product photograph rather than inventing them.
Then I checked them, and found something that decides the direction.</p>
<div class="rule"><p><strong>True jewel tones only work on a dark shell.</strong> Of seven colours
sampled from the photo, exactly one cleared 3:1 on both cream and ink. They are saturated and
mid-dark by nature — which is precisely why every reference you sent uses a black or charcoal
box.</p></div>

<h4 style="margin-top:26px">Option A — commit to the dark shell, get the full jewel range</h4>
{swatches(JEWEL, "#141312")}
<p style="margin-top:12px;font-size:13px;color:var(--muted)">All seven clear AA on ink. Rich,
premium, exactly the reference feeling. The cost: the app becomes dark-first, and light mode
becomes the secondary theme rather than the default.</p>

<h4 style="margin-top:28px">Option B — keep both themes, accept quieter jewels</h4>
{swatches(SHIPPED, "var(--surface)")}
<p style="margin-top:12px;font-size:13px;color:var(--muted)">The six already shipping in
<code>INTENT_COLOR</code>. Same hue families, pulled to mid-tone so one value clears 3:1 on cream
<em>and</em> ink. Less jewel-like, but no theme compromise and already in the product.</p>
</section>

<hr/>

<section>
<h2>The feeling, photographed</h2>
<img src="renders-rack/R5-hero-b.png" alt="Charcoal drawer of jewel-toned capsules on a warm desk" style="margin-bottom:14px">
<p style="font-size:13px;color:var(--muted)">Generated to the same brief as your references, with
the left third left empty for a headline. This is the OG card, the landing hero and the App Store
shot — the register the brand photographs in, rather than illustrates in.</p>
<img src="renders-rack/R4-box-a.png" alt="Top-down box of jewel capsules" style="margin-top:16px;max-width:420px">
</section>

<hr/>

<section>
<div class="box" style="border-color:var(--ink)">
<h4>Recommendation</h4>
<p style="font-size:21px;font-weight:600;letter-spacing:-.015em;margin-bottom:12px">
The lid mark, the rack as the system, and Option B on colour.</p>
<p>The mark and the rack I would take without hesitation — they came out of your references and
they are better than anything I proposed unprompted. The lid says capsule and C at once; the rack
turns your intent taxonomy into the thing people will remember.</p>
<p><strong>On colour I would take B, narrowly.</strong> A is more beautiful and it is what your
references actually look like — but it commits the product to dark-first, and your users are
capturing bright screenshots all day that will sit on that dark ground. B keeps both themes, is
already shipping, and the jewel richness lives in the photography instead, where nothing has to
pass a contrast check.</p>
<p style="margin:0"><strong>If you want A, say so.</strong> It is the more striking product and the
argument for it is real — it is just a bigger decision than a palette. It changes the default theme.</p>
<h4 style="margin-top:22px">Next</h4>
<ol class="next">
  <li>Hand-redraw the lid mark on a grid — ring weight, notch width and the gap need to be exact</li>
  <li>Run it through <code>build_icons.py</code> for favicon, extension, <code>.icns</code> and tray</li>
  <li>Build the rack as a real component — it is a CSS grid of dots, nothing more</li>
  <li>Serif logotype lockups beside the lid, set in a real webfont</li>
  <li>Shoot the hero properly once the mark exists, so the box can carry it</li>
</ol>
</div>
</section>
</div>
"""

out = ROOT / "board-rack.html"
out.write_text(HTML)
print(f"wrote {out} ({len(HTML):,} bytes)")
