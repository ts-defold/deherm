import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { generateBindingEmissionPlan } from "../scripts/generate-binding-emission-plan.mjs";
import { generateCanonicalFamilyArtifacts } from "../scripts/generate-canonical-family-sources.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function authorities() {
  const [plan, projection, profiles] = await Promise.all([
    readFile(join(repositoryRoot, "packages/bindings/generated/defold-binding-lowering-plan.json"), "utf8").then(JSON.parse),
    readFile(join(repositoryRoot, "packages/bindings/generated/defold-script-projection-ir.json"), "utf8").then(JSON.parse),
    readFile(join(repositoryRoot, "packages/bindings/generated/defold-script-route-availability-profiles.json"), "utf8").then(JSON.parse)
  ]);
  return { plan, projection, profiles };
}

function emission(authority, target, usage) {
  return generateBindingEmissionPlan(
    authority.plan,
    authority.projection,
    authority.profiles,
    usage,
    { target, profile: "default-legacy-bullet" }
  );
}

async function writeArtifacts(root, artifacts) {
  for (const [relative, source] of artifacts) {
    const path = join(root, relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, source);
  }
}

function compiler() {
  for (const candidate of [process.env.CXX, "c++", "clang++", "g++"].filter(Boolean)) {
    if (spawnSync(candidate, ["--version"], { encoding: "utf8" }).status === 0) return candidate;
  }
  return null;
}

