#!/usr/bin/env python3
"""Capso — colour and type options, shown as the real product surface.

    python3 drafts/brand/build_options.py

Every colour world renders the same reduced Capso home screen: rail, search,
three captures with intent dots, the two buttons. Only the palette changes, so
what you are comparing is feel rather than swatches. Same for type — identical
copy in every pairing.

Contrast is computed, not asserted by hand, and every world's numbers are
printed under its mock. Anything failing AA is labelled as failing rather than
quietly dropped.
"""
import re
from pathlib import Path

ROOT = Path("/Users/ek/Desktop/ekOS/20_projects/Capso/drafts/brand")
MARK = ROOT / "mark" / "capso-lid.svg"


def L(h: str) -> float:
    h = h.lstrip("#")
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    c = [v / 12.92 if v <= .03928 else ((v + .055) / 1.055) ** 2.4 for v in c]
    return .2126 * c[0] + .7152 * c[1] + .0722 * c[2]


def cr(a: str, b: str) -> float:
    l1, l2 = L(a), L(b)
    return (max(l1, l2) + .05) / (min(l1, l2) + .05)


_raw = re.sub(r"<!--.*?-->", "", MARK.read_text(), flags=re.S)
LID = _raw[_raw.index(">", _raw.index("<svg")) + 1: _raw.rindex("</svg>")].strip()


def lid(size: float, uid: str, color: str = "currentColor") -> str:
    s = (LID.replace('id="capso-notch"', f'id="cn{uid}"')
            .replace("url(#capso-notch)", f"url(#cn{uid})"))
    return (f'<svg viewBox="0 0 24 24" width="{size}" height="{size}" aria-hidden="true" '
            f'style="display:block;flex:none;color:{color}">{s}</svg>')


# INTENT_COLOR, as shipping in apps/web/components/ui.tsx
INTENTS = ["#4a6fa5", "#5b7a4b", "#8f5c80", "#6a5ba8", "#3e7a75", "#a8465c"]

# ---------------------------------------------------------------- worlds
# (key, name, ground, surface, ink, muted, accent-or-None, one-line read)
WORLDS = [
    ("bone", "Bone &amp; Ink", "#f4f0eb", "#faf8f4", "#1f1f1e", "#6f6a62", None,
     "What ships today. Warm neutral, near-black type, zero hue. Screenshots sit on it "
     "as objects on a surface rather than dissolving into a white page."),
    ("paper", "Paper &amp; Graphite", "#f4f4f2", "#fafafa", "#26262b", "#6c6c72", None,
     "The same idea with the warmth taken out. Cooler, flatter, more Swiss — reads "
     "engineered and precise, but also more anonymous. Closest to default-SaaS grey."),
    ("oat", "Oat &amp; Cocoa", "#f2ece1", "#f9f5ee", "#2b211a", "#736759", None,
     "Pushes the coffee reference furthest: the ink is brown-black rather than neutral. "
     "Softest and most physical of the six. Risk is that it starts to read as a "
     "lifestyle brand rather than a tool."),
    ("porcelain", "Porcelain &amp; Slate", "#f6f7f8", "#fdfdfe", "#1b222b", "#666e79", None,
     "Cool white, blue-black ink. The most obviously 'software' of the neutrals and the "
     "highest contrast. Clean, but the ground is close enough to white that captures "
     "stop having edges."),
    ("indigo", "Bone &amp; Ink + one accent", "#f4f0eb", "#faf8f4", "#1f1f1e", "#6f6a62", "#3d4a8f",
     "The option the outside review argued for: keep the neutral base, add one indigo "
     "reserved for AI surfaces and the primary CTA. Shown so the trade is visible "
     "rather than argued about."),
    ("espresso", "Espresso", "#17120f", "#211a16", "#efe7dc", "#95897b", None,
     "Dark-first. Photographs beautifully and feels expensive — but the product is "
     "bright screenshots all day, and here every capture becomes a light box punched "
     "in a dark field."),
]

CARDS = [
    ("Linear — annual billing toggle", 0, [.72, .5, .62, .4]),
    ("Notion — AI accept / discard", 4, [.6, .78, .45, .55]),
    ("Arc — sidebar project grouping", 2, [.55, .42, .7, .48]),
]


