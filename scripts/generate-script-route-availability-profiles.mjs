#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { stableBindingId } from "./lib/binding-identity.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const defaultPolicy = "packages/bindings/overrides/script-route-availability-profiles.json";
const defaultBorrowed = "packages/bindings/generated/defold-script-borrowed-handle-classification.json";
const defaultScriptIr = "packages/bindings/generated/defold-script-api-ir.json";
const defaultOutput = "packages/bindings/generated/defold-script-route-availability-profiles.json";
const featureBits = { core: 1, "box2d-v2": 2, "box2d-v3": 4, bullet3d: 8 };

function fail(message) {
  throw new Error(`script route availability: ${message}`);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseArgs(argv) {
  const options = { check: false, outRoot: repositoryRoot, policy: defaultPolicy, borrowed: defaultBorrowed, scriptIr: defaultScriptIr };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") options.check = true;
    else if (argument === "--out-root") options.outRoot = resolve(argv[++index]);
    else if (argument === "--policy") options.policy = argv[++index];
    else if (argument === "--borrowed") options.borrowed = argv[++index];
    else if (argument === "--script-ir") options.scriptIr = argv[++index];
    else fail(`unknown argument '${argument}'`);
  }
  return options;
}

function inputPath(path) {
  return isAbsolute(path) ? path : join(repositoryRoot, path);
}

