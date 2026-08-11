#!/usr/bin/env python3
"""Capso brand guidelines — the consolidated, decided system."""
import json
import re
from pathlib import Path

ROOT = Path("/Users/ek/Desktop/ekOS/20_projects/Capso/drafts/brand")
MARK = ROOT / "mark" / "capso-lid.svg"
CAPS = ROOT / "mark" / "capso-capsule.svg"


def L(h):
    h = h.lstrip("#")
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    c = [v / 12.92 if v <= .03928 else ((v + .055) / 1.055) ** 2.4 for v in c]
    return .2126 * c[0] + .7152 * c[1] + .0722 * c[2]


def cr(a, b):
    l1, l2 = L(a), L(b)
    return (max(l1, l2) + .05) / (min(l1, l2) + .05)


def svg_inner(p: Path) -> str:
    raw = p.read_text()
    raw = re.sub(r"<!--.*?-->", "", raw, flags=re.S)
    return raw[raw.index(">", raw.index("<svg")) + 1:].replace("</svg>", "").strip()


LID = svg_inner(MARK)
CAP = svg_inner(CAPS)


def lid(size, color="var(--ink)", uid=""):
    # each instance needs its own mask id or they collide in one document
    s = LID.replace('id="capso-notch"', f'id="cn{uid}"').replace("url(#capso-notch)", f"url(#cn{uid})")
    return (f'<svg viewBox="0 0 24 24" width="{size}" height="{size}" aria-hidden="true" '
            f'style="display:block;flex:none;color:{color}">{s}</svg>')


def capsule(size, color="var(--ink)"):
    return (f'<svg viewBox="0 0 24 24" width="{size}" height="{size}" aria-hidden="true" '
            f'style="display:block;flex:none;color:{color}">{CAP}</svg>')


# Read from the same file the apps compile against. A guideline that restates
# the palette by hand is the eighth copy of it, which is precisely the failure
# this document now tells everyone else not to commit.
TOKENS = json.loads((ROOT / "tokens.generated.json").read_text())
_L, _M = TOKENS["color"]["light"], TOKENS["marketing"]
BONE, SURF, INK, MUTED = _L["background"], _L["surface"], _L["foreground"], _L["muted"]
DANGER, DANGER_DK = _L["danger"], TOKENS["color"]["dark"]["danger"]
CLAY, ESPRESSO, SAND = _M["clay"], _M["espresso"], _M["sand"]

INTENT_LABEL = {"reference": "Reference", "design_inspiration": "Design inspiration",
                "competitor": "Competitor", "marketing_hook": "Marketing hook",
                "content_idea": "Content idea", "ux_bug": "UX bug"}
INTENTS = [(INTENT_LABEL[k], v) for k, v in TOKENS["intent"].items()]



# The rim path, taken from the same SVG the app and the icon builders compile.
RIM_D = " ".join(re.search(r'd="(M12 1\.6[^"]+)"', MARK.read_text(), re.S).group(1).split())


def lid_state(size, state, uid):
    """empty · some · full — the three fill states shipping in mark.generated.tsx.

    Built explicitly rather than by slicing the source SVG: an earlier version
    spliced strings and emitted an unclosed <g>.
    """
    r = {"empty": 0, "some": 3, "full": 6}[state]
    face = f'<circle cx="12" cy="12" r="{r}"/>' if r else ""
    return (
        f'<svg viewBox="0 0 24 24" width="{size}" height="{size}" aria-hidden="true" '
        f'style="display:block;flex:none;color:var(--ink)">'
        f'<mask id="cs{uid}"><rect width="24" height="24" fill="#fff"/>'
        f'<rect x="12" y="10.4" width="11" height="3.2" fill="#000"/></mask>'
        f'<g fill="currentColor" fill-rule="evenodd" mask="url(#cs{uid})">'
        f'<path d="{RIM_D}"/>{face}</g></svg>'
    )


# ---------------------------------------------------------------- motion
# Parsed from the shipping stylesheet, not retyped. A motion table in a brand
# guideline carries the same drift risk as a hex: correct the day it is written
# and quietly wrong a week later.
CSS = (ROOT.parent.parent / "apps" / "web" / "app" / "globals.css").read_text()

MOMENT = {
    "capso-arrive": ("A capture lands in the grid", "the most frequent moment in the product", 1),
    "capso-seat": ("Confirm — the capsule seats", "dips and returns; the satisfaction is the deceleration", 1),
    "capso-crimp": ("The seal", "inset ring, one tighten, no rebound", 1),
    "capso-slot-crimp": ("A capsule drops into a rack slot", "the slot acknowledges", 1),
    "capso-reading": ("Capso is reading a capture", "the only looping <em>brand</em> motion", 1),
    "capso-rack-open": ("Picking a capture up opens the rack", "every lid retracts to an open ring", 1),
    "capso-rack-prev": ("Aiming at a slot", "that lid previews itself filling", 1),
    "capso-rack-real": ("Letting go", "lids return to their real fill", 1),
    "capso-overlay-in": ("The capture overlay arrives", "from the Capture button, not fading in place", 0),
    "capso-pop-in": ("⌘K palette", "no travel — keyboard-driven, hit many times a day", 0),
    "capso-fade-in": ("Small state swaps", "opacity only", 0),
    "capso-toast-in": ("A toast", "an 8px rise", 0),
    "capso-shimmer": ("Content placeholder", "functional loop — not brand", 0),
    "capso-progress-sweep": ("In-flight capture, on the thumbnail edge", "functional loop — not brand", 0),
}


