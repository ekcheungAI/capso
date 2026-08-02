#!/usr/bin/env python3
"""Capso — the drag as loading a rack.

    python3 drafts/brand/build_dock.py

The drag machinery already exists: useDragCount broadcasts, DropZone has `armed`
and `over`, .capso-drop-active scales. Every state is generic UI vocabulary —
dashed ring, tint, scale — and none of it says rack.

The proposal is one idea: picking a capture up OPENS the rack. Every project lid
retracts to an open ring, the one you aim at previews itself filling, and the
drop crimps it. No new visual vocabulary: the three fill states already ship.
"""
import json
import re
from pathlib import Path

ROOT = Path("/Users/ek/Desktop/ekOS/20_projects/Capso/drafts/brand")
T = json.loads((ROOT / "tokens.generated.json").read_text())
_L = T["color"]["light"]
BONE, SURF, INK, MUTED = _L["background"], _L["surface"], _L["foreground"], _L["muted"]
M = T["motion"]
EASE, POP, PRESS, PANEL = M["ease-out-strong"], M["dur-pop"], M["dur-press"], M["dur-panel"]
REF = T["intent"]["reference"]

_svg = re.sub(r"<!--.*?-->", "", (ROOT / "mark" / "capso-lid.svg").read_text(), flags=re.S)
RIM = re.search(r'd="(M12 1\.6[^"]+)"', _svg, re.S).group(1)
RIM = re.sub(r"\s+", " ", RIM).strip()


def lid(size, state, uid):
    """state: 0 empty · 1 some · 2 full — the exact three that ship."""
    r = {0: 0, 1: 3, 2: 6}[state]
    face = f'<circle cx="12" cy="12" r="{r}"/>' if r else ""
    return (f'<svg viewBox="0 0 24 24" width="{size}" height="{size}" aria-hidden="true">'
            f'<mask id="k{uid}"><rect width="24" height="24" fill="#fff"/>'
            f'<rect x="12" y="10.4" width="11" height="3.2" fill="#000"/></mask>'
            f'<g fill="currentColor" fill-rule="evenodd" mask="url(#k{uid})">'
            f'<path d="{RIM}"/>{face}</g></svg>')


# (name, real state, count, is the drop target)
ROWS = [("Product ideas", 1, 1, False), ("Marketing & hooks", 0, 0, True),
        ("Competitors", 0, 0, False), ("Bugs to fix", 0, 0, False),
        ("Reference", 1, 1, False)]

rows = ""
for i, (name, state, count, target) in enumerate(ROWS):
    rows += f'''<div class="row{' tgt' if target else ''}" style="--i:{i}">
      <span class="lids">
        <span class="real">{lid(15, state, f'r{i}')}</span>
        <span class="open">{lid(15, 0, f'o{i}')}</span>
        {f'<span class="prev">{lid(15, 1, f"p{i}")}</span>' if target else ''}
      </span>
      <span class="nm">{name}</span>
      <i class="c0">{count}</i>{'<i class="c1">1</i>' if target else ''}
    </div>'''

BEATS = [
    ("Pick up", "Source card fades to 35% and scales to 0.97", "unchanged — the ghost is the slot the capsule just left", "—"),
    ("The rack opens", "Dashed ring appears around every row", "<strong>every lid retracts to an open ring</strong>, staggered 40ms down the list", f"{POP}"),
    ("Aim at a slot", "Tint + solid ring + scale 1.03", "<strong>that lid previews itself filling</strong> one step; the row insets", f"{PRESS}"),
    ("Drop", "State changes, no motion", "<strong>crimp on that lid</strong>, count increments, card leaves the grid", f"{PANEL}"),
    ("Miss or cancel", "Ring clears", "lids close back to their real fill — faster than they opened, no stagger", f"{PRESS}"),
]
beats = "".join(
    f'<tr><td><b>{b}</b></td><td class="why">{n}</td><td>{p}</td><td><code>{d}</code></td></tr>'
    for b, n, p, d in BEATS)