async function loadJson(path, label) {
  const text = await readFile(inputPath(path), "utf8");
  try {
    return { text, value: JSON.parse(text) };
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`);
  }
}

function registrationNames(text, array, sourcePath) {
  const escaped = array.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`static\\s+const\\s+luaL_(?:reg|Reg)\\s+${escaped}\\s*\\[\\s*\\]\\s*=\\s*\\{([\\s\\S]*?)\\n\\s*\\};`));
  assert(match, `${sourcePath}: registration array '${array}' was not found`);
  const body = match[1].replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const names = [...body.matchAll(/\{\s*"([^"]+)"\s*,\s*[^}]+\}/g)].map((entry) => entry[1]);
  assert(names.length > 0, `${sourcePath}: registration array '${array}' is empty`);
  assert(new Set(names).size === names.length, `${sourcePath}: registration array '${array}' contains duplicate names`);
  return names;
}

function manifestListValues(text, field) {
  const values = [];
  const expression = new RegExp(`${field}\\s*:\\s*\\[([^\\]]*)\\]`, "g");
  for (const match of text.matchAll(expression)) {
    for (const raw of match[1].split(",")) {
      const value = raw.trim().replace(/^['"]|['"]$/g, "");
      if (value) values.push(value.replace(/\.lib$/i, "").replace(/^lib(?=(?:box2d|Bullet|LinearMath))/, ""));
    }
  }
  return [...new Set(values)].sort(compareText);
}

function featuresFromManifest(text) {
  const excludedLibraries = manifestListValues(text, "excludeLibs");
  const linkedLibraries = manifestListValues(text, "libs");
  const excluded = new Set(excludedLibraries);
  const linked = new Set(linkedLibraries);
  const noPhysics = linked.has("physics_null");
  const noBox2d = noPhysics || (excluded.has("script_box2d") && excluded.has("script_box2d_defold"));
  const v3 = !noBox2d && linked.has("script_box2d") && excluded.has("script_box2d_defold");
  const bullet = !noPhysics && !excluded.has("BulletDynamics") && !excluded.has("BulletCollision");
  return {
    features: ["core", ...(!noBox2d ? [v3 ? "box2d-v3" : "box2d-v2"] : []), ...(bullet ? ["bullet3d"] : [])],
    excludedLibraries,
    linkedLibraries
  };
}

async function validateEvidence(evidence, kind) {
  const textByPath = new Map();
  for (const item of evidence) {
    let text = textByPath.get(item.path);
    if (text === undefined) {
      text = await readFile(inputPath(item.path), "utf8");
      textByPath.set(item.path, text);
    }
    assert(sha256(text) === item.sha256, `${kind} hash drifted for ${item.path}`);
    for (const anchor of item.anchors ?? []) {
      assert(text.includes(anchor), `${kind} anchor '${anchor}' drifted in ${item.path}`);
    }
  }
  return textByPath;
}

function routeRow(row) {
  return {
    id: row.id,
    stableId: row.stableId,
    rawName: row.rawName,
    operationClass: row.operationClass,
    requiredContext: row.requiredContext
  };
}

function scriptRouteRow(row) {
  return {
    id: row.id,
    stableId: stableBindingId(row.id),
    rawName: row.rawName,
    source: row.source,
    line: row.line
  };
}

function routeSetSha256(rows) {
  return sha256(JSON.stringify(rows.map(({ stableId }) => stableId)));
}

async function generate(options) {
  const policyInput = await loadJson(options.policy, "availability policy");
  const borrowedInput = await loadJson(options.borrowed, "borrowed-handle classification");
  const scriptIrInput = await loadJson(options.scriptIr, "script API IR");
  const policy = policyInput.value;
  const borrowed = borrowedInput.value;
  const scriptIr = scriptIrInput.value;

  assert(policy.schemaVersion === 1, "unsupported policy schema");
  assert(borrowed.defoldRevision === policy.defoldRevision, "Defold revision differs between policy and borrowed-handle classification");
  assert(Array.isArray(borrowed.rows), "borrowed-handle classification has no rows");
  assert(scriptIr.defoldRevision === policy.defoldRevision, "Defold revision differs between policy and script API IR");
  assert(Array.isArray(scriptIr.functions), "script API IR has no functions");
  const documentedNames = new Set(scriptIr.functions.map(({ rawName }) => rawName));
  const scriptRowsByRawName = new Map(scriptIr.functions.map((row) => [row.rawName, scriptRouteRow(row)]));
  assert(scriptRowsByRawName.size === scriptIr.functions.length, "script API IR contains duplicate raw names");

  const rowsByRawName = new Map();
  const rowsByStableId = new Map();
  for (const row of borrowed.rows) {
    assert(!rowsByRawName.has(row.rawName), `duplicate borrowed route '${row.rawName}'`);
    assert(Number.isInteger(row.stableId) && row.stableId >= 0, `${row.id}: invalid stable ID`);
    assert(!rowsByStableId.has(row.stableId), `${row.id}: duplicate stable ID ${row.stableId}`);
    rowsByRawName.set(row.rawName, row);
    rowsByStableId.set(row.stableId, row);
  }

  const buildTexts = await validateEvidence(policy.buildEvidence, "build evidence");
  const manifestEntries = Object.entries(policy.manifests).map(([id, value]) => ({ id, ...value }));
  const manifestTexts = await validateEvidence(manifestEntries, "app manifest");
  const manifestAudit = [];
  for (const manifest of manifestEntries) {
    const parsed = featuresFromManifest(manifestTexts.get(manifest.path));
    assert(JSON.stringify(parsed.features) === JSON.stringify(manifest.features),
      `${manifest.id}: parsed manifest features ${parsed.features.join(",")} differ from policy ${manifest.features.join(",")}`);
    manifestAudit.push({ id: manifest.id, ...parsed });
  }
  const registrationTexts = await validateEvidence(policy.registrations, "Lua registration source");

  const unavailableByFeature = new Map();
  const unavailableScriptRoutesByFeature = new Map();
  for (const exception of policy.documentedButUnregistered) {
    const row = rowsByStableId.get(exception.stableId);
    assert(row?.id === exception.id, `${exception.id}: documented/unregistered stable ID drifted`);
    assert(row.rawName.startsWith("b2d."), `${exception.id}: documented/unregistered route is outside Box2D`);
    const source = registrationTexts.get(exception.source);
    assert(source?.includes(exception.anchor), `${exception.id}: commented registration evidence drifted`);
    const exceptions = unavailableByFeature.get(exception.feature) ?? [];
    unavailableByFeature.set(exception.feature, [...exceptions, { ...routeRow(row), reason: exception.reason }]);
    const scriptRoute = scriptRowsByRawName.get(row.rawName);
    assert(scriptRoute?.id === exception.id, `${exception.id}: documented/unregistered script IR identity drifted`);
    const scriptExceptions = unavailableScriptRoutesByFeature.get(exception.feature) ?? [];
    unavailableScriptRoutesByFeature.set(exception.feature, [...scriptExceptions, { ...scriptRoute, reason: exception.reason }]);
  }

  const registrations = new Map();
  for (const spec of policy.registrations) {
    const text = registrationTexts.get(spec.path);
    const names = registrationNames(text, spec.array, spec.path);
    const fullNames = names.map((name) => `${spec.namespace}.${name}`);
    const key = `${spec.feature}:${spec.namespace}`;
    const existing = registrations.get(key) ?? [];
    registrations.set(key, [...existing, ...fullNames]);
  }

  const availableFeatureRows = {};
  const documentedFeatureRows = {};
  const availableRouteFeatureRows = {};
  const documentedRouteFeatureRows = {};
  const registrationAudit = [];
  for (const feature of Object.keys(policy.expectedFeatureCounts)) {
    const registeredNames = [...registrations.entries()]
      .filter(([key]) => key.startsWith(`${feature}:`))
      .flatMap(([, names]) => names);
    assert(new Set(registeredNames).size === registeredNames.length, `${feature}: duplicate fully-qualified Lua registrations`);
    const matchingRows = registeredNames
      .map((rawName) => rowsByRawName.get(rawName))
      .filter(Boolean)
      .filter((row) => row.operationClass !== "declaration-token")
      .sort((left, right) => left.stableId - right.stableId);
    const registeredDocumentedNames = registeredNames.filter((rawName) => documentedNames.has(rawName));
    const registrationOnlyNames = registeredNames.filter((rawName) => !documentedNames.has(rawName)).sort(compareText);
    assert(registeredDocumentedNames.length === policy.expectedRegisteredDocumentedCounts[feature],
      `${feature}: expected ${policy.expectedRegisteredDocumentedCounts[feature]} registered documented routes, found ${registeredDocumentedNames.length}`);
    assert(registrationOnlyNames.length === policy.expectedRegistrationOnlyCounts[feature],
      `${feature}: expected ${policy.expectedRegistrationOnlyCounts[feature]} registration-only routes, found ${registrationOnlyNames.length}`);
    const relevantPrefix = feature.startsWith("box2d-") ? "b2d." : feature === "bullet3d" ? "bullet3d." : null;
    const unmatched = relevantPrefix === null ? [] : borrowed.rows
      .filter((row) => row.rawName.startsWith(relevantPrefix) && !registeredNames.includes(row.rawName))
      .map((row) => row.rawName)
      .sort(compareText);
    assert(matchingRows.length === policy.expectedAvailableFeatureCounts[feature],
      `${feature}: expected ${policy.expectedAvailableFeatureCounts[feature]} registered handle routes, found ${matchingRows.length}; unregistered candidates: ${unmatched.join(", ")}`);
    const reviewedUnavailable = unavailableByFeature.get(feature) ?? [];
    for (const row of reviewedUnavailable) {
      assert(!registeredNames.includes(row.rawName), `${row.id}: reviewed unavailable route is now registered`);
    }
    const documentedRows = [...matchingRows.map(routeRow), ...reviewedUnavailable]
      .sort((left, right) => left.stableId - right.stableId);
    assert(documentedRows.length === policy.expectedFeatureCounts[feature],
      `${feature}: expected ${policy.expectedFeatureCounts[feature]} documented handle routes, found ${documentedRows.length}`);
    availableFeatureRows[feature] = matchingRows.map(routeRow);
    documentedFeatureRows[feature] = documentedRows;
    const availableScriptRows = registeredDocumentedNames
      .map((rawName) => scriptRowsByRawName.get(rawName))
      .sort((left, right) => left.stableId - right.stableId);
    const documentedScriptRows = [
      ...availableScriptRows,
      ...(unavailableScriptRoutesByFeature.get(feature) ?? [])
    ].sort((left, right) => left.stableId - right.stableId);
    assert(availableScriptRows.length === policy.expectedAvailableRouteFeatureCounts[feature],
      `${feature}: expected ${policy.expectedAvailableRouteFeatureCounts[feature]} registered script routes, found ${availableScriptRows.length}`);
    assert(documentedScriptRows.length === policy.expectedRouteFeatureCounts[feature],
      `${feature}: expected ${policy.expectedRouteFeatureCounts[feature]} documented script routes, found ${documentedScriptRows.length}`);
    availableRouteFeatureRows[feature] = availableScriptRows;
    documentedRouteFeatureRows[feature] = documentedScriptRows;
    registrationAudit.push({
      feature,
      registeredFunctionCount: registeredNames.length,
      matchedHandleRouteCount: matchingRows.length,
      registeredNamesSha256: sha256(JSON.stringify([...registeredNames].sort(compareText))),
      matchedStableIdsSha256: routeSetSha256(matchingRows),
      documentedButUnregisteredCount: reviewedUnavailable.length,
      registeredDocumentedRouteCount: registeredDocumentedNames.length,
      registrationOnlyRouteCount: registrationOnlyNames.length,
      registrationOnlyNames
    });
  }

  const expectedB2d = borrowed.rows.filter((row) => row.rawName.startsWith("b2d."));
  const b2dUnion = new Set([...documentedFeatureRows["box2d-v2"], ...documentedFeatureRows["box2d-v3"]].map(({ stableId }) => stableId));
  assert(b2dUnion.size === expectedB2d.length && expectedB2d.every(({ stableId }) => b2dUnion.has(stableId)),
    "Box2D v2/v3 registration union does not cover the borrowed-handle Box2D census");
  const expectedBullet = borrowed.rows.filter((row) => row.rawName.startsWith("bullet3d."));
  assert(documentedFeatureRows.bullet3d.length === expectedBullet.length, "Bullet registrations do not cover the borrowed-handle Bullet census");
  const coreExpected = borrowed.rows.filter((row) =>
    row.operationClass !== "declaration-token" && /^(buffer|resource|sys)\./.test(row.rawName));
  assert(documentedFeatureRows.core.length === coreExpected.length, "core registrations do not cover the runtime global handle census");

  const profiles = {};
  const routeProfiles = {};
  for (const manifest of manifestEntries) {
    assert(manifest.features[0] === "core", `${manifest.id}: core must be the first feature`);
    assert(!(manifest.features.includes("box2d-v2") && manifest.features.includes("box2d-v3")),
      `${manifest.id}: mutually exclusive Box2D versions were selected together`);
    const selectedDocumented = manifest.features.flatMap((feature) => {
      assert(documentedFeatureRows[feature], `${manifest.id}: unknown feature '${feature}'`);
      return documentedFeatureRows[feature];
    });
    const selectedAvailable = manifest.features.flatMap((feature) => availableFeatureRows[feature]);
    const documentedRoutes = [...new Map(selectedDocumented.map((row) => [row.stableId, row])).values()]
      .sort((left, right) => left.stableId - right.stableId);
    const availableRoutes = [...new Map(selectedAvailable.map((row) => [row.stableId, row])).values()]
      .sort((left, right) => left.stableId - right.stableId);
    const unavailableIds = new Set(availableRoutes.map(({ stableId }) => stableId));
    const unavailableRoutes = documentedRoutes.filter(({ stableId }) => !unavailableIds.has(stableId));
    const expectedCount = policy.expectedProfileCounts[manifest.id];
    const expectedRuntimeCount = policy.expectedRuntimeProfileCounts[manifest.id];
    assert(documentedRoutes.length === expectedCount,
      `${manifest.id}: expected ${expectedCount} documented routes, found ${documentedRoutes.length}`);
    assert(availableRoutes.length === expectedRuntimeCount,
      `${manifest.id}: expected ${expectedRuntimeCount} runtime routes, found ${availableRoutes.length}`);
    const routeHash = routeSetSha256(availableRoutes);
    profiles[manifest.id] = {
      manifest: manifest.path,
      manifestSha256: manifest.sha256,
      features: manifest.features,
      documentedRouteCount: documentedRoutes.length,
      availableRouteCount: availableRoutes.length,
      documentedRoutes,
      availableRoutes,
      unavailableRoutes,
      runtimeHandshake: {
        schema: "deherm.script-route-capabilities/v1",
        profileId: manifest.id,
        defoldRevision: policy.defoldRevision,
        capabilityBits: manifest.features.reduce((bits, feature) => bits | featureBits[feature], 0),
        routeCount: availableRoutes.length,
        routeSetSha256: routeHash
      }
    };

    const selectedDocumentedRoutes = manifest.features.flatMap((feature) => documentedRouteFeatureRows[feature]);
    const selectedAvailableRoutes = manifest.features.flatMap((feature) => availableRouteFeatureRows[feature]);
    const routeDocumented = [...new Map(selectedDocumentedRoutes.map((row) => [row.stableId, row])).values()]
      .sort((left, right) => left.stableId - right.stableId);
    const routeAvailable = [...new Map(selectedAvailableRoutes.map((row) => [row.stableId, row])).values()]
      .sort((left, right) => left.stableId - right.stableId);
    assert(routeDocumented.length === policy.expectedRouteProfileCounts[manifest.id],
      `${manifest.id}: expected ${policy.expectedRouteProfileCounts[manifest.id]} documented script routes, found ${routeDocumented.length}`);
    assert(routeAvailable.length === policy.expectedRuntimeRouteProfileCounts[manifest.id],
      `${manifest.id}: expected ${policy.expectedRuntimeRouteProfileCounts[manifest.id]} registered script routes, found ${routeAvailable.length}`);
    const routeAvailableIds = new Set(routeAvailable.map(({ stableId }) => stableId));
    routeProfiles[manifest.id] = {
      manifest: manifest.path,
      manifestSha256: manifest.sha256,
      features: manifest.features,
      documentedRouteCount: routeDocumented.length,
      availableRouteCount: routeAvailable.length,
      documentedRoutes: routeDocumented,
      availableRoutes: routeAvailable,
      unavailableRoutes: routeDocumented.filter(({ stableId }) => !routeAvailableIds.has(stableId))
    };
  }

  assert(Object.keys(profiles).sort(compareText).join("\n") === Object.keys(policy.expectedProfileCounts).sort(compareText).join("\n"),
    "profile expectations and manifest evidence differ");

  const catalogMaterial = {
    defoldRevision: policy.defoldRevision,
    profiles: Object.fromEntries(Object.entries(routeProfiles).map(([id, profile]) => [id, {
      features: profile.features,
      capabilityBits: profiles[id].runtimeHandshake.capabilityBits,
      routeSetSha256: routeSetSha256(profile.availableRoutes)
    }]))
  };
  const catalogSha256 = sha256(JSON.stringify(catalogMaterial));
  for (const [id, profile] of Object.entries(routeProfiles)) {
    profile.runtimeHandshake = {
      schema: "deherm.script-route-capabilities/v1",
      profileId: id,
      defoldRevision: policy.defoldRevision,
      capabilityBits: profiles[id].runtimeHandshake.capabilityBits,
      routeCount: profile.availableRouteCount,
      routeSetSha256: routeSetSha256(profile.availableRoutes),
      catalogSha256
    };
  }

  const sourceHashes = Object.fromEntries([...new Map([
    ...policy.buildEvidence.map(({ path, sha256: hash }) => [path, hash]),
    ...manifestEntries.map(({ path, sha256: hash }) => [path, hash]),
    ...policy.registrations.map(({ path, sha256: hash }) => [path, hash])
  ])].sort(([left], [right]) => compareText(left, right)));

  const report = {
    schemaVersion: 1,
    defoldRevision: policy.defoldRevision,
    catalogSha256,
    inputEvidence: {
      policy: options.policy,
      policySha256: sha256(policyInput.text),
      borrowedClassification: options.borrowed,
      borrowedClassificationSha256: sha256(borrowedInput.text),
      scriptIr: options.scriptIr,
      scriptIrSha256: sha256(scriptIrInput.text),
      sourceHashes
    },
    handshakeContract: {
      schema: "deherm.script-route-capabilities/v1",
      requiredFields: ["schema", "profileId", "defoldRevision", "capabilityBits", "routeCount", "routeSetSha256", "catalogSha256"],
      acceptance: "All fields must exactly match the selected generated profile before route installation. Unknown bits, IDs, revisions, route sets, and catalog hashes fail closed."
    },
    registrationAudit,
    manifestAudit,
    handleFeatures: Object.fromEntries(Object.entries(documentedFeatureRows).map(([id, documentedRoutes]) => [id, {
      capabilityBit: featureBits[id],
      documentedRouteCount: documentedRoutes.length,
      availableRouteCount: availableFeatureRows[id].length,
      documentedRouteSetSha256: routeSetSha256(documentedRoutes),
      availableRouteSetSha256: routeSetSha256(availableFeatureRows[id]),
      documentedRoutes,
      availableRoutes: availableFeatureRows[id],
      unavailableRoutes: documentedRoutes.filter(({ stableId }) =>
        !availableFeatureRows[id].some((available) => available.stableId === stableId))
    }])),
    handleProfiles: Object.fromEntries(Object.entries(profiles).map(([id, profile]) => [id, {
      manifest: profile.manifest,
      manifestSha256: profile.manifestSha256,
      features: profile.features,
      documentedRouteCount: profile.documentedRouteCount,
      availableRouteCount: profile.availableRouteCount,
      documentedRoutes: profile.documentedRoutes,
      availableRoutes: profile.availableRoutes,
      unavailableRoutes: profile.unavailableRoutes
    }])),
    features: Object.fromEntries(Object.entries(documentedRouteFeatureRows).map(([id, documentedRoutes]) => [id, {
      capabilityBit: featureBits[id],
      documentedRouteCount: documentedRoutes.length,
      availableRouteCount: availableRouteFeatureRows[id].length,
      documentedRouteSetSha256: routeSetSha256(documentedRoutes),
      availableRouteSetSha256: routeSetSha256(availableRouteFeatureRows[id]),
      documentedRoutes,
      availableRoutes: availableRouteFeatureRows[id],
      unavailableRoutes: documentedRoutes.filter(({ stableId }) =>
        !availableRouteFeatureRows[id].some((available) => available.stableId === stableId))
    }])),
    profiles: routeProfiles
  };

  // Keep evidence reads live so removing either build pin is generator-visible.
  assert(buildTexts.size === policy.buildEvidence.length, "build evidence paths are not unique");
  return `${JSON.stringify(report, null, 2)}\n`;
}

const options = parseArgs(process.argv.slice(2));
const output = await generate(options);
const destination = join(options.outRoot, defaultOutput);
if (options.check) {
  const current = await readFile(destination, "utf8");
  assert(current === output, `${defaultOutput} is stale; regenerate it`);
} else {
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, output);
}
