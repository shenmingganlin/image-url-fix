import test from "node:test";
import assert from "node:assert/strict";
import { expectedGptImage2Size, sizeMismatchWarning } from "./expected-size.mjs";

test("matches the gpt-image-2 flexible resolution vectors", () => {
  const cases = [
    ["3:2", "4K", 3536, 2336],
    ["3:2", "2K", 2048, 1360],
    ["3:2", "1K", 1024, 688],
    ["1:1", "4K", 2880, 2880],
    ["16:9", "1K", 1072, 624],
    ["16:9", "4K", 3840, 2160],
  ];
  for (const [ratio, resolution, width, height] of cases) {
    assert.deepEqual(expectedGptImage2Size({ ratio, resolution }), { width, height }, `${ratio} ${resolution}`);
  }
});

test("does not warn for the selected 4K 3:2 size", () => {
  const expected = expectedGptImage2Size({ ratio: "3:2", resolution: "4K" });
  assert.equal(sizeMismatchWarning(expected, { width: 3536, height: 2336 }), null);
});

test("warns with both dimensions when the delivered size differs", () => {
  const expected = expectedGptImage2Size({ ratio: "3:2", resolution: "4K" });
  const warning = sizeMismatchWarning(expected, { width: 1024, height: 688 });
  assert.ok(warning);
  assert.match(warning, /3536×2336/);
  assert.match(warning, /1024×688/);
});

test("returns null when ratio or resolution is missing or auto", () => {
  assert.equal(expectedGptImage2Size({ ratio: "3:2" }), null);
  assert.equal(expectedGptImage2Size({ resolution: "4K" }), null);
  assert.equal(expectedGptImage2Size({ ratio: "3:2", resolution: "auto" }), null);
});
