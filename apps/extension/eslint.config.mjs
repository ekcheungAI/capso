import js from "@eslint/js";
import globals from "globals";

/**
 * The extension had no lint at all until now.
 *
 * `pnpm lint` resolves to `pnpm -r --if-present lint`, and only `apps/web`
 * carried a `lint` script — so this directory was never checked by anything,
 * never type-checked (it is plain JS), and never loaded in a real Chrome. A
 * capture path that threw `ReferenceError: contentHash is not defined` on every
 * single capture passed a fully green gate.
 *
 * `no-undef` is the rule that would have caught it, and it comes free with
 * `js.configs.recommended` — the only reason it was not catching anything is
 * that eslint was never pointed here.
 */
export default [
  {
    ignores: [
      // Generated from packages/shared/src/capture.ts by `pnpm capture:spec`.
      // Linting it would report problems nobody can fix here; the generator is
      // the place to change it, and `pnpm capture:check` guards the copy.
      "capture-spec.generated.js",
    ],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.browser, // popup.js / options.js run in a page
        ...globals.serviceworker, // background.js runs in an MV3 worker
        ...globals.webextensions, // chrome.*
      },
    },
  },
  {
    // The smoke test assigns the browser globals it stubs.
    files: ["*.check.mjs"],
    languageOptions: { globals: { ...globals.node } },
  },
];
