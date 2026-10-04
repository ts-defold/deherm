#!/usr/bin/env node
// The JS half of the typed-native transport.
//
// `script-universal-value.ts` already declares the whole `extern_c` surface of
// the universal static frame, and `shermes -emit-c` lowers every one of those
// declarations to a direct C call. What it does not have is a way for ordinary
// bytecode to reach it: the generated SDK dispatches through
// `__defoldScriptBridgeV1.call(stableId, args)`, and that object is a JSI host
// function installed by the runtime.
//
// This generator emits the sound-typed unit that closes the gap. Compiled by
// `shermes` and evaluated into the same Hermes runtime as the bundle, it
// replaces `__defoldScriptBridgeV1` with an AOT-compiled object whose `call`
// takes the routes it claims through the static frame and delegates everything
// else to the JSI bridge it captured. The choice is therefore made in native
// code, per call, inside one runtime - which is the whole point: a route that
// cannot be soundly typed keeps working over JSI in the same binary.
//
// The claimed set is not authored here. It is the lowering plan's own
// `staticHermesCAbi: emit` selection for the script surface, intersected with
// the universal-value family that actually owns a dispatchable frame. A route
// the plan did not lower has no entry, so it cannot be claimed by accident.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  projectStaticHermesTypedNativeBridgeFacts,
  renderTypescript,
} from "../packages/compiler/src/static-hermes-typed-native-bridge-output-emitter.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const relativeInputs = {
  plan: "packages/bindings/generated/defold-binding-lowering-plan.json",
  universal: "packages/bindings/generated/defold-script-universal-value-bindings.json",
  capi: "defold/defold_hermes/include/defold_hermes/script_bridge_capi.hpp",
};
const relativeOutputs = {
  typescript: "packages/static-hermes/src/generated/script-typed-native-bridge.ts",
  report: "packages/bindings/generated/defold-typed-native-bridge.json",
  facts: "packages/bindings/generated/defold-typed-native-bridge-recipe-facts.json",
};

// Mirrors of the exact C ABI tags. They are asserted against the pinned header
// below rather than trusted, because a silent drift here would mis-tag values
// crossing the frame instead of failing.
const kHandleKindHash = 1;
const kHandleKindUrl = 2;
const kHandleKindGuiNode = 3;
const kDefoldKindVector3 = 1;
const kDefoldKindVector4 = 2;
const kDefoldKindQuaternion = 3;
const kDefoldKindMatrix4 = 4;