def motion_rows():
    """One row per @keyframes the stylesheet declares, with the rule that uses it.

    Keyed on keyframes rather than on class selectors: the rack is driven by
    [data-armed] / [data-over] attribute selectors and transitions, so a
    class-only scan silently missed half the system — including every rack beat
    and the crimp, which lives on ::after.
    """
    names = re.findall(r"@keyframes\s+(capso-[a-z-]+)", CSS)
    rows = ""
    for kf in dict.fromkeys(names):
        m = re.search(r"([^{}]*)\{[^{}]*animation:\s*([^;]*" + re.escape(kf) + r"[^;]*);", CSS)
        sel = " ".join(m.group(1).split()).lstrip("}").strip() if m else "—"
        decl = " ".join(m.group(2).split()) if m else "—"
        moment, note, _ = MOMENT.get(kf, ("—", "", 0))
        loops = "infinite" in decl
        rows += (f'<tr><td><code>{sel}</code></td><td><b>{moment}</b></td>'
                 f'<td><code>{decl}</code></td>'
                 f'<td>{"<span class=\'loop\'>loops</span>" if loops else "once"}</td>'
                 f'<td class="why">{note}</td></tr>')
    return rows, len(dict.fromkeys(names))


motion, motion_count = motion_rows()

RACK = [("Product ideas", "some", 1), ("Marketing & hooks", "empty", 0),
        ("Competitors", "empty", 0), ("Onboarding teardown", "full", 6)]
rack_rows = "".join(
    f'<div class="rr">{lid_state(15, st, f"k{i}")}<span>{n}</span><i>{c or ""}</i></div>'
    for i, (n, st, c) in enumerate(RACK))
states_row = "".join(
    f'<div class="st">{lid_state(38, st, f"b{st}")}<b>{st}</b><small>{lab}</small></div>'
    for st, lab in [("empty", "a slot waiting"), ("some", "has captures"), ("full", "filling up")])
brand_loops = [k for k, v in MOMENT.items() if v[2] and k == "capso-reading"]

CORE = [
    ("Bone", BONE, "Product ground", f"{cr(INK, BONE):.1f}:1 with ink"),
    ("Surface", SURF, "Cards, panels", f"{cr(INK, SURF):.1f}:1 with ink"),
    ("Ink", INK, "Type, buttons, the mark", "the only 'accent' there is"),
    ("Muted", MUTED, "Secondary text", f"{cr(MUTED, BONE):.1f}:1 on bone"),
    ("Danger", DANGER, "Error text (light)", f"{cr(DANGER, BONE):.1f}:1 on bone"),
    ("Clay", CLAY, "Marketing ground", f"{cr(ESPRESSO, CLAY):.1f}:1 with espresso"),
    ("Sand", SAND, "Marketing panels", f"{cr(ESPRESSO, SAND):.1f}:1 with espresso"),
    ("Espresso", ESPRESSO, "Marketing type", "warm counterpart to ink"),
    ("Clay muted", _M["muted"], "Marketing secondary", f"{cr(_M['muted'], CLAY):.1f}:1 on clay"),
]

sizes = "".join(
    f'<div class="sz"><div class="szb" style="width:{max(px,40)}px;height:{max(px,40)}px">'
    f'{lid(px, uid=f"s{px}")}</div><span>{px}</span></div>' for px in (96, 48, 32, 24, 16))

swatches = "".join(
    f'<div class="sw"><div class="chip" style="background:{hexv};'
    f'{"box-shadow:inset 0 0 0 1px rgb(0 0 0/.10)" if L(hexv) > .5 else ""}"></div>'
    f'<b>{n}</b><code>{hexv}</code><em>{use}</em><small>{note}</small></div>'
    for n, hexv, use, note in CORE)

_D = TOKENS["color"]["dark"]
DARK = [("Ink ground", _D["background"], "Product ground", f"{cr(_D['foreground'], _D['background']):.1f}:1 with type"),
        ("Surface", _D["surface"], "Cards, panels", f"{cr(_D['foreground'], _D['surface']):.1f}:1 with type"),
        ("Type", _D["foreground"], "Type, buttons, the mark", "accent inverts to this"),
        ("Muted", _D["muted"], "Secondary text", f"{cr(_D['muted'], _D['background']):.1f}:1 on ground"),
        ("Danger", DANGER_DK, "Error text (dark)", f"{cr(DANGER_DK, _D['background']):.1f}:1 on ground")]

dark_swatches = "".join(
    f'<div class="sw"><div class="chip" style="background:{hexv};'
    f'{"box-shadow:inset 0 0 0 1px rgb(0 0 0/.10)" if L(hexv) > .5 else ""}"></div>'
    f'<b>{n}</b><code>{hexv}</code><em>{use}</em><small>{note}</small></div>'
    for n, hexv, use, note in DARK)

