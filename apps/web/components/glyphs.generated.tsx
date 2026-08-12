/* GENERATED — DO NOT EDIT.
   Source: drafts/brand/art/glyphs/
   Regenerate: pnpm brand:tokens   ·   Verify: pnpm brand:check */

export type GlyphName = "arrow" | "blur" | "box" | "deck" | "rack" | "seat" | "text" | "undo";

/** Renders once, near the root. Every <CapsoGlyph> is a <use> of one of these. */
export function CapsoGlyphDefs() {
  return (
    <svg width="0" height="0" aria-hidden="true" style={{ position: "absolute" }}>
      <defs>
      <symbol id="capso-glyph-arrow" viewBox="0 0 24 24">
        <g fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 19 19 5"/>
          <path d="M12 5h7v7"/>
        </g>
      </symbol>
      <symbol id="capso-glyph-blur" viewBox="0 0 24 24">
        <g fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
          <rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/>
          <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/>
          <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/>
          <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/>
        </g>
      </symbol>
      <symbol id="capso-glyph-box" viewBox="0 0 24 24">
        <g fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
          <rect x="5" y="5" width="14" height="14" rx="2"/>
        </g>
      </symbol>
      <symbol id="capso-glyph-deck" viewBox="0 0 24 24">
        <g fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="14" cy="14" r="5.75"/>
          <path d="M4.25 10A5.75 5.75 0 0 1 10 4.25"/>
        </g>
      </symbol>
      <symbol id="capso-glyph-rack" viewBox="0 0 24 24">
        <g fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2.5" y="6.25" width="19" height="11.5" rx="2.75"/>
          <circle cx="7.5" cy="12" r="1.55" fill="currentColor" stroke="none"/>
          <circle cx="12" cy="12" r="1.55" fill="currentColor" stroke="none"/>
          <circle cx="16.5" cy="12" r="1.55" fill="currentColor" stroke="none"/>
        </g>
      </symbol>
      <symbol id="capso-glyph-seat" viewBox="0 0 24 24">
        <g fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3.75 8.25v4.5a5.5 5.5 0 0 0 5.5 5.5h5.5a5.5 5.5 0 0 0 5.5-5.5v-4.5"/>
          <circle cx="12" cy="12" r="3.6"/>
        </g>
      </symbol>
      <symbol id="capso-glyph-text" viewBox="0 0 24 24">
        <g fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 6h14"/>
          <path d="M12 6v13"/>
          <path d="M9 19h6"/>
        </g>
      </symbol>
      <symbol id="capso-glyph-undo" viewBox="0 0 24 24">
        <g fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
          <path d="M8 7.5 4 11.5 8 15.5"/>
          <path d="M4.5 11.5h8.5a4.75 4.75 0 0 1 0 9.5H11.5"/>
        </g>
      </symbol>
      </defs>
    </svg>
  );
}

/**
 * Pass a `label` to make it announced; without one it is decorative and hidden
 * from assistive tech — same contract as CapsoMark.
 */
export function CapsoGlyph({
  name,
  size = 20,
  className = "",
  label,
}: {
  name: GlyphName;
  size?: number;
  className?: string;
  label?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={{ display: "block", flex: "none" }}
    >
      <use href={`#capso-glyph-${name}`} />
    </svg>
  );
}
