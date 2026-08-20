import assert from "node:assert/strict";
import test from "node:test";
import {
  ANNOTATION_CUSTOM_COLORS_KEY,
  isAnnotationHexColor,
  readAnnotationCustomColors,
  saveAnnotationCustomColor,
} from "./annotation-colors.ts";

const hex = (digits: string) => `#${digits}`;

function memoryStorage(initial?: string) {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set(ANNOTATION_CUSTOM_COLORS_KEY, initial);
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    value: () => values.get(ANNOTATION_CUSTOM_COLORS_KEY),
  };
}

test("custom annotation colors accept only exact six-digit hex values", () => {
  assert.equal(isAnnotationHexColor(hex("12ab34")), true);
  assert.equal(isAnnotationHexColor(hex("ABCDEF")), true);
  assert.equal(isAnnotationHexColor(hex("abc")), false);
  assert.equal(isAnnotationHexColor("red"), false);
  assert.equal(isAnnotationHexColor(hex("12345678")), false);
});

test("saved annotation colors fail closed on malformed or unbounded local state", () => {
  assert.deepEqual(readAnnotationCustomColors(memoryStorage("not json")), []);
  assert.deepEqual(readAnnotationCustomColors(memoryStorage(JSON.stringify({ color: hex("12ab34") }))), []);
  assert.deepEqual(
    readAnnotationCustomColors(memoryStorage(JSON.stringify([
      hex("12ab34"),
      hex("ABCDEF"),
      "red",
      hex("12ab34"),
    ]))),
    [hex("12ab34"), hex("abcdef")],
  );
});

test("saving a custom color is durable, newest-first, de-duplicated and capped", () => {
  const storage = memoryStorage();
  let colors: string[] = [];
  for (let index = 0; index < 10; index += 1) {
    colors = saveAnnotationCustomColor(storage, colors, hex(`${index}`.padStart(6, "0")));
  }
  assert.equal(colors.length, 8);
  assert.equal(colors[0], hex("000009"));
  assert.equal(colors.at(-1), hex("000002"));
  colors = saveAnnotationCustomColor(storage, colors, hex("000005"));
  assert.equal(colors[0], hex("000005"));
  assert.equal(new Set(colors).size, colors.length);
  assert.deepEqual(JSON.parse(storage.value()!), colors);
});
