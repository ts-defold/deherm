import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { generate, loadInputs } from "../scripts/generate-script-dynamic-values.mjs";
import { renderScriptDynamicValuesOutputs } from "../packages/compiler/src/script-dynamic-values-output-emitter.mjs";
import { stableBindingId } from "../scripts/lib/binding-identity.mjs";

const root = new URL("../", import.meta.url);

test("package dynamic-values emitter reproduces generated artifacts byte-for-byte", async () => {
  const [factsText, header, source, target] = await Promise.all([
    readFile(new URL("packages/bindings/generated/defold-script-dynamic-values-recipe-facts.json", root), "utf8"),
    readFile(new URL("defold/defold_hermes/include/defold_hermes/generated_script_dynamic_values.hpp", root), "utf8"),
    readFile(new URL("defold/defold_hermes/src/generated_script_dynamic_values.cpp", root), "utf8"),
    readFile(new URL("packages/sdk/src/generated/script/dynamic-values.ts", root), "utf8"),
  ]);
  const outputs = renderScriptDynamicValuesOutputs(JSON.parse(factsText));
  assert.equal(outputs.header, header);
  assert.equal(outputs.source, source);
  assert.equal(outputs.target, target);
});

function generateFrom(inputs, changes = {}) {
  return generate(
    changes.patternsText ?? inputs.patternsText,
    changes.irText ?? inputs.irText,
    changes.overridesText ?? inputs.overridesText,
    changes.sources ?? inputs.sources,
    changes.registrationsText ?? inputs.registrationsText,
  );
}

