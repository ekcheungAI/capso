import assert from "node:assert/strict";
import { captureProjectList } from "./overlay-projects.ts";

const id = "018f22c4-cada-7c6b-9d5b-fc35f7f92276";

assert.deepEqual(captureProjectList([{ id, name: "Launch research" }]), [
  { id, name: "Launch research" },
]);
assert.equal(captureProjectList([{ id: "forged", name: "Launch" }]), null);
assert.equal(captureProjectList([{ id, name: " padded " }]), null);
assert.equal(captureProjectList([{ id, name: "Launch", extra: true }]), null);
assert.equal(captureProjectList(Array.from({ length: 51 }, () => ({ id, name: "Too many" }))), null);

console.log("overlay project boundary checks passed");
