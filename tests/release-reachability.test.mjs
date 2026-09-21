import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { buildScriptRouteSymbolIndex } from "../packages/compiler/src/script-route-symbol-index.mjs";
import { buildDmSdkCallSymbolIndex } from "../packages/compiler/src/dmsdk-call-symbol-index.mjs";
import { materializeDmSdkUsages } from "../packages/compiler/src/dmsdk-universal-materializer.mjs";
import { writeProjectDmSdkCallSymbolIndex, writeProjectRouteSymbolIndex } from "../packages/cli/src/resource-symbols.mjs";
import {
  callDmSdkDeclaration,
  installDmSdkBridge
} from "../packages/sdk/src/generated/dmsdk/runtime.ts";
import { generateTypedNativeProjection } from "../scripts/generate-typed-native-projection.mjs";
import { generateBindingEmissionPlan } from "../scripts/generate-binding-emission-plan.mjs";
import { generateReleaseBuild } from "../scripts/generate-release-build.mjs";
import {
  bundleReachableStableIds,
  checkerReachableRoutes,
  crossCheckReachability,
  defoldApiUsageDocument
} from "../scripts/defold-api-reachability.mjs";

const root = path.resolve(import.meta.dirname, "..");
const fixture = path.join(root, "tests/fixtures/reachability");

