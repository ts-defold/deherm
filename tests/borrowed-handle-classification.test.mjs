import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { stableBindingId } from "../scripts/lib/binding-identity.mjs";
import { generateBorrowedHandleClassification } from "../scripts/generate-borrowed-handle-classification.mjs";

const root = new URL("../", import.meta.url);

async function text(path) {
  return readFile(new URL(path, root), "utf8");
}

async function inputs() {
  const overrideText = await text("packages/bindings/overrides/script-borrowed-handle-classification.json");
  const override = JSON.parse(overrideText);
  const sourceTexts = new Map(await Promise.all(override.sourceEvidence.map(async ({ source }) => [
    source,
    await text(`upstream/defold/${source}`)
  ])));
  return {
    irText: await text("packages/bindings/generated/defold-script-api-ir.json"),
    accountingText: await text("packages/bindings/generated/defold-script-api-accounting.json"),
    patternsText: await text("packages/bindings/generated/defold-script-binding-patterns.json"),
    overrideText,
    sourceTexts
  };
}

function replaceJson(input, mutate) {
  const value = JSON.parse(input);
  mutate(value);
  return `${JSON.stringify(value, null, 2)}\n`;
}

const sourceInputs = await inputs();
const generated = generateBorrowedHandleClassification(sourceInputs);
const checked = JSON.parse(await text("packages/bindings/generated/defold-script-borrowed-handle-classification.json"));

test("partitions all 437 borrowed-handle routes exactly once", () => {
  assert.equal(generated.routeCount, 437);
  assert.deepEqual(generated.operationClassCounts, {
    "checked-handle-input-terminal": 367,
    "checked-child-engine-object-invalidate": 2,
    "checked-handle-return-capture": 55,
    "checked-self-engine-object-invalidate": 5,
    "declaration-token": 8
  });
  assert.deepEqual(generated.moduleCounts, {
    b2d: 218,
    buffer: 5,
    bullet3d: 139,
    go: 1,
    gui: 55,
    render: 8,
    resource: 10,
    sys: 1
  });
  assert.equal(new Set(generated.rows.map(({ id }) => id)).size, 437);
  assert.deepEqual(checked, generated);
});

test("admits a handle producer on its declared result, whatever shape its arguments take", () => {
  assert.deepEqual(generated.censusBasisCounts, {
    "declared-handle-result": 22,
    "handle-lowering-family": 415
  });
  // A constructor taking a definition record is filed under the table lowering
  // family, because a table-shaped parameter outranks a handle when the family
  // is chosen. It is still a producer, and the partition has to see it.
  const constructor = generated.rows.find(({ id }) => id === "script:b2d.joint.create_distance");
  assert.equal(constructor.censusBasis, "declared-handle-result");
  assert.equal(constructor.loweringFamily, "lua-table");
  assert.equal(constructor.operationClass, "checked-handle-return-capture");
  assert.deepEqual(constructor.returnHandleKinds, ["box2d-joint"]);
  assert.equal(constructor.hostHandleEffect, "capture-return");

  // Every handle-returning `create_*` is in, and no name pattern selected them:
  // the census basis is the declared result type, and it also admits producers
  // whose names read as accessors.
  const producers = generated.rows.filter(({ operationClass }) => operationClass === "checked-handle-return-capture");
  assert.equal(producers.filter(({ member }) => member.startsWith("create_")).length, 20);
  assert.ok(producers.some(({ member }) => member.startsWith("get_")));
  assert.ok(producers.every(({ returnHandleKinds }) => returnHandleKinds.length === 1));

  // A union of scalars that merely admits a handle member is not a handle
  // result, and a sequence of handles is a table.
  assert.equal(generated.rows.find(({ id }) => id === "script:b2d.body.get_joints"), undefined);
  assert.equal(generated.rows.find(({ id }) => id === "script:go.get"), undefined);
});

test("scopes a handle kind's representation to the backend that implements it", () => {
  const world = generated.handleKinds.find(({ id }) => id === "box2d-world");
  assert.equal(world.representationIsFeatureScoped, true);
  assert.deepEqual(world.capturableFeatures, ["box2d-v3"]);
  assert.deepEqual(world.uncapturableFeatures, ["box2d-v2"]);
  const legacy = world.representations.find(({ feature }) => feature === "box2d-v2");
  assert.equal(legacy.representation, "lua-light-userdata");
  assert.equal(legacy.capturable, false);
  assert.match(legacy.reason, /light userdata/);
  assert.deepEqual(legacy.sourceEvidence, ["box2d-world-v2"]);

  const body = generated.handleKinds.find(({ id }) => id === "box2d-body");
  assert.equal(body.representationIsFeatureScoped, false);
  assert.equal(body.capturableFeatures, null);
  assert.deepEqual(body.representations, [{
    feature: null,
    representation: "lua-rooted-userdata",
    capturable: true,
    sourceEvidence: ["box2d-body"]
  }]);
});

