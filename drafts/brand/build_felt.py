#!/usr/bin/env python3
"""Capso — why it feels dull, and the six things that would fix it.

    python3 drafts/brand/build_felt.py

Written against the deployed preview rather than a mockup. The diagnosis is
evidence, not opinion: the mark appears nowhere in the product, the rack exists
only in documents, and the seat fires on the rarest action in the app.

Palette from tokens.generated.json, like every other surface.
"""
import json
import re
from pathlib import Path

ROOT = Path("/Users/ek/Desktop/ekOS/20_projects/Capso/drafts/brand")
T = json.loads((ROOT / "tokens.generated.json").read_text())
_L = T["color"]["light"]
BONE, SURF, INK, MUTED = _L["background"], _L["surface"], _L["foreground"], _L["muted"]
EASE = T["motion"]["ease-out-strong"]
I = T["intent"]


def lid_fill(size: float, fill: float, uid: str, color: str = "currentColor") -> str:
    """The mark, with the foil face sized to how full the project is.

    This is the whole idea in one function: rim r10.4 and crimp r8.2 never
    change, so it is always the same glyph, but the face grows as captures land.
    A sidebar of these reads as a rack seen head-on, and the fullness is
    information rather than decoration.

    The fill is QUANTISED to three steps, not continuous. A linear map was tried
    first and fails for the same reason the 16px icon needed its own grid: one
    capture out of eight puts the face at r0.75, which at a 15px glyph is under
    a device pixel, so "has something in it" rendered identically to "empty" —
    the single most important distinction in the whole control. Three steps are
    distinguishable at this size; eight are not, and the exact count is already
    on the row.
    """
    f = max(0.0, min(1.0, fill))
    r = 0.0 if f == 0 else 3.0 if f < 0.5 else 6.0
    face = f'<circle cx="12" cy="12" r="{r:g}"/>' if r else ""
    return f'''<svg viewBox="0 0 24 24" width="{size}" height="{size}" aria-hidden="true"
      style="display:block;flex:none;color:{color}">
      <mask id="f{uid}"><rect width="24" height="24" fill="#fff"/>
        <rect x="12" y="10.4" width="11" height="3.2" fill="#000"/></mask>
      <g fill="currentColor" fill-rule="evenodd" mask="url(#f{uid})">
        <path d="M12 1.6a10.4 10.4 0 1 1 0 20.8a10.4 10.4 0 0 1 0-20.8z
                 M12 3.8a8.2 8.2 0 1 0 0 16.4a8.2 8.2 0 0 0 0-16.4z"/>{face}</g></svg>'''


# The five real projects, plus the two the library already holds, so the demo
# shows all three states rather than only "empty" and "one".
PROJECTS = [("Product ideas", 1, 8), ("Marketing & hooks", 0, 8),
            ("Competitors", 0, 8), ("Bugs to fix", 0, 8),
            ("Reference", 1, 8), ("Onboarding teardown", 5, 8)]

now_rows = "".join(
    f'<div class="row"><span>{n}</span><i>{c}</i></div>' for n, c, _ in PROJECTS)
new_rows = "".join(
    f'<div class="row nrow">{lid_fill(15, c / cap, f"p{k}")}<span>{n}</span>'
    f'<i>{c or ""}</i></div>'
    for k, (n, c, cap) in enumerate(PROJECTS))

FINDINGS = [
    ("The mark is not in the product.",
     "It is in the favicon, the extension, the Mac icon and the OG card — every surface except the one "
     "you look at all day. <code>shell.tsx:97</code> renders <code>&lt;p&gt;Capso&lt;/p&gt;</code>, plain "
     "system sans. The single most identity-carrying asset we made never appears on screen."),
    ("You are looking at an empty product, and I designed for a full one.",
     "Two captures cover about a tenth of that canvas; roughly three quarters of it is bare ground. "
     "“Let the captures carry the colour” is a good rule with forty captures and a vacuum with two — "
     "at this density the interface <em>is</em> the screen, and I gave it nothing to be."),
    ("The rack is a metaphor in a document, not a structure on screen.",
     "Projects render as a text list with a number. Nothing about the sidebar says slots, capacity, or "
     "filling up. The one place the organising story could be constantly visible is the one place it is "
     "completely absent."),
    ("The seat is imperceptible, and it fires on the rarest action.",
     "A 2.4% scale dip over 220ms is below the threshold you would notice unless you were looking for it — "
     "and it only plays on <strong>Confirm</strong>, which happens once per suggestion. The action that "
     "happens constantly, a capture arriving, has no motion at all."),
    ("The story is never told.",
     "“You’re not organised. Capso is.” appears in the OG card and nowhere in the product. First-run asks a "
     "functional question. Nothing on any screen states what the thing is for."),
]
findings = "".join(
    f'<div class="find"><span class="n">{k+1}</span><div><h3>{t}</h3><p>{b}</p></div></div>'
    for k, (t, b) in enumerate(FINDINGS))

