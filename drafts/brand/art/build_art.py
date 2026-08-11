#!/usr/bin/env python3
"""Validate and derive Capso's generated art from the curated masters.

    python3 drafts/brand/art/build_art.py            validate + write out/
    python3 drafts/brand/art/build_art.py --check    validate only, write nothing

Sibling of ../mark/build_icons.py, deliberately not part of it: the two have
separate install.sh scripts so that rebuilding art can never clobber icons.

What this exists to prevent. The brand has one mechanism (gen-tokens.mjs) that
stops colours drifting, and it works because it *asserts* rather than documents.
Generated art has three ways to drift that a comment cannot catch:

  1. A master gets hand-edited in Preview and no longer matches what was
     reviewed.  ->  sha256 pinned in manifest.json.
  2. Art creeps up in saturation until it competes with the screenshots it sits
     beside, breaking design principle 5.  ->  OKLCH chroma ceilings from
     tokens.illustration, measured per asset.
  3. A *sample* screenshot drifts toward Capso's own palette, so a fake
     screenshot of somebody else's product starts looking like ours — which doc
     15 calls worse than shipping no sample at all.  ->  the inverse assertion,
     sampleMinDeltaE.

Colour maths is hand-rolled sRGB -> OKLab: numpy is not installed on this
machine and one 40-line conversion is cheaper than a new dependency in a script
that runs by hand a few times a year.
"""
import hashlib
import json
import sys
from io import BytesIO
from math import cbrt
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent.parent
OUT = HERE / "out"
MANIFEST = json.loads((HERE / "manifest.json").read_text())
TOKENS = json.loads((HERE / "../tokens.generated.json").resolve().read_text())
ILL = TOKENS["illustration"]

CHECK = "--check" in sys.argv
errors: list[str] = []
notes: list[str] = []


def fail(msg: str) -> None:
    errors.append(msg)


# --- colour ------------------------------------------------------------------

def _lin(c: float) -> float:
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def oklab(rgb: tuple[int, int, int]) -> tuple[float, float, float]:
    """sRGB 0-255 -> OKLab. Bjorn Ottosson's matrices."""
    r, g, b = (_lin(v / 255) for v in rgb)
    l = cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
    m = cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
    s = cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
    return (
        0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
        1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
        0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
    )


def chroma(rgb: tuple[int, int, int]) -> float:
    """OKLCH chroma, scaled x100 so the token ceilings read as friendly integers."""
    _, a, b = oklab(rgb)
    return (a * a + b * b) ** 0.5 * 100


def delta_e(x: tuple[int, int, int], y: tuple[int, int, int]) -> float:
    """Euclidean distance in OKLab, x100. Close enough to CIEDE2000 for a gate
    whose job is 'obviously the same ground' vs 'obviously a different one'."""
    a, b = oklab(x), oklab(y)
    return sum((p - q) ** 2 for p, q in zip(a, b)) ** 0.5 * 100


def delta_ab(x: tuple[int, int, int], y: tuple[int, int, int]) -> float:
    """Distance in the chroma plane only — hue and saturation, ignoring lightness.

    This is the right test for "is this the same paper as the rest of the set",
    and full delta_e is the wrong one. Measured against the first real batch, the
    generated grounds were unmistakably the same warm off-white but landed 7-31
    away on full OKLab, purely because the model exposes brighter or dimmer frame
    to frame. Exposure is a photographic variable; hue is the brand. Gating on
    lightness would have rejected seven of eight frames that were in fact correct,
    and the fix for that failure would have been to loosen the ceiling until it
    caught nothing at all.
    """
    _, a1, b1 = oklab(x)
    _, a2, b2 = oklab(y)
    return ((a1 - a2) ** 2 + (b1 - b2) ** 2) ** 0.5 * 100


def hex_rgb(h: str) -> tuple[int, int, int]:
    h = h.lstrip("#")
    return tuple(int(h[i : i + 2], 16) for i in (0, 2, 4))  # type: ignore[return-value]


def sample_pixels(im: Image.Image, cap: int = 40_000) -> list[tuple[int, int, int]]:
    """Thumbnail first: a 4K master has 8M pixels and the ceilings are about the
    overall impression, not about one stray saturated speck."""
    small = im.convert("RGB").copy()
    small.thumbnail((200, 200))
    raw = small.tobytes()  # not getdata(), which Pillow 14 removes
    return [(raw[i], raw[i + 1], raw[i + 2]) for i in range(0, min(len(raw), cap * 3), 3)]


