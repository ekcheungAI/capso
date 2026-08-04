import assert from "node:assert/strict";
import test from "node:test";
import { citationId, extractCitedIds } from "./citations.ts";

test("UUID citations survive parsing and invented ids are rejected", () => {
  const id = "510901b3-e430-4bbf-ab90-10e2dcb35534";
  assert.deepEqual(extractCitedIds(`The annual toggle is here [${id}] [invented].`, [id]), [id]);
  assert.equal(citationId(`[${id}]`), id);
});

test("duplicate citations are returned once", () => {
  assert.deepEqual(extractCitedIds("[s1] then [s1] and [s2]", ["s1", "s2"]), ["s1", "s2"]);
});