def app_mock(key: str, ink: str, accent: str | None) -> str:
    """The reduced Capso home screen. Same markup for every world."""
    btn = accent or ink
    cards = ""
    for i, (title, ci, bars) in enumerate(CARDS):
        hue = INTENTS[ci]
        rows = "".join(f'<span style="width:{int(w*100)}%"></span>' for w in bars)
        cards += (
            f'<div class="c">'
            f'  <div class="shot" style="--h:{hue}">'
            f'    <div class="chrome"><i></i><i></i><i></i></div>'
            f'    <div class="bars">{rows}</div>'
            f'    <div class="pill"></div>'
            f'  </div>'
            f'  <div class="ct"><span class="dot" style="background:{hue}"></span><b>{title}</b></div>'
            f'</div>')
    nav = "".join(f"<span>{n}</span>" for n in ("Inbox", "All captures", "Search", "Memory"))
    proj = "".join(f'<span>{n}<i>{c}</i></span>' for n, c in
                   [("Pricing page redesign", 3), ("Onboarding teardown", 5), ("Q3 launch", 3)])
    return f"""<div class="app">
  <aside>
    <div class="wm">{lid(15, key + 'w')}Capso</div>
    <nav>{nav}</nav>
    <div class="ph">Projects</div>
    <div class="pl">{proj}</div>
  </aside>
  <main>
    <div class="sb">Search your memory…<kbd>⌘K</kbd></div>
    <div class="rs">{lid(11, key + 'r')}<span>Resurfaced · you saved this for the same
      question in March</span></div>
    <div class="cards">{cards}</div>
    <div class="acts"><span class="gh">Import…</span>
      <span class="cta" style="background:{btn}">Capture</span></div>
  </main>
</div>"""


def audit(ground: str, surface: str, ink: str, muted: str, accent: str | None) -> str:
    rows = [("ink / ground", cr(ink, ground), 4.5),
            ("muted / ground", cr(muted, ground), 4.5),
            ("ink / surface", cr(ink, surface), 4.5),
            ("worst dot / ground", min(cr(h, ground) for h in INTENTS), 3.0)]
    if accent:
        rows.append(("ground / accent (button)", cr(ground, accent), 4.5))
    out = ""
    for name, v, floor in rows:
        ok = "pass" if v >= floor else "FAIL"
        out += (f'<span class="m {"bad" if ok == "FAIL" else ""}">{name}'
                f'<b>{v:.2f}:1</b><i>{ok} · AA {floor}</i></span>')
    return f'<div class="audit">{out}</div>'


# ---------------------------------------------------------------- type
# All Google Fonts, all SIL OFL 1.1. Fraunces was verified against the upstream
# OFL.txt directly; the rest come from the same library under the same licence.
# (display family, display css, display weight/style, ui stack, name, note)
PAIRS = [
    ("Fraunces", "'Fraunces',serif", 600, "-apple-system,BlinkMacSystemFont,system-ui,sans-serif",
     "Fraunces 600 + system sans",
     "What the guideline currently specifies. A soft, slightly wonky serif with an optical "
     "axis — warm without being cute, and the italic is characterful enough to carry emphasis "
     "on its own. No webfont in the product.", "current"),
    ("Instrument Serif", "'Instrument Serif',serif", 400, "'Inter',system-ui,sans-serif",
     "Instrument Serif + Inter",
     "Higher contrast, tighter, more fashion-editorial. Sharper and more current than Fraunces, "
     "but colder — it borrows authority rather than warmth, and it only has one weight.", ""),
    ("Newsreader", "'Newsreader',serif", 500, "-apple-system,BlinkMacSystemFont,system-ui,sans-serif",
     "Newsreader 500 + system sans",
     "The most neutral serif of the three. Bookish, quiet, reads like a well-set article. "
     "Least likely to date; also least likely to be remembered.", ""),
    ("Bricolage Grotesque", "'Bricolage Grotesque',sans-serif", 600, "'Inter',system-ui,sans-serif",
     "Bricolage Grotesque + Inter",
     "No serif at all. The 2026 expressive-grotesk register: quirky, tightly spaced, a bit "
     "irregular on purpose. Feels newer than any serif here, and noticeably younger — but it "
     "<b>has no italic</b> (Google Fonts rejects the ital axis with a 400), so the slant above is "
     "synthesised by the browser and the emphasis rule would have to change.", ""),
    ("Playfair Display", "'Playfair Display',serif", 600, "'Inter',system-ui,sans-serif",
     "Playfair Display + Inter",
     "Classical, high-contrast, luxury-adjacent. Elegant at large sizes but it is everywhere, "
     "and it pulls the brand towards wedding-invitation rather than tool.", ""),
    ("Inter Tight", "'Inter Tight',sans-serif", 600, "'Inter',system-ui,sans-serif",
     "Inter Tight + Inter",
     "One family throughout, display cut tightened. Maximum coherence and zero personality — "
     "this is what almost every AI product already looks like.", ""),
]