def modal_bg(px: list[tuple[int, int, int]]) -> tuple[int, int, int]:
    """Most common colour, quantised to 16 levels per channel so near-identical
    paper pixels count as one bucket instead of ten thousand."""
    buckets: dict[tuple[int, int, int], int] = {}
    for p in px:
        k = (p[0] // 16, p[1] // 16, p[2] // 16)
        buckets[k] = buckets.get(k, 0) + 1
    b = max(buckets, key=lambda k: buckets[k])
    return (b[0] * 16 + 8, b[1] * 16 + 8, b[2] * 16 + 8)


# --- checks ------------------------------------------------------------------

GROUND = hex_rgb(ILL["ground"])
BONE = hex_rgb(TOKENS["color"]["light"]["background"])


def check_palette(asset: dict, im: Image.Image) -> None:
    px = sample_pixels(im)
    chromas = sorted(chroma(p) for p in px)
    p99 = chromas[int(len(chromas) * 0.99) - 1]
    mean = sum(chromas) / len(chromas)
    bg = modal_bg(px)
    aid, register = asset["id"], asset.get("register", "brand")

    if register == "brand":
        if p99 > ILL["maxChroma"]:
            fail(f"{aid}: p99 chroma {p99:.1f} > {ILL['maxChroma']} — art is out-saturating captures")
        if mean > ILL["maxMeanChroma"]:
            fail(f"{aid}: mean chroma {mean:.1f} > {ILL['maxMeanChroma']}")
        d = delta_ab(bg, GROUND)
        if d > ILL["groundDeltaE"]:
            fail(f"{aid}: ground hue distance {d:.1f} > {ILL['groundDeltaE']} — not the same paper as the rest of the set")
        notes.append(f"  {aid:22} p99 {p99:5.1f}  mean {mean:5.1f}  ground dE {d:5.1f}")
    else:
        # Checked the opposite way round from brand art, and NOT merely by distance
        # from bone: a realistic light SaaS UI sits about dE 3 from bone, so a
        # distance gate would have forced every sample dark or heavily tinted — and
        # an unbelievable sample is worse than no sample. What actually distinguishes
        # somebody else's product from ours is that theirs HAS a brand colour. Capso
        # has none by decision, so "carries a hue of its own" is the real test.
        d = delta_ab(bg, BONE)
        if p99 < ILL["sampleMinChroma"]:
            fail(
                f"{aid}: p99 chroma {p99:.1f} < {ILL['sampleMinChroma']} — sample has no palette of "
                f"its own and reads as Capso's own neutral UI"
            )
        if d < ILL["sampleMinGroundDeltaE"]:
            fail(f"{aid}: background dE {d:.1f} from bone — this is literally our paper")
        notes.append(f"  {aid:22} p99 {p99:5.1f}  bone dE {d:5.1f}  (off-brand by design)")


def main() -> int:
    assets = MANIFEST["assets"]
    if not assets:
        print("manifest has no assets yet — nothing to build.")
        print("ok     mechanism is wired; add rows after generation passes its acceptance bar")
        return 0

    if not CHECK:
        OUT.mkdir(parents=True, exist_ok=True)
    total = 0

    for asset in assets:
        aid = asset["id"]
        master = HERE / asset["master"]
        if not master.exists():
            fail(f"{aid}: master missing — {asset['master']}")
            continue

        raw = master.read_bytes()
        got = hashlib.sha256(raw).hexdigest()
        if got != asset["sha256"]:
            fail(f"{aid}: sha256 drift — master was edited after review\n"
                 f"         manifest {asset['sha256'][:16]}…  actual {got[:16]}…")
            continue

        with Image.open(master) as im:
            check_palette(asset, im)

            for inst in asset["install"]:
                dest = OUT / Path(inst["to"]).name
                out_im = im.convert("RGB")
                if (edge := inst.get("longEdge")):
                    out_im.thumbnail((edge, edge), Image.LANCZOS)

                # Encode to memory first and measure THAT, in both modes. The first
                # cut measured len(raw) — the master — when checking, so --check and
                # a real build disagreed and --check false-failed on masters that
                # derived down fine. A check mode that does not agree with the build
                # is worse than no check mode.
                fmt, opts = (
                    ("PNG", {"optimize": True})
                    if dest.suffix == ".png"
                    else ("WEBP", {"quality": inst.get("quality", 78), "method": 6})
                )
                buf = BytesIO()
                out_im.save(buf, fmt, **opts)
                size = buf.tell()
                if not CHECK:
                    dest.write_bytes(buf.getvalue())
                if size > inst["maxBytes"]:
                    fail(f"{aid}: {dest.name} is {size:,} B > {inst['maxBytes']:,} B budget")
                if inst["to"].startswith("apps/web/public/"):
                    total += size

    ceiling = MANIFEST["budget"]["publicBytesCeiling"]
    if total > ceiling:
        fail(f"aggregate apps/web/public art is {total:,} B > {ceiling:,} B ceiling")

    if notes:
        print("palette:")
        print("\n".join(notes))
    print(f"\napps/web/public art total: {total:,} B of {ceiling:,} B")

    if errors:
        print("\n" + "\n".join(f"FAIL   {e}" for e in errors), file=sys.stderr)
        return 1
    print(f"ok     {len(assets)} asset(s) validated" + ("" if CHECK else f", derivatives in {OUT}"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
