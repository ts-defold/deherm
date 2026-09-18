import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { generateBindingEmissionPlan, run } from "../scripts/generate-binding-emission-plan.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const plan = JSON.parse(await readFile(join(root, "bindings/generated/defold-binding-lowering-plan.json"), "utf8"));
const scriptProjection = JSON.parse(await readFile(join(root, "bindings/generated/defold-script-projection-ir.json"), "utf8"));
const profiles = JSON.parse(await readFile(join(root, "bindings/generated/defold-script-route-availability-profiles.json"), "utf8"));

function usage(symbols, dynamicAccess = false) {
  return { schemaVersion: 1, dynamicAccess, symbols };
}

test("final-build selection retains only reachable compatible units and shared programs", () => {
  const selectedIds = [
    "script:camera.get_projection",
    "script:factory.create",
    "script:go.delete"
  ];
  const result = generateBindingEmissionPlan(plan, scriptProjection, profiles, usage(selectedIds), {
    target: "dynamicHermesJsi",
    profile: "default-legacy-bullet"
  });
  assert.deepEqual(result.units.map(({ id }) => id), [...selectedIds].sort());
  assert.equal(result.treeShaking.totalPlanUnits, 2287);
  assert.equal(result.treeShaking.selectedForEmissionUnits, 3);
  assert.equal(result.treeShaking.notSelectedUnits, 2284);
  assert.ok(result.treeShaking.retainedMarshallingPrograms <= 3);
  assert.ok(result.treeShaking.retainedMarshallingPrograms < result.treeShaking.totalMarshallingPrograms);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.evidenceBoundary.generation, "planned-not-emitted");
  assert.equal(result.evidenceBoundary.runtime, "not-claimed");
  assert.match(result.emissionPlanSha256, /^[a-f0-9]{64}$/);
  const referencedPrograms = new Set(result.units.map(({ marshallingProgram }) => marshallingProgram));
  assert.deepEqual([...referencedPrograms].sort((left, right) => left - right), result.tables.marshallingPrograms.map((_, index) => index));
});

test("new game-code reachability changes do not regenerate the canonical API plan", () => {
  const one = generateBindingEmissionPlan(plan, scriptProjection, profiles, usage(["script:go.delete"]));
  const two = generateBindingEmissionPlan(plan, scriptProjection, profiles, usage(["script:go.delete", "script:factory.create"]));
  assert.equal(one.sourcePlanSha256, plan.planSha256);
  assert.equal(two.sourcePlanSha256, plan.planSha256);
  assert.notEqual(one.emissionPlanSha256, two.emissionPlanSha256);
  assert.equal(one.treeShaking.selectedForEmissionUnits, 1);
  assert.equal(two.treeShaking.selectedForEmissionUnits, 2);
});

test("semantically identical reachability manifests produce one canonical artifact", () => {
  const left = generateBindingEmissionPlan(plan, scriptProjection, profiles, {
    schemaVersion: 1,
    dynamicAccess: false,
    symbols: ["script:factory.create", "script:go.delete"],
    ignoredMetadata: "left"
  });
  const right = generateBindingEmissionPlan(plan, scriptProjection, profiles, {
    symbols: ["script:go.delete", "script:factory.create"],
    dynamicAccess: false,
    schemaVersion: 1,
    ignoredMetadata: "right"
  });
  assert.deepEqual(left, right);
});

test("explicit use fails closed for blocked, unavailable, duplicate, and unknown bindings", () => {
  assert.throws(() => generateBindingEmissionPlan(
    plan,
    scriptProjection,
    profiles,
    usage(["script:b2d.body.apply_force"])
  ), /cannot emit.*blocked-semantic/);
  assert.throws(() => generateBindingEmissionPlan(
    plan,
    scriptProjection,
    profiles,
    usage(["script:b2d.body.get_user_data"]),
    { profile: "v3-bullet" }
  ), /unavailable in Defold profile/);
  assert.throws(() => generateBindingEmissionPlan(plan, scriptProjection, profiles, usage(["script:go.delete", "script:go.delete"])), /duplicate symbols/);
  assert.throws(() => generateBindingEmissionPlan(plan, scriptProjection, profiles, usage(["script:not.real"])), /unknown binding/);
});

test("dynamic access chooses the full currently compatible pre-generated target surface", () => {
  const result = generateBindingEmissionPlan(plan, scriptProjection, profiles, usage([], true), {
    target: "dynamicHermesJsi",
    profile: "default-legacy-bullet"
  });
  const sourceRows = new Map(scriptProjection.rows.map((row, index) => [index, row]));
  const profileAvailable = (unit) => {
    if (unit.identity.surface !== "script") return true;
    const availability = sourceRows.get(unit.sourceRef.row).availability;
    return availability.token === "core" || availability.token === "html5-host" ||
      availability.runtimeProfiles?.includes("default-legacy-bullet") === true;
  };
  const expected = plan.units.filter((unit) =>
    unit.backends.dynamicHermesJsi.selection === "emit" && profileAvailable(unit)).length;
  const expectedDiagnostics = plan.units.filter((unit) =>
    unit.backends.dynamicHermesJsi.selection !== "emit" && profileAvailable(unit)).length;
  assert.equal(result.treeShaking.selectedForEmissionUnits, expected);
  assert.equal(result.usage.requestedCount, 2287);
  assert.equal(result.diagnostics.length, expectedDiagnostics);
});

test("stale or forged lowering and profile authorities fail before selection", () => {
  const forgedPlan = structuredClone(plan);
  forgedPlan.units[0].backends.dynamicHermesJsi.selection = "emit";
  assert.throws(
    () => generateBindingEmissionPlan(forgedPlan, scriptProjection, profiles, usage([])),
    /internal digest is invalid/
  );

  const forgedProjection = structuredClone(scriptProjection);
  forgedProjection.rows[0].availability.runtimeProfiles = [];
  assert.throws(
    () => generateBindingEmissionPlan(plan, forgedProjection, profiles, usage([])),
    /does not match the lowering plan authority/
  );

  const forgedProfiles = structuredClone(profiles);
  forgedProfiles.catalogSha256 = "0".repeat(64);
  assert.throws(
    () => generateBindingEmissionPlan(plan, scriptProjection, forgedProfiles, usage([])),
    /authorities differ/
  );
});

test("the final-build planner CLI is deterministic without changing API generation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deherm-emission-plan-"));
  try {
    const usagePath = join(directory, "usage.json");
    const output = join(directory, "emission.json");
    await writeFile(usagePath, `${JSON.stringify(usage(["script:go.delete"]))}\n`);
    await run(["--usage", usagePath, "--output", output]);
    const first = await readFile(output, "utf8");
    await run(["--usage", usagePath, "--output", output, "--check"]);
    assert.equal(await readFile(output, "utf8"), first);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
