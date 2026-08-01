#!/usr/bin/env python3
"""Capso — the coffee system: motion, rack, family, lexicon, and the mascot question.

    python3 drafts/brand/build_coffee.py

The brief was "every screenshot should feel like inserting a coffee capsule at
the right place". That is a motion brief before it is a logo brief, so the seat
interaction is the centrepiece and everything else hangs off it.

Palette comes from tokens.generated.json like every other shipping surface.
"""
import json
import re
from pathlib import Path

ROOT = Path("/Users/ek/Desktop/ekOS/20_projects/Capso/drafts/brand")
MARK = ROOT / "mark" / "capso-lid.svg"
CAPS = ROOT / "mark" / "capso-capsule.svg"

T = json.loads((ROOT / "tokens.generated.json").read_text())
_L = T["color"]["light"]
BONE, SURF, INK, MUTED = _L["background"], _L["surface"], _L["foreground"], _L["muted"]
CLAY, ESPRESSO = T["marketing"]["clay"], T["marketing"]["espresso"]
INTENTS = T["intent"]
EASE = T["motion"]["ease-out-strong"]

LABEL = {"reference": "Reference", "design_inspiration": "Design inspiration",
         "competitor": "Competitor", "marketing_hook": "Marketing hook",
         "content_idea": "Content idea", "ux_bug": "UX bug"}


def inner(p: Path) -> str:
    raw = re.sub(r"<!--.*?-->", "", p.read_text(), flags=re.S)
    return raw[raw.index(">", raw.index("<svg")) + 1: raw.rindex("</svg>")].strip()


LID, CAP = inner(MARK), inner(CAPS)


def lid(size, uid, color="currentColor"):
    s = LID.replace('id="capso-notch"', f'id="c{uid}"').replace("url(#capso-notch)", f"url(#c{uid})")
    return (f'<svg viewBox="0 0 24 24" width="{size}" height="{size}" aria-hidden="true" '
            f'style="display:block;flex:none;color:{color}">{s}</svg>')


def capsule(size, color="currentColor"):
    return (f'<svg viewBox="0 0 24 24" width="{size}" height="{size}" aria-hidden="true" '
            f'style="display:block;flex:none;color:{color}">{CAP}</svg>')


# ---------------------------------------------------------------- family
family = "".join(
    f'<div class="fam"><div class="famlid" style="color:{v}">{lid(46, f"f{i}")}</div>'
    f'<b>{LABEL[k]}</b><code>{v}</code></div>'
    for i, (k, v) in enumerate(INTENTS.items()))

# ---------------------------------------------------------------- lexicon
LEX = [
    ("Rack", "A project", "Not “folder”. A rack holds a fixed set of slots and you can see the whole thing at once — which is the promise."),
    ("Slot", "A place in a project", "An empty slot is information. A folder with nothing in it is just an empty folder."),
    ("Seat", "Filing a capture", "“Seated in Pricing page redesign.” It happened, it is snug, it is done. Beats “saved”, which says nothing about where."),
    ("Pull", "Retrieval", "“Capso pulled three of these back.” You do not search a rack, you pull the one you want."),
    ("Lid", "The capture's face", "The thumbnail is the lid — the thing you read to know what is inside without opening it."),
    ("Crimp", "The confirm moment", "The seal. Confirming a suggestion crimps it: it stops being Capso's guess and becomes yours."),
]
lexicon = "".join(
    f'<tr><td><b>{w}</b></td><td>{m}</td><td class="why">{why}</td></tr>' for w, m, why in LEX)

# ---------------------------------------------------------------- mascot ladder
LADDER = [
    ("0", "The object", "The lid, nothing added. What ships today.", "safe"),
    ("1", "The object, alive", "Same lid, four states — at rest, reading, suggesting, filed. Life through behaviour, not anatomy.", "recommended"),
    ("2", "Minimal expression", "Two square apertures knocked out of the foil face. Reads as a face only once you look for it.", "the honest middle"),
    ("3", "A character", "Full mascot — body, face, poses, an illustrator on retainer.", "costly"),
]

