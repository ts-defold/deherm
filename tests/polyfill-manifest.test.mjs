import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const manifest = JSON.parse(await readFile(
  new URL("../packages/polyfills/compatibility.json", import.meta.url),
  "utf8"
));

test("polyfill compatibility policy is explicit and deterministic", () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.policy.strictProfile, "fail-on-untyped-or-missing");
  assert.equal(manifest.policy.installation, "reachable-only");
  const ids = manifest.features.map((feature) => feature.id);
  assert.equal(new Set(ids).size, ids.length, "polyfill feature IDs must be unique");
  for (const feature of manifest.features) {
    assert.ok(feature.category);
    assert.ok(feature.native);
    assert.ok(feature.static);
    assert.ok(feature.html5);
    assert.ok(feature.action);
  }
});

test("strict Static Hermes rejects dynamic code and declares scheduler hosts", () => {
  const byId = new Map(manifest.features.map((feature) => [feature.id, feature]));
  assert.equal(byId.get("eval")?.action, "reject-strict");
  assert.equal(byId.get("Function.constructor")?.action, "reject-strict");
  for (const id of ["queueMicrotask", "setTimeout", "requestAnimationFrame"]) {
    assert.equal(byId.get(id)?.action, "polyfill");
  }
});