// A claimed route must marshal every value it can see. These shape kinds carry
// something this transport cannot represent in sound TypeScript, so a route
// declaring one is left on its baseline transport rather than half-supported.
// Callback-bearing routes can still be claimed when their callback parameter
// is optional: the sound-typed adapter declines calls carrying a function and
// falls back to the captured JSI bridge before touching the Static frame. The
// lowering plan structurally blocks required callbacks and callback results;
// retained handles remain unsupported here.
const kUnsupportedShapeKinds = new Set(["handle", "userdata", "opaque"]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertAbiTags(capiHeader) {
  // The enum order in script_bridge_capi.hpp is the ABI. Read it rather than
  // restating it, so a reordered enum breaks generation instead of runtime.
  const section = /enum class ScriptHandleKind : uint8_t \{([\s\S]*?)\};/.exec(capiHeader);
  assert.ok(section, "script_bridge_capi.hpp no longer declares ScriptHandleKind");
  const handleKinds = section[1]
    .split("\n")
    .map((line) => /^\s*(k[A-Za-z0-9]+)/.exec(line.replace(/\/\*[\s\S]*?\*\//g, "")))
    .filter(Boolean)
    .map((match) => match[1]);
  assert.equal(handleKinds[kHandleKindHash], "kHash", "ScriptHandleKind::kHash moved");
  assert.equal(handleKinds[kHandleKindUrl], "kUrl", "ScriptHandleKind::kUrl moved");
  assert.equal(handleKinds[kHandleKindGuiNode], "kGuiNode", "ScriptHandleKind::kGuiNode moved");

  const defoldSection = /enum class ScriptDefoldValueKind : uint8_t \{([\s\S]*?)\};/.exec(capiHeader);
  assert.ok(defoldSection, "script_bridge_capi.hpp no longer declares ScriptDefoldValueKind");
  const defoldKinds = defoldSection[1]
    .split("\n")
    .map((line) => /^\s*(k[A-Za-z0-9]+)/.exec(line.replace(/\/\*[\s\S]*?\*\//g, "")))
    .filter(Boolean)
    .map((match) => match[1]);
  assert.equal(defoldKinds[kDefoldKindVector3], "kVector3", "ScriptDefoldValueKind::kVector3 moved");
  assert.equal(defoldKinds[kDefoldKindVector4], "kVector4", "ScriptDefoldValueKind::kVector4 moved");
  assert.equal(defoldKinds[kDefoldKindQuaternion], "kQuaternion", "ScriptDefoldValueKind::kQuaternion moved");
  assert.equal(defoldKinds[kDefoldKindMatrix4], "kMatrix4", "ScriptDefoldValueKind::kMatrix4 moved");
}

export function selectClaimedRoutes(plan, universal) {
  assert.equal(universal.schemaVersion, 1, "Unsupported universal-value binding report schema");
  const sameRevision = plan.defoldRevision === universal.defoldRevision;
  const universalById = new Map(universal.bindings.map((binding) => [binding.stableId, binding]));
  const claimed = [];
  const declined = [];
  for (const unit of plan.units) {
    if (unit.identity.surface !== "script") continue;
    if (unit.backends?.staticHermesCAbi?.selection !== "emit") continue;
    const stableId = unit.identity.stableId;
    assert.ok(
      Number.isInteger(stableId) && stableId >= 0 && stableId <= 0xffffffff,
      `${unit.identity.id} has no stable ID`,
    );
    const binding = universalById.get(stableId);
    if (!binding && !sameRevision) {
      declined.push({
        id: unit.identity.id,
        stableId,
        reason: "canonical-route-absent-from-derived-revision",
      });
      continue;
    }
    assert.ok(binding, `${unit.identity.id}: canonical typed-native selection has no universal-value frame`);
    const unsupported = binding.shapeKinds.filter((kind) => kUnsupportedShapeKinds.has(kind));
    assert.deepEqual(
      unsupported,
      [],
      `${unit.identity.id}: canonical typed-native selection contains unrepresentable shapes`,
    );
    if (binding.variadic) {
      // Universal-value variadics are not unbounded: their generated operation
      // descriptor fixes the same policy-owned maximum the native frame checks.
      // The adapter below already walks the runtime argument array, so these
      // routes need no handwritten arity expansion; they share this mechanical
      // bounded adapter with every fixed-arity route.
      assert.equal(
        binding.maximumArgumentCount,
        universal.bounds.maximumArguments,
        `${unit.identity.id}: variadic bound differs from the universal frame capacity`,
      );
    }
    assert.ok(
      Number.isInteger(binding.maximumArgumentCount) &&
        binding.maximumArgumentCount >= 0 &&
        binding.maximumArgumentCount <= universal.bounds.maximumArguments,
      `${unit.identity.id}: argument bound exceeds the universal frame capacity`,
    );
    claimed.push({
      id: unit.identity.id,
      stableId,
      maximumArgumentCount: binding.maximumArgumentCount,
      ...(binding.variadic ? { arity: "bounded-variadic" } : {}),
    });
  }
  claimed.sort((left, right) => left.stableId - right.stableId);
  declined.sort((left, right) => left.stableId - right.stableId);
  const maximumArgumentCount = claimed.reduce((maximum, route) => Math.max(maximum, route.maximumArgumentCount), 0);
  return { claimed, declined, maximumArgumentCount, planRevisionMatched: sameRevision };
}

async function writeOrCheck(target, content, check) {
  if (check) {
    const current = await readFile(target, "utf8").catch(() => null);
    assert.equal(current, content, `${path.relative(repositoryRoot, target)} is stale`);
    return;
  }
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

export async function run(argv = process.argv) {
  const check = argv.includes("--check");
  const [planRaw, universalRaw, capiHeader] = await Promise.all([
    readFile(path.join(repositoryRoot, relativeInputs.plan), "utf8"),
    readFile(path.join(repositoryRoot, relativeInputs.universal), "utf8"),
    readFile(path.join(repositoryRoot, relativeInputs.capi), "utf8"),
  ]);
  assertAbiTags(capiHeader);
  const plan = JSON.parse(planRaw);
  const universal = JSON.parse(universalRaw);
  const selection = selectClaimedRoutes(plan, universal);
  const planScriptTypedNativeEmit = plan.units.filter(
    (unit) => unit.identity.surface === "script" && unit.backends?.staticHermesCAbi?.selection === "emit",
  ).length;
  if (selection.planRevisionMatched) {
    assert.equal(
      selection.claimed.length,
      planScriptTypedNativeEmit,
      "typed-native bridge selection differs from the canonical script plan",
    );
    assert.equal(
      selection.declined.length,
      0,
      "typed-native bridge cannot decline a route selected by the canonical script plan",
    );
  } else {
    assert.equal(
      selection.claimed.length + selection.declined.length,
      planScriptTypedNativeEmit,
      "typed-native fallback does not account for every canonical script route",
    );
  }
  const typescriptFacts = projectStaticHermesTypedNativeBridgeFacts(selection);
  const typescript = renderTypescript(typescriptFacts);
  const factsDocument = `${JSON.stringify(typescriptFacts, null, 2)}\n`;
  const body = {
    schemaVersion: 1,
    generator: "scripts/generate-typed-native-bridge.mjs",
    transport: "typed-native",
    defoldRevision: universal.defoldRevision,
    canonicalPlanRevision: plan.defoldRevision,
    inputHashes: {
      [relativeInputs.plan]: sha256(planRaw),
      [relativeInputs.universal]: sha256(universalRaw),
      [relativeInputs.capi]: sha256(capiHeader),
    },
    planTypedNativeEmit: planScriptTypedNativeEmit,
    planTypedNativeBackendEmit: plan.runtimes?.hermes?.byTransport?.["typed-native"]?.emit ?? null,
    claimedRouteCount: selection.claimed.length,
    declinedRouteCount: selection.declined.length,
    maximumArgumentCount: selection.maximumArgumentCount,
    claimedRoutes: selection.claimed,
    declinedRoutes: selection.declined,
    generatedSha256: { typescript: sha256(typescript) },
    evidenceBoundary: {
      routeSelection: selection.planRevisionMatched
        ? "derived-from-the-canonical-lowering-plan"
        : "canonical-plan-intersected-with-derived-universal-frames",
      cEmission: "requires-shermes-emit-c-consumer",
      compilation: "not-claimed",
      linkage: "not-claimed",
      runtime: "not-claimed",
    },
  };
  const report = `${JSON.stringify({ ...body, reportSha256: sha256(JSON.stringify(body)) }, null, 2)}\n`;
  await writeOrCheck(path.join(repositoryRoot, relativeOutputs.typescript), typescript, check);
  await writeOrCheck(path.join(repositoryRoot, relativeOutputs.report), report, check);
  await writeOrCheck(path.join(repositoryRoot, relativeOutputs.facts), factsDocument, check);
  console.log(
    `typed-native bridge claims all ${selection.claimed.length} canonical script routes (${selection.declined.length} declined)`,
  );
  return body;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await run();
