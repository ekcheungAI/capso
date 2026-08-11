#!/usr/bin/env node
/**
 * Compile packages/shared/src/tokens.json into every surface that needs it.
 *
 *     pnpm brand:tokens          write the generated files
 *     pnpm brand:check           verify they are current, and that no source
 *                                file declares a colour of its own
 *
 * Why this exists: before it, the palette was hand-copied into six places and
 * three of them had already drifted. apps/extension/options.html still carried
 * the retired terracotta `#c2461f`, apps/extension/popup.html the terracotta
 * before that, and apps/web/components/capture.tsx the pre-bone foreground.
 * Nobody had done anything wrong — there was simply no mechanism, so drift was
 * the default state rather than a mistake.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "packages/shared/src/tokens.json");
const t = JSON.parse(readFileSync(SRC, "utf8"));

const BANNER = (from) =>
  `/* GENERATED — DO NOT EDIT.\n` +
  `   Source: ${from}\n` +
  `   Regenerate: pnpm brand:tokens   ·   Verify: pnpm brand:check */\n`;

const vars = (scheme) =>
  Object.entries(t.color[scheme])
    .map(([k, v]) => `  --${k}: ${v};`)
    .join("\n");

const extras = [
  ...Object.entries(t.intent).map(([k, v]) => `  --intent-${k.replace(/_/g, "-")}: ${v};`),
  // Marketing surfaces need these as real CSS. They are not mode-dependent — clay
  // and espresso are the same in dark mode, because a marketing surface is a
  // printed thing, not a themed one. Emitted here rather than left to the page so
  // that a landing hero cannot become the seventh place the palette is hand-copied,
  // which is the exact failure this file was written to end.
  ...Object.entries(t.marketing).map(([k, v]) => `  --marketing-${k}: ${v};`),
  ...Object.entries(t.motion).map(([k, v]) => `  --${k}: ${v};`),
  ...Object.entries(t.radius).map(([k, v]) => `  --radius-${k}: ${v};`),
  `  --font-ui: ${t.font.ui};`,
  `  --font-display: ${t.font.display};`,
  `  --font-mono: ${t.font.mono};`,
].join("\n");

const css = (from) =>
  BANNER(from) +
  `:root {\n  color-scheme: light dark;\n${vars("light")}\n${extras}\n}\n\n` +
  `@media (prefers-color-scheme: dark) {\n  :root {\n` +
  vars("dark").replace(/^ {2}/gm, "    ") +
  `\n  }\n}\n`;

/**
 * The mark, as a React component.
 *
 * Generated from the same SVG the icon builders read, for the same reason the
 * colours are generated: a hand-copied `<path d="...">` in a .tsx is the exact
 * drift the rest of this script exists to prevent.
 *
 * The notch is a mask, and a mask needs an id. Rather than mint one per
 * instance (which would force a client component for `useId`), the three fill
 * states are defined once as `<symbol>`s and every instance is a `<use>`. One
 * definition, valid ids, and the fill state stays declarative.
 *
 * Fill is quantised to three steps, not continuous: at a 15px glyph a linear
 * map puts one-of-eight at r0.75, under a device pixel, so "has something in
 * it" renders identically to "empty" — the most important distinction in the
 * control. The exact count is already on the row.
 */
function markComponent(src) {
  const svg = readFileSync(join(ROOT, "drafts/brand/mark/capso-lid.svg"), "utf8");
  const rim = svg.match(/d="(M12 1\.6[^"]+)"/s);
  if (!rim) throw new Error("capso-lid.svg: rim path not found — did the mark change shape?");
  const d = rim[1].replace(/\s+/g, " ").trim();
  const notch = svg.match(/<rect x="12" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/);
  if (!notch) throw new Error("capso-lid.svg: notch rect not found");
  const [, ny, nw, nh] = notch;

  const symbol = (name, r) => `      <symbol id="capso-lid-${name}" viewBox="0 0 24 24">
        <g fill="currentColor" fillRule="evenodd" mask="url(#capso-notch-def)">
          <path d="${d}" />${r ? `\n          <circle cx="12" cy="12" r="${r}" />` : ""}
        </g>
      </symbol>`;

  return `${BANNER(src)}
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
          <rect x="12" y="${ny}" width="${nw}" height="${nh}" fill="#000" />
        </mask>
${symbol("empty", 0)}
${symbol("some", 3)}
${symbol("full", 6)}
      </defs>
    </svg>
  );
}

