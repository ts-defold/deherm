import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import test from "node:test";

import { ensureBindingLoweringPlan } from "../scripts/ensure-binding-lowering-plan.mjs";
import { inputPaths, loadBindingLoweringInputs } from "../scripts/generate-binding-lowering-plan.mjs";

async function cacheFixture() {
  const root = await mkdtemp(join(tmpdir(), "deherm-lowering-cache-"));
  const inputs = await loadBindingLoweringInputs();
  for (const [name, relative] of Object.entries(inputPaths)) {
    const destination = join(root, relative);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, inputs[name]);
  }
  return {
    root,
    output: join(root, "bindings/generated/defold-binding-lowering-plan.json"),
    sentinel: join(root, "bindings/generated/defold-binding-lowering-plan.sentinel.json")
  };
}

test("content-addressed ensure is idempotent and writes nothing while the sentinel validates", async () => {
  const fixture = await cacheFixture();
  try {
    const first = await ensureBindingLoweringPlan(fixture);
    assert.equal(first.action, "regenerated");
    assert.equal(first.reason, "missing-or-invalid-sentinel");
    const [output, sentinel] = await Promise.all([readFile(fixture.output, "utf8"), readFile(fixture.sentinel, "utf8")]);

    const second = await ensureBindingLoweringPlan(fixture);
    assert.equal(second.action, "current");
    assert.equal(second.cacheKey, first.cacheKey);
    assert.equal(await readFile(fixture.output, "utf8"), output);
    assert.equal(await readFile(fixture.sentinel, "utf8"), sentinel);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("changed inputs, corrupted output, or a deleted sentinel invalidate the exact key", async () => {
  const fixture = await cacheFixture();
  try {
    await ensureBindingLoweringPlan(fixture);
    await writeFile(fixture.output, "{}\n");
    await assert.rejects(ensureBindingLoweringPlan({ ...fixture, check: true }), /output-size-mismatch/);
    assert.equal((await ensureBindingLoweringPlan(fixture)).reason, "output-size-mismatch");

    const validOutput = await readFile(fixture.output);
    validOutput[0] = validOutput[0] === 0x7b ? 0x5b : 0x7b;
    await writeFile(fixture.output, validOutput);
    await assert.rejects(
      ensureBindingLoweringPlan({ ...fixture, check: true, deepCheck: true }),
      /output-digest-mismatch/
    );
    assert.equal((await ensureBindingLoweringPlan({ ...fixture, force: true })).reason, "forced");

    const forged = JSON.parse(await readFile(fixture.output, "utf8"));
    forged.evidenceBoundary.compilation = "yes-claimed";
    const { planSha256: ignored, ...forgedBody } = forged;
    forged.planSha256 = createHash("sha256").update(JSON.stringify(forgedBody)).digest("hex");
    const forgedText = `${JSON.stringify(forged, null, 2)}\n`;
    const forgedSentinel = JSON.parse(await readFile(fixture.sentinel, "utf8"));
    forgedSentinel.outputBytes = Buffer.byteLength(forgedText);
    forgedSentinel.outputSha256 = createHash("sha256").update(forgedText).digest("hex");
    forgedSentinel.planSha256 = forged.planSha256;
    await writeFile(fixture.output, forgedText);
    await writeFile(fixture.sentinel, `${JSON.stringify(forgedSentinel, null, 2)}\n`);
    const beforeDeepCheck = await Promise.all([readFile(fixture.output, "utf8"), readFile(fixture.sentinel, "utf8")]);
    await assert.rejects(
      ensureBindingLoweringPlan({ ...fixture, deepCheck: true }),
      /output-does-not-match-declared-inputs/
    );
    assert.deepEqual(
      await Promise.all([readFile(fixture.output, "utf8"), readFile(fixture.sentinel, "utf8")]),
      beforeDeepCheck,
      "deep verification must never repair or rewrite evidence"
    );
    await ensureBindingLoweringPlan({ ...fixture, force: true });

    await unlink(fixture.sentinel);
    assert.equal((await ensureBindingLoweringPlan(fixture)).reason, "missing-or-invalid-sentinel");

    const targetPath = join(fixture.root, inputPaths.dynamicHermesJsi);
    const target = JSON.parse(await readFile(targetPath, "utf8"));
    target.capabilities.push("test-capability");
    await writeFile(targetPath, `${JSON.stringify(target, null, 2)}\n`);
    const changed = await ensureBindingLoweringPlan(fixture);
    assert.equal(changed.reason, "input-or-generator-key-changed");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
