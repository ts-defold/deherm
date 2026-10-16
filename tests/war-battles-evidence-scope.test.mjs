import assert from "node:assert/strict";
import test from "node:test";

import { WEBTRANSPORT_SOURCE_PATHS } from "../examples/war-battles-online/integration/webtransport-evidence.mjs";
import { AUTHORITATIVE_LOAD_SOURCE_PATHS } from "../examples/war-battles-online/integration/authoritative-load-evidence.mjs";
import { HEADLESS_SOAK_SOURCE_PATHS } from "../examples/war-battles-online/headless/soak-evidence.mjs";

test("War Battles runtime evidence tracks game code and locked dependencies, not unrelated root tasks", () => {
  for (const paths of [WEBTRANSPORT_SOURCE_PATHS, AUTHORITATIVE_LOAD_SOURCE_PATHS, HEADLESS_SOAK_SOURCE_PATHS]) {
    assert.ok(paths.includes("examples/war-battles-online/core"));
    assert.ok(paths.includes("examples/war-battles-online/package.json"));
    assert.ok(paths.includes("pnpm-lock.yaml"));
    assert.equal(paths.includes("package.json"), false);
  }
});
