import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const paths = {
  loop: resolve(root, "loops/capso-cleanshot-replacement-loop.md"),
  state: resolve(root, "loops/STATE.md"),
  parity: resolve(root, "27_CLEANSHOT_DAILY_DRIVER_PARITY.md"),
};

const real = {
  loop: await readFile(paths.loop, "utf8"),
  state: await readFile(paths.state, "utf8"),
  parity: await readFile(paths.parity, "utf8"),
};

const REQUIRED_FRONTMATTER = [
  "name",
  "description",
  "schedule",
  "timezone",
  "trigger",
  "maker_agent",
  "checker_agent",
  "executor_agent",
];
const REQUIRED_SECTIONS = [
  "## Purpose",
  "## Pre-conditions",
  "## Execution Flow",
  "## Exit Conditions",
  "### Success",
  "### No-op",
  "### Failure",
  "## Related Files",
];
const REQUIRED_GATES = [
  "UX-01",
  "CAP-01",
  "CAP-02",
  "OVL-01",
  "ANN-01",
  "DUR-01",
  "HIS-01",
  "AI-01",
  "LRN-01",
  "RET-01",
  "PKG-01",
  "DOG-01",
];

function frontmatter(body) {
  const raw = body.match(/^---\n([\s\S]*?)\n---/)?.[1];
  if (!raw) return null;
  return Object.fromEntries(
    raw.split("\n").map((line) => {
      const index = line.indexOf(":");
      if (index < 1) return [line, ""];
      return [line.slice(0, index).trim(), line.slice(index + 1).trim().replace(/^['"]|['"]$/g, "")];
    }),
  );
}

function validate({ loop, state, parity }) {
  const failures = [];
  let checks = 0;
  const check = (condition, message) => {
    checks += 1;
    if (!condition) failures.push(message);
  };
  const fm = frontmatter(loop);

  check(Boolean(fm), "frontmatter is missing or malformed");
  for (const field of REQUIRED_FRONTMATTER) {
    check(Boolean(fm?.[field]), `frontmatter field ${field} must be non-empty`);
  }
  check(
    fm?.maker_agent !== fm?.checker_agent,
    "maker_agent and checker_agent must be different",
  );
  check(
    fm?.schedule === "0 * * * *",
    "schedule must be a five-field hourly cron expression",
  );
  check(fm?.timezone === "Asia/Hong_Kong", "timezone must be Asia/Hong_Kong");

  for (const section of REQUIRED_SECTIONS) {
    check(loop.includes(section), `loop is missing section ${section}`);
  }
  check(loop.includes("mkdir loops/.active-run"), "loop must atomically acquire the canonical lease");
  check(loop.includes("owner-$RUN_ID-started-$EPOCH"), "lease must carry owner/run metadata");
  check(loop.includes("verify the metadata directory contains this\nrun's `RUN_ID`"), "only the lease owner may release it");
  check(loop.includes("preflight\n   non-run"), "preflight conflicts must be no-write non-runs");
  check(loop.includes("foreign/legacy lease"), "legacy file leases must cause a no-write no-op");
  check(loop.includes("do not write STATE, BUILD_LOG, raw logs"), "foreign leases must not mutate shared state");
  check(loop.includes("two repair-and-resubmission attempts"), "retry semantics must allow two repairs after initial review");
  check(loop.includes("third verdict"), "retry failure boundary must be explicit");
  check(!loop.includes("Checker rejects twice"), "retry exits must not fail after only two verdicts");
  check(loop.includes("loops/STATE.md"), "loop must update persistent state");
  check(loop.includes("Never alter its settings"), "loop must preserve CleanShot settings");
  check(loop.includes("Do not push, deploy, publish"), "loop must prohibit external release actions");
  check(loop.includes("production"), "loop must protect production state");

  for (const section of [
    "## Active loops",
    "## Gate scoreboard",
    "## Ordered task queue",
    "## Run history",
    "## Discovered technical debt",
  ]) check(state.includes(section), `STATE is missing section ${section}`);
  check(state.includes("capso-cleanshot-replacement"), "STATE must register the active loop");
  for (const gate of REQUIRED_GATES) {
    check(state.includes(`| ${gate}`), `scoreboard is missing ${gate}`);
    const queued = gate === "DOG-01"
      ? state.includes("DOG-01 —")
      : new RegExp(`\\b${gate.replace("-", "\\-")}[a-z]\\b`).test(state);
    check(queued, `queue is missing work for ${gate}`);
  }
  check(state.includes("DOG-01 is never eligible until every preceding scoreboard gate\nis PASS"), "dogfood must depend on every gate passing");
  check(parity.includes("## Five-day dogfood exit gate"), "parity contract needs a dogfood exit gate");
  check(parity.includes("does not\ncontinuously observe"), "parity contract must prohibit passive observation");
  check(!/(api[_-]?key|secret|token)\s*[:=]\s*\S+/i.test(`${loop}\n${state}\n${parity}`), "contract must not contain credential values");

  return { failures, checks };
}

// Negative fixtures ensure the validator rejects the exact defects it claims to catch.
const fixtures = [
  ["same Maker and Checker", (x) => ({ ...x, loop: x.loop.replace("checker_agent: independent-read-only-reviewer", "checker_agent: primary-codex-implementer") })],
  ["vague schedule", (x) => ({ ...x, loop: x.loop.replace('schedule: "0 * * * *"', "schedule: hourly") })],
  ["missing atomic lease", (x) => ({ ...x, loop: x.loop.replace("mkdir loops/.active-run", "inspect loops/.active-run") })],
  ["missing external safety", (x) => ({ ...x, loop: x.loop.replace("Do not push, deploy, publish", "Do not release") })],
  ["missing gate work", (x) => ({ ...x, state: x.state.replaceAll("LRN-01a", "LEARN-EVAL") })],
  ["contradictory retry exit", (x) => ({ ...x, loop: x.loop.replace("the Checker rejects the second retry (third verdict)", "Checker rejects twice") })],
  ["state-writing foreign lease", (x) => ({ ...x, loop: x.loop.replace("do not write STATE, BUILD_LOG, raw logs", "write a NO-OP row to STATE") })],
];

for (const [name, mutate] of fixtures) {
  const result = validate(mutate(real));
  if (result.failures.length === 0) {
    console.error(`Validator self-test failed: ${name} fixture was accepted.`);
    process.exit(1);
  }
}

const result = validate(real);
if (result.failures.length) {
  console.error("Capso loop contract is invalid:");
  for (const failure of result.failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Capso loop contract passed ${result.checks} parsed structural and safety checks.`);
  console.log(`Validator rejected ${fixtures.length} malformed contract fixtures.`);
}