HTML = f"""<title>Capso — loading the rack</title>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600&display=swap" rel="stylesheet">
<style>
:root{{--bone:{BONE};--surface:{SURF};--ink:{INK};--muted:{MUTED};--line:rgb(31 31 30/.13);--ease:{EASE}}}
@media (prefers-color-scheme:dark){{:root{{--bone:#151513;--surface:#1d1d1a;--ink:#efece5;--muted:#928d84;--line:rgb(239 236 229/.15)}}}}
*{{box-sizing:border-box}}
body{{margin:0;background:var(--bone);color:var(--ink);
  font:15px/1.62 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,system-ui,sans-serif;-webkit-font-smoothing:antialiased}}
.w{{max-width:960px;margin:0 auto;padding:56px 30px 110px}}
h1{{font-family:'Fraunces',serif;font-weight:600;font-size:46px;letter-spacing:-.04em;line-height:1.05;margin:0 0 14px}}
h2{{font-family:'Fraunces',serif;font-weight:600;font-size:27px;letter-spacing:-.03em;margin:0 0 10px}}
p{{margin:0 0 13px;max-width:66ch}}
.lede{{color:var(--muted);font-size:16.5px}}
code{{font:.85em ui-monospace,Menlo,monospace}}
hr{{border:0;border-top:1px solid var(--line);margin:46px 0}}
table{{width:100%;border-collapse:collapse;font-size:13.5px}}
td,th{{text-align:left;padding:11px 12px 11px 0;border-bottom:1px solid var(--line);vertical-align:top}}
th{{font-size:10.5px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}}
.why{{color:var(--muted)}}
.two{{display:grid;grid-template-columns:270px 1fr;gap:34px;align-items:start}}
.cap{{font-size:13px;color:var(--muted);margin-top:10px}}

/* ---- the rack, loading ------------------------------------------------
   4.4s loop: idle · open (staggered) · aim · drop · settle · reset        */
.side{{border:1px solid var(--line);border-radius:13px;background:var(--bone);padding:14px 10px}}
.ph{{font-size:9.5px;letter-spacing:.11em;text-transform:uppercase;color:var(--muted);padding:0 6px;margin:0 0 8px}}
.row{{display:flex;align-items:center;gap:9px;padding:6px;border-radius:8px;font-size:13.5px;position:relative}}
.lids{{position:relative;width:15px;height:15px;flex:none}}
.lids>span{{position:absolute;inset:0;display:block}}
.lids svg{{display:block}}
.nm{{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}}
i{{font-style:normal;font-size:11.5px;color:var(--muted);font-variant-numeric:tabular-nums}}
.c1{{position:absolute;right:6px;opacity:0}}

/* the real fill hands over to the open ring while the rack is armed */
.real{{animation:realfade 4.4s linear infinite;animation-delay:calc(var(--i) * 40ms)}}
.open{{opacity:0;animation:openfade 4.4s linear infinite;animation-delay:calc(var(--i) * 40ms)}}
@keyframes realfade{{0%,13%{{opacity:1}}16%,84%{{opacity:0}}88%,100%{{opacity:1}}}}
@keyframes openfade{{0%,13%{{opacity:0}}16%,84%{{opacity:1}}88%,100%{{opacity:0}}}}
/* …except the target, which fills as you aim at it and stays filled */
.tgt .open{{animation:openfade-t 4.4s linear infinite}}
@keyframes openfade-t{{0%,13%{{opacity:0}}16%,36%{{opacity:1}}40%,100%{{opacity:0}}}}
.prev{{opacity:0;animation:prevfade 4.4s linear infinite}}
@keyframes prevfade{{0%,36%{{opacity:0}}40%,92%{{opacity:1}}96%,100%{{opacity:0}}}}
.tgt .real{{animation:realfade-t 4.4s linear infinite}}
@keyframes realfade-t{{0%,13%{{opacity:1}}16%,92%{{opacity:0}}96%,100%{{opacity:1}}}}

/* the row you are aiming at */
.tgt{{animation:aim 4.4s var(--ease) infinite}}
@keyframes aim{{
  0%,34%   {{background:transparent;box-shadow:none}}
  40%,52%  {{background:color-mix(in srgb,var(--ink) 5%,transparent);
             box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--ink) 22%,transparent)}}
  56%,100% {{background:transparent;box-shadow:none}}
}}
/* the crimp on drop — one tighten, no rebound */
.tgt .lids{{animation:crimp 4.4s var(--ease) infinite}}
@keyframes crimp{{0%,51%{{transform:scale(1)}}54%{{transform:scale(.9)}}58%,100%{{transform:scale(1)}}}}
.tgt .c0{{animation:c0 4.4s linear infinite}}
.tgt .c1{{animation:c1 4.4s linear infinite}}
@keyframes c0{{0%,52%{{opacity:1}}54%,92%{{opacity:0}}96%,100%{{opacity:1}}}}
@keyframes c1{{0%,52%{{opacity:0}}54%,92%{{opacity:1}}96%,100%{{opacity:0}}}}

/* the capsule in flight */
.fly{{position:absolute;left:-104px;top:96px;width:46px;height:46px;border-radius:8px;
  background:color-mix(in srgb,{REF} 18%,var(--surface));box-shadow:0 0 0 1px var(--line);
  animation:fly 4.4s var(--ease) infinite;opacity:0}}
@keyframes fly{{
  0%,10%  {{opacity:0;transform:translate(0,0) scale(1);border-radius:8px}}
  14%     {{opacity:1;transform:translate(4px,-4px) scale(1.03)}}
  40%     {{opacity:1;transform:translate(92px,-46px) scale(.62);border-radius:40%}}
  52%     {{opacity:1;transform:translate(118px,-58px) scale(.32);border-radius:50%}}
  54%,100%{{opacity:0;transform:translate(118px,-58px) scale(.32);border-radius:50%}}
}}
.stage{{position:relative}}
@media (prefers-reduced-motion:reduce){{
  .real,.open,.prev,.tgt,.tgt .lids,.tgt .c0,.tgt .c1,.fly{{animation:none!important}}
  .open,.prev,.c1,.fly{{opacity:0}} .real{{opacity:1}}
}}
@media(max-width:800px){{.two{{grid-template-columns:1fr}}h1{{font-size:33px}}}}
</style>

<div class="w">
<h1>Loading the rack</h1>
<p class="lede">The drag already works. What it does not do is say <em>rack</em> — every state is
generic UI vocabulary. One idea fixes that: <strong>picking a capture up opens the rack.</strong></p>

<hr/>

<div class="two">
  <div class="stage">
    <div class="fly"></div>
    <div class="side"><p class="ph">Projects</p>{rows}</div>
  </div>
  <div>
    <h2>What you are watching</h2>
    <p style="font-size:14.5px">At rest the lids show real fill. The moment a capture is picked up
    <strong>every lid retracts to an open ring</strong> — the rack opens, staggered 40ms down the
    list so it reads as one drawer rather than five flickers.</p>
    <p style="font-size:14.5px">The row you aim at <strong>previews itself filling</strong>: the face
    appears at the level it would be after the drop. You see the outcome before you commit.</p>
    <p style="font-size:14.5px;margin:0">Release, and that lid crimps once and the count ticks. No
    rebound — the same rigid-material rule as everywhere else.</p>
  </div>
</div>
<p class="cap">No new visual vocabulary: empty / some / full are the three states that already
ship in <code>mark.generated.tsx</code>. This is the same control, animated.</p>

<hr/>

<h2>Beat by beat</h2>
<table>
<tr><th>Beat</th><th>Now</th><th>Proposed</th><th>Duration</th></tr>
{beats}
</table>
<p class="cap">Every duration is an existing token. The stagger is 40ms × 5 rows = 200ms, inside the
micro-cascade budget; exits are faster than entrances and drop the stagger entirely, per the rule
that people care more about what appears than what leaves.</p>

<hr/>

<h2>Where it goes</h2>
<table>
<tr><th>File</th><th>Change</th></tr>
<tr><td><code>components/ui.tsx</code> → <code>DropZone</code></td>
    <td class="why">Already receives <code>armed</code> and tracks <code>over</code>. Both need to
    reach the row's <code>CapsoMark</code> rather than only drawing a ring — the cleanest way is a
    render prop or a <code>data-armed</code> / <code>data-over</code> attribute the mark reads.</td></tr>
<tr><td><code>components/shell.tsx</code> → <code>Row</code></td>
    <td class="why">Takes the real <code>fill</code> today. Needs to resolve to
    <code>empty</code> while armed and to the previewed level while over.</td></tr>
<tr><td><code>app/globals.css</code></td>
    <td class="why">Three keyframes — open, preview, crimp — reusing
    <code>--dur-pop</code>, <code>--dur-press</code>, <code>--dur-panel</code>.</td></tr>
</table>

<hr/>

<h2>Two things to decide</h2>
<p><strong>The multi-drag deck.</strong> Dragging a selection already broadcasts a count and shows
“drop 3”. The rack version is a small stack of lids on the drag badge — a deck in hand. It is the
one place a new asset would be needed, so it is worth deciding separately rather than bundling.</p>
<p><strong>The drag image itself.</strong> HTML5 drag-and-drop paints a browser-generated ghost of
the card unless <code>setDragImage</code> is called. A lid rendered at the cursor would be the most
literal version of “carrying a capsule” — and the most likely to feel gimmicky. I would ship the
rack first and judge the cursor afterwards, on a build rather than in the abstract.</p>
<p style="color:var(--muted);font-size:13.5px;margin-top:20px">Keyboard parity is already covered:
“Move to…” exists on every card, so none of this makes drag the only route.</p>
</div>
"""

out = ROOT / "board-dock.html"
out.write_text(HTML)
print(f"wrote {out} ({len(HTML):,} bytes)")
print(f"  tokens: pop {POP} · press {PRESS} · panel {PANEL} · ease {EASE}")