ANNOTATE = TOKENS.get("annotate", {})
annots = "".join(
    f'<div class="dt"><span style="background:{h}"></span><b>{n.title()}</b><code>{h}</code>'
    f'<small>{cr(h, BONE):.1f} on bone</small></div>' for n, h in ANNOTATE.items())

dots = "".join(
    f'<div class="dt"><span style="background:{h}"></span><b>{n}</b><code>{h}</code>'
    f'<small>{cr(h, BONE):.1f} · {cr(h, INK):.1f}</small></div>' for n, h in INTENTS)

HTML = f"""<title>Capso — brand guidelines</title>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600&display=swap" rel="stylesheet">
<style>
:root{{--bone:{BONE};--surface:{SURF};--ink:{INK};--muted:{MUTED};--clay:{CLAY};--espresso:{ESPRESSO};
  --line:rgb(31 31 30/.13)}}
@media (prefers-color-scheme:dark){{:root{{--bone:#151513;--surface:#1d1d1a;--ink:#efece5;--muted:#928d84;--line:rgb(239 236 229/.14)}}}}
*{{box-sizing:border-box}}
body{{margin:0;background:var(--bone);color:var(--ink);
  font:15px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,system-ui,sans-serif;-webkit-font-smoothing:antialiased}}
.w{{max-width:960px;margin:0 auto;padding:60px 32px 120px}}
.ser{{font-family:'Fraunces',serif}}
h1{{font-family:'Fraunces',serif;font-weight:600;font-size:52px;letter-spacing:-.04em;line-height:1.03;margin:0 0 16px}}
h2{{font-family:'Fraunces',serif;font-weight:600;font-size:30px;letter-spacing:-.03em;margin:0 0 10px}}
h3{{font-size:15px;font-weight:600;margin:0 0 6px}}
h4{{font-size:10.5px;font-weight:600;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin:0 0 14px}}
p{{margin:0 0 14px;max-width:66ch}}
.lede{{color:var(--muted);font-size:17px}}
code{{font:.84em ui-monospace,Menlo,monospace}}
hr{{border:0;border-top:1px solid var(--line);margin:56px 0}}
section{{margin-bottom:52px}}
img{{max-width:100%;display:block;border-radius:12px}}
.two{{display:grid;grid-template-columns:1fr 1fr;gap:22px}}
.cap{{font-size:13px;color:var(--muted);margin-top:10px}}
.lock{{display:flex;align-items:center;gap:15px;font-family:'Fraunces',serif;font-weight:600;
  font-size:46px;letter-spacing:-.038em;line-height:1}}
.panel{{border:1px solid var(--line);border-radius:14px;padding:26px;background:var(--surface)}}
.dkpanel{{background:{INK};color:{BONE};border-color:transparent}}
.sizes{{display:flex;align-items:flex-end;gap:20px;flex-wrap:wrap}}
.sz{{display:grid;justify-items:center;gap:7px}}
.szb{{display:grid;place-items:center}}
.sz span{{font-size:10.5px;color:var(--muted)}}
.grid{{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px}}
.sw{{border:1px solid var(--line);border-radius:12px;overflow:hidden;background:var(--surface)}}
.chip{{height:66px}}
.sw b,.sw code,.sw em,.sw small{{display:block;padding:0 12px}}
.sw b{{font-size:13px;font-weight:600;margin-top:11px}}
.sw code{{font-size:11px;color:var(--muted);margin-top:1px}}
.sw em{{font-size:12px;font-style:normal;margin-top:6px}}
.sw small{{font-size:11px;color:var(--muted);margin:3px 0 13px}}
.dots{{display:grid;grid-template-columns:repeat(auto-fit,minmax(168px,1fr));gap:11px}}
.dt{{display:grid;grid-template-columns:16px 1fr;gap:9px;align-items:center;
  border:1px solid var(--line);border-radius:10px;padding:11px 13px;background:var(--surface)}}
.dt span{{width:12px;height:12px;border-radius:99px;display:block}}
.dt b{{font-size:12.5px;font-weight:600;grid-column:2}}
.dt code,.dt small{{grid-column:2;font-size:10.5px;color:var(--muted)}}
.rules{{display:grid;grid-template-columns:1fr 1fr;gap:26px}}
.rules ul{{margin:8px 0 0;padding-left:18px;font-size:13.5px;color:var(--muted)}}
.rules li{{margin-bottom:7px}}
.do li::marker{{color:var(--ink)}}
table{{width:100%;border-collapse:collapse;font-size:13.5px}}
td,th{{text-align:left;padding:10px 10px 10px 0;border-bottom:1px solid var(--line);vertical-align:top}}
th{{font-size:10.5px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}}
.states{{display:flex;gap:26px;flex-wrap:wrap;align-items:center}}
.st{{display:grid;justify-items:center;gap:8px;font-size:11px;color:var(--muted)}}
.ring{{width:46px;height:46px;border-radius:99px;border:2px solid var(--ink);position:relative}}
.ring i{{position:absolute;inset:34%;border-radius:99px;background:var(--ink);opacity:0}}
.ring.f i{{opacity:1}}
.ring.h{{border-style:dashed}}
.ring.p{{border-color:var(--muted)}}
.change{{border-left:3px solid var(--ink);padding:6px 0 6px 20px;margin:22px 0}}
.rr{{display:flex;align-items:center;gap:9px;padding:6px;border-radius:7px;font-size:13.5px}}
.rr span{{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}}
.rr i{{font-style:normal;font-size:11.5px;color:var(--muted)}}
.st{{display:grid;justify-items:center;gap:7px;text-align:center}}
.st b{{font-size:12.5px;font-weight:600}}
.st small{{font-size:11px;color:var(--muted)}}
.loop{{font-size:10px;letter-spacing:.06em;text-transform:uppercase;font-weight:600;
  background:var(--ink);color:var(--bone);border-radius:999px;padding:2px 8px}}
.change p{{margin:0 0 9px}}.change p:last-child{{margin:0}}
/* mockups — the retrieval surfaces, built from the real tokens */
.mock{{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:13px;
  max-width:330px;font-size:12px}}
.thumb{{height:96px;border-radius:7px;background:
  repeating-linear-gradient(135deg,rgb(31 31 30/.05) 0 9px,rgb(31 31 30/.09) 9px 18px);margin-bottom:10px}}
.row{{display:flex;align-items:center;gap:6px}}
.row .t{{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}}
.why{{color:var(--muted);font-size:11.5px;margin-top:5px;line-height:1.45}}
.ichip{{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--line);
  border-radius:99px;padding:2px 8px;font-size:10.5px;color:var(--muted);margin-top:8px}}
.ichip i{{width:6px;height:6px;border-radius:99px;display:block}}
.ans{{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:16px}}
.ans .hd{{display:flex;gap:9px;align-items:flex-start}}
.ans p{{font-size:14px;margin:0;max-width:none}}
.cites{{display:flex;gap:7px;margin:12px 0 0 25px}}
.cites span{{width:34px;height:24px;border-radius:4px;display:block;background:
  repeating-linear-gradient(135deg,rgb(31 31 30/.06) 0 6px,rgb(31 31 30/.11) 6px 12px)}}
.prov{{display:grid;grid-template-columns:auto 1fr 1fr;gap:0;font-size:13.5px}}
.prov>div{{padding:9px 14px 9px 0;border-bottom:1px solid var(--line)}}
.prov .h{{font-size:10.5px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}}
@media(max-width:760px){{.two,.rules{{grid-template-columns:1fr}}.w{{padding:34px 18px 80px}}h1{{font-size:36px}}}}
</style>

<div class="w">

<div class="lock" style="margin-bottom:30px">{lid(46, uid="hd")}Capso</div>
<h1>Brand guidelines</h1>
<p class="lede">Everything decided, in one place. Version 1 — the working system, not a finished
manual.</p>

<hr/>

<section>
<h2>The feeling</h2>
<p><strong>You're not organised. Capso is.</strong> The brand has to hold two things at once:
competent enough that you hand over your filing without worrying, warm enough that it never feels
like it is scolding you for being messy.</p>
<p>Everything below follows from that. Cold technical design fails the second half. Cute design
fails the first. The resolution is <em>quiet order</em> — restraint that reads as care rather than
austerity.</p>
<div class="two" style="margin-top:24px">
  <div><img src="renders-look/C1-bone-ink.png" alt="Bone and ink direction">
    <p class="cap"><strong>Product.</strong> Bone ground, ink type, no accent colour. The only hue
    on screen belongs to your captures.</p></div>
  <div><img src="renders-look/C4-warm-clay.png" alt="Warm clay direction">
    <p class="cap"><strong>Marketing.</strong> Same family, warmer light. Real material, deeper
    ground, the register everything photographed lives in.</p></div>
</div>
</section>

<hr/>

<section>
<h2>Logo</h2>
<div class="two" style="align-items:center;margin-bottom:24px">
  <div class="panel" style="display:grid;place-items:center;padding:40px">{lid(150, uid="hero")}</div>
  <div>
    <h3>A capsule lid, seen from above</h3>
    <p style="font-size:14.5px">Three concentric parts, exactly what you see looking down into a
    rack: the flange rim, the <strong>crimp ring</strong>, and the sealed foil face. The notch
    through the right is the finger relief on a real holder — and it opens the ring into a
    <strong>C</strong>.</p>
    <p style="font-size:14.5px;margin:0">Drawn on a 24-unit grid. Rim r10.4, crimp r8.2, face r6.0,
    notch y10.4–13.6. One file, <code>currentColor</code>, transparent ground.</p>
  </div>
</div>

<h4>Why top-down matters</h4>
<div class="two" style="align-items:center">
  <div class="panel" style="display:flex;gap:34px;align-items:center;justify-content:center;padding:30px">
    {lid(78, uid="cmp")}{capsule(78)}
  </div>
  <p style="font-size:14.5px;margin:0">A medicine capsule is a <em>symmetric oblong seen from the
  side</em>. A coffee capsule is a <em>truncated cone with a flanged rim</em> — widest at the lid,
  tapering to the base. The taper is the entire difference. Use the lid as the mark; the side
  profile exists for the rack, columns and motion.</p>
</div>

<h4 style="margin-top:34px">Sizes</h4>
<div class="panel"><div class="sizes">{sizes}</div></div>
<p class="cap">Holds to 16px unmodified. Below 24px the crimp ring closes — that is intended, not a
failure. On a dark ground use the same file inverted; it is a silhouette, not a line drawing.</p>

<h4 style="margin-top:34px">States, not a mascot</h4>
<div class="panel"><div class="states">
  <div class="st"><div class="ring"><i></i></div>At rest</div>
  <div class="st"><div class="ring h"><i></i></div>Reading</div>
  <div class="st"><div class="ring p"><i></i></div>Suggesting</div>
  <div class="st"><div class="ring f"><i></i></div>Filed</div>
</div></div>
<p class="cap">The mark carries life through state, never a face. These map one-to-one onto the four
states already in <code>capture.tsx:268-275</code>. There is no character in this brand and there
should not be one. <b>Amended 2026-08-12:</b> the brand does now ship generated art — still-life
photography of capsules in decks and trays — but that is imagery, not a character. Objects in
order, zero characters, exactly as the reference boards always were.</p>
</section>

<hr/>

<section>
<h2>The rack</h2>
<p>The single change that made the metaphor structural rather than decorative. Every project row
carries the mark, and <strong>the foil face is sized to how full that project is</strong>. Rim and
crimp never change, so it is always one glyph — the sidebar becomes a rack seen head-on.</p>

<div class="two" style="align-items:center;margin-top:22px">
  <div class="panel"><div class="states">{states_row}</div></div>
  <div class="panel" style="padding:16px 12px">{rack_rows}</div>
</div>

<p class="cap"><strong>Empty is the important one.</strong> “Marketing &amp; hooks 0” was the
flattest thing on the screen and most of the sidebar; an open ring says <em>waiting</em>. Emptiness
became the clearest statement of the idea rather than its weakest point.</p>

<h4 style="margin-top:32px">Why three states and not a continuous fill</h4>
<p>A linear map from count to face radius was tried first and fails for the same reason the 16px
icon needed its own grid: one capture out of eight puts the face at r0.75, which at a 15px glyph is
under a device pixel. “Has something in it” rendered <em>identically</em> to “empty” — the single
most important distinction in the control. Three steps are distinguishable at this size; eight are
not, and the exact count is already on the row.</p>

<h4 style="margin-top:32px">Loading the rack</h4>
<p>Picking a capture up <strong>opens the rack</strong>: every lid retracts to an open ring,
staggered 40ms down the list so it reads as one drawer rather than five flickers. The row you aim at
previews itself filling — you see the outcome before you commit — and the drop crimps that slot.
Letting go closes the rack faster than it opened, with no stagger, because people care more about
what appears than what leaves.</p>
<p class="cap">No new visual vocabulary anywhere in this: empty / some / full are the three states
the mark already ships, animated.</p>
</section>

<hr/>

<section>
<h2>Typography</h2>
<div class="two">
  <div class="panel">
    <h4>Display — Fraunces 600</h4>
    <p class="ser" style="font-size:38px;font-weight:600;letter-spacing:-.03em;line-height:1.1;margin:0 0 10px">
      Screenshots,<br/><em style="font-style:italic">beautifully</em> organised.</p>
    <p style="font-size:13px;color:var(--muted);margin:0">Wordmark, headlines, marketing. The
    italic carries emphasis — never bold, never colour. Optical sizing on, tracking −0.03em at
    display sizes.</p>
  </div>
  <div class="panel">
    <h4>Interface — system sans</h4>
    <p style="font-size:20px;font-weight:600;margin:0 0 4px">Everything you've captured</p>
    <p style="font-size:14px;margin:0 0 4px">Body copy sits at 14px.</p>
    <p style="font-size:12px;color:var(--muted);margin:0 0 12px">Metadata at 12px, the floor.</p>
    <p style="font-size:13px;color:var(--muted);margin:0">No webfont in the app. Scale 12/14/16/20/28,
    per <code>15_DESIGN_SYSTEM_AND_UX.md:106</code>. Fraunces never appears inside the product.</p>
  </div>
</div>
</section>

<hr/>

<section>
<h2>Colour</h2>
<div class="change">
  <p><strong>There is no accent hue. Buttons are ink.</strong> The only colour the interface asserts
  is none; the captures carry all of it. Measured on a full grid of realistic screenshots,
  <strong>100% of the chromatic pixels on screen belong to the captures</strong>.</p>
  <p>How it got here, since the reasoning matters more than the value: terracotta was the placeholder
  and failed AA twice over, needing a hand-tuned pair per scheme. A sorted green was recommended and
  was also wrong — on cream it read institutional. Seeing four directions rendered side by side is
  what settled it, and what removed the accent entirely rather than replacing it. Ink inverts with
  the theme for free, so the mode-dependence went with it.</p>
</div>
<div class="grid" style="margin-top:22px">{swatches}</div>

<h4 style="margin-top:36px">Dark</h4>
<p>Not a second palette — the same one inverted. Only <code>danger</code> needs its own value,
because no single red clears 4.5:1 on both grounds.</p>
<div class="grid" style="margin-top:16px">{dark_swatches}</div>

<h4 style="margin-top:36px">Intent — the only colour in the product</h4>
<p>Six hues, one per intent, already shipping in <code>INTENT_COLOR</code>. Mid-tone and low-chroma
so a single value clears 3:1 on <em>both</em> grounds with no light/dark pair. Shown as an 8px dot,
<strong>never as text</strong> — they are tuned for 3:1, not 4.5.</p>
<div class="dots">{dots}</div>
<p class="cap">Ratios shown are on bone · on ink.</p>

<h4 style="margin-top:36px">Annotation — the second exception, and why it is not a contradiction</h4>
<p>Markup on a capture ships with five pens. On its face that breaks the rule this whole section
rests on. It does not, and the distinction is worth stating because it is the test for anything
future: <strong>this is colour the user authors, not colour the interface asserts.</strong></p>
<p>A red arrow you drew on a screenshot is <em>content</em> — the same category as the screenshot
underneath it. It is no more a brand colour than the pixels it sits on. Chrome stays bone and ink;
the captures, the intent dots and now your own marks carry everything else.</p>
<div class="dots" style="margin-top:14px">{annots}</div>
<p class="cap">Five, because more becomes a colour picker and a colour picker is a decision the
product should not be asking for. Each clears 4.5:1 on bone, so a pen is legible as a line even
where it crosses a pale region of the screenshot.</p>
</section>

<hr/>

<section>
<h2>Retrieval</h2>
<div class="change">
  <p><strong>The rack is only half the promise.</strong> Everything above is about order —
  filing, shelves, things landing where they belong. But the brief was <em>"even though you are
  not organised, AI will help you organise and make sure you never lose a single train of
  thought."</em> Order is the first clause. The second is that the right thing comes back.</p>
  <p><strong>The rack holds everything. Capso knows which one to pull.</strong></p>
</div>

<h4 style="margin-top:34px">A resurfaced capture</h4>
<div class="two" style="align-items:center">
  <div class="mock">
    <div class="thumb"></div>
    <div class="row">{lid(16, uid="rs")}<span class="t">Linear's annual billing toggle</span></div>
    <div class="why">Came back because you're writing pricing for Capso — you saved this
    for the same question in March.</div>
    <span class="ichip"><i style="background:#4a6fa5"></i>Reference</span>
  </div>
  <div>
    <p style="font-size:14.5px">An ordinary card. The <strong>mark at 16px</strong> before the
    title is the whole signal, and <strong>the reason line is mandatory</strong> — a resurfaced
    item you cannot interrogate is a recommendation you cannot trust or dismiss.</p>
    <p style="font-size:14.5px;margin:0">It lives on its own shelf on home, above the projects.
    Empty most days, and that is fine: an empty shelf is information for the same reason an
    unfilled ring is. No badge, no count, no red dot.</p>
  </div>
</div>

<h4 style="margin-top:34px">The search answer</h4>
<div class="ans">
  <div class="hd">{lid(16, uid="sa")}<p>You saved three pricing pages with annual toggles. Two put
  the discount on the toggle itself; the one you called out as clearest put it on the plan card.</p></div>
  <div class="cites"><span></span><span></span><span></span></div>
</div>
<p class="cap">Agentic search over memory already ships (<code>8055391</code>). The register is the
rest of the product: same 14px system sans, no chat bubble, no typing animation, no gradient
border. The mark is the only thing that says this was written by Capso.</p>
<ul style="font-size:13.5px;color:var(--muted);max-width:66ch;padding-left:18px">
  <li style="margin-bottom:7px"><strong style="color:var(--ink)">Screenshots are the citation.</strong>
  Every claim carries its source capture as a thumbnail you can click. Nothing is asserted without one.</li>
  <li style="margin-bottom:7px"><strong style="color:var(--ink)">Thinking is the crimp-ring pulse</strong>
  — the mark breathing, <code>1.6s ease-in-out</code>. Not a spinner, not three dots, and not Tailwind's default pulse, which is what it actually was until it got fixed.</li>
  <li><strong style="color:var(--ink)">Nothing found says nothing found</strong>, in one sentence,
  and does not guess.</li>
</ul>
</section>

<hr/>

<section>
<h2>Provenance</h2>
<p><strong>The mark means Capso decided. Its absence means you did.</strong> This is the rule that
makes the identity functional instead of decorative, and it is why the brand needs no colour to
signal AI — the glyph already does it, and it cannot clash with a screenshot.</p>
<div class="prov" style="margin-top:20px">
  <div class="h"></div><div class="h">Capso decided</div><div class="h">You decided</div>
  <div>Intent</div><div class="row">{lid(15, uid="p1")}<span>inferred by classify</span></div><div>you edited it</div>
  <div>Title</div><div class="row">{lid(15, uid="p2")}<span>generated</span></div><div>you typed it</div>
  <div>Project</div><div class="row">{lid(15, uid="p3")}<span>suggested — ring stays open</span></div><div>you filed it</div>
  <div>Placement</div><div class="row">{lid(15, uid="p4")}<span>resurfaced</span></div><div>you searched for it</div>
</div>
<p class="cap" style="margin-top:16px"><strong>Confirming takes the mark off.</strong> The moment you
accept a suggestion it stops being Capso's and becomes yours — which means the mark can never be
used as a watermark, a sidebar logo, or empty-state decoration. If it appears where nothing was
inferred, the rule is broken and the signal is worth nothing.</p>
</section>

<hr/>

<section>
<h2>Motion</h2>
<p>No animation dependency — all of it is CSS on opacity and transform. The table below is
<strong>parsed from <code>globals.css</code> at build time</strong>, not retyped, so it cannot drift
from what ships. {motion_count} keyframes, in declaration order.</p>

<div class="change">
  <p><strong>One rule decides most of this: the material is rigid.</strong> A coffee capsule is
  aluminium going into a socket, so every seat, arrival and crimp decelerates hard and
  <strong>stops dead — zero overshoot</strong>. A bounce would read as rubber. The satisfaction has
  to come from the deceleration curve, which is the difference between this feeling expensive and
  feeling like a toy.</p>
</div>

<table style="margin-top:20px">
<tr><th>Selector</th><th>Moment</th><th>Declaration</th><th>Runs</th><th>Note</th></tr>
{motion}
</table>

<h4 style="margin-top:32px">The looping rule, stated precisely</h4>
<p>An earlier draft of this document claimed the reading pulse was “the only looping motion
anywhere”. That was never true of the product and is worth correcting rather than quietly
softening: <strong>three things loop</strong>, and only one of them is brand.</p>
<table>
<tr><th></th><th>Loop</th><th>Why it is allowed</th></tr>
<tr><td><code>.capso-reading</code></td><td>the mark, breathing</td>
  <td class="why"><strong>The only looping brand motion.</strong> Sine-based ease-in-out, because an
  ambient loop needs an invisible seam — a strong ease-out would make it tick.</td></tr>
<tr><td><code>.capso-skeleton</code></td><td>content placeholder</td>
  <td class="why">Functional, not brand. It stands in for content that has not arrived; banning it
  would be dogma.</td></tr>
<tr><td><code>.capso-progress</code></td><td>in-flight capture edge</td>
  <td class="why">Functional. Rides the thumbnail, communicates that the model is still working on
  that specific capture.</td></tr>
</table>
<p class="cap">Everything that is not a loop settles inside 250ms. If it draws attention to itself
it is wrong.</p>

<h4 style="margin-top:32px">Reduced motion</h4>
<p>A global rule collapses durations and pins iteration counts to 1. That is right for one-shots and
<em>wrong for loops</em>: it freezes them on their first keyframe. <code>.capso-reading</code> would
have held at 38% opacity — a mark that reads as broken rather than working — so it has an explicit
override to full. Any future loop needs the same treatment; assume the global rule will betray it.</p>
</section>

<hr/>

<section>
<h2>Rules</h2>
<div class="rules">
  <div><h4>Do</h4><ul class="do">
    <li>Let captures carry the colour — the interface stays bone and ink</li>
    <li>Use the italic, not bold or colour, to carry emphasis</li>
    <li>Keep the mark's states tied to real product states</li>
    <li>Show empty slots — an unfilled ring is information</li>
    <li>Photograph objects in order, warm light, real material</li>
    <li>Set marketing in Fraunces, the app in system sans</li>
    <li>Mark what Capso decided, and only what Capso decided</li>
    <li>Give every resurfaced capture a stated reason</li>
  </ul></div>
  <div><h4>Don't</h4><ul>
    <li>No mascot, no face, no eyes. Ever — generated art included (2026-08-12)</li>
    <li>No accent colour on buttons — buttons are ink</li>
    <li>Never use intent colours as text, only as dots</li>
    <li>No gradients, no glow, no sparkles for AI — the mark is the signal</li>
    <li>Never put Fraunces inside the product UI</li>
    <li>No side-profile capsule as the mark — that reads as medicine</li>
    <li>Never use the mark as a watermark or empty-state decoration</li>
  </ul></div>
</div>
</section>

<hr/>

<section>
<h2>One source of truth</h2>
<p>Everything above is only a brand if it cannot drift. The values live in
<code>packages/shared/src/tokens.json</code> and <strong>nothing else in the repo may declare a
colour</strong>. <code>pnpm brand:tokens</code> compiles that file into every surface;
<code>pnpm brand:check</code> fails the build if any output is stale or if a source file declares a
colour of its own, and it runs as part of <code>pnpm lint</code>.</p>
<table>
<tr><th>Surface</th><th>Consumes</th></tr>
<tr><td><code>apps/web</code></td><td><code>app/tokens.generated.css</code>, imported by <code>globals.css</code></td></tr>
<tr><td><code>apps/extension</code></td><td><code>tokens.generated.css</code>, linked from popup + options</td></tr>
<tr><td><code>apps/mac</code></td><td><code>src/tokens.generated.css</code>, imported by <code>App.css</code></td></tr>
<tr><td>icons &amp; OG card</td><td><code>tokens.generated.json</code>, read by the Python builders</td></tr>
</table>
<div class="change" style="margin-top:24px">
  <p><strong>This exists because the alternative was already failing.</strong> The palette had been
  hand-copied into six places and three had drifted: the extension options page still carried a
  retired accent pair, the extension popup carried the accent before <em>that</em> plus the OS
  system colours, and the Mac popover declared no brand values at all — so the surface a user
  touches most often was the least branded one.</p>
  <p>Nobody made a mistake. There was no mechanism, so drift was the default state rather than an
  error. <strong>A brand that depends on everyone remembering is not a system.</strong></p>
</div>
<p style="margin-top:20px">One escape hatch — <code>brand-allow: &lt;reason&gt;</code>, with a
mandatory written reason — because a blanket ban would have forced code to lie. The sample-capture
canvas in <code>capture.tsx</code> depicts <em>somebody else's</em> product, and a fake screenshot
that looks like Capso is worse than no sample at all.</p>
<p class="cap">The useful side effect: changing the ground is now four values in one file. App,
extension, Mac popover, favicon, <code>.icns</code>, tray template and share card all regenerate,
and the check proves nothing was missed.</p>
</section>

<hr/>

<section>
<h2>What this changed in code — applied</h2>
<table>
<tr><th>Token</th><th>Was</th><th>Is</th></tr>
<tr><td><code>--background</code></td><td><code>#fbf9f5</code></td><td><code>{BONE}</code></td></tr>
<tr><td><code>--surface</code></td><td><code>#ffffff</code></td><td><code>{SURF}</code></td></tr>
<tr><td><code>--foreground</code></td><td><code>#141412</code></td><td><code>{INK}</code></td></tr>
<tr><td><code>--muted</code></td><td><code>#6b6a64</code></td><td><code>{MUTED}</code></td></tr>
<tr><td><code>--accent</code></td><td><code>#c2461f</code> / <code>#e8683a</code></td><td><code>{INK}</code> — buttons are ink</td></tr>
<tr><td><code>--accent-ink</code></td><td><code>#ffffff</code> / <code>#141412</code></td><td><code>{BONE}</code></td></tr>
<tr><td><code>--danger</code></td><td colspan="2">new — <code>{DANGER}</code> / <code>{DANGER_DK}</code>, a pair</td></tr>
<tr><td><code>INTENT_COLOR</code></td><td colspan="2">unchanged — moved to the token file, same six values</td></tr>
</table>
<p class="cap"><code>--danger</code> came out of branding the extension, which needed an error
colour. No single red clears 4.5:1 on both grounds — the same trap the terracotta accent fell into
— so it is a light/dark pair. It is <em>not</em> the <code>ux_bug</code> intent dot: that one is
tuned to 3:1 because it is a dot, and this is text.</p>
<p class="cap">The mode-dependent accent is gone: ink inverts with the theme, so dark mode is now
the plain inverse instead of a hand-tuned second pair.</p>
<div class="change" style="margin-top:24px">
  <p><strong>One consequence worth recording.</strong> Roughly seventy call sites used
  <code>text-accent</code>. Most were fills, rings and borders and simply became ink — but eleven
  used the hue as the <em>only</em> at-rest signal on a link or control. With the accent equal to
  the foreground those would have rendered as plain body text.</p>
  <p>Those eleven moved to <code>underline underline-offset-2</code>, or to
  <code>hover:underline</code> where the hover was the affordance. That is the correct answer in an
  ink-only system, and it is the rule going forward: <strong>links are underlined, not
  coloured.</strong> Sites already sitting on <code>text-muted</code> were left alone — muted rising
  to ink on hover is still a real change.</p>
</div>
</section>

<hr/>
<section>
<h2>Shipped</h2>
<p>Everything in this document is in the product or in the pipeline that builds it. The mark is in
the sidebar and on first run, the rack carries fill state on every project, captures arrive by
seating, the overlay crimps on confirm, and the reading state is the mark rather than a borrowed
utility class.</p>
<p><strong>Two things are generated rather than written.</strong> The palette compiles from
<code>packages/shared/src/tokens.json</code>, and the mark's geometry compiles from
<code>capso-lid.svg</code> into <code>components/mark.generated.tsx</code> — a
<code>&lt;path d="…"&gt;</code> pasted into a component is the same drift a hard-coded hex is.
<code>pnpm brand:check</code> fails the build on either, and on any stray colour in source.</p>
<p><strong>Fraunces is SIL OFL 1.1</strong> — commercial use, embedding and redistribution all
permitted. Reserved Font Name, so a modified cut may not be called Fraunces; we do not modify it.</p>
<p style="color:var(--muted);font-size:13.5px;margin:22px 0 0">Still open: the crimp texture at rest
and the zero-state line, both polish. The tray template's Rust-side wire-up.
<code>NEXT_PUBLIC_SITE_URL</code> is unset, so shared links resolve against the Vercel production
host rather than a domain. And the trademark check on the name — <code>MASTER_PLAN.md:61</code>. The
mark survives a rename, being a capsule rather than the letters.</p></section>
</div>
"""

out = ROOT / "GUIDELINES.html"
out.write_text(HTML)
print(f"wrote {out} ({len(HTML):,} bytes)")
print(f"  ink on bone   {cr(INK, BONE):.2f}")
print(f"  muted on bone {cr(MUTED, BONE):.2f}")
print(f"  bone on ink   {cr(BONE, INK):.2f}")
print(f"  espresso/clay {cr(ESPRESSO, CLAY):.2f}")
