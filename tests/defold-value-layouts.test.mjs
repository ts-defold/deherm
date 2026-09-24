import assert from "node:assert/strict";
import test from "node:test";

import { generateDefoldValueLayouts } from "../scripts/generate-defold-value-layouts.mjs";

function projection(...names) {
  return {
    defoldRevision: "0123456789012345678901234567890123456789",
    rows: names.map((name, index) => ({
      id: `script:test.${index}`,
      signature: { kind: "defold-value", name }
    }))
  };
}

function policy() {
  return {
    schemaVersion: 1,
    transparent: {},
    opaque: {
      node: "retained-engine-handle",
      "future-only": "retained-engine-handle"
    },
    recordingShapes: {
      node: "handle",
      "future-only": "handle"
    },
    opaqueReasons: {
      "retained-engine-handle": "Engine-owned handle."
    }
  };
}

test("revision-specific value names use a visible conservative universal fallback", () => {
  const report = generateDefoldValueLayouts({
    projection: projection("node", "go.EASING_INBACK", "buffer"),
    policy: policy(),
    sources: {},
    sourcePaths: {}
  });

  assert.equal(report.opaque.node.classification, "reviewed");
  for (const name of ["buffer", "go.EASING_INBACK"]) {
    assert.deepEqual(report.opaque[name], {
      reason: "source-derived-conservative-fallback",
      note: "This Defold revision documents the value name, but no reviewed fixed-layout or retained-handle specialization exists yet. It remains available through the generated universal value transport and is excluded only from transparent typed-native lowering.",
      classification: "generated",
      proof: "source-derived-name; specialized-layout-unproven",
      fallbackTransport: "script-universal-value",
      recordingShape: "userdata",
      alert: "specialized-layout-unproven"
    });
  }
  assert.equal(report.coverage.conservativeOpaque, 2);
  assert.equal(report.alerts.length, 2);
  assert.deepEqual(report.dormantPolicyEntries, ["future-only"]);
});

test("a policy entry for an API absent from this revision is dormant, not fatal", () => {
  const report = generateDefoldValueLayouts({
    projection: projection("node"),
    policy: policy(),
    sources: {},
    sourcePaths: {}
  });

  assert.deepEqual(Object.keys(report.opaque), ["node"]);
  assert.deepEqual(report.dormantPolicyEntries, ["future-only"]);
  assert.equal(report.coverage.dormantPolicyEntries, 1);
});
