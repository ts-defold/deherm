import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  generate,
  loadInputs,
  maximumTableRecordFieldCount,
} from "../scripts/generate-script-table-record-bindings.mjs";

const root = new URL("../", import.meta.url);

async function derive(inputs, run) {
  const revision = JSON.parse(inputs.irText).defoldRevision;
  const previousRevision = process.env.DEHERM_DERIVED_REVISION;
  const previousAudit = process.env.DEHERM_REVISION_AUDIT;
  const auditDirectory = await mkdtemp(path.join(tmpdir(), "deherm-table-record-capability-"));
  process.env.DEHERM_DERIVED_REVISION = revision;
  process.env.DEHERM_REVISION_AUDIT = path.join(auditDirectory, "audit.ndjson");
  try {
    return await run();
  } finally {
    if (previousRevision === undefined) delete process.env.DEHERM_DERIVED_REVISION;
    else process.env.DEHERM_DERIVED_REVISION = previousRevision;
    if (previousAudit === undefined) delete process.env.DEHERM_REVISION_AUDIT;
    else process.env.DEHERM_REVISION_AUDIT = previousAudit;
    await rm(auditDirectory, { recursive: true, force: true });
  }
}

test("an empty structural family has a valid zero-sized semantic capacity", () => {
  assert.equal(maximumTableRecordFieldCount([]), 0);
  assert.equal(maximumTableRecordFieldCount([{ fields: [] }, { fields: [{}, {}] }]), 2);
});

test("fixed-record wave is bounded to reviewed pure ASTC and physics-version records", async () => {
  execFileSync(process.execPath, ["scripts/generate-script-table-record-bindings.mjs", "--check"], {
    cwd: root,
    stdio: "pipe",
  });
  const report = JSON.parse(
    await readFile(new URL("packages/bindings/generated/defold-script-table-record-bindings.json", root), "utf8"),
  );
  assert.equal(report.routeCount, 148);
  assert.equal(report.candidateCount, 3);
  assert.equal(report.executableCount, 3);
  assert.equal(report.blockedCount, 145);
  assert.deepEqual(report.blockerCounts, {
    "copied-defold-value-record": 9,
    "dynamic-recursive-values": 5,
    "handle-or-callback-crossing": 39,
    "opaque-or-nested-record": 2,
    "reviewed-semantic-record": 6,
    "target-context-or-platform-state-record": 6,
    "tagged-table-union": 3,
    "unbounded-typed-map": 15,
    "unbounded-typed-sequence": 60,
  });
  assert.equal(report.blockedRoutes.length, 145);
  assert.equal(
    report.blockedRoutes.find(({ id }) => id === "script:sys.get_engine_info").blocker,
    "target-context-or-platform-state-record",
  );
  assert.equal(
    report.blockedRoutes.find(({ id }) => id === "script:model.get_aabb").blocker,
    "copied-defold-value-record",
  );
  assert.match(report.coverageClaim, /native-dynamic captured-Lua adapter using caller-owned bounded record storage/);
  assert.deepEqual(report.bindings.map(({ id }) => id).toSorted(), [
    "script:b2d.get_version",
    "script:bullet3d.get_version",
    "script:image.get_astc_header",
  ]);
  const astc = report.bindings.find(({ id }) => id === "script:image.get_astc_header");
  assert.equal(astc.requiredContext, "global");
  assert.deepEqual(
    astc.fields.map(({ name, codec }) => [name, codec]),
    [
      ["width", "Integer"],
      ["height", "Integer"],
      ["depth", "Integer"],
      ["block_size_x", "Integer"],
      ["block_size_y", "Integer"],
      ["block_size_z", "Integer"],
    ],
  );
  assert.deepEqual(
    report.bindings.find(({ id }) => id === "script:b2d.get_version").fields.map(({ name }) => name),
    ["version", "major", "middle", "minor"],
  );
  assert.deepEqual(
    report.bindings.find(({ id }) => id === "script:bullet3d.get_version").fields.map(({ name }) => name),
    ["version", "number", "major", "minor"],
  );
  assert.ok(
    report.bindings.every(
      ({ structuralCapability }) =>
        structuralCapability.arguments.checked &&
        structuralCapability.result.arity === 1 &&
        structuralCapability.stackEffect.tablePushes === 1 &&
        structuralCapability.stackEffect.returnedValues === 1,
    ),
  );
  assert.deepEqual(report.staleOptimizationQueue, []);
});

test("fixed-record generator reports stale source and rejects unsafe reviewed widening", async () => {
  const inputs = await loadInputs();
  const stale = new Map(inputs.sourceTexts);
  const [path, text] = stale.entries().next().value;
  stale.set(path, `${text}\n`);
  assert.doesNotThrow(() => generate({ ...inputs, sourceTexts: stale }));
  const wrongType = JSON.parse(inputs.policyText);
  wrongType.routes[0].recordType = "sys.engine_info";
  assert.throws(() => generate({ ...inputs, policyText: JSON.stringify(wrongType) }), /reviewed record type drifted/);
  const duplicate = JSON.parse(inputs.policyText);
  duplicate.routes.push({ ...duplicate.routes[0] });
  assert.throws(
    () => generate({ ...inputs, policyText: JSON.stringify(duplicate) }),
    /duplicate reviewed table-record route/,
  );
  const malformedStorage = JSON.parse(inputs.policyText);
  malformedStorage.routes[0].outputSources = [];
  assert.throws(
    () => generate({ ...inputs, policyText: JSON.stringify(malformedStorage) }),
    /malformed proven-route source storage/,
  );
});