/**
 * \`fill\` is the provenance-free half of the brand: an open ring is a slot
 * waiting, a part face is a shelf with something on it, a full face is one that
 * is filling up. Pass a \`label\` to make it announced; without one it is
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
      <use href={\`#capso-lid-\${fill}\`} />
    </svg>
  );
}

/** Counts to fill states. Kept here so every surface bands them identically. */
export function fillFor(count: number): Fill {
  if (count <= 0) return "empty";
  return count < 5 ? "some" : "full";
}
`;
}

/** Files this script owns. Anything here is overwritten without asking. */
const TARGETS = [
  ["apps/web/components/mark.generated.tsx",
    () => markComponent("drafts/brand/mark/capso-lid.svg")],
  ["apps/web/app/tokens.generated.css", (rel) => css(rel)],
  ["apps/extension/tokens.generated.css", (rel) => css(rel)],
  ["apps/mac/src/tokens.generated.css", (rel) => css(rel)],
  [
    "drafts/brand/tokens.generated.json",
    () =>
      JSON.stringify(
        { $generated: "pnpm brand:tokens — do not edit", ...t },
        null,
        2,
      ) + "\n",
  ],
];

/**
 * Source files allowed to contain a raw hex, and why.
 *
 * Keep this list short and justified. Every entry is a place the mechanism
 * cannot reach; if one stops being true, delete it rather than leaving it.
 */
const HEX_ALLOWED = new Set([
  "packages/shared/src/tokens.json", // the source itself
  "apps/web/app/tokens.generated.css",
  "apps/extension/tokens.generated.css",
  "apps/mac/src/tokens.generated.css",
  "drafts/brand/tokens.generated.json",
  "apps/web/components/mark.generated.tsx",
]);

const SCAN_DIRS = ["apps/web/app", "apps/web/components", "apps/web/lib",
  "apps/extension", "apps/mac/src", "packages/shared/src"];
const SCAN_EXT = /\.(tsx?|css|html|js|mjs|json)$/;
const SKIP_DIR = /(^|\/)(node_modules|\.next|dist|target|out|icons)(\/|$)/;

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(join(ROOT, dir));
  } catch {
    return;
  }
  for (const e of entries) {
    const rel = `${dir}/${e}`;
    if (SKIP_DIR.test(rel)) continue;
    if (statSync(join(ROOT, rel)).isDirectory()) yield* walk(rel);
    else if (SCAN_EXT.test(e)) yield rel;
  }
}

/**
 * Per-line escape hatch: `brand-allow: <reason>` on the line, or on the line
 * directly above it.
 *
 * There is one genuinely correct reason to hard-code a colour here — content
 * that depicts somebody else's product. The sample-screenshot canvas in
 * capture.tsx must NOT use Capso's palette, because a screenshot of another
 * site that looks like Capso is worse than no sample at all. A blanket ban
 * would have forced that code to lie, so the rule takes a written reason
 * instead. An empty reason does not count.
 */
const ALLOW_RE = /brand-allow:\s*\S+/;

function strayHexes() {
  const found = [];
  for (const rel of SCAN_DIRS.flatMap((d) => [...walk(d)])) {
    if (HEX_ALLOWED.has(rel)) continue;
    const lines = readFileSync(join(ROOT, rel), "utf8").split("\n");
    lines.forEach((line, i) => {
      // #rgb, #rrggbb, #rrggbbaa — but not a URL fragment or an id selector
      const m = line.match(/#[0-9a-fA-F]{3,8}\b/g);
      if (!m) return;
      if (ALLOW_RE.test(line) || (i > 0 && ALLOW_RE.test(lines[i - 1]))) return;
      for (const hex of m) {
        if (!/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(hex)) continue;
        found.push({ rel, line: i + 1, hex, text: line.trim().slice(0, 90) });
      }
    });
  }
  return found;
}

const check = process.argv.includes("--check");
let failed = false;

for (const [rel, make] of TARGETS) {
  const want = make(relative(ROOT, SRC));
  const path = join(ROOT, rel);
  let have = null;
  try {
    have = readFileSync(path, "utf8");
  } catch {}
  if (check) {
    if (have !== want) {
      console.error(`STALE  ${rel} — run \`pnpm brand:tokens\``);
      failed = true;
    } else {
      console.log(`ok     ${rel}`);
    }
  } else if (have !== want) {
    writeFileSync(path, want);
    console.log(`wrote  ${rel}`);
  } else {
    console.log(`ok     ${rel}`);
  }
}

const stray = strayHexes();
if (stray.length) {
  console.error(
    `\n${stray.length} hard-coded colour${stray.length === 1 ? "" : "s"} outside the token source:`,
  );
  for (const s of stray) console.error(`  ${s.rel}:${s.line}  ${s.hex}   ${s.text}`);
  console.error("\nMove these into packages/shared/src/tokens.json, or use a CSS variable.");
  failed = true;
} else {
  console.log("ok     no stray colours in source");
}

if (failed) process.exit(1);
if (check) console.log("\nbrand check passed");
