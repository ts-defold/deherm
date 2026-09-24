import assert from "node:assert/strict";
import test from "node:test";

import { REFINERY_THEME_SEED, setCollectionNumberProperty } from "../integration/arena-theme-runtime.mjs";

const property = `component_properties {
  id: "arena"
  properties {
      id: "mapSeed"
      value: "0.0"
      type: PROPERTY_TYPE_NUMBER
    }
}`;

test("the runtime theme gate replaces exactly the map seed", () => {
  assert.ok(REFINERY_THEME_SEED <= 2 ** 24, "the Defold number property seed must remain exactly representable");
  const changed = setCollectionNumberProperty(property, "mapSeed", REFINERY_THEME_SEED);
  assert.equal(changed, property.replace('value: "0.0"', `value: "${REFINERY_THEME_SEED}.0"`));
});

test("the runtime theme gate fails closed when the property is absent or ambiguous", () => {
  assert.throws(() => setCollectionNumberProperty("", "mapSeed", REFINERY_THEME_SEED), /found 0/u);
  assert.throws(
    () => setCollectionNumberProperty(`${property}\n${property}`, "mapSeed", REFINERY_THEME_SEED),
    /found 2/u,
  );
});