MOVES = [
    ("Put the mark in the sidebar", "1 line", "high",
     "The lid replaces nothing — it sits beside the wordmark. The coffee object is then on screen "
     "permanently, at every moment, for the cost of one import."),
    ("Projects become a rack", "half a day", "highest",
     "Each project carries the mark with its <strong>face sized to how full it is</strong>. Same glyph "
     "throughout, so the sidebar becomes a column of lids — a rack seen head-on — and fullness is "
     "information, not ornament. This is the intervention that makes the metaphor structural."),
    ("Captures arrive by seating", "half a day", "highest",
     "New captures currently just appear. They should land: the arc, the corner-radius softening toward a "
     "lid, the hard stop. This is the motion you already approved, moved from the rarest action in the "
     "app to the most frequent one."),
    ("Empty projects show an open slot", "2 hours", "high",
     "“Marketing &amp; hooks 0” is the dullest thing on the screen and it is most of the sidebar. An open "
     "ring says <em>waiting</em>. Emptiness becomes the clearest statement of the metaphor rather than "
     "the flattest part of the page."),
    ("The crimp, at rest", "2 hours", "medium",
     "Concentric rings at the mark's own pitch, at ~4% ink, in the large empty areas only. Gives the bone "
     "ground something to be when there is nothing on it. Never behind live captures."),
    ("Say the line, once", "1 hour", "medium",
     "The true zero state is the only place the product can state what it is for without interrupting "
     "anyone. One line, one action — not a banner, not a tour."),
]
moves = "".join(
    f'<tr><td><b>{i+1}. {t}</b></td><td><code>{e}</code></td>'
    f'<td><span class="imp {p.split()[0]}">{p}</span></td><td class="why">{w}</td></tr>'
    for i, (t, e, p, w) in enumerate(MOVES))

