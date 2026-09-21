import assert from "node:assert/strict";
import test from "node:test";

import * as compiler from "../packages/compiler/src/index.mjs";
import { loadBindingLoweringInputs } from "../packages/compiler/src/generate-binding-lowering-plan.mjs";

test("the compiler public API exposes pure lowering, not checkout path loading", async () => {
  assert.equal(typeof compiler.generateBindingLoweringPlan, "function");
  assert.equal("loadBindingLoweringInputs" in compiler, false);
  assert.equal("run" in compiler, false);
  await assert.rejects(
    loadBindingLoweringInputs(),
    /requires an explicit authenticated or materialized surface root/u
  );
});