async function runGeneratedDispatchProbe(outputs, stableId, expectedStatus) {
  const directory = await mkdtemp(join(tmpdir(), "deherm-dynamic-dispatch-"));
  try {
    const includeDirectory = join(directory, "defold_hermes");
    await mkdir(includeDirectory);
    const source = join(directory, "generated_script_dynamic_values.cpp");
    const harness = join(directory, "probe.cpp");
    const executable = join(directory, "probe");
    await Promise.all([
      writeFile(join(includeDirectory, "generated_script_dynamic_values.hpp"), outputs.header),
      writeFile(source, outputs.source),
      writeFile(
        harness,
        `#include <defold_hermes/generated_script_dynamic_values.hpp>\n` +
          `int main() {\n` +
          `  namespace dynamic = defold_hermes::dynamic_value;\n` +
          `  defold_hermes::ScriptCallFrame frame{}; frame.stableId = ${stableId}u;\n` +
          `  frame.argumentCount = 255;\n` +
          `  return dynamic::dispatch(&frame, nullptr, 0, nullptr) == dynamic::DispatchStatus::${expectedStatus} ? 0 : 1;\n` +
          `}\n`,
      ),
    ]);
    execFileSync(
      process.env.CXX || "clang++",
      [
        "-std=c++17",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-pedantic",
        `-I${directory}`,
        "-Idefold/defold_hermes/include",
        source,
        harness,
        "-o",
        executable,
      ],
      { cwd: root, stdio: "pipe" },
    );
    execFileSync(executable, [], { stdio: "pipe" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("dynamic-value generator classifies the complete family from pinned source", async () => {
  execFileSync(process.execPath, ["scripts/generate-script-dynamic-values.mjs", "--check"], { cwd: root });
  const report = JSON.parse(
    await readFile(new URL("packages/bindings/generated/defold-script-dynamic-value-bindings.json", root), "utf8"),
  );
  const overrides = JSON.parse(
    await readFile(new URL("packages/bindings/overrides/script-dynamic-value-bindings.json", root), "utf8"),
  );
  assert.equal(report.routeCount, 14);
  assert.equal(report.generatedFamilyCandidateCount, 11);
  assert.equal(report.optimizedReplayCount, 11);
  assert.equal(report.universalFallbackCount, 0);
  assert.equal(report.blockedCount, 3);
  assert.equal(report.maximumArgumentCount, 32);
  assert.match(report.inputEvidence.scriptIrSha256, /^[0-9a-f]{64}$/);
  assert.match(report.inputEvidence.bindingPatternsSha256, /^[0-9a-f]{64}$/);
  assert.match(report.inputEvidence.reviewedOverridesSha256, /^[0-9a-f]{64}$/);
  assert.match(report.inputEvidence.registeredCallableEvidenceSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(report.blockerCounts, {
    "recursive-json-value-policy": 2,
    "recursive-log-side-effect-policy": 1,
  });
  assert.equal(new Set(report.bindings.map(({ id }) => id)).size, 14);
  assert.equal(new Set(report.bindings.map(({ stableId }) => stableId)).size, 14);
  assert.equal(
    report.bindings.every(({ id, stableId }) => Number.parseInt(stableId) === stableBindingId(id)),
    true,
  );
  assert.deepEqual(
    report.bindings.map(({ stableId }) => Number.parseInt(stableId)),
    report.bindings.map(({ stableId }) => Number.parseInt(stableId)).toSorted((a, b) => a - b),
  );
  assert.equal(
    report.bindings
      .filter(({ generatedFamilyExecutableCandidate }) => generatedFamilyExecutableCandidate)
      .every(({ targetSupport }) => targetSupport.nativeDynamicHermes === "candidate-awaits-shared-router-integration"),
    true,
  );
  assert.equal(
    report.bindings
      .filter(({ generatedFamilyExecutableCandidate }) => generatedFamilyExecutableCandidate)
      .every(({ targetSupport }) => targetSupport.html5BrowserHost === "not-executable-no-generated-provider"),
    true,
  );
  assert.equal(
    report.bindings
      .filter(({ generatedFamilyExecutableCandidate }) => generatedFamilyExecutableCandidate)
      .every(
        ({ optimizationProven, replayEvidence, focusedNativeEvidence }) =>
          optimizationProven &&
          replayEvidence.registrations.length === 2 &&
          replayEvidence.executionContext === "global-lua-module" &&
          focusedNativeEvidence === "observed-bounded-registered-Lua-replay-transport",
      ),
    true,
  );
  assert.deepEqual(
    overrides.sources.map(({ key }) => key),
    ["json", "pprint"],
  );
  assert.equal(
    report.bindings
      .filter(({ generatedFamilyExecutableCandidate }) => generatedFamilyExecutableCandidate)
      .every((binding) => !("sourceEvidence" in binding)),
    true,
  );
});

test("private callable renames preserve generated replay while registration, context, and codec withdrawal fall back", async () => {
  const inputs = await loadInputs();
  const baseline = generateFrom(inputs);
  const registrations = JSON.parse(inputs.registrationsText);
  for (const targetId of ["defold-engine-box2d-v3", "defold-engine-box2d-v2"]) {
    for (const name of ["bit.band", "bit.bor", "bit.bxor", "socket.skip"]) {
      for (const route of registrations.targets[targetId].routes.filter((route) => route.name === name)) {
        route.cFunction += "_private_rename";
      }
    }
  }
  assert.deepEqual(generateFrom(inputs, { registrationsText: JSON.stringify(registrations) }), baseline);

  const missingRegistration = JSON.parse(inputs.registrationsText);
  missingRegistration.targets["defold-engine-box2d-v3"].routes = missingRegistration.targets[
    "defold-engine-box2d-v3"
  ].routes.filter(({ name }) => name !== "bit.band");
  const missingOutputs = generateFrom(inputs, { registrationsText: JSON.stringify(missingRegistration) });
  const missingReport = JSON.parse(missingOutputs.report);
  const missingBand = missingReport.bindings.find(({ id }) => id === "script:bit.band");
  assert.equal(missingReport.generatedFamilyCandidateCount, 11);
  assert.equal(missingReport.optimizedReplayCount, 10);
  assert.equal(missingReport.universalFallbackCount, 1);
  assert.equal(missingBand.optimizationProven, false);
  assert.deepEqual(missingBand.optimizationBlockers, ["registered-global-callable-evidence-missing"]);

  const missingContext = JSON.parse(inputs.registrationsText);
  missingContext.targets["defold-engine-box2d-v2"].routes.find(({ name }) => name === "socket.skip").module =
    "renamed_socket";
  const contextReport = JSON.parse(generateFrom(inputs, { registrationsText: JSON.stringify(missingContext) }).report);
  assert.equal(contextReport.bindings.find(({ id }) => id === "script:socket.skip").optimizationProven, false);

  const ambiguousRegistration = JSON.parse(inputs.registrationsText);
  const ambiguousBand = structuredClone(
    ambiguousRegistration.targets["defold-engine-box2d-v3"].routes.find(({ name }) => name === "bit.band"),
  );
  ambiguousBand.cFunction += "_other_variant";
  ambiguousRegistration.targets["defold-engine-box2d-v3"].routes.push(ambiguousBand);
  const ambiguousReport = JSON.parse(
    generateFrom(inputs, { registrationsText: JSON.stringify(ambiguousRegistration) }).report,
  );
  assert.equal(ambiguousReport.bindings.find(({ id }) => id === "script:bit.band").optimizationProven, false);

  const targetDisagreement = JSON.parse(inputs.registrationsText);
  targetDisagreement.targets["defold-engine-box2d-v2"].routes.find(
    ({ name }) => name === "bit.band",
  ).arity.derived.min = 2;
  const disagreementReport = JSON.parse(
    generateFrom(inputs, { registrationsText: JSON.stringify(targetDisagreement) }).report,
  );
  assert.equal(disagreementReport.bindings.find(({ id }) => id === "script:bit.band").optimizationProven, false);

  const malformedRegistration = JSON.parse(inputs.registrationsText);
  malformedRegistration.targets["defold-engine-box2d-v2"].routes.find(
    ({ name }) => name === "bit.band",
  ).registration.path = "";
  assert.throws(
    () => generateFrom(inputs, { registrationsText: JSON.stringify(malformedRegistration) }),
    /canonical Lua registration surface contains a malformed registered route/,
  );

  const codecPatterns = JSON.parse(inputs.patternsText);
  codecPatterns.bindings.find(({ id }) => id === "script:types.is_url").parameterCodecs[0].rawType = "table";
  const codecReport = JSON.parse(generateFrom(inputs, { patternsText: JSON.stringify(codecPatterns) }).report);
  const missingCodec = codecReport.bindings.find(({ id }) => id === "script:types.is_url");
  assert.equal(missingCodec.optimizationProven, false);
  assert.deepEqual(missingCodec.optimizationBlockers, ["structural-codec-evidence-missing"]);

  await runGeneratedDispatchProbe(baseline, stableBindingId("script:bit.band"), "kError");
  await runGeneratedDispatchProbe(missingOutputs, stableBindingId("script:bit.band"), "kMissing");
});

test("generated dynamic-value glue is bounded and fail-closed", async () => {
  const [source, header, target, report] = await Promise.all([
    readFile(new URL("defold/defold_hermes/src/generated_script_dynamic_values.cpp", root), "utf8"),
    readFile(new URL("defold/defold_hermes/include/defold_hermes/generated_script_dynamic_values.hpp", root), "utf8"),
    readFile(new URL("packages/sdk/src/generated/script/dynamic-values.ts", root), "utf8"),
    readFile(new URL("packages/bindings/generated/defold-script-dynamic-value-bindings.json", root), "utf8").then(
      JSON.parse,
    ),
  ]);
  assert.match(header, /kMaximumArgumentCount = 32/);
  assert.match(source, /Dynamic-value argument count is outside the generated fixed capacity/);
  assert.match(source, /Dynamic-value Lua result does not match the generated result mode/);
  assert.match(source, /!operation->optimizationProven/);
  assert.match(header, /bool optimizationProven/);
  assert.match(source, /frame->resultCount=0/);
  assert.doesNotMatch(source, /\bnew\b|malloc|realloc|std::vector|unordered_map/);
  for (const binding of report.bindings.filter(
    ({ generatedFamilyExecutableCandidate }) => generatedFamilyExecutableCandidate,
  )) {
    assert.match(target, new RegExp(binding.id.replaceAll(".", "\\.")));
  }
  assert.doesNotMatch(target, /json\.decode|json\.encode|pprint/);
});

test("dynamic-value generation reports stale upstream evidence and rejects missing decisions", async () => {
  const inputs = await loadInputs();
  const stale = inputs.sources.map((source, index) => (index === 0 ? { ...source, text: `${source.text}\n` } : source));
  assert.doesNotThrow(() => generateFrom(inputs, { sources: stale }));
  const overrides = JSON.parse(inputs.overridesText);
  delete overrides.routes["script:bit.band"];
  assert.throws(
    () => generateFrom(inputs, { overridesText: JSON.stringify(overrides) }),
    /override coverage drifted|missing reviewed/,
  );
});

test("dynamic-value generation rejects stale cross-input provenance and duplicate identities", async () => {
  const inputs = await loadInputs();
  const staleRevision = JSON.parse(inputs.patternsText);
  staleRevision.defoldRevision = "0".repeat(40);
  assert.throws(
    () => generateFrom(inputs, { patternsText: JSON.stringify(staleRevision) }),
    /different Defold revisions/,
  );

  const staleHash = JSON.parse(inputs.patternsText);
  staleHash.sourceSha256 = "0".repeat(64);
  assert.throws(() => generateFrom(inputs, { patternsText: JSON.stringify(staleHash) }), /stale against script IR/);

  const duplicate = JSON.parse(inputs.patternsText);
  duplicate.bindings[1] = structuredClone(duplicate.bindings[0]);
  assert.throws(
    () => generateFrom(inputs, { patternsText: JSON.stringify(duplicate) }),
    /duplicate binding-pattern id/,
  );

  const staleCount = JSON.parse(inputs.patternsText);
  staleCount.classifiedFunctionCount -= 1;
  assert.throws(
    () => generateFrom(inputs, { patternsText: JSON.stringify(staleCount) }),
    /classified binding count is stale/,
  );

  const sourceMetadata = structuredClone(inputs.sources);
  sourceMetadata[0].sha256 = "0".repeat(64);
  assert.throws(() => generateFrom(inputs, { sources: sourceMetadata }), /pinned source metadata drifted/);

  assert.throws(() => generateFrom(inputs, { sources: inputs.sources.slice(1) }), /pinned source count drifted/);
});
