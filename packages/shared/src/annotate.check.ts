import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { pixelate, type AnnotationCanvasContext } from "./annotate.ts";

type RedactionFixture = {
  width: number;
  height: number;
  redaction: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  originalRgba: number[];
  flattenedRgba: number[];
};

const fixture = JSON.parse(
  readFileSync(
    new URL("../fixtures/annotation-redaction.json", import.meta.url),
    "utf8",
  ),
) as RedactionFixture;

class MemoryCanvas implements AnnotationCanvasContext {
  strokeStyle: string | object = "";
  fillStyle: string | object = "";
  lineWidth = 0;
  lineCap = "";
  lineJoin = "";
  font = "";
  textBaseline = "";
  lineDashOffset = 0;
  private readonly width: number;
  private readonly pixels: Uint8ClampedArray;

  constructor(width: number, pixels: Uint8ClampedArray) {
    this.width = width;
    this.pixels = pixels;
  }

  get rgba() {
    return [...this.pixels];
  }

  getImageData(x: number, y: number, width: number, height: number) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let row = 0; row < height; row += 1) {
      for (let column = 0; column < width; column += 1) {
        const source = ((y + row) * this.width + x + column) * 4;
        const target = (row * width + column) * 4;
        data.set(this.pixels.subarray(source, source + 4), target);
      }
    }
    return { data };
  }

  fillRect(x: number, y: number, width: number, height: number) {
    assert.equal(typeof this.fillStyle, "string");
    const match = /^rgb\((\d+),(\d+),(\d+)\)$/.exec(this.fillStyle as string);
    assert.ok(match, `unexpected pixel fill ${String(this.fillStyle)}`);
    const color = match.slice(1).map(Number);
    for (let row = y; row < y + height; row += 1) {
      for (let column = x; column < x + width; column += 1) {
        const offset = (row * this.width + column) * 4;
        this.pixels.set([...color, 255], offset);
      }
    }
  }

  strokeRect() {}
  strokeText() {}
  fillText() {}
  beginPath() {}
  moveTo() {}
  lineTo() {}
  closePath() {}
  stroke() {}
  fill() {}
  setLineDash() {}
  save() {}
  restore() {}
}

const rgbValues = (rgba: number[]) => rgba.filter((_, index) => index % 4 === 0);

test("the production pixelator irreversibly produces the shared native redaction fixture", () => {
  assert.equal(fixture.originalRgba.length, fixture.width * fixture.height * 4);
  assert.equal(fixture.flattenedRgba.length, fixture.originalRgba.length);
  const canvas = new MemoryCanvas(
    fixture.width,
    Uint8ClampedArray.from(fixture.originalRgba),
  );

  pixelate(
    canvas,
    fixture.redaction.x,
    fixture.redaction.y,
    fixture.redaction.width,
    fixture.redaction.height,
  );

  assert.deepEqual(canvas.rgba, fixture.flattenedRgba);
  const originalDetails = new Set(rgbValues(fixture.originalRgba));
  const flattenedDetails = new Set(rgbValues(canvas.rgba));
  assert.ok(flattenedDetails.size < originalDetails.size);
  for (const detail of originalDetails) {
    assert.equal(
      flattenedDetails.has(detail),
      false,
      `source detail ${detail} survived redaction`,
    );
  }
});
