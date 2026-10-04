import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  generateScriptUrlAddressClassification,
  loadScriptUrlAddressInputs,
  renderScriptUrlAddressRuntime,
  scriptUrlBindingRecipeFacts,
} from "../scripts/generate-script-url-address-classification.mjs";
import { renderScriptUrlNativeOutputs } from "../packages/compiler/src/script-url-output-emitter.mjs";

const root = new URL("../", import.meta.url);
const sourceInputs = await loadScriptUrlAddressInputs();
const generated = generateScriptUrlAddressClassification(sourceInputs);

async function runGeneratedDispatchProbe(report, expectedStatus) {
  const directory = await mkdtemp(join(tmpdir(), "deherm-url-dispatch-"));
  try {
    const includeDirectory = join(directory, "defold_hermes");
    await mkdir(includeDirectory);
    const runtime = renderScriptUrlAddressRuntime(report);
    const source = join(directory, "generated_script_url_bindings.cpp");
    const harness = join(directory, "probe.cpp");
    const executable = join(directory, "probe");
    await Promise.all([
      writeFile(join(includeDirectory, "generated_script_url_bindings.hpp"), runtime.header),
      writeFile(source, runtime.source),
      writeFile(
        harness,
        `#include <defold_hermes/generated_script_url_bindings.hpp>\n` +
          `int main() {\n` +
          `  namespace url = defold_hermes::url_binding;\n` +
          `  defold_hermes::ScriptCallFrame frame{};\n` +
          `  frame.stableId = url::operations()[0].stableId;\n` +
          `  frame.argumentCount = static_cast<uint32_t>(url::operations()[0].maximumArgumentCount) + 1u;\n` +
          `  return url::dispatch(&frame, nullptr, 0, nullptr) == url::DispatchStatus::${expectedStatus} ? 0 : 1;\n` +
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
        "-Wno-zero-length-array",
        "-pedantic",
        `-I${directory}`,
        "-Idefold/defold_hermes/include",
        "-Iupstream/defold/engine/dlib/src",
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

test("classifies the exact 70-route URL/address frontier without overlapping Matrix4", async () => {
  assert.equal(generated.routeCount, 70);
  assert.equal(generated.optimizedRouteCount, 70);
  assert.equal(generated.universalFallbackRouteCount, 0);
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
    tilemap: 4,
  });
  assert.deepEqual(generated.rawUrlParameterTypeCounts, {
    "string|hash|url": 54,
    "url|number|nil": 19,
  });
  assert.deepEqual(generated.disjointCensus, {
    classifiedDefoldValue: 127,
    matrix4Disjoint: 20,
    urlCandidates: 73,
    excludedPreexistingUrl: 3,
    urlAddressRoutes: 70,
    nonMatrixNonUrl: 34,
    binaryStringRemainder: 2,
    otherNonMatrixNonUrl: 32,
  });
  assert.ok(
    generated.rows.every(
      ({ routing, targetSupport }) =>
        routing.status === "generated-native-dynamic" &&
        targetSupport.nativeDynamicHermes.status === "generated-executable" &&
        targetSupport.nativeStaticHermes.status === "fail-closed-unverified" &&
        targetSupport.html5BrowserHost.status === "fail-closed-unverified",
    ),
  );
  assert.match(generated.coverageClaim, /generated stable-ID descriptors/);
  assert.deepEqual(generated.optimizationEvidence, {
    requiredSourceEvidence: ["dm-message-url-layout", "dm-script-public-url-api"],
    availableSourceEvidence: ["dm-message-url-layout", "dm-script-public-url-api"],
    missingSourceEvidence: [],
    executionContext: "captured-game-object-script-instance",
    codecProof: "exact-script-ir-and-binding-pattern-agreement",
    ownership: "ToURL-result-copied-before-Lua-pop-into-frame-local-generation-checked-ScriptUrlArena",
  });
});

test("private URL resolver renames do not affect replay generation", () => {
  const renamedPrivateImplementation = structuredClone(sourceInputs);
  renamedPrivateImplementation.sourceTexts.set(
    "engine/script/src/script_msg.cpp",
    "private implementation renamed from ResolveURL to ResolveAddress",
  );
  assert.deepEqual(generateScriptUrlAddressClassification(renamedPrivateImplementation), generated);
  assert.ok(
    !generated.inputEvidence.defoldSources.some(({ path }) => path.endsWith("/script_msg.cpp")),
    "private URL implementation leaked into replay evidence",
  );
});

test("withdrawing public URL ABI or captured-context evidence preserves 70 universal fallbacks", async () => {
  const override = JSON.parse(sourceInputs.overrideText);
  const layoutSource = override.sourceEvidence.find(({ id }) => id === "dm-message-url-layout").source;
  const publicApiSource = override.sourceEvidence.find(({ id }) => id === "dm-script-public-url-api").source;

  const missingLayout = structuredClone(sourceInputs);
  missingLayout.withdrawnSources = new Set([layoutSource]);
  const layoutReport = generateScriptUrlAddressClassification(missingLayout);
  assert.equal(layoutReport.routeCount, 70);
  assert.equal(layoutReport.optimizedRouteCount, 0);
  assert.equal(layoutReport.universalFallbackRouteCount, 70);
  assert.deepEqual(layoutReport.optimizationEvidence.missingSourceEvidence, ["dm-message-url-layout"]);
  assert.ok(layoutReport.rows.every(({ optimizationProven }) => !optimizationProven));

  const missingPublicApi = structuredClone(sourceInputs);
  missingPublicApi.withdrawnSources = new Set([publicApiSource]);
  const contextReport = generateScriptUrlAddressClassification(missingPublicApi);
  assert.equal(contextReport.optimizedRouteCount, 0);
  assert.equal(contextReport.universalFallbackRouteCount, 70);
  assert.deepEqual(contextReport.optimizationEvidence.missingSourceEvidence, ["dm-script-public-url-api"]);

  await runGeneratedDispatchProbe(generated, "kError");
  await runGeneratedDispatchProbe(layoutReport, "kMissing");
  await runGeneratedDispatchProbe(contextReport, "kMissing");
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
  assert.throws(
    () => generateScriptUrlAddressClassification(routeDrift),
    /census (?:drifted|expected .* found)|route count drifted/,
  );

  const shapeDrift = structuredClone(sourceInputs);
  const ir = JSON.parse(shapeDrift.irText);
  ir.functions.find(({ id }) => id === "script:physics.set_group").parameters[0].rawType = "url|string";
  shapeDrift.irText = `${JSON.stringify(ir, null, 2)}\n`;
  assert.throws(() => generateScriptUrlAddressClassification(shapeDrift), /binding-pattern shapes differ/);

  const sourceDrift = structuredClone(sourceInputs);
  const [sourcePath, sourceText] = sourceDrift.sourceTexts.entries().next().value;
  sourceDrift.sourceTexts.set(sourcePath, `${sourceText}\n// drift\n`);
  assert.doesNotThrow(() => generateScriptUrlAddressClassification(sourceDrift));
});

test("generated runtime uses explicit URL branding and preserves the nonzero reserved lane", async () => {
  const [jsi, address] = await Promise.all([
    readFile(new URL("../defold/defold_hermes/src/script_jsi_bridge.cpp", import.meta.url), "utf8"),
    readFile(new URL("../packages/sdk/src/address.ts", import.meta.url), "utf8"),
  ]);
  assert.match(jsi, /kDefoldUrlProperty = "__dehermUrlV1"/);
  assert.match(jsi, /"reserved".*url\.reserved/s);
  assert.match(jsi, /setProperty\(runtime, kDefoldUrlProperty, true\)/);
  assert.match(address, /readonly __dehermUrlV1: true/);
  assert.match(address, /readonly reserved: DefoldHash/);
});

test("package emitter reconstructs URL native outputs from compact source-selected facts", async () => {
  const [factsRaw, reportRaw, header, source] = await Promise.all([
    readFile(
      new URL("../packages/bindings/generated/defold-script-url-binding-recipe-facts.json", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../packages/bindings/generated/defold-script-url-address-classification.json", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../defold/defold_hermes/include/defold_hermes/generated_script_url_bindings.hpp", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../defold/defold_hermes/src/generated_script_url_bindings.cpp", import.meta.url), "utf8"),
  ]);
  const facts = JSON.parse(factsRaw);
  assert.deepEqual(renderScriptUrlNativeOutputs(facts), { header, source });
  assert.deepEqual(scriptUrlBindingRecipeFacts(JSON.parse(reportRaw)), facts);
  assert.ok(Buffer.byteLength(JSON.stringify(facts)) < Buffer.byteLength(reportRaw));
  const malformed = structuredClone(facts);
  malformed.operations[1].stableId = malformed.operations[0].stableId;
  assert.throws(() => renderScriptUrlNativeOutputs(malformed), /sorted by unique stable ID/);
});

test("regenerates the classification byte-identically in a temporary output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deherm-url-classifier-"));
  try {
    const temporary = join(directory, "classification.json");
    execFileSync(process.execPath, ["scripts/generate-script-url-address-classification.mjs", "--output", temporary], {
      cwd: root,
      stdio: "pipe",
    });
    assert.equal(
      await readFile(temporary, "utf8"),
      await readFile(
        new URL("packages/bindings/generated/defold-script-url-address-classification.json", root),
        "utf8",
      ),
    );
    execFileSync(process.execPath, ["scripts/generate-script-url-address-classification.mjs", "--check"], {
      cwd: root,
      stdio: "pipe",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("native URL arena proves pinned layout, exact bits, reentrancy, exhaustion, and stale rejection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deherm-url-arena-"));
  try {
    const executable = join(directory, "script-url-arena-test");
    execFileSync(
      process.env.CXX || "clang++",
      [
        "-std=c++17",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-Wno-zero-length-array",
        "-pedantic",
        "-Idefold/defold_hermes/include",
        "-Iupstream/defold/engine/dlib/src",
        "native/script_url_arena_test.cpp",
        "-o",
        executable,
      ],
      { cwd: root, stdio: "pipe" },
    );
    assert.equal(execFileSync(executable, [], { encoding: "utf8" }).trim(), "script-url-arena:ok allocations:0");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
