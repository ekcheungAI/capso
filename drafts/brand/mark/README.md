# Capso icon set

Hand-drawn mark and the full icon set derived from it. **Nothing here is installed
yet** — `out/` is generated output, and `install.sh` copies it into `apps/`.

> Not installed on purpose: a concurrent Claude Code session was editing
> `apps/web` while this was built. Run `install.sh` when that settles.

## Source files — edit these

| File | What it is |
|---|---|
| `capso-silhouette.svg` | **The source of truth.** Single-colour capsule, knocked-out eyes, split seam. Everything 32px and up derives from it. |
| `capso-mark.svg` | Primary two-tone mark (terracotta cap, cream body, hairline). For docs and UI, not for icons. |
| `capso-icon-16.svg` | Pixel-hinted 16px master. Deliberately different geometry — see below. |
| `capso-icon-web.svg` | Composed: full-bleed accent plate + cream mark. *Generated — do not hand-edit.* |
| `capso-icon-mac.svg` | Composed: squircle with Apple's margin. *Generated.* |
| `capso-tray.svg` | Composed: black template for the macOS menu bar. *Generated.* |

Rebuild after any edit:

```bash
python3 drafts/brand/mark/build_icons.py
```

## Why 16px has its own file

A downscale can't work there. The eye radius is 1.65 on a 24-unit grid; at 16px
that lands on ~1.5 device pixels and antialiases into a smudge. `capso-icon-16.svg`
redraws the mark on a 16-unit grid where every edge falls on a whole pixel, with
**square** eyes — at 2px a circle is mush and a square is crisp, and at that size
nobody can tell the difference. `build_icons.py` embeds it into `favicon.ico` and
`icon.ico` via `append_images` so Pillow can't quietly re-downscale it.

Two other things learned the hard way, both recorded in the SVG comments:
`shape-rendering="crispEdges"` deforms the rounded arcs and must stay off the body,
and the eye radius had to go from 1.25 to 1.65 before it resolved at small sizes.

## Geometry

24-unit grid. Body `x4 y3 w16 h18 rx7` — a 16:18 ratio matching the approved A1
render, with `rx7` leaving only a 2-unit straight horizontal run so it reads as a
capsule, not a rounded rectangle. Seam at `y12`, dead centre. Eyes at `cy8.2 r1.65`,
`cx9.15/14.85` — sat lower than the generated render, which had them too high.

## Output — `out/`

| File | Size | Goes to |
|---|---|---|
| `favicon.ico` | 16/32/48 | `apps/web/app/favicon.ico` |
| `icon-180.png` | 180 | `apps/web/public/apple-touch-icon.png` |
| `icon-192.png` `icon-512.png` | 192, 512 | `apps/web/public/` (PWA manifest) |
| `og-image.png` | 1200×630 | `apps/web/public/og-image.png` |
| `icon-16/32/48/128.png` | — | `apps/extension/icons/` |
| `32x32.png` `128x128.png` `128x128@2x.png` `icon.icns` `icon.ico` `icon-1024.png` | — | `apps/mac/src-tauri/icons/` |
| `trayTemplate.png` `trayTemplate@2x.png` | 22, 44 | `apps/mac/src-tauri/icons/` — menu-bar template |
| `icon-qa-sheet.png` | — | QA reference, not shipped |

## Manifest changes `install.sh` does not make

Copying files is not enough. These still need editing by hand:

**`apps/extension/manifest.json`** — `icons` currently declares only `128`, and
`action` has no `default_icon` at all, which is why Chrome shows a generic letter
tile:

```json
"icons":  { "16": "icons/icon16.png", "32": "icons/icon32.png",
            "48": "icons/icon48.png", "128": "icons/icon128.png" },
"action": { "default_popup": "popup.html", "default_title": "Capso",
            "default_icon": { "16": "icons/icon16.png",
                              "32": "icons/icon32.png",
                              "48": "icons/icon48.png" } }
```

**`apps/web/app/layout.tsx`** — has only `title` and `description`. Needs
`metadataBase`, `icons` and `openGraph` before the OG card does anything.

**`apps/mac/src-tauri/tauri.conf.json`** — `bundle.icon` already lists the right
filenames, so the copy is enough. The tray template is a separate wire-up in the
Rust side.

## Still open

- **The OG background is procedural, not generated.** It was meant to come from
  gpt-image-2 via the imagegen skill; that call is blocked by the sandbox
  classifier. `build_og.py` documents the swap point if that gets approved.
- `15_DESIGN_SYSTEM_AND_UX.md:79-84` still reads *"NO visual mascot/character in
  MVP"*. That needs amending before any of this ships.