test("assigns stable IDs, concrete representations, context, and validity metadata", () => {
  assert.ok(generated.rows.every((row) => row.stableId === stableBindingId(row.id)));
  assert.equal(new Set(generated.rows.map(({ stableId }) => stableId)).size, 437);
  assert.ok(generated.rows.every(({ inputHandleKinds, returnHandleKinds }) =>
    inputHandleKinds.length + returnHandleKinds.length > 0));

  const kinds = new Map(generated.handleKinds.map((kind) => [kind.id, kind]));
  assert.equal(kinds.get("gui-node").representation, "lua-rooted-userdata");
  assert.equal(kinds.get("graphics-render-target").representation, "numeric-graphics-asset-handle");
  assert.equal(kinds.get("resource-declaration").representation, "declaration-only-token");
  assert.match(kinds.get("buffer-data").ownership, /owner-c-owner-lua-or-owner-resource/);
  assert.ok(generated.handleKinds.every(({ validity, invalidationBoundary, sourceEvidence }) =>
    validity.length > 0 && invalidationBoundary.length > 0 && sourceEvidence.length > 0));

  assert.equal(generated.rows.find(({ id }) => id === "script:b2d.get_body").requiredContext,
    "game-object-instance");
  assert.equal(generated.rows.find(({ id }) => id === "script:gui.clone").requiredContext, "gui-scene");
  assert.equal(generated.rows.find(({ id }) => id === "script:render.constant_buffer").requiredContext,
    "render-script-instance-and-graphics-context");
  assert.equal(generated.rows.find(({ id }) => id === "script:resource.atlas").requiredContext,
    "component-property-compiler");
  const childDestroy = generated.rows.find(({ id }) => id === "script:b2d.body.destroy_shape");
  assert.equal(childDestroy.invalidatedIdentity, "child-index");
  assert.equal(childDestroy.hostHandleEffect, "preserve");
  const selfDestroy = generated.rows.find(({ id }) => id === "script:b2d.joint.destroy");
  assert.equal(selfDestroy.invalidatedIdentity, "self-underlying");
  assert.equal(selfDestroy.hostHandleEffect, "preserve");
});

test("keeps declaration tokens out of runtime handle capture", () => {
  const declarations = generated.rows.filter(({ operationClass }) => operationClass === "declaration-token");
  assert.deepEqual(declarations.map(({ id }) => id), [
    "script:go.property",
    "script:resource.atlas",
    "script:resource.buffer",
    "script:resource.font",
    "script:resource.material",
    "script:resource.render_target",
    "script:resource.texture",
    "script:resource.tile_source"
  ]);
  assert.ok(declarations.every(({ inputHandleKinds, returnHandleKinds }) =>
    [...inputHandleKinds, ...returnHandleKinds].includes("resource-declaration")));
  assert.match(generated.coverageClaim, /not runtime evidence/);
  assert.match(generated.allocationClaim, /does not claim.*allocation-free.*engine operations may allocate/i);
  assert.deepEqual(generated.implementationOrder.map(({ operationClass }) => operationClass), [
    "checked-handle-input-terminal",
    "checked-handle-return-capture",
    "checked-child-engine-object-invalidate",
    "checked-self-engine-object-invalidate",
    "declaration-token"
  ]);
});

test("fails closed on census, exception, stable-ID, kind, and source drift", () => {
  const censusDrift = structuredClone(sourceInputs);
  censusDrift.accountingText = replaceJson(censusDrift.accountingText, (value) => {
    const borrowed = new Set(JSON.parse(censusDrift.patternsText).bindings
      .filter(({ loweringFamily }) => loweringFamily === "borrowed-handle")
      .map(({ id }) => id));
    value.rows = value.rows.filter(({ id }) => !borrowed.has(id) || id !== [...borrowed][0]);
  });
  assert.throws(() => generateBorrowedHandleClassification(censusDrift), /route count drifted/);

  const missingProducer = structuredClone(sourceInputs);
  missingProducer.overrideText = replaceJson(missingProducer.overrideText, (value) => {
    value.exceptionalRoutes["checked-handle-return-capture"].pop();
  });
  assert.throws(() => generateBorrowedHandleClassification(missingProducer), /producers differ/);

  const overlap = structuredClone(sourceInputs);
  overlap.overrideText = replaceJson(overlap.overrideText, (value) => {
    value.exceptionalRoutes["checked-self-engine-object-invalidate"].push(
      value.exceptionalRoutes["checked-handle-return-capture"][0]
    );
  });
  assert.throws(() => generateBorrowedHandleClassification(overlap), /multiple operation classes/);

  const staleStableId = structuredClone(sourceInputs);
  staleStableId.overrideText = replaceJson(staleStableId.overrideText, (value) => {
    value.exceptionalRoutes["declaration-token"][0].stableId ^= 1;
  });
  assert.throws(() => generateBorrowedHandleClassification(staleStableId), /stable ID is stale/);

  const missingKind = structuredClone(sourceInputs);
  missingKind.overrideText = replaceJson(missingKind.overrideText, (value) => {
    value.handleKinds.find(({ id }) => id === "box2d-body").rawTypes = [];
  });
  assert.throws(() => generateBorrowedHandleClassification(missingKind), /no raw handle types/);

  const staleSource = structuredClone(sourceInputs);
  const [sourcePath, sourceText] = staleSource.sourceTexts.entries().next().value;
  staleSource.sourceTexts.set(sourcePath, `${sourceText}\n// drift\n`);
  assert.throws(() => generateBorrowedHandleClassification(staleSource), /source hash is stale/);
});

test("check command proves the checked-in classification is current", () => {
  execFileSync(process.execPath, ["scripts/generate-borrowed-handle-classification.mjs", "--check"], {
    cwd: root,
    stdio: "pipe"
  });
});
