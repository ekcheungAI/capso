"use client";

import Image from "next/image";

/**
 * Generated art (D17, 2026-08-12), direction "Decks and Trays".
 *
 * Raster rather than inline SVG, which has one consequence worth stating: these
 * files are outside `brand:check`'s reach — it scans source for stray hex and
 * never opens an image. The palette guarantee for them lives in
 * `drafts/brand/art/build_art.py`, which measures OKLCH chroma against the
 * ceilings in `tokens.illustration` and refuses anything that would out-saturate
 * a screenshot. Adding art here without going through that pipeline skips the
 * only check there is.
 *
 * Every piece is decorative: the sentence beside it carries the meaning, so the
 * alt text is empty and the image is hidden from screen readers rather than
 * described. An illustration of an empty tray narrated as "an empty tray" tells
 * a screen-reader user nothing the heading did not already say.
 */

const ART = {
  "role-marketing": "/art/role-marketing.webp",
  "role-product": "/art/role-product.webp",
  "role-founder": "/art/role-founder.webp",
  "role-empty": "/art/role-empty.webp",
} as const;

export type ArtName = keyof typeof ART;

export function Art({
  name,
  className = "",
  sizes = "(min-width: 640px) 340px, 100vw",
  priority = false,
}: {
  name: ArtName;
  className?: string;
  sizes?: string;
  priority?: boolean;
}) {
  return (
    <Image
      src={ART[name]}
      alt=""
      aria-hidden
      width={720}
      height={483}
      sizes={sizes}
      priority={priority}
      className={className}
    />
  );
}
