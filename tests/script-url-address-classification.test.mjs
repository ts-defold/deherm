import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  generateScriptUrlAddressClassification,
  loadScriptUrlAddressInputs
} from "../scripts/generate-script-url-address-classification.mjs";

const root = new URL("../", import.meta.url);
const sourceInputs = await loadScriptUrlAddressInputs();
const generated = generateScriptUrlAddressClassification(sourceInputs);

test("classifies the exact 70-route URL/address frontier without overlapping Matrix4", async () => {
  assert.equal(generated.routeCount, 70);
  assert.equal(generated.urlParameterCount, 73);
  assert.deepEqual(generated.moduleCounts, {
    camera: 19,
    collectionfactory: 3,
    factory: 3,
    go: 15,
    label: 2,
    model: 5,
    particlefx: 2,
    physics: 11,
    sound: 3,
    sprite: 3,
    tilemap: 4
  });
  assert.deepEqual(generated.rawUrlParameterTypeCounts, {
    "string|hash|url": 54,
    "url|number|nil": 19
  });
  assert.deepEqual(generated.disjointCensus, {
    classifiedDefoldValue: 127,
    matrix4Disjoint: 20,
    urlCandidates: 73,
    excludedPreexistingUrl: 3,
    urlAddressRoutes: 70,
    nonMatrixNonUrl: 34,
    binaryStringRemainder: 2,
    otherNonMatrixNonUrl: 32
  });
  assert.ok(generated.rows.every(({ routing, targetSupport }) =>
    routing.status === "generated-native-dynamic" &&
    targetSupport.nativeDynamicHermes.status === "generated-executable" &&
    targetSupport.nativeStaticHermes.status === "fail-closed-unverified" &&
    targetSupport.html5BrowserHost.status === "fail-closed-unverified"));
  assert.match(generated.coverageClaim, /generated stable-ID descriptors/);
});

test("keeps full URLs distinct from context-sensitive string and hash shorthand", () => {
  const camera = generated.rows.find(({ id }) => id === "script:camera.get_aspect_ratio");
  assert.deepEqual(camera.urlParameters[0].forms, ["full-url", "numeric-camera-id", "nil-default"]);
  const physics = generated.rows.find(({ id }) => id === "script:physics.set_group");
  assert.deepEqual(physics.urlParameters[0].forms, ["string-shorthand", "hash-shorthand", "full-url"]);
  assert.match(generated.representationPolicy.fullUrl, /four exact uint64 lanes/);
  assert.match(generated.representationPolicy.stringShorthand, /captured Lua caller context/);
  assert.match(generated.representationPolicy.collapsedLegacyUrl, /fail-closed/);
});

test("fails closed on route, shape, partition, and pinned-source drift", () => {
  const routeDrift = structuredClone(sourceInputs);
  const patternsForRoute = JSON.parse(routeDrift.patternsText);
  patternsForRoute.bindings.find(({ id }) => id === "script:physics.set_group").loweringFamily = "lua-table";
  routeDrift.patternsText = `${JSON.stringify(patternsForRoute, null, 2)}\n`;
  assert.throws(() => generateScriptUrlAddressClassification(routeDrift), /census drifted|route count drifted/);

  const shapeDrift = structuredClone(sourceInputs);
  const ir = JSON.parse(shapeDrift.irText);
  ir.functions.find(({ id }) => id === "script:physics.set_group").parameters[0].rawType = "url|string";
  shapeDrift.irText = `${JSON.stringify(ir, null, 2)}\n`;
  assert.throws(() => generateScriptUrlAddressClassification(shapeDrift), /binding-pattern shapes differ/);

  const sourceDrift = structuredClone(sourceInputs);
  const [sourcePath, sourceText] = sourceDrift.sourceTexts.entries().next().value;
  sourceDrift.sourceTexts.set(sourcePath, `${sourceText}\n// drift\n`);
  assert.throws(() => generateScriptUrlAddressClassification(sourceDrift), /source hash is stale/);
});

test("generated runtime uses explicit URL branding and preserves the nonzero reserved lane", async () => {
  const [jsi, address] = await Promise.all([
    readFile(new URL("../defold/defold_hermes/src/script_jsi_bridge.cpp", import.meta.url), "utf8"),
    readFile(new URL("../packages/sdk/src/address.ts", import.meta.url), "utf8")
  ]);
  assert.match(jsi, /kDefoldUrlProperty = "__dehermUrlV1"/);
  assert.match(jsi, /"reserved".*url\.reserved/s);
  assert.match(jsi, /setProperty\(runtime, kDefoldUrlProperty, true\)/);
  assert.match(address, /readonly __dehermUrlV1: true/);
  assert.match(address, /readonly reserved: DefoldHash/);
});

test("regenerates the classification byte-identically in a temporary output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deherm-url-classifier-"));
  try {
    const temporary = join(directory, "classification.json");
    execFileSync(process.execPath, [
      "scripts/generate-script-url-address-classification.mjs", "--output", temporary
    ], { cwd: root, stdio: "pipe" });
    assert.equal(await readFile(temporary, "utf8"), await readFile(
      new URL("packages/bindings/generated/defold-script-url-address-classification.json", root), "utf8"));
    execFileSync(process.execPath, ["scripts/generate-script-url-address-classification.mjs", "--check"], {
      cwd: root,
      stdio: "pipe"
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("native URL arena proves pinned layout, exact bits, reentrancy, exhaustion, and stale rejection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deherm-url-arena-"));
  try {
    const executable = join(directory, "script-url-arena-test");
    execFileSync(process.env.CXX || "clang++", [
      "-std=c++17", "-Wall", "-Wextra", "-Werror", "-Wno-zero-length-array", "-pedantic",
      "-Idefold/defold_hermes/include", "-Iupstream/defold/engine/dlib/src",
      "native/script_url_arena_test.cpp", "-o", executable
    ], { cwd: root, stdio: "pipe" });
    assert.equal(execFileSync(executable, [], { encoding: "utf8" }).trim(),
      "script-url-arena:ok allocations:0");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
