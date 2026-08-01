/* GENERATED — DO NOT EDIT.
   Source: drafts/brand/mark/capso-lid.svg
   Regenerate: pnpm brand:tokens   ·   Verify: pnpm brand:check */

type Fill = "empty" | "some" | "full";

/**
 * Renders once, near the root. Every <CapsoMark> is a <use> of one of these.
 */
export function CapsoMarkDefs() {
  return (
    <svg width="0" height="0" aria-hidden="true" style={{ position: "absolute" }}>
      <defs>
        <mask id="capso-notch-def">
          <rect width="24" height="24" fill="#fff" />
          <rect x="12" y="10.4" width="11" height="3.2" fill="#000" />
        </mask>
      <symbol id="capso-lid-empty" viewBox="0 0 24 24">
        <g fill="currentColor" fillRule="evenodd" mask="url(#capso-notch-def)">
          <path d="M12 1.6 a10.4 10.4 0 1 1 0 20.8 a10.4 10.4 0 0 1 0 -20.8 z M12 3.8 a8.2 8.2 0 1 0 0 16.4 a8.2 8.2 0 0 0 0 -16.4 z" />
        </g>
      </symbol>
      <symbol id="capso-lid-some" viewBox="0 0 24 24">
        <g fill="currentColor" fillRule="evenodd" mask="url(#capso-notch-def)">
          <path d="M12 1.6 a10.4 10.4 0 1 1 0 20.8 a10.4 10.4 0 0 1 0 -20.8 z M12 3.8 a8.2 8.2 0 1 0 0 16.4 a8.2 8.2 0 0 0 0 -16.4 z" />
          <circle cx="12" cy="12" r="3" />
        </g>
      </symbol>
      <symbol id="capso-lid-full" viewBox="0 0 24 24">
        <g fill="currentColor" fillRule="evenodd" mask="url(#capso-notch-def)">
          <path d="M12 1.6 a10.4 10.4 0 1 1 0 20.8 a10.4 10.4 0 0 1 0 -20.8 z M12 3.8 a8.2 8.2 0 1 0 0 16.4 a8.2 8.2 0 0 0 0 -16.4 z" />
          <circle cx="12" cy="12" r="6" />
        </g>
      </symbol>
      </defs>
    </svg>
  );
}

/**
 * `fill` is the provenance-free half of the brand: an open ring is a slot
 * waiting, a part face is a shelf with something on it, a full face is one that
 * is filling up. Pass a `label` to make it announced; without one it is
 * decorative and hidden from assistive tech.
 */
export function CapsoMark({
  size = 16,
  fill = "full",
  className = "",
  label,
}: {
  size?: number;
  fill?: Fill;
  className?: string;
  label?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      className={className}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={{ display: "block", flex: "none" }}
    >
      <use href={`#capso-lid-${fill}`} />
    </svg>
  );
}

/** Counts to fill states. Kept here so every surface bands them identically. */
export function fillFor(count: number): Fill {
  if (count <= 0) return "empty";
  return count < 5 ? "some" : "full";
}