function compileAndRun(cxx, root, target, sources, mainSource) {
  const prefix = join(root, "canonical", target);
  const main = join(root, `${target}-main.cpp`);
  const output = join(root, `${target}-test`);
  return writeFile(main, mainSource).then(() => {
    const result = spawnSync(cxx, [
      "-std=c++17", "-Wall", "-Wextra", "-Werror", "-pedantic",
      `-I${join(prefix, "include")}`,
      ...sources.map((source) => join(prefix, source)),
      main,
      "-o", output
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const execution = spawnSync(output, [], { encoding: "utf8" });
    assert.equal(execution.status, 0, `${execution.stdout}\n${execution.stderr}`);
  });
}

test("dynamic canonical families emit only reachable routes and compile as a deterministic gate", async (t) => {
  const cxx = compiler();
  if (!cxx) return t.skip("No C++ compiler is available");
  const authority = await authorities();
  const allSelected = emission(authority, "dynamicHermesJsi", { schemaVersion: 1, dynamicAccess: true, symbols: [] });
  const capable = allSelected.units.map((unit) => authority.plan.units[unit.sourceUnit]);
  const families = new Map();
  for (const unit of capable) if (!families.has(unit.sourceState.loweringFamily)) families.set(unit.sourceState.loweringFamily, unit);
  assert.ok(families.size > 2, "fixture needs selected and omitted canonical lowering families");
  const chosen = [...families.values()].slice(0, 2);
  const usage = { schemaVersion: 1, dynamicAccess: false, symbols: chosen.map((unit) => unit.identity.id).reverse() };
  const first = generateCanonicalFamilyArtifacts(authority.plan, emission(authority, "dynamicHermesJsi", usage));
  const second = generateCanonicalFamilyArtifacts(authority.plan, emission(authority, "dynamicHermesJsi", {
    ...usage,
    symbols: [...usage.symbols].reverse()
  }));
  assert.deepEqual([...first.artifacts], [...second.artifacts]);
  assert.equal(first.manifest.routeCount, 2);
  assert.equal(first.manifest.groupCount, 2);
  assert.equal(first.manifest.outputs.length, first.artifacts.size - 1);
  for (const output of first.manifest.outputs) {
    const contents = first.artifacts.get(`canonical/dynamicHermesJsi/${output.path}`);
    assert.equal(output.bytes, Buffer.byteLength(contents));
    assert.equal(output.sha256, sha256(contents));
  }
  const omittedFamily = [...families.keys()].find((family) => !chosen.some((unit) => unit.sourceState.loweringFamily === family));
  assert.ok(omittedFamily);
  assert.equal(first.manifest.groups.some((group) => group.loweringFamily === omittedFamily), false);
  assert.deepEqual(
    new Set(first.manifest.groups.flatMap((group) => group.routeIds)),
    new Set(chosen.map((unit) => unit.identity.id))
  );
  const omitted = capable.find((unit) => !usage.symbols.includes(unit.identity.id));
  assert.ok(omitted);
  const allSource = [...first.artifacts.values()].join("\n");
  assert.doesNotMatch(allSource, new RegExp(`0x${omitted.identity.stableId.toString(16).padStart(8, "0")}u`));

  const temporary = await mkdtemp(join(tmpdir(), "deherm-canonical-family-"));
  try {
    await writeArtifacts(temporary, first.artifacts);
    const sources = ["src/registry.cpp", ...first.manifest.groups.map((group) => group.source)];
    const selectedId = chosen[0].identity.stableId;
    await compileAndRun(cxx, temporary, "dynamicHermesJsi", sources, `
#include "deherm_canonical_release.h"
#include <stdint.h>
extern "C" int defoldHermesScriptCall(uint32_t, uint32_t, const uint8_t*, const uint8_t*, const double*, const uint64_t*, const uint32_t*, const uint32_t*, const char*, uint32_t, uint8_t*, uint8_t*, double*, uint64_t*, char*, uint32_t, uint32_t*) { return 73; }
int main() {
  if (dehermCanonicalReleaseRouteCount() != 2u) return 1;
  if (!dehermCanonicalReleaseRoutes()) return 2;
  if (!dehermCanonicalReleaseRouteEnabled(${selectedId}u)) return 3;
  if (dehermCanonicalReleaseRouteEnabled(${omitted.identity.stableId}u)) return 4;
  if (dehermCanonicalReleaseDispatch(${selectedId}u, 0, nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, 0, nullptr, nullptr, nullptr, nullptr, nullptr, 0, nullptr) != 73) return 5;
  if (dehermCanonicalReleaseDispatch(${omitted.identity.stableId}u, 0, nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, 0, nullptr, nullptr, nullptr, nullptr, nullptr, 0, nullptr) != DEHERM_CANONICAL_RELEASE_NOT_REACHABLE) return 6;
  return 0;
}
`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("the complete currently authorized Dynamic Hermes family inventory compiles and links", async (t) => {
  const cxx = compiler();
  if (!cxx) return t.skip("No C++ compiler is available");
  const authority = await authorities();
  const selected = emission(authority, "dynamicHermesJsi", { schemaVersion: 1, dynamicAccess: true, symbols: [] });
  const generated = generateCanonicalFamilyArtifacts(authority.plan, selected);
  assert.equal(generated.manifest.routeCount, selected.units.length);
  assert.deepEqual(
    generated.manifest.groups.map((group) => [group.loweringFamily, group.routeCount]),
    Object.entries(selected.familyCounts)
  );
  const temporary = await mkdtemp(join(tmpdir(), "deherm-canonical-full-dynamic-"));
  try {
    await writeArtifacts(temporary, generated.artifacts);
    const firstId = selected.units[0].id;
    const stableId = authority.plan.units[selected.units[0].sourceUnit].identity.stableId;
    assert.equal(typeof firstId, "string");
    await compileAndRun(
      cxx,
      temporary,
      "dynamicHermesJsi",
      ["src/registry.cpp", ...generated.manifest.groups.map((group) => group.source)],
      `
#include "deherm_canonical_release.h"
#include <stdint.h>
extern "C" int defoldHermesScriptCall(uint32_t, uint32_t, const uint8_t*, const uint8_t*, const double*, const uint64_t*, const uint32_t*, const uint32_t*, const char*, uint32_t, uint8_t*, uint8_t*, double*, uint64_t*, char*, uint32_t, uint32_t*) { return 1; }
int main() {
  return dehermCanonicalReleaseRouteCount() == ${selected.units.length}u && dehermCanonicalReleaseRouteEnabled(${stableId}u) ? 0 : 1;
}
`
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

for (const target of ["staticHermesCAbi", "browserWasmHost"]) {
  test(`${target} emits a compile-valid fail-closed registry and exact authority requirements`, async (t) => {
    const cxx = compiler();
    if (!cxx) return t.skip("No C++ compiler is available");
    const authority = await authorities();
    const selected = emission(authority, target, { schemaVersion: 1, dynamicAccess: true, symbols: [] });
    const generated = generateCanonicalFamilyArtifacts(authority.plan, selected);
    assert.equal(generated.manifest.routeCount, 0);
    assert.equal(generated.manifest.groupCount, 0);
    assert.equal(generated.requirements.status, "blocked-by-canonical-plan");
    assert.match(generated.requirements.requirementsSha256, /^[a-f0-9]{64}$/);
    const { requirementsSha256, ...requirementsBody } = generated.requirements;
    assert.equal(requirementsSha256, sha256(JSON.stringify(requirementsBody)));
    assert.ok(Object.keys(generated.requirements.selectionCounts).length > 0);
    assert.equal([...generated.artifacts.keys()].some((path) => path.includes("/family-")), false);
    const expectedSelections = {};
    for (const unit of authority.plan.units) {
      const disposition = unit.backends[target].selection;
      expectedSelections[disposition] = (expectedSelections[disposition] ?? 0) + 1;
    }
    assert.deepEqual(generated.requirements.selectionCounts, Object.fromEntries(Object.entries(expectedSelections).sort()));
    assert.equal(Object.values(generated.requirements.selectionCounts).reduce((sum, count) => sum + count, 0), authority.plan.units.length);
    const temporary = await mkdtemp(join(tmpdir(), `deherm-${target}-`));
    try {
      await writeArtifacts(temporary, generated.artifacts);
      await compileAndRun(cxx, temporary, target, ["src/registry.cpp"], `
#include "deherm_canonical_release.h"
int main() {
  if (dehermCanonicalReleaseRouteCount() != 0u) return 1;
  if (dehermCanonicalReleaseRoutes() != nullptr) return 2;
  if (dehermCanonicalReleaseRouteEnabled(1u)) return 3;
  return dehermCanonicalReleaseDispatch(1u, 0, nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, 0, nullptr, nullptr, nullptr, nullptr, nullptr, 0, nullptr) == DEHERM_CANONICAL_RELEASE_NOT_REACHABLE ? 0 : 4;
}
`);
      if (target === "browserWasmHost") {
        const browserAdapter = join(temporary, "canonical", target, "browser-library.js");
        const syntax = spawnSync(process.execPath, ["--check", browserAdapter], { encoding: "utf8" });
        assert.equal(syntax.status, 0, syntax.stderr);
        const source = await readFile(browserAdapter, "utf8");
        assert.match(source, /return false/);
        assert.doesNotMatch(source, /_dehermCanonicalReleaseRouteEnabled/);
      } else {
        const source = await readFile(join(temporary, "canonical", target, "static-hermes.js"), "utf8");
        assert.match(source, /Object\.freeze\(\[\]\)/);
        assert.match(source, /return false/);
        assert.doesNotMatch(source, /extern_c/);
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
}

test("canonical family emission rejects a forged blocked unit even with a recomputed emission digest", async () => {
  const authority = await authorities();
  const valid = emission(authority, "dynamicHermesJsi", { schemaVersion: 1, dynamicAccess: true, symbols: [] });
  const sourceUnit = authority.plan.units.findIndex((unit) => unit.backends.dynamicHermesJsi.selection !== "emit");
  const blocked = authority.plan.units[sourceUnit];
  const forgedBody = {
    ...valid,
    units: [{
      id: blocked.identity.id,
      sourceUnit,
      surface: blocked.identity.surface,
      loweringFamily: blocked.sourceState.loweringFamily
    }]
  };
  delete forgedBody.emissionPlanSha256;
  const forged = { ...forgedBody, emissionPlanSha256: sha256(JSON.stringify(forgedBody)) };
  assert.throws(
    () => generateCanonicalFamilyArtifacts(authority.plan, forged),
    /canonical '(blocked-capability|blocked-semantic|omit-profile|separate-module)' disposition/
  );
});

test("the native Dynamic Hermes consumer links generated sources and gates JSI dispatch", async () => {
  const [cmake, bridge] = await Promise.all([
    readFile(join(repositoryRoot, "CMakeLists.txt"), "utf8"),
    readFile(join(repositoryRoot, "defold/defold_hermes/src/script_jsi_bridge.cpp"), "utf8")
  ]);
  assert.match(cmake, /include\("\$\{DEHERM_CANONICAL_RELEASE_DIR\}\/sources\.cmake"\)/);
  assert.match(cmake, /DEHERM_CANONICAL_RELEASE_TARGET STREQUAL "dynamicHermesJsi"/);
  assert.match(cmake, /target_sources\(defold-hermes-runtime PRIVATE \$\{DEHERM_CANONICAL_RELEASE_SOURCES\}\)/);
  assert.match(cmake, /DEHERM_CANONICAL_RELEASE=1/);
  assert.match(bridge, /#if defined\(DEHERM_CANONICAL_RELEASE\)[\s\S]*dehermCanonicalReleaseRouteEnabled\(id\)/);
});
