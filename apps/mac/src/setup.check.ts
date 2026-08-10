import assert from "node:assert/strict";
import test from "node:test";
import {
  cloudAccountPresentation,
  shortcutRecorderLabel,
} from "./setup.ts";

test("an unconfigured test build never asks for an email", () => {
  const presentation = cloudAccountPresentation(false, "signed_out");

  assert.equal(presentation.showEmailForm, false);
  assert.equal(presentation.status, "Not enabled in this test build");
  assert.match(presentation.message, /No email is needed/i);
});

test("a configured signed-out build explains which email to use", () => {
  const presentation = cloudAccountPresentation(true, "signed_out");

  assert.equal(presentation.showEmailForm, true);
  assert.match(presentation.message, /same email/i);
  assert.match(presentation.message, /web and Mac/i);
});

test("shortcut controls say that the displayed shortcut is editable", () => {
  assert.equal(shortcutRecorderLabel("⌃⇧C", false), "Change ⌃⇧C");
  assert.equal(shortcutRecorderLabel("⌃⇧C", true), "Press keys…");
});
