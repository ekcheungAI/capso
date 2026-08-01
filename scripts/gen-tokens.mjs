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
  ...Object.entries(t.motion).map(([k, v]) => `  --${k}: ${v};`),
  ...Object.entries(t.radius).map(([k, v]) => `  --radius-${k}: ${v};`),
  `  --font-ui: ${t.font.ui};`,
  `  --font-mono: ${t.font.mono};`,
].join("\n");

const css = (from) =>
  BANNER(from) +
  `:root {\n  color-scheme: light dark;\n${vars("light")}\n${extras}\n}\n\n` +
  `@media (prefers-color-scheme: dark) {\n  :root {\n` +
  vars("dark").replace(/^ {2}/gm, "    ") +
  `\n  }\n}\n`;

/** Files this script owns. Anything here is overwritten without asking. */
const TARGETS = [
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