FONT_URL = ("https://fonts.googleapis.com/css2"
            "?family=Bricolage+Grotesque:opsz,wght@12..96,600"
            "&family=Fraunces:ital,opsz,wght@0,9..144,600;1,9..144,600"
            "&family=Instrument+Serif:ital@0;1"
            "&family=Inter+Tight:wght@400;600"
            "&family=Inter:wght@400;500;600"
            "&family=Newsreader:ital,opsz,wght@0,6..72,500;1,6..72,500"
            "&family=Playfair+Display:ital,wght@0,600;1,600&display=block")

worlds_html = ""
for key, name, bg, su, ink, mu, ac, note in WORLDS:
    line = f"rgb({int(ink[1:3],16)} {int(ink[3:5],16)} {int(ink[5:7],16)} / .12)"
    tag = '<span class="tag">ships today</span>' if key == "bone" else ""
    worlds_html += f"""
<figure class="world">
  <div class="frame" style="--bg:{bg};--su:{su};--ink:{ink};--mu:{mu};--line:{line};--btnink:{bg}">
    {app_mock(key, ink, ac)}
  </div>
  <figcaption>
    <h3>{name}{tag}</h3>
    <div class="hex"><code>{bg}</code><code>{su}</code><code>{ink}</code><code>{mu}</code>
      {f'<code>{ac}</code>' if ac else ''}</div>
    <p>{note}</p>
    {audit(bg, su, ink, mu, ac)}
  </figcaption>
</figure>"""

pairs_html = ""
for i, (fam, css, wt, ui, name, note, tag) in enumerate(PAIRS):
    chip = '<span class="tag">current</span>' if tag else ""
    pairs_html += f"""
<figure class="pair">
  <div class="frame ptype">
    <div class="plock" style="font-family:{css};font-weight:{wt}">{lid(26, f'p{i}')}Capso</div>
    <p class="phead" style="font-family:{css};font-weight:{wt}">You’re not organised.<br/>
      <em>Capso is.</em></p>
    <p class="pui" style="font-family:{ui}">Onboarding teardown · 5 captures · 1 Aug ·
      <span>filed automatically</span></p>
  </div>
  <figcaption><h3>{name}{chip}</h3><p>{note}</p></figcaption>
</figure>"""