async function json(relative) {
  return JSON.parse(await readFile(path.join(root, relative), "utf8"));
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function refreshIndexIdentity(indexDocument) {
  const body = structuredClone(indexDocument);
  delete body.indexSha256;
  indexDocument.indexSha256 = createHash("sha256").update(canonicalJson(body)).digest("hex");
}

function runTtsc(project) {
  return execFileSync(path.join(root, "node_modules/.bin/ttsc"), ["-p", path.join(fixture, project)], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

const index = buildScriptRouteSymbolIndex(
  await json("packages/bindings/generated/defold-script-api-ir.json"),
  await json("packages/bindings/generated/defold-binding-lowering-plan.json")
);
const memberByRouteId = new Map(Object.entries(index.members).map(([member, route]) => [route.id, member]));

// The fixture compiles against a freshly derived index rather than a committed
// one, so the checker is always answering in the identity the current lowering
// plan uses.
await mkdir(path.join(fixture, ".deherm/generated"), { recursive: true });
await writeFile(
  path.join(fixture, ".deherm/generated/script-route-symbol-index.json"),
  `${JSON.stringify(index, null, 2)}\n`
);
const dmSdkCatalog = await json("packages/bindings/generated/defold-dmsdk-universal-bindings.json");
const dmSdkIr = await json("packages/bindings/generated/defold-sdk-ir.json");
const dmSdkIndex = buildDmSdkCallSymbolIndex(
  dmSdkIr,
  dmSdkCatalog
);
const dmSdkIndexFile = path.join(fixture, ".deherm/generated/dmsdk-call-symbol-index.json");
await writeFile(
  dmSdkIndexFile,
  `${JSON.stringify(dmSdkIndex, null, 2)}\n`
);

test("every dmSDK recipe has a checker-resolvable overload identity", () => {
  assert.equal(dmSdkIndex.recipeCount, 1361);
  assert.equal(Object.keys(dmSdkIndex.declarations).length, 1361);
  assert.equal(dmSdkIndex.overloadCount, 1335);
  assert.equal(dmSdkIndex.ambiguousOverloadCount, 21);
  assert.equal(dmSdkIndex.universalReadyCount, 486);
  assert.equal(dmSdkIndex.generatedAdapterCount, 59);
  assert.equal(dmSdkIndex.specializationRequiredCount, 816);
  assert.equal(Object.keys(dmSdkIndex.markers).length, dmSdkIndex.overloadCount);
  assert.match(dmSdkIndex.indexSha256, /^[0-9a-f]{64}$/);
});

test("the project dmSDK index uses the policy-materialized revision inputs", async () => {
  const outputRoot = await mkdtemp(path.join(tmpdir(), "deherm-dmsdk-index-"));
  try {
    await mkdir(path.join(outputRoot, "ir"), { recursive: true });
    const revision = "a".repeat(40);
    await Promise.all([
      writeFile(path.join(outputRoot, "ir", "dmsdk.json"), `${JSON.stringify({ ...dmSdkIr, defoldRevision: revision })}\n`),
      writeFile(path.join(outputRoot, "ir", "dmsdk-universal-bindings.json"), `${JSON.stringify(dmSdkCatalog)}\n`)
    ]);
    const generated = await writeProjectDmSdkCallSymbolIndex(outputRoot);
    assert.equal(generated.index.defoldRevision, revision);
    assert.equal(generated.index.recipeCount, dmSdkCatalog.recipes.length);
    assert.equal(generated.file, path.join(outputRoot, "generated", "dmsdk-call-symbol-index.json"));
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});

test("the project script route index uses the policy-materialized revision inputs", async () => {
  const outputRoot = await mkdtemp(path.join(tmpdir(), "deherm-script-index-"));
  try {
    await mkdir(path.join(outputRoot, "ir"), { recursive: true });
    const revision = "b".repeat(40);
    const projectIr = structuredClone(await json("packages/bindings/generated/defold-script-api-ir.json"));
    const projectPlan = structuredClone(await json("packages/bindings/generated/defold-binding-lowering-plan.json"));
    projectIr.defoldRevision = revision;
    projectPlan.defoldRevision = revision;
    delete projectPlan.planSha256;
    projectPlan.planSha256 = createHash("sha256").update(JSON.stringify(projectPlan)).digest("hex");
    await Promise.all([
      writeFile(path.join(outputRoot, "ir", "script-api.json"), `${JSON.stringify(projectIr)}\n`),
      writeFile(path.join(outputRoot, "ir", "binding-lowering-plan.json"), `${JSON.stringify(projectPlan)}\n`)
    ]);
    const generated = await writeProjectRouteSymbolIndex(outputRoot);
    assert.equal(generated.index.defoldRevision, revision);
    assert.equal(generated.index.loweringPlanSha256, projectPlan.planSha256);
    assert.equal(generated.index.routeCount, 926);
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});

// The member paths the checker resolves have to be the ones the generated SDK
// actually declares. `modules.ts` is an independent rendering of the same
// surface that carries the stable ID beside every member, so agreeing with it
// on all 926 routes is a real check rather than a restatement of the deriving
// code.
function membersFromGeneratedModules(source) {
  const members = new Map();
  const stack = [];
  let declaringInterface = null;
  for (const line of source.split("\n")) {
    const namespace = line.match(/^export const [A-Za-z0-9_]+: Types\.([A-Za-z0-9_]+) = \{/);
    if (namespace) {
      declaringInterface = namespace[1];
      stack.length = 0;
      continue;
    }
    if (declaringInterface === null) continue;
    const route = line.match(/^\s*([A-Za-z0-9_]+): \(\(\.\.\.args: readonly unknown\[\]\) => callScriptApi\(0x([0-9a-f]+),/);
    if (route) {
      members.set([declaringInterface, ...stack, route[1]].join("."), Number.parseInt(route[2], 16));
      continue;
    }
    if (/^\s*[A-Za-z0-9_]+: \{\s*$/.test(line)) {
      stack.push(line.trim().split(":")[0]);
      continue;
    }
    if (/^\s*\},?\s*$/.test(line)) {
      if (stack.length) stack.pop();
      else declaringInterface = null;
    }
  }
  return members;
}

test("every declared member path resolves to exactly one canonical route", async () => {
  const declared = membersFromGeneratedModules(
    await readFile(path.join(root, "packages/sdk/src/generated/script/modules.ts"), "utf8")
  );
  assert.equal(declared.size, index.routeCount);
  assert.equal(Object.keys(index.members).length, index.routeCount);
  for (const [member, route] of Object.entries(index.members)) {
    assert.equal(declared.get(member), route.stableId, `${member} does not name its declared stable ID`);
  }
  assert.equal(index.members["GuiApi.getNode"].id, "script:gui.get_node");
  // Nested Lua modules are declared as type literals inside their interface, so
  // the member path the checker resolves has to carry the nesting too.
  assert.equal(index.members["B2dApi.body.applyForce"].id, "script:b2d.body.apply_force");
});

test("the checker resolves a fixture project to its exact route set", async () => {
  runTtsc("tsconfig.json");
  const manifest = JSON.parse(await readFile(
    path.join(fixture, ".deherm/generated/defold-api-usage.json"), "utf8"));
  assert.equal(manifest.dynamicAccess, false);
  assert.deepEqual(manifest.routes.map(({ id }) => id), [
    "script:go.get_position",
    "script:go.set_position",
    "script:gui.get_node",
    "script:gui.set_color",
    "script:msg.post",
    "script:vmath.vector3",
    "script:vmath.vector4"
  ]);
  // A member reached through an alias is the same member; resolution is by
  // symbol, not by the spelling at the call site.
  const vector3 = manifest.routes.find(({ id }) => id === "script:vmath.vector3");
  assert.ok(vector3.sites.length >= 2, "the aliased and direct call sites are both recorded");
  for (const route of manifest.routes) {
    for (const site of route.sites) assert.equal(site.file, "src/game.ts");
  }
});

test("the checker resolves dmSDK calls to exact materializable recipes", async () => {
  runTtsc("tsconfig.json");
  const manifest = JSON.parse(await readFile(
    path.join(fixture, ".deherm/generated/dmsdk-usage.json"), "utf8"));
  assert.equal(manifest.catalogSha256, dmSdkCatalog.sourceHashes.catalog);
  assert.equal(manifest.surfaceRecipeCount, 1361);
  assert.equal(manifest.usageCount, 1);
  assert.deepEqual(manifest.ambiguousSites, []);
  assert.equal(manifest.usages[0].declarationId,
    "dmsdk:dmGraphics::Finalize@upstream/defold/engine/graphics/src/dmsdk/graphics/graphics.h:1759:1460");
  assert.equal(manifest.usages[0].numericId, 503);
  assert.equal(manifest.usages[0].symbol, "dmGraphics::Finalize");
  assert.equal(manifest.usages[0].materialization.state, "universal-ready");
  assert.equal(manifest.usages[0].sites[0].file, "src/game.ts");
  assert.equal(
    manifest.symbolIndexSourceSha256,
    createHash("sha256").update(await readFile(dmSdkIndexFile)).digest("hex"),
  );

  const generated = materializeDmSdkUsages(manifest.usages, {
    catalog: dmSdkCatalog,
    catalogSha256: manifest.catalogSha256
  });
  assert.equal(generated.manifest.length, 1);
  assert.equal(generated.manifest[0].declarationId, manifest.usages[0].declarationId);
  assert.match(generated.source, /dmGraphics::Finalize/);
  assert.equal(generated.verification.vectors[0].nativeSymbol, "dmGraphics::Finalize");
  assert.match(generated.verificationSource, /deherm_dmsdk_usage_503__exact_callee/);
});

test("release reachability refuses a generated runtime/index mismatch", async () => {
  const declarationId =
    "dmsdk:dmGraphics::Finalize@upstream/defold/engine/graphics/src/dmsdk/graphics/graphics.h:1759:1460";
  const marker = dmSdkIndex.declarations[declarationId].marker;
  const mismatched = structuredClone(dmSdkIndex);
  const staleMarker = `${marker}_stale`;
  mismatched.markers[staleMarker] = mismatched.markers[marker];
  delete mismatched.markers[marker];
  for (const declaration of mismatched.markers[staleMarker].declarations) {
    mismatched.declarations[declaration.declarationId].marker = staleMarker;
  }
  refreshIndexIdentity(mismatched);
  await writeFile(dmSdkIndexFile, `${JSON.stringify(mismatched, null, 2)}\n`);
  let failure = null;
  try {
    runTtsc("tsconfig.json");
  } catch (error) {
    failure = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  } finally {
    await writeFile(dmSdkIndexFile, `${JSON.stringify(dmSdkIndex, null, 2)}\n`);
  }
  assert.ok(failure, "a marker missing from the project index must not disappear from reachability");
  assert.match(failure, /resolved dmSDK overload marker is absent from the generated index/);
  const manifest = JSON.parse(await readFile(
    path.join(fixture, ".deherm/generated/dmsdk-usage.json"), "utf8"));
  assert.equal(manifest.usageCount, 0);
  assert.equal(manifest.unresolvedSites[0].marker, marker);
});

test("release reachability rejects a structurally tampered dmSDK index", async () => {
  const declarationId =
    "dmsdk:dmGraphics::Finalize@upstream/defold/engine/graphics/src/dmsdk/graphics/graphics.h:1759:1460";
  const tampered = structuredClone(dmSdkIndex);
  tampered.declarations[declarationId].numericId += 1;
  await writeFile(dmSdkIndexFile, `${JSON.stringify(tampered, null, 2)}\n`);
  let failure = null;
  try {
    runTtsc("tsconfig.json");
  } catch (error) {
    failure = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  } finally {
    await writeFile(dmSdkIndexFile, `${JSON.stringify(dmSdkIndex, null, 2)}\n`);
  }
  assert.ok(failure, "marker/declaration disagreement must invalidate the dmSDK symbol index");
  assert.match(failure, /no usable dmSDK symbol index was found/);
});

test("release reachability rejects a dmSDK index whose authenticated body changed", async () => {
  const tampered = structuredClone(dmSdkIndex);
  tampered.defoldRevision = "0".repeat(40);
  await writeFile(dmSdkIndexFile, `${JSON.stringify(tampered, null, 2)}\n`);
  let failure = null;
  try {
    runTtsc("tsconfig.json");
  } catch (error) {
    failure = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  } finally {
    await writeFile(dmSdkIndexFile, `${JSON.stringify(dmSdkIndex, null, 2)}\n`);
  }
  assert.ok(failure, "changing an indexed fact without updating its identity must invalidate the index");
  assert.match(failure, /no usable dmSDK symbol index was found/);
});

test("release reachability refuses dmSDK overloads collapsed by TypeScript", async () => {
  let failure = null;
  try {
    runTtsc("tsconfig.dmsdk-ambiguous.json");
  } catch (error) {
    failure = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
  assert.ok(failure, "an ambiguous native overload must not be guessed");
  assert.match(failure, /dmSDK call dmEndian::ByteSwap collapses 2 native declarations/);
  assert.match(failure, /dmsdk:dmEndian::ByteSwap@/);
  const manifest = JSON.parse(await readFile(
    path.join(fixture, ".deherm/generated/dmsdk-usage.ambiguous.json"), "utf8"));
  assert.equal(manifest.usageCount, 0);
  assert.equal(manifest.ambiguousSites.length, 1);
  assert.equal(manifest.ambiguousSites[0].declarationIds.length, 2);
});

test("an exact selector resolves a collapsed overload to its concrete generated adapter route", async () => {
  runTtsc("tsconfig.dmsdk-exact.json");
  const manifest = JSON.parse(await readFile(
    path.join(fixture, ".deherm/generated/dmsdk-usage.exact.json"), "utf8"));
  assert.equal(manifest.usageCount, 1);
  assert.deepEqual(manifest.ambiguousSites, []);
  assert.deepEqual(manifest.specializationRequiredSites, []);
  assert.equal(manifest.usages[0].declarationId,
    "dmsdk:dmEndian::ByteSwap@upstream/defold/engine/dlib/src/dmsdk/dlib/endian.hpp:46:195");
  assert.equal(manifest.usages[0].materialization.state, "generated-adapter");
  assert.equal(manifest.usages[0].materialization.family, "scalar");
  assert.equal(manifest.usages[0].materialization.route.kind, "named-wrapper");
  assert.equal(manifest.usages[0].materialization.route.applicability, "callable");
});

test("release reachability diagnoses calls that need generated specialization", async () => {
  let failure = null;
  try {
    runTtsc("tsconfig.dmsdk-specialization.json");
  } catch (error) {
    failure = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
  assert.ok(failure, "a declaration needing usage facts must not appear universally materializable");
  assert.match(failure, /requires generated usage specialization before release materialization/);
  const manifest = JSON.parse(await readFile(
    path.join(fixture, ".deherm/generated/dmsdk-usage.specialization.json"), "utf8"));
  assert.equal(manifest.usageCount, 0);
  assert.deepEqual(manifest.ambiguousSites, []);
  assert.deepEqual(manifest.unresolvedSites, []);
  assert.equal(manifest.specializationRequiredSites.length, 1);
  assert.equal(manifest.specializationRequiredSites[0].declarationId,
    "dmsdk:~dmArray<T>@upstream/defold/engine/dlib/src/dmsdk/dlib/array.h:403:50");
  assert.ok(manifest.specializationRequiredSites[0].requirements.includes("receiver-native-type"));
  assert.match(manifest.specializationRequiredSites[0].diagnostic, /receiverCppType/);
});

test("an exact declaration selector still calls the bridge's native symbol", () => {
  let observed;
  installDmSdkBridge({
    call(symbol, args) {
      observed = { symbol, args };
      return 7;
    },
    callDeclaration(declarationId, symbol, args) {
      observed = { declarationId, symbol, args };
      return 7;
    }
  });
  const declarationId =
    "dmsdk:dmEndian::ByteSwap@upstream/defold/engine/dlib/src/dmsdk/dlib/endian.hpp:46:195";
  const result = callDmSdkDeclaration(
    declarationId,
    1,
  );
  assert.equal(result, 7);
  assert.deepEqual(observed, { declarationId, symbol: "dmEndian::ByteSwap", args: [1] });
});

test("release reachability refuses a nonliteral exact dmSDK selector", async () => {
  let failure = null;
  try {
    runTtsc("tsconfig.dmsdk-dynamic-exact.json");
  } catch (error) {
    failure = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
  assert.ok(failure, "a nonliteral exact selector must not disappear from reachability");
  assert.match(failure, /exact dmSDK declaration ID must be a string literal/);
  const manifest = JSON.parse(await readFile(
    path.join(fixture, ".deherm/generated/dmsdk-usage.dynamic-exact.json"), "utf8"));
  assert.equal(manifest.usageCount, 0);
  assert.equal(manifest.unresolvedSites.length, 1);
});

test("release reachability refuses indirect dmSDK callable escapes", async () => {
  let failure = null;
  try {
    runTtsc("tsconfig.dmsdk-indirect.json");
  } catch (error) {
    failure = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
  assert.ok(failure, "indirect dmSDK calls must not disappear from reachability");
  assert.match(failure, /indirect dmSDK invocation through \.call is not modeled/);
  assert.match(failure, /indirect dmSDK invocation through \.apply is not modeled/);
  assert.match(failure, /indirect dmSDK invocation through Reflect\.apply is not modeled/);
  const manifest = JSON.parse(await readFile(
    path.join(fixture, ".deherm/generated/dmsdk-usage.indirect.json"), "utf8"));
  assert.equal(manifest.usageCount, 0);
  assert.equal(manifest.unresolvedSites.length, 3);
});

test("undeclared dynamic access is a diagnostic naming the site", () => {
  let failure = null;
  try {
    runTtsc("tsconfig.dynamic.json");
  } catch (error) {
    failure = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
  assert.ok(failure, "a release-profile compilation must refuse undeclared dynamic access");
  assert.match(failure, /dynamic\/dynamic\.ts\(\d+,\d+\)/);
  assert.match(failure, /computed member access on the generated Defold script surface/);
  assert.match(failure, /"dynamicApiAccess": true/);
});

test("declared dynamic access compiles and opts into the complete surface", async () => {
  runTtsc("tsconfig.dynamic-declared.json");
  const manifest = JSON.parse(await readFile(
    path.join(fixture, ".deherm/generated/defold-api-usage.dynamic-declared.json"), "utf8"));
  assert.equal(manifest.dynamicAccess, true);
  assert.equal(manifest.declaredDynamicAccess, true);
  assert.equal(manifest.dynamicSites.length, 1);
});

test("development computes reachability without failing on undeclared dynamic access", async () => {
  runTtsc("tsconfig.dynamic-development.json");
  const manifest = JSON.parse(await readFile(
    path.join(fixture, ".deherm/generated/defold-api-usage.dynamic-development.json"), "utf8"));
  assert.equal(manifest.profile, "development");
  assert.equal(manifest.dynamicAccess, true);
  assert.equal(manifest.declaredDynamicAccess, false);
});

/** The usage document a bundler would publish for the fixture program. */
async function fixtureUsage({ corruptBundle = false } = {}) {
  const manifest = JSON.parse(await readFile(
    path.join(fixture, ".deherm/generated/defold-api-usage.json"), "utf8"));
  const checkerRouteIds = checkerReachableRoutes(manifest, new Set(["src/game.ts"]));
  // esbuild retains whole namespace objects, so the emitted stable IDs are every
  // route of every namespace the program touched. That is the coarser, entirely
  // independent derivation the checker is checked against.
  const reachedNamespaces = new Set(Object.values(index.members)
    .filter(({ id }) => checkerRouteIds.includes(id))
    .map(({ namespace }) => namespace));
  const emitted = Object.values(index.members)
    .filter(({ namespace }) => reachedNamespaces.has(namespace))
    .map(({ stableId }) => `callScriptApi(${stableId}, args)`)
    .join("\n");
  const bundleStableIds = bundleReachableStableIds(emitted);
  // A bundler that dropped a route the checker resolved is the disagreement
  // this cross-check exists to catch.
  if (corruptBundle) bundleStableIds.delete(index.members["GuiApi.getNode"].stableId);
  const crossCheck = crossCheckReachability({
    entryPoint: "src/game.ts",
    output: "dist/game.js",
    manifest,
    routeIndex: index,
    checkerRouteIds,
    bundleStableIds
  });
  return {
    document: defoldApiUsageDocument({
      entryPoint: "src/game.ts",
      output: "dist/game.js",
      manifest,
      routeIndex: index,
      checkerRouteIds,
      crossCheck
    }),
    checkerRouteIds,
    bundleStableIds
  };
}

test("the module graph cross-checks the checker instead of authorizing it", async () => {
  const agreeing = await fixtureUsage();
  assert.equal(agreeing.document.derivation.crossCheck.status, "agree");
  assert.equal(agreeing.document.derivation.authority, "ttsc-checker-symbol-resolution");
  // The bundler retains far more than the checker resolves — that is the whole
  // reason module granularity cannot drive a release.
  assert.ok(agreeing.bundleStableIds.size > agreeing.checkerRouteIds.length * 3);

  const disagreeing = await fixtureUsage({ corruptBundle: true });
  assert.equal(disagreeing.document.derivation.crossCheck.status, "disagree");
  assert.match(disagreeing.document.derivation.crossCheck.disagreements.join("\n"),
    /the checker resolved script:gui\.get_node but the bundler emitted no dispatch/);

  const [plan, projection, profiles] = await Promise.all([
    json("packages/bindings/generated/defold-binding-lowering-plan.json"),
    json("packages/bindings/generated/defold-script-projection-ir.json"),
    json("packages/bindings/generated/defold-script-route-availability-profiles.json")
  ]);
  assert.throws(
    () => generateBindingEmissionPlan(plan, projection, profiles, disagreeing.document, {}),
    /failed its module-graph cross-check/
  );
});

test("dynamic access must be declared before a release retains the whole surface", async () => {
  const [plan, projection, profiles] = await Promise.all([
    json("packages/bindings/generated/defold-binding-lowering-plan.json"),
    json("packages/bindings/generated/defold-script-projection-ir.json"),
    json("packages/bindings/generated/defold-script-route-availability-profiles.json")
  ]);
  const manifest = JSON.parse(await readFile(
    path.join(fixture, ".deherm/generated/defold-api-usage.dynamic-development.json"), "utf8"));
  const document = defoldApiUsageDocument({
    entryPoint: "dynamic/dynamic.ts",
    output: "dist/dynamic.js",
    manifest,
    routeIndex: index,
    checkerRouteIds: [],
    crossCheck: { status: "agree", disagreements: [] }
  });
  assert.equal(document.dynamicAccess, true);
  assert.throws(
    () => generateBindingEmissionPlan(plan, projection, profiles, document, {}),
    /reaches the surface dynamically without declaring it/
  );

  const declared = JSON.parse(await readFile(
    path.join(fixture, ".deherm/generated/defold-api-usage.dynamic-declared.json"), "utf8"));
  const declaredDocument = defoldApiUsageDocument({
    entryPoint: "dynamic/dynamic.ts",
    output: "dist/dynamic.js",
    manifest: declared,
    routeIndex: index,
    checkerRouteIds: [],
    crossCheck: { status: "agree", disagreements: [] }
  });
  const emission = generateBindingEmissionPlan(plan, projection, profiles, declaredDocument, {});
  // Declaring it is not free: it costs the entire profile-available surface.
  const profileAvailable = plan.units.filter((unit) => {
    if (unit.backends.dynamicHermesJsi.selection !== "emit") return false;
    if (unit.identity.surface !== "script") return true;
    const availability = projection.rows[unit.sourceRef.row].availability;
    return availability.token === "core" || availability.token === "html5-host" ||
      availability.runtimeProfiles?.includes(emission.profileId) === true;
  }).length;
  assert.equal(emission.treeShaking.selectedForEmissionUnits, profileAvailable);
  assert.ok(profileAvailable > 700, "declared dynamic access retains essentially the whole surface");
  assert.equal(emission.usage.declaredDynamicAccess, true);
});

test("the release projection retains the fixture's routes and none of the rest", async () => {
  const { document, checkerRouteIds } = await fixtureUsage();
  const temporary = await mkdtemp(path.join(tmpdir(), "deherm-reachability-"));
  const usagePath = path.join(temporary, "defold-api-usage.json");
  const output = path.join(temporary, "release");
  try {
    await writeFile(usagePath, `${JSON.stringify(document, null, 2)}\n`);
    const result = await generateReleaseBuild(["--output-root", output, "--defold-usage", usagePath]);
    const reachability = result.projection.canonicalDefoldApi.reachability;
    assert.equal(reachability.authority, "ttsc-checker-symbol-resolution");
    assert.equal(reachability.crossCheck, "agree");
    assert.deepEqual(reachability.reachableRouteIds, [...checkerRouteIds].sort());
    assert.equal(reachability.emittedRouteCount, checkerRouteIds.length);

    // The whole point: a real program's release surface is a small fraction of
    // the 913 emittable routes, not all of them.
    const emission = JSON.parse(await readFile(path.join(output, "defold-binding-emission-plan.json"), "utf8"));
    assert.equal(emission.treeShaking.selectedForEmissionUnits, checkerRouteIds.length);
    assert.ok(checkerRouteIds.length < 20);
    assert.equal(emission.usage.authority, "ttsc-checker-symbol-resolution");
    assert.equal(emission.usage.crossCheck, "agree");

    // Dead-symbol retention over the generated route tables and registry: an
    // unreachable route's stable ID must be absent, not merely disabled.
    const registry = await readFile(path.join(output, "canonical/dynamicHermesJsi/src/registry.cpp"), "utf8");
    const hex = (routeId) => `0x${index.members[memberByRouteId.get(routeId)].stableId.toString(16).padStart(8, "0")}`;
    const reached = new Set(checkerRouteIds);
    for (const route of Object.values(index.members)) {
      const literal = hex(route.id);
      if (reached.has(route.id)) assert.match(registry, new RegExp(literal));
      else assert.doesNotMatch(registry, new RegExp(literal),
        `${route.id} is unreachable but its stable ID is retained in the release registry`);
    }

    // The CMake input list is the same set: nothing unreachable can even be
    // handed to the compiler.
    const sources = await readFile(path.join(output, "canonical/dynamicHermesJsi/sources.cmake"), "utf8");
    const manifest = JSON.parse(await readFile(
      path.join(output, "canonical/dynamicHermesJsi/manifest.json"), "utf8"));
    assert.equal(manifest.routeCount, checkerRouteIds.length);
    for (const group of manifest.groups) assert.match(sources, new RegExp(group.source.replace(/[/.]/g, "\\$&")));
    assert.equal(sources.split("\n").filter((line) => line.includes("/src/family-")).length, manifest.groupCount);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("the typed-native lane and its emitted C carry only reachable symbols", async (t) => {
  const vmathReport = await json("packages/bindings/generated/defold-static-hermes-vmath.json");
  const projection = generateTypedNativeProjection({
    vmathReport,
    // The fixture calls vmath.vector3/vector4 but none of the typed-native
    // scalar routes except length.
    reachableRouteIds: ["script:vmath.length"],
    target: "staticHermesCAbi"
  });
  assert.deepEqual(projection.manifest.retainedRouteIds, ["script:vmath.length"]);
  assert.deepEqual(projection.manifest.prunedRouteIds, ["script:vmath.length_sqr", "script:vmath.project"]);
  const source = projection.artifacts.get("canonical/staticHermesCAbi/typed-native/script-vmath.ts");
  for (const symbol of projection.manifest.retainedSymbols) assert.match(source, new RegExp(symbol));
  for (const symbol of projection.manifest.prunedSymbols) {
    assert.doesNotMatch(source, new RegExp(symbol),
      `${symbol} is unreachable but survives into the typed-native lane`);
  }

  const shermes = path.join(root, "build/native/bin/shermes");
  if (!existsSync(shermes)) {
    t.skip("shermes is not built; the emitted-C gate needs `cmake --build build/native --target shermes`");
    return;
  }
  const temporary = await mkdtemp(path.join(tmpdir(), "deherm-emit-c-"));
  try {
    const probe = '\nconst __report = $SHBuiltin.extern_c({include: "defold_hermes/static_probe.h"},' +
      " function defold_hermes_static_vmath_report(stage: c_u32, value: c_f64): void { throw 0; });\n" +
      "__report(1, vmathLengthVector3(3, 4, 12));\n";
    const prunedInput = path.join(temporary, "pruned.ts");
    const prunedOutput = path.join(temporary, "pruned.c");
    await writeFile(prunedInput, `${source}${probe}`);
    execFileSync(shermes, [
      "-fno-std-globals", "-typed", "-strict", "-O", "-emit-c",
      "-exported-unit=deherm_static_vmath", prunedInput, "-o", prunedOutput
    ], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    const emitted = await readFile(prunedOutput, "utf8");
    assert.match(emitted, /deherm_static_vmath_8d4b1f66_length_vector3/);
    for (const symbol of projection.manifest.prunedSymbols) {
      assert.doesNotMatch(emitted, new RegExp(symbol),
        `${symbol} is unreachable but appears in the emitted C`);
    }

    // The gate is not vacuous: the complete lane emits exactly those symbols.
    const fullInput = path.join(temporary, "full.ts");
    const fullOutput = path.join(temporary, "full.c");
    const fullSource = await readFile(path.join(root, "packages/static-hermes/src/generated/script-vmath.ts"), "utf8");
    await writeFile(fullInput, `${fullSource}${probe}` +
      "__report(2, vmathProjectVector3Vector3(2, 4, 6, 1, 2, 3));\n" +
      "__report(3, vmathLengthSqrVector3(3, 4, 12));\n");
    execFileSync(shermes, [
      "-fno-std-globals", "-typed", "-strict", "-O", "-emit-c",
      "-exported-unit=deherm_static_vmath", fullInput, "-o", fullOutput
    ], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    const fullEmitted = await readFile(fullOutput, "utf8");
    assert.match(fullEmitted, /deherm_static_vmath_a027f373_project_vector3_vector3/);
    assert.match(fullEmitted, /deherm_static_vmath_b1bb687b_length_sqr_vector3/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
