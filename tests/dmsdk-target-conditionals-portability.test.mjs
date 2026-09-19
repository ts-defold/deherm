import assert from "node:assert/strict";
import test from "node:test";

import { canonicalText } from "../scripts/generate-dmsdk-target-conditionals.mjs";

test("dmSDK target conditional inputs have host-independent line endings", () => {
  const canonical = "alpha\nbeta\ngamma\n";
  assert.equal(canonicalText(canonical), canonical);
  assert.equal(canonicalText("alpha\r\nbeta\rgamma\r\n"), canonical);
});
