/**
 * Brand tokens — the single source of truth for every surface.
 *
 * The data lives in `tokens.json` so that Node, TypeScript and the Python
 * asset builders can all read the same bytes. This module adds types and,
 * more importantly, the *reasons* — a token without a recorded reason is how
 * a design system rots back into taste.
 *
 * Consumers:
 *   apps/web           tokens.generated.css, imported by app/globals.css
 *   apps/extension     tokens.generated.css, linked from popup + options
 *   apps/mac           tokens.generated.css, imported by src/App.css
 *   drafts/brand/mark  tokens.generated.json, read by build_icons/build_og
 *
 * Regenerate all four with `pnpm brand:tokens`; `pnpm brand:check` fails the
 * build if any of them has drifted or if a stray hex appears in source.
 */
import raw from "./tokens.json" with { type: "json" };

export type Scheme = "light" | "dark";

/**
 * There is no accent hue.
 *
 * Every screen in this product is mostly other people's screenshots, and a
 * brand colour cannot win that fight — measured on a full grid, 100% of the
 * chromatic pixels on screen belong to captures. So `accent` is ink and
 * `accent-ink` is the ground; they simply swap between schemes, which also
 * retires the old mode-dependent terracotta that needed a hand-tuned pair per
 * scheme to clear AA.
 *
 * `background` is warm on purpose. Most captures are white-ish, so the ground
 * has to separate from pure white or cards stop having edges — bone measures
 * 1.135:1 against white where a cool near-white manages only 1.073:1.
 */
export const color: Record<Scheme, Readonly<Record<string, string>>> = raw.color;

/**
 * The only hues in the product. Semantic, not decorative: one per classifier
 * intent, rendered as an 8px dot and never as text — they are tuned to clear
 * 3:1 on both grounds, which is the non-text floor, not the 4.5:1 text one.
 */
export const intent: Readonly<Record<string, string>> = raw.intent;

/** Marketing surfaces only — landing pages, OG cards, photography. Never in-app. */
export const marketing: Readonly<Record<string, string>> = raw.marketing;

/** Under 250ms throughout: every one of these surfaces is hit daily. */
export const motion: Readonly<Record<string, string>> = raw.motion;

export const radius: Readonly<Record<string, string>> = raw.radius;

/**
 * `display` is Fraunces (SIL OFL 1.1) and is for marketing only — it must never
 * enter the app bundle, where the cost of a webfont is a layout shift on a
 * screen the user opens twenty times a day.
 */
export const font: Readonly<Record<string, string>> = raw.font;

/** WCAG AA. Asserted by the asset builders rather than eyeballed. */
export const contrastFloors = raw.contrastFloors;

/** Which named ground is active. Switching it is a four-value edit in tokens.json. */
export const ground: string = raw.ground;

export const tokens = raw;
export default tokens;
