#!/usr/bin/env python3
"""Contact sheet for raw generation candidates, at the size they will actually ship.

    python3 drafts/brand/art/qa-sheet.py cards --width 340
    python3 drafts/brand/art/qa-sheet.py screens --width 400

Reads ../renders-art/<batch>/ (gitignored raw output) and writes
out/qa-<batch>.png. Distinct from build_art.py, which validates *curated*
masters: this one is for the go/no-go review that happens BEFORE curation.

Why review at delivery size rather than full resolution. The role cards render
in a 340px-wide button. A still life that is beautiful at 1024px and mud at
340px is a failed asset, and the only way to see that is to look at it at 340px.
../mark/README.md records the same lesson from the other direction — the crimp
ring survives 24px and turns to grey smear at 16px, which is why there is a
separate hand-hinted master for that size.

The set matters more than any single frame: if one card reads as a different
shoot, re-roll the whole set rather than the outlier.
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
RAW = HERE.parent / "renders-art"
OUT = HERE / "out"
PAD = 24
LABEL = 18


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    batch = sys.argv[1]
    width = int(sys.argv[sys.argv.index("--width") + 1]) if "--width" in sys.argv else 340

    src = RAW / batch
    if not src.is_dir():
        print(f"error: {src} not found — generate into it first", file=sys.stderr)
        return 1

    files = sorted(p for p in src.iterdir() if p.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"})
    if not files:
        print(f"error: no images in {src}", file=sys.stderr)
        return 1

    thumbs = []
    for f in files:
        with Image.open(f) as im:
            im = im.convert("RGB")
            h = round(im.height * width / im.width)
            thumbs.append((f.name, im.resize((width, h), Image.LANCZOS)))

    cols = min(4, len(thumbs))
    rows = (len(thumbs) + cols - 1) // cols
    cell_h = max(t.height for _, t in thumbs) + LABEL
    sheet = Image.new(
        "RGB",
        (cols * width + PAD * (cols + 1), rows * cell_h + PAD * (rows + 1)),
        (244, 240, 235),  # bone — review on the ground the art will sit on
    )
    draw = ImageDraw.Draw(sheet)

    for i, (name, t) in enumerate(thumbs):
        x = PAD + (i % cols) * (width + PAD)
        y = PAD + (i // cols) * (cell_h + PAD)
        sheet.paste(t, (x, y))
        draw.text((x, y + t.height + 4), name[:44], fill=(111, 106, 98))

    OUT.mkdir(parents=True, exist_ok=True)
    dest = OUT / f"qa-{batch}.png"
    sheet.save(dest, "PNG", optimize=True)
    print(f"wrote {dest}  ({len(thumbs)} candidates at {width}px, on bone)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
