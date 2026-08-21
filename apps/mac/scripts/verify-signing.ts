import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { verifySigningTarget } from "../src/signing-verification.ts";

const targetArgument = process.argv[2];
if (!targetArgument) {
  console.error(
    "Usage: pnpm verify:screen-recording-identity /Applications/Capso.app",
  );
  process.exit(2);
}

const target = resolve(targetArgument);

function codesign(args: string[]) {
  const result = spawnSync("/usr/bin/codesign", args, { encoding: "utf8" });
  return {
    ok: result.status === 0,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

const assessment = verifySigningTarget(target, codesign);
if (!assessment.ok) {
  console.error("Capso is not safe to install for persistent Screen Recording access:");
  for (const problem of assessment.problems) console.error(`- ${problem}`);
  process.exit(1);
}

console.log("Capso has a stable team signing identity for macOS privacy access.");
