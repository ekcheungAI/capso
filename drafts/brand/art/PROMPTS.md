# Capso generated art — prompts

Every prompt that produced a shipped asset, verbatim. `manifest.json` points at
the anchors below by id (`PROMPTS.md#cards-empty`), so an asset can always be
traced back to the words that made it.

Model for every target: **`nano_banana_pro`** (Higgsfield MCP).

`marketing_studio_image` was considered and rejected: its `medias[].roles` wants a
real product photograph as input, there is no physical Capso product to shoot,
and its house style is ad-slick — which is the one register the direction below
forbids.

---

## The stem

Prepended to every **brand-register** prompt (role cards, hero, OG plate, icon
sheets). Not used for sample screenshots, which are deliberately off-brand — see
"Content register" at the bottom.

```
Editorial still-life photograph, medium-format camera, 80mm lens at f/5.6.
Subject: small anonymous archival objects arranged in deliberate order on a
matte, slightly textured warm off-white paper surface, seen from directly
overhead at 90 degrees.

Objects: brushed anodised aluminium discs the size of a coffee-capsule lid, each
with a shallow crimped rim and one small notch cut through the edge; a low
sand-coloured paperboard rack with evenly spaced circular slots, some slots
holding a disc, some empty; plain unprinted paper rectangles, edges crisp and
square, with absolutely no text or graphics printed on them.

Light: one soft north-facing window from the upper left, no fill light, no
second source. Shadows are long, soft-edged, warm grey, and fall consistently to
the lower right. Every surface is matte — paper, not plastic. Visible paper grain.

Colour: strictly warm neutral. Clay, sand, espresso brown, aluminium grey. Total
chroma across the frame must stay very low.

Composition: asymmetric, off-centre, with generous negative space.

Do not include: people, faces, hands, characters, eyes, mascots. No glowing
edges, neon, bloom, lens flare, god rays, particles, sparkles. No blue or purple
technology gradient, no cyan, no magenta. No circuit boards, brains, robots,
wireframe globes, or any AI symbolism. No floating translucent UI panels, no
glassmorphism, no chrome, no reflective plastic. No 3D render look, no Blender
studio HDRI, no clay render. No isometric city. No readable text and no logos
anywhere in the frame. No laptops, phones, coffee cups, latte art, succulents,
notebooks or pens. No vignette. No HDR. Never centred with a radial glow.
```

Why this does not read as AI slop: slop is centred, glowing, blue-purple,
3D-rendered and symmetrical. Every one of those is in the negative list. What is
left is a photographic still life with one light source and warm neutrals.

Why it coexists with "screenshots are the hero": it is chromatically **quieter**
than any screenshot. Doc 15 records that 100% of the chromatic pixels on a real
grid belong to the captures. This art keeps that true — it adds texture and
light, not hue.

---

## Brand register

### `#cards-marketing` — role card, "Marketing"
> …stem… A fan of overlapping blank paper rectangles in poster proportions, spread across the surface like swatches being compared, one disc resting on the topmost sheet.

### `#cards-product` — role card, "Product & design"
> …stem… A squared, precisely aligned stack of blank paper rectangles with two small paper tabs protruding from the middle of the stack, one disc set beside it.

### `#cards-founder` — role card, "Founder"
> …stem… Two separate stacks of blank paper meeting at a shallow angle, with a single aluminium disc bridging the gap between them.

### `#cards-empty` — role card, "Start empty"
> …stem… A bare sand-coloured paperboard rack, every circular slot empty, with one shaft of window light falling through a single slot onto the paper beneath.

Acceptance for this set: reviewed together at real 340px card width. If any one
reads as a different shoot, re-roll the whole set, not the outlier. **`#cards-empty`
must read as readiness, not sadness** — doc 15 banned sad boxes for a reason, and
that reasoning survives the override.

### `#hero-wide` — landing hero, 21:9
> …stem… A wide paperboard rack seen overhead, discs seated in the left third, the right two thirds empty paper surface for typography.

### `#hero-tall` — landing hero, 4:5 (≤768px)
Generated natively rather than reframed from `#hero-wide`: a reframe crops the
negative space, which is exactly where the headline goes.

### `#og-plate` — OG card plate, 4:3
Consumed by `build_og.py`, which composites Fraunces type over it in headless
Chrome and asserts contrast. Generate the plate only — no type.

### `#icons-sheet` — icon concept sheets, 1:1
> A 4×4 grid of flat monochrome pictograms, dark ink on a warm off-white ground, uniform stroke weight, drawn on a visible 24-unit grid. Subjects: a rack of circular slots, a single empty slot, a disc seated in a slot, a disc being pulled out, a crimped rim seen edge-on, a stack of discs. Geometric, minimal, no perspective, no shading, no colour, no text.

**Reference only — never shipped.** Higgsfield emits raster; the rail renders at
18–20px monochrome. These sheets are looked at while hand-authoring
`glyphs/*.svg`. See README in `../mark/` for why a raster glyph fails at 16px.

---

## Content register — sample screenshots

Deliberately **off-brand**. These depict somebody else's product, so a sample
that looks like Capso is a bug, and `build_art.py` asserts the background is at
least ΔE 12 *away* from bone.

Every product depicted is **fictional**: Verrick (dev tool), Brellow (payments),
Palewick (notes/AI), Corveth (email), Skaldi (launcher), Weftly (browser). The
names were cleared before use. Do not reintroduce real ones — see the header
comment in `apps/web/lib/store/seed.ts`.

### Safety text — appended to every content-register prompt

```
This depicts a FICTIONAL software product named "<Name>". No real company,
brand, logo, wordmark or product may appear. Do not reproduce the interface of
Linear, Stripe, Notion, Superhuman, Raycast, Arc, Figma, Slack, Apple or Google,
or of any real product. No App Store or Play Store chrome. No macOS traffic-light
window buttons and no iOS status bar — use a plain neutral window frame. Any logo
in frame is an abstract geometric glyph invented for this fictional product.
```

### Believability levers — apply to every shot

Perfection reads as fake. Each prompt asks for:

1. **Real data density** — awkward numbers (`2,481`, not `2,500`), a legal
   footnote in small grey type, one truncated label with an ellipsis.
2. **One imperfection** — a slightly clipped tooltip, a scrollbar stopped
   mid-track, a row left in its hover state. Real screenshots are caught mid-use.
3. **Chrome matching the seed's `type`** — `web_page` gets a browser frame with a
   plausible fake URL (`app.verrick.io/settings/billing`); `ui_screen` gets none.
4. **A distinct palette per fictional product** — Verrick cool-grey/indigo,
   Brellow warm red, Palewick amber, Corveth violet, Skaldi near-black, Weftly
   green. This is both the believability lever and the ΔE assertion.

### `#screens-cjk` — seed s10, 競品 changelog

**Hard gate.** Traditional Chinese OCR is a stated product requirement, and CJK
glyph fidelity is the known weak spot of every image model. This asset must OCR
correctly through the real pipeline. After two failed re-rolls, keep the
canvas-drawn original for this one asset and record the exception in
`manifest.json`. Never ship malformed Chinese in a product that claims to read
Chinese.