HTML = f"""<title>Capso — colour and type options</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="{FONT_URL}" rel="stylesheet">
<style>
:root{{--pg:#f4f0eb;--pi:#1f1f1e;--pm:#6f6a62;--pl:rgb(31 31 30/.13);--ps:#faf8f4}}
@media (prefers-color-scheme:dark){{:root{{--pg:#151513;--pi:#efece5;--pm:#928d84;--pl:rgb(239 236 229/.15);--ps:#1d1d1a}}}}
*{{box-sizing:border-box}}
body{{margin:0;background:var(--pg);color:var(--pi);
  font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,system-ui,sans-serif;
  -webkit-font-smoothing:antialiased}}
.w{{max-width:1180px;margin:0 auto;padding:58px 30px 110px}}
h1{{font-family:'Fraunces',serif;font-weight:600;font-size:48px;letter-spacing:-.04em;
  line-height:1.04;margin:0 0 14px}}
h2{{font-family:'Fraunces',serif;font-weight:600;font-size:29px;letter-spacing:-.03em;margin:0 0 8px}}
h3{{font-size:16px;font-weight:600;margin:0 0 7px;display:flex;align-items:center;gap:9px}}
.lede{{color:var(--pm);font-size:16.5px;max-width:70ch;margin:0}}
hr{{border:0;border-top:1px solid var(--pl);margin:46px 0}}
.tag{{font-size:9.5px;letter-spacing:.09em;text-transform:uppercase;font-weight:600;
  border:1px solid var(--pl);border-radius:999px;padding:2px 8px;color:var(--pm)}}
.grid{{display:grid;grid-template-columns:1fr 1fr;gap:38px 30px;margin-top:30px}}
figure{{margin:0}}
figcaption p{{font-size:13.5px;color:var(--pm);margin:0 0 10px;line-height:1.55}}
.hex{{display:flex;gap:7px;flex-wrap:wrap;margin-bottom:9px}}
.hex code{{font:10.5px ui-monospace,Menlo,monospace;color:var(--pm);
  border:1px solid var(--pl);border-radius:5px;padding:1px 5px}}
.frame{{border:1px solid var(--pl);border-radius:14px;overflow:hidden;margin-bottom:15px}}
.audit{{display:flex;flex-wrap:wrap;gap:6px}}
.m{{display:flex;flex-direction:column;border:1px solid var(--pl);border-radius:8px;
  padding:5px 9px;font-size:9.5px;color:var(--pm);letter-spacing:.02em}}
.m b{{font-size:12.5px;color:var(--pi);font-weight:600;margin-top:1px}}
.m i{{font-style:normal;font-size:9px}}
.m.bad{{border-color:#a8465c;color:#a8465c}}.m.bad b{{color:#a8465c}}

/* ---- the mock ---- */
.app{{background:var(--bg);color:var(--ink);display:grid;grid-template-columns:132px 1fr;
  height:252px;font-size:9px}}
.app aside{{border-right:1px solid var(--line);padding:12px 11px;display:flex;
  flex-direction:column;gap:11px}}
.wm{{display:flex;align-items:center;gap:6px;font-weight:600;font-size:12.5px;letter-spacing:-.02em}}
.app nav,.pl{{display:flex;flex-direction:column;gap:6px}}
.app nav span{{font-size:9.5px}}
.ph{{font-size:7.5px;letter-spacing:.11em;text-transform:uppercase;color:var(--mu)}}
.pl span{{display:flex;justify-content:space-between;font-size:9.5px}}
.pl i{{font-style:normal;color:var(--mu)}}
.app main{{padding:12px 13px;display:flex;flex-direction:column;gap:9px;min-width:0}}
.sb{{border:1px solid var(--line);background:var(--su);border-radius:7px;padding:7px 9px;
  color:var(--mu);display:flex;justify-content:space-between;align-items:center;font-size:9.5px}}
.sb kbd{{font:7.5px ui-monospace,Menlo,monospace;border:1px solid var(--line);
  border-radius:3px;padding:1px 4px}}
.rs{{display:flex;align-items:center;gap:6px;color:var(--mu);font-size:8.5px;line-height:1.35}}
.cards{{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;min-height:0}}
.c{{background:var(--su);border:1px solid var(--line);border-radius:7px;overflow:hidden;
  display:flex;flex-direction:column;min-width:0}}
.shot{{background:color-mix(in srgb,var(--h) 13%,var(--su));padding:6px;flex:1;
  display:flex;flex-direction:column;gap:4px;position:relative}}
.chrome{{display:flex;gap:2px;margin-bottom:2px}}
.chrome i{{width:3px;height:3px;border-radius:9px;background:color-mix(in srgb,var(--h) 45%,transparent)}}
.bars{{display:flex;flex-direction:column;gap:3px}}
.bars span{{height:3px;border-radius:2px;background:color-mix(in srgb,var(--h) 32%,transparent);display:block}}
.pill{{position:absolute;right:6px;bottom:6px;width:20px;height:6px;border-radius:9px;
  background:color-mix(in srgb,var(--h) 62%,transparent)}}
.ct{{display:flex;align-items:center;gap:4px;padding:5px 6px;font-size:8px;min-width:0}}
.ct b{{font-weight:400;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}}
.dot{{width:4px;height:4px;border-radius:9px;flex:none;display:block}}
.acts{{display:flex;gap:6px;justify-content:flex-end;margin-top:auto}}
.gh{{border:1px solid var(--line);background:var(--su);border-radius:999px;padding:5px 11px;font-size:9px}}
.cta{{border-radius:999px;padding:5px 13px;font-size:9px;font-weight:500;color:var(--btnink)}}

/* ---- type specimens ---- */
.ptype{{background:var(--ps);padding:24px 26px 26px;height:252px;display:flex;
  flex-direction:column;gap:16px}}
.plock{{display:flex;align-items:center;gap:10px;font-size:27px;letter-spacing:-.035em;line-height:1}}
.phead{{font-size:34px;line-height:1.06;letter-spacing:-.035em;margin:auto 0 0}}
.phead em{{font-style:italic}}
.pui{{font-size:12.5px;color:var(--pm);margin:0}}
.pui span{{color:var(--pi)}}
.close{{border-top:1px solid var(--pl);padding-top:32px;max-width:72ch}}
.close p{{margin:0 0 13px}}
code{{font:.85em ui-monospace,Menlo,monospace}}
@media(max-width:900px){{.grid{{grid-template-columns:1fr}}h1{{font-size:34px}}}}
</style>

<div class="w">
<h1>Colour and type, side by side</h1>
<p class="lede">Every colour world below renders the same reduced Capso home screen — rail, search,
a resurfaced line, three captures, both buttons. Only the palette changes, so what you are judging
is feel rather than swatches. Same for type: identical copy in all six.</p>

<hr/>

<h2>Six colour worlds</h2>
<p class="lede">Ratios are computed, not eyeballed. All six clear AA; where one is close, the number
says so. The intent dots stay identical throughout — they are semantic and already shipping.</p>
<div class="grid">{worlds_html}</div>

<hr/>

<h2>Six type pairings</h2>
<p class="lede">Display font sets the wordmark and marketing headlines only. The interface line
underneath shows the UI font that ships with it. All six families are Google Fonts under SIL OFL
1.1 — the licence question is not a differentiator here.</p>
<div class="grid">{pairs_html}</div>

<hr/>

<div class="close">
<h2>Where I land</h2>
<p><strong>Bone &amp; Ink, and Fraunces.</strong> Not because they are what we already built —
here is what changed my mind while making this page.</p>
<p><strong>Paper and Porcelain lose the captures.</strong> Put the three cards side by side across
the six mocks: on the cooler grounds the surface and the ground converge and the cards stop having
edges. Bone and Oat keep them as objects. That is a functional difference in a product that is
almost entirely other people's screenshots, not a taste one.</p>
<p><strong>Oat is the real alternative</strong>, and it is a genuine choice rather than a
concession — warmer, more physical, closest to the reference photographs. It is the one I would
switch to if you want the coffee reference louder. The cost is that brown-black ink reads
lifestyle sooner than it reads tool.</p>
<p><strong>The indigo variant is the useful one to look at.</strong> Seen rather than argued, the
accent does not read as intelligence — it reads as a seventh colour, competing with six intent
dots that already mean something. And <code>#6a5ba8</code> is already marketing-hook in
<code>INTENT_COLOR</code>, so an indigo brand accent collides with a live semantic value.</p>
<p><strong>On type, one option ruled itself out on a fact rather than taste.</strong> The
guideline says italic carries emphasis — never bold, never colour. <strong>Bricolage Grotesque
has no italic</strong>; Google Fonts returns a 400 for the axis, so what you see in that
specimen is a browser-synthesised slant. Picking it would mean rewriting the emphasis rule.</p>
<p>Of the rest: Instrument Serif is sharper but colder and ships one weight. Newsreader is the
safe choice and the forgettable one. Playfair is everywhere. Inter Tight is what every other AI
product already looks like. <strong>Fraunces</strong> holds the two-things-at-once requirement
better than any of them — the optical axis is what keeps it from reading either stiff or twee,
and its italic is characterful enough to do the emphasis job alone.</p>
<p style="color:var(--pm);font-size:13.5px;margin-top:20px">Nothing here is applied. Say the word
on a world and a pairing and I will swap the tokens, rebuild the icon set and the OG card, and
update the guideline — it is four token values and one font declaration.</p>
</div>
</div>
"""

out = ROOT / "board-options.html"
out.write_text(HTML)
print(f"wrote {out} ({len(HTML):,} bytes)")
for key, name, bg, su, ink, mu, ac, _ in WORLDS:
    worst = min(cr(h, bg) for h in INTENTS)
    flag = "" if worst >= 3.0 and cr(mu, bg) >= 4.5 else "   <-- CHECK"
    print(f"  {re.sub('&amp;','&',name):26s} ink {cr(ink,bg):5.2f}  muted {cr(mu,bg):5.2f}  "
          f"worst dot {worst:4.2f}{flag}")