test("structural capability preserves private spelling and withdraws on consumed output drift", async () => {
  const inputs = await loadInputs();
  const policy = JSON.parse(inputs.policyText);
  const imageSource = policy.sources.find(({ key }) => key === "script-image");
  const renamed = new Map(inputs.sourceTexts);
  const box2dModule = policy.sources.find(({ key }) => key === "script-box2d-module");
  const box2dOutput = policy.sources.find(({ key }) => key === "script-box2d-v3");
  const bulletSource = policy.sources.find(({ key }) => key === "script-bullet3d");
  renamed.set(
    imageSource.path,
    renamed
      .get(imageSource.path)
      .replaceAll("Image_GetAstcHeader", "Image_ReadAstcRecord")
      .replaceAll("Data is not a valid .astc file", "ASTC header rejected"),
  );
  renamed.set(box2dModule.path, renamed.get(box2dModule.path).replaceAll("PushBox2DVersion", "EmitBox2DVersionRecord"));
  renamed.set(box2dOutput.path, renamed.get(box2dOutput.path).replaceAll("PushBox2DVersion", "EmitBox2DVersionRecord"));
  const registration = JSON.parse(inputs.registrationSurfaceText);
  for (const route of registration.targets["defold-engine-box2d-v3"].routes) {
    if (route.name === "image.get_astc_header") route.cFunction = "Image_ReadAstcRecord";
  }
  const preserved = generate({
    ...inputs,
    sourceTexts: renamed,
    registrationSurfaceText: JSON.stringify(registration),
  });
  assert.equal(preserved.report.candidateCount, 3);
  assert.equal(
    preserved.report.bindings.find(({ id }) => id === "script:image.get_astc_header").structuralCapability.registration
      .cFunction,
    "Image_ReadAstcRecord",
  );

  const equivalentReturns = [
    "return 1U;",
    "return /* one fixed record */ ( 1u );",
    "return (\n            /* one table */\n            1UL\n        );",
  ];
  for (const replacement of equivalentReturns) {
    const respelled = new Map(inputs.sourceTexts);
    respelled.set(
      bulletSource.path,
      respelled
        .get(bulletSource.path)
        .replace(
          'lua_setfield(L, -2, "minor");\n        return 1;',
          `lua_setfield(L, -2, "minor");\n        ${replacement}`,
        ),
    );
    const equivalent = generate({ ...inputs, sourceTexts: respelled });
    assert.equal(equivalent.report.candidateCount, 3, `${replacement} preserves the one-result capability`);
    assert.equal(
      equivalent.report.bindings.find(({ id }) => id === "script:bullet3d.get_version").structuralCapability.stackEffect
        .returnedValues,
      1,
    );
  }

  for (const commentedCheck of ["// luaL_checktype(L, 1, LUA_TSTRING);", "/* luaL_checktype(L, 1, LUA_TSTRING); */"]) {
    const missingArgumentEvidence = new Map(inputs.sourceTexts);
    missingArgumentEvidence.set(
      imageSource.path,
      missingArgumentEvidence.get(imageSource.path).replaceAll("luaL_checktype(L, 1, LUA_TSTRING);", commentedCheck),
    );
    const withoutArgumentEvidence = await derive(inputs, () =>
      generate({ ...inputs, sourceTexts: missingArgumentEvidence }),
    );
    assert.equal(withoutArgumentEvidence.report.candidateCount, 2);
    assert.ok(
      withoutArgumentEvidence.report.staleOptimizationQueue.some(
        ({ id, reason }) => id === "script:image.get_astc_header" && reason === "structural-output-capability-absent",
      ),
    );
    assert.ok(
      withoutArgumentEvidence.report.blockedRoutes.some(({ id }) => id === "script:image.get_astc_header"),
      "missing argument evidence keeps the route in the universal fallback partition",
    );
  }

  const withdrawn = new Map(inputs.sourceTexts);
  withdrawn.set(
    imageSource.path,
    withdrawn
      .get(imageSource.path)
      .replace('lua_setfield(L, -2, "block_size_z");', 'lua_setfield(L, -2, "private_block_z");'),
  );
  const generated = await derive(inputs, () => generate({ ...inputs, sourceTexts: withdrawn }));
  assert.equal(generated.report.candidateCount, 2);
  assert.ok(
    generated.report.staleOptimizationQueue.some(
      ({ id, reason }) => id === "script:image.get_astc_header" && reason === "structural-output-capability-absent",
    ),
  );
  assert.ok(
    generated.report.blockedRoutes.some(({ id }) => id === "script:image.get_astc_header"),
    "withdrawn specialization remains in the universal fallback partition",
  );
  const descriptors = JSON.parse(
    await readFile(new URL("packages/bindings/generated/defold-script-binding-descriptors.json", root), "utf8"),
  );
  assert.ok(
    descriptors.cold.stableKeys.includes("script:image.get_astc_header"),
    "the authoritative route descriptor survives optimization withdrawal",
  );

  const extraDirectPush = new Map(inputs.sourceTexts);
  extraDirectPush.set(
    bulletSource.path,
    extraDirectPush
      .get(bulletSource.path)
      .replace(
        'lua_setfield(L, -2, "minor");\n        return 1;',
        'lua_setfield(L, -2, "minor");\n        lua_pushlightuserdata(L, NULL);\n        return 1;',
      ),
  );
  const withoutExactDirectStack = await derive(inputs, () => generate({ ...inputs, sourceTexts: extraDirectPush }));
  assert.equal(withoutExactDirectStack.report.candidateCount, 2);
  assert.ok(
    withoutExactDirectStack.report.staleOptimizationQueue.some(
      ({ id, reason }) => id === "script:bullet3d.get_version" && reason === "structural-output-capability-absent",
    ),
  );

  const extraWrappedPush = new Map(inputs.sourceTexts);
  extraWrappedPush.set(
    box2dOutput.path,
    extraWrappedPush
      .get(box2dOutput.path)
      .replace(
        'lua_setfield(L, -2, "minor");\n    }',
        'lua_setfield(L, -2, "minor");\n        lua_pushlightuserdata(L, NULL);\n    }',
      ),
  );
  const withoutExactWrappedStack = await derive(inputs, () => generate({ ...inputs, sourceTexts: extraWrappedPush }));
  assert.equal(withoutExactWrappedStack.report.candidateCount, 2);
  assert.ok(
    withoutExactWrappedStack.report.staleOptimizationQueue.some(
      ({ id, reason }) => id === "script:b2d.get_version" && reason === "structural-output-capability-absent",
    ),
  );

  const extraWrapperHelper = new Map(inputs.sourceTexts);
  extraWrapperHelper.set(
    box2dModule.path,
    extraWrapperHelper
      .get(box2dModule.path)
      .replace(
        "    static int B2D_GetVersion(lua_State* L)",
        "    static void PushUnmodeledValue(int, lua_State* L) { lua_pushlightuserdata(L, NULL); }\n\n" +
          "    static int B2D_GetVersion(lua_State* L)",
      )
      .replace("        PushBox2DVersion(L);", "        PushBox2DVersion(L);\n        PushUnmodeledValue(0, L);"),
  );
  const withoutExactWrapper = await derive(inputs, () => generate({ ...inputs, sourceTexts: extraWrapperHelper }));
  assert.equal(withoutExactWrapper.report.candidateCount, 2);
  assert.ok(
    withoutExactWrapper.report.staleOptimizationQueue.some(
      ({ id, reason }) => id === "script:b2d.get_version" && reason === "structural-output-capability-absent",
    ),
  );

  const invalidReturns = [
    "return 0;",
    "/* return 1U; */ return 0;",
    'const char* ignored = "return 1;"; return 2U;',
    "return 1; return 1U;",
  ];
  for (const replacement of invalidReturns) {
    const stackEffectLost = new Map(inputs.sourceTexts);
    stackEffectLost.set(
      bulletSource.path,
      stackEffectLost
        .get(bulletSource.path)
        .replace(
          'lua_setfield(L, -2, "minor");\n        return 1;',
          `lua_setfield(L, -2, "minor");\n        ${replacement}`,
        ),
    );
    const withoutStackEffect = await derive(inputs, () => generate({ ...inputs, sourceTexts: stackEffectLost }));
    assert.equal(withoutStackEffect.report.candidateCount, 2, `${replacement} withdraws the specialization`);
    assert.ok(
      withoutStackEffect.report.staleOptimizationQueue.some(
        ({ id, reason }) => id === "script:bullet3d.get_version" && reason === "structural-output-capability-absent",
      ),
    );
  }
});

test("generated runtime is fail-closed and has no generated Lua allocation path", async () => {
  const [header, source, target] = await Promise.all(
    [
      "defold/defold_hermes/include/defold_hermes/generated_script_table_record_bindings.hpp",
      "defold/defold_hermes/src/generated_script_table_record_bindings.cpp",
      "packages/sdk/src/generated/script/table-record-bindings.ts",
    ].map((path) => readFile(new URL(path, root), "utf8")),
  );
  assert.match(header, /kCandidateCount = 3/);
  assert.match(header, /kMaximumFieldCount = 6/);
  assert.match(header, /enum class Context/);
  assert.match(source, /Table-record captured Lua backend is unavailable/);
  assert.match(source, /caller-owned scratch is exhausted/);
  assert.match(source, /fixed-field descriptor/);
  assert.doesNotMatch(source, /lua_newtable|luaL_ref|\bnew\b|malloc|std::vector/);
  assert.match(target, /ImageAstcHeader/);
  assert.match(target, /generated-executable-shared-script-adapter/);
  assert.match(target, /not executable in the HTML5 browser host/);
});