HTML = f"""<title>Capso — making it felt</title>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,600;1,9..144,600&display=swap" rel="stylesheet">
<style>
:root{{--bone:{BONE};--surface:{SURF};--ink:{INK};--muted:{MUTED};--line:rgb(31 31 30/.13);--ease:{EASE}}}
@media (prefers-color-scheme:dark){{:root{{--bone:#151513;--surface:#1d1d1a;--ink:#efece5;--muted:#928d84;--line:rgb(239 236 229/.15)}}}}
*{{box-sizing:border-box}}
body{{margin:0;background:var(--bone);color:var(--ink);
  font:15px/1.62 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,system-ui,sans-serif;-webkit-font-smoothing:antialiased}}
.w{{max-width:1020px;margin:0 auto;padding:58px 30px 120px}}
h1{{font-family:'Fraunces',serif;font-weight:600;font-size:50px;letter-spacing:-.04em;line-height:1.04;margin:0 0 14px}}
h1 em{{font-style:italic}}
h2{{font-family:'Fraunces',serif;font-weight:600;font-size:29px;letter-spacing:-.03em;margin:0 0 10px}}
h3{{font-size:15.5px;font-weight:600;margin:0 0 5px}}
h4{{font-size:10.5px;font-weight:600;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin:0 0 12px}}
p{{margin:0 0 13px;max-width:68ch}}
.lede{{color:var(--muted);font-size:16.5px}}
code{{font:.85em ui-monospace,Menlo,monospace}}
hr{{border:0;border-top:1px solid var(--line);margin:50px 0}}
section{{margin-bottom:46px}}
.panel{{border:1px solid var(--line);border-radius:15px;background:var(--surface);padding:24px}}
.two{{display:grid;grid-template-columns:1fr 1fr;gap:22px}}
.cap{{font-size:13px;color:var(--muted);margin-top:9px}}
.find{{display:grid;grid-template-columns:34px 1fr;gap:14px;padding:18px 0;border-bottom:1px solid var(--line)}}
.find:last-child{{border-bottom:0}}
.find .n{{font-family:'Fraunces',serif;font-weight:600;font-size:23px;color:var(--muted);line-height:1}}
.find p{{margin:0;font-size:14px;color:var(--muted)}}
.find h3{{font-size:16px}}
table{{width:100%;border-collapse:collapse;font-size:13.5px}}
td,th{{text-align:left;padding:11px 12px 11px 0;border-bottom:1px solid var(--line);vertical-align:top}}
th{{font-size:10.5px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}}
.why{{color:var(--muted)}}
.imp{{font-size:10px;letter-spacing:.07em;text-transform:uppercase;font-weight:600;
  border-radius:999px;padding:2px 9px;border:1px solid var(--line);color:var(--muted);white-space:nowrap}}
.imp.highest{{background:var(--ink);color:var(--bone);border-color:var(--ink)}}

/* ---------- sidebar comparison ---------- */
.side{{background:var(--bone);border:1px solid var(--line);border-radius:13px;padding:16px 12px;
  font-size:13px;min-height:250px}}
.wm{{display:flex;align-items:center;gap:8px;font-weight:600;font-size:15px;
  letter-spacing:-.02em;margin-bottom:16px;padding:0 6px}}
.ph{{font-size:9.5px;letter-spacing:.11em;text-transform:uppercase;color:var(--muted);
  padding:0 6px;margin:0 0 7px}}
.row{{display:flex;align-items:center;gap:8px;padding:5px 6px;border-radius:7px}}
.row span{{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}}
.row i{{font-style:normal;color:var(--muted);font-size:12px}}
.nrow svg{{opacity:.85}}

/* ---------- arrival comparison ---------- */
.stage{{position:relative;height:190px;border:1px solid var(--line);border-radius:13px;
  background:var(--bone);overflow:hidden}}
.slotmark{{position:absolute;left:50%;top:50%;width:74px;height:74px;margin:-37px 0 0 -37px;
  border:2px dashed var(--line);border-radius:12px}}
.arr{{position:absolute;left:50%;top:50%;width:74px;height:74px;margin:-37px 0 0 -37px;
  border-radius:9px;background:var(--surface);box-shadow:0 0 0 1px var(--line);overflow:hidden}}
.arr .im{{height:48px;background:color-mix(in srgb,{I['reference']} 16%,var(--surface))}}
.arr .tx{{height:4px;margin:8px 8px 0;border-radius:2px;background:var(--line)}}
.fadein{{animation:justappear 2.8s steps(1,end) infinite}}
@keyframes justappear{{0%,8%{{opacity:0}}9%,86%{{opacity:1}}88%,100%{{opacity:0}}}}
.seatin{{animation:landing 2.8s var(--ease) infinite}}
@keyframes landing{{
  0%    {{opacity:0;transform:translate(-120px,-46px) scale(1.1);border-radius:9px}}
  6%    {{opacity:1}}
  10%   {{transform:translate(-72px,-40px) scale(1.05);border-radius:9px}}
  22%   {{transform:translate(0,0) scale(1);border-radius:14px}}   /* hard stop, no rebound */
  86%   {{transform:translate(0,0) scale(1);border-radius:14px;opacity:1}}
  92%,100%{{opacity:0}}
}}
@media (prefers-reduced-motion:reduce){{.fadein,.seatin{{animation:none;opacity:1;transform:none}}}}

/* ---------- crimp ---------- */
.crimp{{height:120px;border-radius:13px;border:1px solid var(--line);background:
  repeating-radial-gradient(circle at 50% 50%, transparent 0 12px,
    color-mix(in srgb,var(--ink) 4%,transparent) 12px 13px), var(--surface)}}
.close{{border-top:1px solid var(--line);padding-top:30px;max-width:70ch}}
@media(max-width:860px){{.two{{grid-template-columns:1fr}}h1{{font-size:34px}}}}
</style>

<div class="w">
<h1>Why it feels dull</h1>
<p class="lede">You are right, and the reason is not that the palette is too quiet. It is that almost
none of the brand is actually <em>in</em> the product. Here is the honest diagnosis, then six things
that would fix it, ranked.</p>

<hr/>

<section>
<h2>The diagnosis</h2>
{findings}
</section>

<hr/>

<section>
<h2>The principle</h2>
<div class="panel">
  <p style="font-size:17px;margin:0"><strong>The rack has to be visible at rest — not only in
  motion.</strong></p>
  <p style="margin:12px 0 0;font-size:14.5px;color:var(--muted)">Everything built so far puts the
  metaphor in things that happen: the seat, the crimp, a toast that says “seated”. All of it is
  invisible while you are simply looking at the screen, which is 99% of the time. The fix is to make
  the resting state carry it.</p>
</div>
</section>

<hr/>

<section>
<h2>1 · The mark, and the rack</h2>
<p>Same sidebar, same data — your five projects plus one that has filled up, so all three states are visible.</p>
<div class="two" style="margin-top:18px">
  <div>
    <div class="side">
      <div class="wm">Capso</div>
      <p class="ph">Projects</p>{now_rows}
    </div>
    <p class="cap"><strong>Now.</strong> A text list and four zeroes. Nothing here is Capso rather
    than any other tool.</p>
  </div>
  <div>
    <div class="side">
      <div class="wm">{lid_fill(17, 1, "wm")}Capso</div>
      <p class="ph">Projects</p>{new_rows}
    </div>
    <p class="cap"><strong>Proposed.</strong> The mark, then a column of lids whose
    <strong>faces are sized to how full each project is</strong>. Empty projects are open rings —
    slots waiting, not zeroes. The sidebar becomes a rack seen head-on, and the count is still there
    for anyone who wants the number.</p>
  </div>
</div>
<p class="cap">One glyph, one rule, no new colour: rim and crimp never change, only the face grows.
That is why it reads as a system rather than as five icons.</p>
</section>

<hr/>

<section>
<h2>2 · Captures arrive by seating</h2>
<div class="two">
  <div>
    <div class="stage"><div class="slotmark"></div>
      <div class="arr fadein"><div class="im"></div><div class="tx"></div></div></div>
    <p class="cap"><strong>Now.</strong> The capture appears. That is the product's most frequent
    moment and it has no character at all.</p>
  </div>
  <div>
    <div class="stage"><div class="slotmark"></div>
      <div class="arr seatin"><div class="im"></div><div class="tx"></div></div></div>
    <p class="cap"><strong>Proposed.</strong> It arrives on an arc, corners soften toward the lid,
    and it stops dead — no rebound, because aluminium into a socket does not bounce.</p>
  </div>
</div>
<p class="cap">This is the motion already agreed, moved from <strong>Confirm</strong> — which fires
once per suggestion — to <strong>capture arrival</strong>, which fires every single time you use the
product. Same code, hundreds of times the exposure.</p>
</section>

<hr/>

<section>
<h2>3 · The crimp, at rest</h2>
<p>The mark zoomed out, at about 4% ink, in the large empty areas only. It is the one texture in the
system and it is derived rather than invented — concentric rings at the crimp's own pitch.</p>
<div class="crimp" style="margin-top:16px"></div>
<p class="cap">Empty states and marketing grounds. <strong>Never behind live captures</strong> — they
have enough going on, and this is furniture, not pattern for its own sake.</p>
</section>

<hr/>

<section>
<h2>What to build, in order</h2>
<table>
<tr><th>Move</th><th>Effort</th><th>Impact</th><th>Why it carries the theme</th></tr>
{moves}
</table>
<p class="cap">Doing 1–4 is roughly a day and a half and would change the whole feel. Items 5 and 6
are polish and can wait.</p>
</section>

<hr/>

<section>
<h2>What not to do</h2>
<div class="two">
  <div class="panel">
    <h4>Tempting, and wrong</h4>
    <ul style="font-size:13.5px;color:var(--muted);padding-left:18px;margin:0">
      <li style="margin-bottom:8px">Add a brand colour to “liven it up”. The dullness is structural;
      a hue would just be a hue, and we measured that it loses to the captures.</li>
      <li style="margin-bottom:8px">Put the crimp texture behind the grid. It would fight every
      screenshot.</li>
      <li style="margin-bottom:8px">Animate more things. The problem is not quantity of motion, it is
      that the motion is on the wrong action.</li>
      <li>Add a mascot to warm it up. Already settled, and it would not fix an empty sidebar.</li>
    </ul>
  </div>
  <div class="panel">
    <h4>The test for anything new</h4>
    <p style="font-size:14px;margin:0;color:var(--muted)">Does it still make sense with
    <strong>two hundred</strong> captures on screen? The rack, the fill state and the arrival all do —
    they scale into information. Decoration does not: it is invisible at two captures and unbearable
    at two hundred.</p>
  </div>
</div>
</section>

<hr/>

<div class="close">
<h2>The honest summary</h2>
<p>I built a brand system and verified it thoroughly — tokens that cannot drift, contrast that is
measured, motion derived from the material. All of that is real. But I put it in
<em>documents and infrastructure</em>, and the only part that reached the screen was the absence of
colour, which at two captures reads as nothing rather than as restraint.</p>
<p><strong>The fix is not more design. It is putting the design that exists into the interface.</strong>
The mark is drawn and unused. The rack is specified and unbuilt. The seat is implemented and wired
to the wrong event.</p>
<p style="color:var(--muted);font-size:13.5px;margin-top:20px">Nothing here is applied. Say the word
and I will build 1–4 against the real app and push it to the same preview.</p>
</div>
</div>
"""

out = ROOT / "GUIDE-felt.html"
out.write_text(HTML)
print(f"wrote {out} ({len(HTML):,} bytes)")