HTML = f"""<title>Capso — the coffee system</title>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,600;1,9..144,600&display=swap" rel="stylesheet">
<style>
:root{{--bone:{BONE};--surface:{SURF};--ink:{INK};--muted:{MUTED};--clay:{CLAY};--espresso:{ESPRESSO};
  --line:rgb(31 31 30/.13);--ease:{EASE}}}
@media (prefers-color-scheme:dark){{:root{{--bone:#151513;--surface:#1d1d1a;--ink:#efece5;--muted:#928d84;--line:rgb(239 236 229/.15)}}}}
*{{box-sizing:border-box}}
body{{margin:0;background:var(--bone);color:var(--ink);
  font:15px/1.62 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,system-ui,sans-serif;-webkit-font-smoothing:antialiased}}
.w{{max-width:1020px;margin:0 auto;padding:58px 30px 120px}}
h1{{font-family:'Fraunces',serif;font-weight:600;font-size:50px;letter-spacing:-.04em;line-height:1.03;margin:0 0 14px}}
h1 em{{font-style:italic}}
h2{{font-family:'Fraunces',serif;font-weight:600;font-size:29px;letter-spacing:-.03em;margin:0 0 10px}}
h3{{font-size:15.5px;font-weight:600;margin:0 0 6px}}
h4{{font-size:10.5px;font-weight:600;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin:0 0 14px}}
p{{margin:0 0 14px;max-width:66ch}}
.lede{{color:var(--muted);font-size:16.5px}}
code{{font:.85em ui-monospace,Menlo,monospace}}
hr{{border:0;border-top:1px solid var(--line);margin:52px 0}}
section{{margin-bottom:48px}}
.panel{{border:1px solid var(--line);border-radius:15px;background:var(--surface);padding:26px}}
.two{{display:grid;grid-template-columns:1.05fr .95fr;gap:30px;align-items:center}}
.cap{{font-size:13px;color:var(--muted);margin-top:10px}}
table{{width:100%;border-collapse:collapse;font-size:13.5px}}
td,th{{text-align:left;padding:10px 12px 10px 0;border-bottom:1px solid var(--line);vertical-align:top}}
th{{font-size:10.5px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}}
.why{{color:var(--muted)}}
.tag{{font-size:9.5px;letter-spacing:.09em;text-transform:uppercase;font-weight:600;
  border:1px solid var(--line);border-radius:999px;padding:2px 9px;color:var(--muted);margin-left:9px}}
.tag.on{{background:var(--ink);color:var(--bone);border-color:var(--ink)}}

/* ---------- the seat interaction ----------
   The flying capture lives INSIDE the target slot and animates from an offset
   to translate(0,0). Landing is then exact by construction — an earlier version
   used a guessed pixel offset and missed the slot by ~30px. */
.stage{{position:relative;height:300px;display:grid;place-items:center}}
.rack{{position:absolute;right:30px;top:50%;transform:translateY(-50%);
  width:104px;padding:12px 0;border:1px solid var(--line);border-radius:18px;background:var(--bone);
  display:flex;flex-direction:column;align-items:center;gap:11px}}
.slot{{width:46px;height:46px;border-radius:999px;border:2px solid var(--ink);opacity:.20;
  display:grid;place-items:center;position:relative}}
.slot.full::after{{content:"";width:20px;height:20px;border-radius:999px;background:var(--ink)}}
.slot.full{{opacity:1}}
.slot.target{{opacity:.32;animation:crimp 3.6s var(--ease) infinite}}
@keyframes crimp{{
  0%,12.4%   {{opacity:.32;transform:scale(1)}}
  13%        {{opacity:1;transform:scale(.94)}}   /* the seal — one tighten, no rebound */
  16%        {{opacity:1;transform:scale(1)}}
  84%        {{opacity:1;transform:scale(1)}}
  90%,100%   {{opacity:.32;transform:scale(1)}}
}}
.seated{{position:absolute;width:20px;height:20px;border-radius:999px;background:var(--ink);
  opacity:0;animation:seated 3.6s linear infinite}}
@keyframes seated{{0%,12.9%{{opacity:0}}13%,86%{{opacity:1}}90%,100%{{opacity:0}}}}

.cardwrap{{position:absolute;left:50%;top:50%;width:120px;height:120px;margin:-60px 0 0 -60px;
  animation:seat 3.6s infinite;will-change:transform,opacity}}
.card{{position:absolute;inset:0;border-radius:9px;background:var(--surface);
  border:1px solid var(--line);overflow:hidden;
  animation:morph 3.6s infinite;will-change:border-radius}}
/* The capture stays a legible screenshot for ~75% of the travel and becomes the
   lid only as it seats. Cross-fading across the whole flight was tried first and
   is worse: mid-air it reads as an indistinct grey blob, and the transformation
   stops being an event. */
.card::after{{content:"";position:absolute;inset:-1px;border-radius:inherit;background:var(--ink);
  opacity:0;animation:face 3.6s var(--ease) infinite}}
@keyframes face{{0%,10%{{opacity:0}}13%,100%{{opacity:1}}}}
.inner{{animation:dim 3.6s var(--ease) infinite}}
@keyframes dim{{0%,9.5%{{opacity:1}}12.6%,100%{{opacity:0}}}}
.shot{{height:84px;background:color-mix(in srgb,{INTENTS['reference']} 15%,var(--surface));
  padding:10px;display:flex;flex-direction:column;gap:6px}}
.shot i{{display:block;height:5px;border-radius:3px;
  background:color-mix(in srgb,{INTENTS['reference']} 34%,transparent)}}
.ct{{display:flex;align-items:center;gap:5px;padding:7px 9px;font-size:9.5px;color:var(--muted)}}
.ct u{{width:5px;height:5px;border-radius:99px;background:{INTENTS['reference']};display:block}}
/* shadow is its own layer so it can arrive late — follow-through */
.shadow{{position:absolute;inset:0;border-radius:9px;opacity:0;
  box-shadow:0 14px 30px rgb(31 31 30/.16);animation:shade 3.6s var(--ease) infinite}}
@keyframes shade{{0%,3%{{opacity:0}}9%{{opacity:1}}14.5%{{opacity:.4}}18%,100%{{opacity:0}}}}

@keyframes seat{{
  0%     {{transform:translate(-286px,-6px) scale(1);opacity:0}}
  1.5%   {{opacity:1;animation-timing-function:ease-out}}
  4%     {{transform:translate(-286px,-11px) scale(1.015);opacity:1;   /* anticipation */
           animation-timing-function:var(--ease)}}
  8.5%   {{transform:translate(-186px,-42px) scale(.82)}}              /* arc apex */
  13%    {{transform:translate(0,0) scale(.167);opacity:1}}            /* seated: 120 x .167 = 20px */
  13.01% {{opacity:0}}
  100%   {{transform:translate(0,0) scale(.167);opacity:0}}
}}
@keyframes morph{{
  0%,4%  {{border-radius:9px;animation-timing-function:var(--ease)}}
  13%    {{border-radius:999px}}
  100%   {{border-radius:999px}}
}}
/* Neighbours step back while the hero moves — staging, not decoration. */
.rack .slot.full{{animation:recede 3.6s var(--ease) infinite}}
@keyframes recede{{0%,3%{{opacity:1}}6%,13%{{opacity:.4}}20%,100%{{opacity:1}}}}
@media (prefers-reduced-motion:reduce){{
  /* The whole point is the settle. Without motion, show the settled state
     rather than a loop that never resolves. */
  .cardwrap,.card,.card::after,.inner,.shadow,.slot,.seated{{animation:none!important}}
  .cardwrap{{display:none}} .seated{{opacity:1}} .slot.target{{opacity:1}}
}}

/* ---------- family ---------- */
.fams{{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:13px}}
.fam{{border:1px solid var(--line);border-radius:12px;background:var(--surface);padding:16px;
  display:grid;justify-items:center;gap:5px}}
.famlid{{margin-bottom:5px}}
.fam b{{font-size:12.5px;font-weight:600}}
.fam code{{font-size:10.5px;color:var(--muted)}}

/* ---------- crimp texture ---------- */
.crimp{{height:150px;border-radius:15px;border:1px solid var(--line);
  background:
    repeating-radial-gradient(circle at 50% 50%,
      transparent 0 13px, color-mix(in srgb,var(--ink) 7%,transparent) 13px 14px);
  background-color:var(--surface)}}

/* ---------- ladder ---------- */
.ladder{{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}}
.rung{{border:1px solid var(--line);border-radius:13px;background:var(--surface);
  padding:20px 16px;display:flex;flex-direction:column;gap:9px}}
.rung .art{{height:74px;display:grid;place-items:center}}
.rung h3{{margin:0;font-size:13.5px}}
.rung p{{font-size:12px;color:var(--muted);margin:0;line-height:1.5}}
.rung .n{{font-size:10px;color:var(--muted);letter-spacing:.1em}}
.rung.pick{{border-color:var(--ink);box-shadow:inset 0 0 0 1px var(--ink)}}
.rung.no .art{{opacity:.35}} .rung.no h3,.rung.no p{{opacity:.7}}
.states{{display:flex;gap:9px}}
.ring{{width:17px;height:17px;border-radius:999px;border:2px solid var(--ink);position:relative}}
.ring.d{{border-style:dashed}} .ring.m{{border-color:var(--muted)}}
.ring.f::after{{content:"";position:absolute;inset:3px;border-radius:999px;background:var(--ink)}}
.close{{border-top:1px solid var(--line);padding-top:32px;max-width:70ch}}
@media(max-width:860px){{.two,.ladder{{grid-template-columns:1fr}}h1{{font-size:34px}}}}
</style>

<div class="w">
<h1>The coffee system</h1>
<p class="lede">You asked for the feeling that every screenshot is a capsule going into the right
slot. That is a motion brief before it is a logo brief — so the seating interaction is the centre
of this, and the rest hangs off it.</p>

<hr/>

<section>
<h2>The seat</h2>
<div class="two">
  <div class="panel stage">
    <div class="rack">
      <div class="slot full"></div>
      <div class="slot full"></div>
      <div class="slot target">
        <span class="seated"></span>
        <div class="cardwrap">
          <div class="shadow"></div>
          <div class="card"><div class="inner">
            <div class="shot"><i style="width:78%"></i><i style="width:54%"></i><i style="width:66%"></i></div>
            <div class="ct"><u></u>Linear — annual billing</div>
          </div></div>
        </div>
      </div>
      <div class="slot"></div>
    </div>
  </div>
  <div>
    <h3>Rigid, not bouncy — and that is the whole decision</h3>
    <p style="font-size:14.5px">A coffee capsule is aluminium seating into a socket. Rigid materials
    decelerate hard and <strong>stop dead</strong>. Give this any overshoot and it reads as rubber —
    wrong for the material, and it breaks the one motion rule we already have: <em>if it draws
    attention to itself it is wrong</em>.</p>
    <p style="font-size:14.5px;margin:0">So the satisfaction has to come from the <strong>deceleration
    curve</strong>, not from a bounce. That is the difference between this feeling expensive and
    feeling like a toy.</p>
  </div>
</div>

<table style="margin-top:26px">
<tr><th>Beat</th><th>What moves</th><th>Timing</th><th>Why</th></tr>
<tr><td>Anticipation</td><td>Capture lifts 4px, scales to 1.015</td><td>~145ms, ease-out</td>
  <td class="why">Disney's first principle. Without it the travel starts from nothing and reads as a teleport.</td></tr>
<tr><td>Travel</td><td>Arcs to the slot — apex 30px above the straight line</td><td>~320ms, <code>--ease-out-strong</code></td>
  <td class="why">Arc, not a straight line. Straight reads mechanical; the arc is what makes it feel handled.</td></tr>
<tr><td>Morph</td><td>Corners 9px → full round; scale to 0.35</td><td>same span</td>
  <td class="why">The capture <em>becomes</em> the lid on the way in. This is the brand idea, animated once per capture.</td></tr>
<tr><td>Seat</td><td>Hard decelerate to a stop. <strong>Zero overshoot.</strong></td><td>tail of the travel</td>
  <td class="why">Rigid material. The curve does the work.</td></tr>
<tr><td>Crimp</td><td>Slot ring tightens to 0.94 once, returns</td><td>~110ms</td>
  <td class="why">Secondary action — the socket acknowledges. One tighten, no rebound.</td></tr>
<tr><td>Follow-through</td><td>Shadow peaks mid-flight, lands late</td><td>+50ms behind the card</td>
  <td class="why">Objects and their shadows do not move as one. This is most of what separates believable from flat.</td></tr>
<tr><td>Staging</td><td>Neighbouring slots recede to 45%</td><td>over the travel</td>
  <td class="why">The 1/3 rule: only the hero should compete for attention.</td></tr>
</table>
<p class="cap">Total ~465ms, inside the 250ms-per-beat budget and under the 500ms ceiling for a
staged sequence. Reduced-motion shows the seated end state — the point of the animation is the
resolution, so a loop that never resolves is the wrong fallback.</p>
</section>

<hr/>

<section>
<h2>The family</h2>
<p>The six intent hues already ship as 8px dots. Given a physical form they become a
<strong>rack of capsule varieties</strong> — the same idea, finally legible. Same values, no new
colour: this is the dot promoted, not a new system.</p>
<div class="fams" style="margin-top:20px">{family}</div>
<p class="cap">Marketing and empty states can use the lids at size. In-product they stay 8px dots —
the guideline's rule that intent is never applied at scale still holds.</p>
</section>

<hr/>

<section>
<h2>The crimp</h2>
<p>One texture, derived from the mark's own geometry rather than invented: concentric rings at the
crimp pitch. It is the only pattern in the system and it earns its place by being the mark
zoomed out.</p>
<div class="crimp" style="margin-top:18px"></div>
<p class="cap">For marketing grounds, empty states and the OG card — never behind live captures,
which have enough going on.</p>
</section>

<hr/>

<section>
<h2>The words</h2>
<p>This is the cheapest and most pervasive identity lever on the page. A coffee-derived vocabulary
costs nothing to ship, appears in every string, and cannot be copied by a competitor the way a
mark can.</p>
<table style="margin-top:18px">
<tr><th>Word</th><th>Means</th><th>Why this one</th></tr>
{lexicon}
</table>
<p class="cap">Use them in product copy and marketing alike. The one rule: never explain the
metaphor in the UI. “Seated in Pricing page redesign” works whether or not the reader thinks about
coffee.</p>
</section>

<hr/>

<section>
<h2>The mascot question, honestly</h2>
<p>You raised it again, so here it is as four options rather than an argument. The question is not
“mascot yes/no” — it is <strong>how much anatomy</strong> the object needs before it feels alive.</p>
<div class="ladder" style="margin-top:22px">
  <div class="rung">
    <span class="n">LEVEL 0</span>
    <div class="art">{lid(44, "l0")}</div>
    <h3>The object</h3>
    <p>The lid, nothing added. What ships today. Correct and a little inert.</p>
  </div>
  <div class="rung pick">
    <span class="n">LEVEL 1 · RECOMMENDED</span>
    <div class="art"><div class="states">
      <span class="ring"></span><span class="ring d"></span><span class="ring m"></span><span class="ring f"></span>
    </div></div>
    <h3>The object, alive</h3>
    <p>Same lid, four states. Life through <em>behaviour</em> — the seat, the crimp, the pulse —
    rather than anatomy. This is what the animation above is.</p>
  </div>
  <div class="rung no">
    <span class="n">LEVEL 2 · DECLINED</span>
    <div class="art">
      <svg viewBox="0 0 24 24" width="44" height="44" aria-hidden="true" style="color:var(--ink)">
        <mask id="mface"><rect width="24" height="24" fill="#fff"/>
          <rect x="12" y="10.4" width="11" height="3.2" fill="#000"/>
          <rect x="9.3" y="7.9" width="2.2" height="2.2" fill="#000"/>
          <rect x="12.5" y="7.9" width="2.2" height="2.2" fill="#000"/></mask>
        <g fill="currentColor" fill-rule="evenodd" mask="url(#mface)">
          <path d="M12 1.6a10.4 10.4 0 1 1 0 20.8a10.4 10.4 0 0 1 0-20.8z M12 3.8a8.2 8.2 0 1 0 0 16.4a8.2 8.2 0 0 0 0-16.4z"/>
          <circle cx="12" cy="12" r="6"/>
        </g>
      </svg>
    </div>
    <h3>Minimal expression</h3>
    <p><strong>Declined 2026-08-01.</strong> Two square apertures in the foil. Technically it
    survives 16px, but the squares read as damage to the lid rather than as a face — and the mark
    was doing fine without them.</p>
  </div>
  <div class="rung">
    <span class="n">LEVEL 3</span>
    <div class="art" style="opacity:.55">{capsule(40)}</div>
    <h3>A character</h3>
    <p>Body, face, poses, an expression sheet. Needs a real illustrator — I would not fake it here,
    because a badly drawn one argues unfairly against the idea.</p>
  </div>
</div>

<div class="panel" style="margin-top:26px">
  <h3>Where I land, and the one thing that would change it</h3>
  <p style="font-size:14.5px">The coffee feeling you are describing is <strong>already in the
  motion</strong>, not in a face. Watch the seat above — that is the sensation of putting a capsule
  in a rack, and no character would add to it. Level 1 is what I would ship.</p>
  <p style="font-size:14.5px"><strong>Settled: Level 1, no face.</strong> Level 2 was drawn and
  declined — the apertures read as damage to the lid, not as expression. The mark stays an object.</p>
  <p style="font-size:14.5px;margin:0">The one thing that would reopen it: <strong>if Capso ever
  needs to be liked before it is trusted.</strong> Mascots earn their keep in acquisition — a
  landing page, a sticker, an app-store screenshot. That is a marketing decision taken later, and
  it would be Level 3 done properly by an illustrator, not Level 2 revisited.</p>
</div>
</section>

<hr/>

<div class="close">
<h2>What I would build next</h2>
<p><strong>The seat, for real.</strong> The animation above is a prototype. Shipping it means the
capture card morphing into its slot when a suggestion is confirmed — the crimp — in
<code>capture.tsx</code>, using the motion tokens already in the file. That is the single highest
-leverage thing on this page: it is the brand, and it fires several times a day.</p>
<p><strong>The words, everywhere.</strong> A sweep of product copy to the lexicon above. Cheap,
and it changes how the whole thing reads.</p>
<p style="color:var(--muted);font-size:13.5px;margin-top:20px">Nothing here is applied. The palette
is read from <code>tokens.generated.json</code>, so this page cannot disagree with the app.</p>
</div>
</div>
"""

out = ROOT / "board-coffee.html"
out.write_text(HTML)
print(f"wrote {out} ({len(HTML):,} bytes)")
print(f"  seat sequence ~465ms · ease {EASE} · zero overshoot (rigid)")
