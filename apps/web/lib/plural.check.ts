import assert from "node:assert/strict";
import test from "node:test";
import { plural, verb } from "./plural.ts";

test("one is singular, everything else is not", () => {
  // The bug this replaced: the home page greeted a library with one pending
  // capture as "1 captures need a project".
  assert.equal(plural(1, "capture"), "1 capture");
  assert.equal(plural(0, "capture"), "0 captures");
  assert.equal(plural(2, "capture"), "2 captures");
});

test("irregular plurals can be given explicitly", () => {
  assert.equal(plural(1, "match", "matches"), "1 match");
  assert.equal(plural(3, "match", "matches"), "3 matches");
});

test("the verb agrees with the count", () => {
  assert.equal(verb(1, "needs", "need"), "needs");
  assert.equal(verb(2, "needs", "need"), "need");
});
