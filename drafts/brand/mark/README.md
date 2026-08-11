# Capso icon set

Hand-drawn mark and the full icon set derived from it. **Installed** as of
2026-08-01 — `out/` is generated output and `install.sh --apply` has been run.

## Source files — edit these

| File | What it is |
|---|---|
| `capso-lid.svg` | **The source of truth.** A capsule lid seen from above: flange rim r10.4, crimp ring r8.2, sealed face r6.0, notch through the right at y10.4–13.6. 24-unit grid, `currentColor`, transparent ground. |
| `capso-capsule.svg` | Side profile — truncated cone with a flange. Not the mark. Exists for the rack, columns and motion, and for the coffee-vs-medicine comparison. |
| `capso-icon-16.svg` | Pixel-hinted 16px master. Deliberately different geometry — see below. |
| `capso-icon-web.svg` | Composed: full-bleed bone plate + ink mark. *Generated — do not hand-edit.* |
| `capso-icon-mac.svg` | Composed: bone squircle with Apple's margin. *Generated.* |
| `capso-tray.svg` | Composed: black template for the macOS menu bar. *Generated.* |

Rebuild after any edit:

```bash
python3 drafts/brand/mark/build_icons.py
python3 drafts/brand/mark/build_og.py
bash drafts/brand/mark/install.sh --apply
```

### Superseded — kept for history, not built from

`capso-silhouette.svg` and `capso-mark.svg` are the earlier blob-capsule mascot
with knocked-out eyes. That direction was dropped: there is no character in this
brand. Nothing in the build reads them.

Still true after 2026-08-12, when the illustration ban was lifted. The brand now
ships generated still-life art (`drafts/brand/art/`), but a character was
considered again and declined again. These two files stay superseded.

## The other build chain

`drafts/brand/art/` holds the generated art programme — masters, manifest and
`build_art.py`. It is a sibling of this directory, not a part of it: the two have
separate `install.sh` scripts on purpose, so rebuilding art can never clobber
icons. The 24-grid glyph sources under `art/glyphs/` are compiled into components
by `scripts/gen-tokens.mjs`, the same way `capso-lid.svg` becomes `mark.generated.tsx`.

## Why the plate is bone and the mark is ink

There is no accent colour in this brand, so the plate had to be one of the two
neutrals. Ink loses: `#1f1f1e` sits at almost exactly the luminance of Chrome's
dark tab strip and the icon disappears into it. A dark glyph on a light plate is
also the higher-contrast direction at 16px, and it survives light *and* dark
browser chrome.

## Why 16px has its own file

A downscale can't work there. The crimp ring is 2.2 units on a 24-unit grid; at
16px that lands on ~1.5 device pixels and antialiases into a grey smear — losing
the one detail that makes the mark read as a coffee capsule rather than a disc.
`capso-icon-16.svg` redraws it on a 16-unit grid where every axis-aligned edge
falls on a whole pixel: rim r7/r5 (exactly 2px of ring), gap 2px, face r3.

Two deliberate divergences from the master, both documented in the SVG: the face
sits at 0.43 of the rim rather than 0.577, because a proportionally correct face
leaves a 1px gap that closes on the diagonals; and the notch runs from x8 so it
still severs the rim *and* slots the face, which is what keeps the glyph the same
letter at 16px as at 128px.

Check `out/icon-qa-sheet.png` after any change — it puts every small size beside
a 12× pixelated blow-up.

One more thing learned the hard way and recorded in the SVG: the notch mask has
to sit on the `<g>`, not on the ring `<path>`. On the path alone the face keeps
its slot-free centre and the mark reads as a different glyph at 16px than at 32.

## Do not let Pillow resize .ico frames

`pack_ico()` renders one PNG per size through Chrome and hands Pillow an
exact-size image for **every** requested size. That is not belt-and-braces — the
obvious approach is actively broken. In Pillow 12.2 `IcoImagePlugin._save`:

1. the `for provided_im in provided_ims: … else:` block reuses the loop variable
   after fall-through, so a size with no exact match is resized from the **last**
   provided image rather than the base one; and
2. that resize is `thumbnail()`, which never upscales.

Passing a base image plus `append_images=[hinted16]` therefore builds every
frame from the 16px master and leaves them all 16×16. It did: the Tauri
`icon.ico` shipped seven 16×16 frames, and `favicon.ico` had its 32 replaced by
a duplicate 16. Neither Pillow nor `im.info["sizes"]` reports this — `sizes` is
deduplicated, so it looked correct.

`pack_ico()` now reads the .ico directory table back and asserts both the frame
list and that the 16px frame is the hinted master byte-for-byte.

## Output — `out/`

| File | Size | Goes to |
|---|---|---|
| `favicon.ico` | 16/32/48 | `apps/web/app/favicon.ico` |
| `icon-180.png` | 180 | `apps/web/public/apple-touch-icon.png` |
| `icon-192.png` `icon-512.png` | 192, 512 | `apps/web/public/` |
| `og-image.png` | 1200×630 | `apps/web/public/og-image.png` |
| `icon-16/32/48/128.png` | — | `apps/extension/icons/` |
| `32x32.png` `128x128.png` `128x128@2x.png` `icon.icns` `icon.ico` `icon-1024.png` | — | `apps/mac/src-tauri/icons/` |
| `trayTemplate.png` `trayTemplate@2x.png` | 22, 44 | `apps/mac/src-tauri/icons/` — menu-bar template |
| `icon-qa-sheet.png` | — | QA reference, not shipped |

## Wire-up beyond copying files

- **`apps/extension/manifest.json`** — done. `icons` and `action.default_icon`
  both declare 16/32/48/128.
- **`apps/web/app/layout.tsx`** — done. `metadataBase`, `icons`, `openGraph`,
  `twitter`, and a `viewport` export carrying `themeColor` per mode.
  `metadataBase` reads `NEXT_PUBLIC_SITE_URL` and falls back to localhost; set
  that env var once a domain exists or the OG image will resolve against :3000.
- **`apps/mac/src-tauri/tauri.conf.json`** — `bundle.icon` already lists the
  right filenames, so the copy is enough. The tray template is a separate
  wire-up on the Rust side and is **still not done**.

## The OG card

`build_og.py` renders HTML through headless Chrome rather than drawing with
Pillow, which is what lets the card use real Fraunces — fetched from Google
Fonts at render time, so no font file is vendored. Fraunces is SIL OFL 1.1:
commercial use, embedding and redistribution all permitted; it is a Reserved
Font Name, so a modified cut may not be called Fraunces. We do not modify it.

Contrast ratios are asserted in the script, not eyeballed.

## Still open

- Tray template wire-up in the Tauri Rust side.
- `NEXT_PUBLIC_SITE_URL` — no production domain registered yet.
- Trademark check on the name "Capso" (`MASTER_PLAN.md:61`). The mark survives a
  rename, being a capsule rather than the letters.
