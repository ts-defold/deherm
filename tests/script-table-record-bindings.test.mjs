import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { generate, loadInputs } from "../scripts/generate-script-table-record-bindings.mjs";

const root = new URL("../", import.meta.url);

test("fixed-record wave is bounded to reviewed pure ASTC and physics-version records", async () => {
  execFileSync(process.execPath, ["scripts/generate-script-table-record-bindings.mjs", "--check"], { cwd: root, stdio: "pipe" });
  const report = JSON.parse(await readFile(new URL("packages/bindings/generated/defold-script-table-record-bindings.json", root), "utf8"));
  assert.equal(report.routeCount, 148);
  assert.equal(report.candidateCount, 3);
  assert.equal(report.executableCount, 3);
  assert.equal(report.blockedCount, 145);
  assert.deepEqual(report.blockerCounts, { "copied-defold-value-record": 9, "dynamic-recursive-values": 5, "handle-or-callback-crossing": 39, "opaque-or-nested-record": 2, "reviewed-semantic-record": 6, "target-context-or-platform-state-record": 6, "tagged-table-union": 3, "unbounded-typed-map": 15, "unbounded-typed-sequence": 60 });
  assert.equal(report.blockedRoutes.length, 145);
  assert.equal(report.blockedRoutes.find(({ id }) => id === "script:sys.get_engine_info").blocker, "target-context-or-platform-state-record");
  assert.equal(report.blockedRoutes.find(({ id }) => id === "script:model.get_aabb").blocker, "copied-defold-value-record");
  assert.match(report.coverageClaim, /native-dynamic captured-Lua adapter using caller-owned bounded record storage/);
  assert.deepEqual(report.bindings.map(({ id }) => id).toSorted(), ["script:b2d.get_version", "script:bullet3d.get_version", "script:image.get_astc_header"]);
  const astc = report.bindings.find(({ id }) => id === "script:image.get_astc_header");
  assert.equal(astc.requiredContext, "global");
  assert.deepEqual(astc.fields.map(({ name, codec }) => [name, codec]), [["width", "Integer"], ["height", "Integer"], ["depth", "Integer"], ["block_size_x", "Integer"], ["block_size_y", "Integer"], ["block_size_z", "Integer"]]);
  assert.deepEqual(report.bindings.find(({ id }) => id === "script:b2d.get_version").fields.map(({ name }) => name), ["version", "major", "middle", "minor"]);
  assert.deepEqual(report.bindings.find(({ id }) => id === "script:bullet3d.get_version").fields.map(({ name }) => name), ["version", "number", "major", "minor"]);
});

test("fixed-record generator reports stale source and rejects unsafe reviewed widening", async () => {
  const inputs = await loadInputs();
  const stale = new Map(inputs.sourceTexts); const [path, text] = stale.entries().next().value; stale.set(path, `${text}\n`);
  assert.doesNotThrow(() => generate({ ...inputs, sourceTexts: stale }));
  const wrongType = JSON.parse(inputs.policyText); wrongType.routes[0].recordType = "sys.engine_info";
  assert.throws(() => generate({ ...inputs, policyText: JSON.stringify(wrongType) }), /reviewed record type drifted/);
  const duplicate = JSON.parse(inputs.policyText); duplicate.routes.push({ ...duplicate.routes[0] });
  assert.throws(() => generate({ ...inputs, policyText: JSON.stringify(duplicate) }), /duplicate reviewed table-record route/);
});

test("generated runtime is fail-closed and has no generated Lua allocation path", async () => {
  const [header, source, target] = await Promise.all(["defold/defold_hermes/include/defold_hermes/generated_script_table_record_bindings.hpp", "defold/defold_hermes/src/generated_script_table_record_bindings.cpp", "packages/sdk/src/generated/script/table-record-bindings.ts"].map((path) => readFile(new URL(path, root), "utf8")));
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
