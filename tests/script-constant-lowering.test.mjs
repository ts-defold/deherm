import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  generateModules,
  registrationScopeForConstant
} from "../packages/compiler/src/sdk/script-sdk.mjs";

const root = new URL("../", import.meta.url);

test("number, string, and uint64 hash policy values have literal lowerings", () => {
  const trees = new Map([["fixture", {
    fields: [
      { rawName: "NUMBER", source: "fixture.lua", line: 1 },
      { rawName: "STRING", source: "fixture.lua", line: 2 },
      { rawName: "HASH", source: "fixture.lua", line: 3 }
    ],
    functions: [],
    children: new Map()
  }]]);
  const values = new Map([
    ["fixture.NUMBER", { valueKind: "number", value: 7 }],
    ["fixture.STRING", { valueKind: "string", value: "color" }],
    ["fixture.HASH", { valueKind: "hash", value: "0x80356add32e752e9" }]
  ]);
  const source = generateModules(trees, values);
  assert.match(source, /return 7 as unknown as/);
  assert.match(source, /return "color" as unknown as/);
  assert.match(source, /return 0x80356add32e752e9n as unknown as/);
  assert.doesNotMatch(source, /getScriptApiValue/);
});

test("source-derived script constants are lowered across runtime profiles", async () => {
  execFileSync(process.execPath, ["scripts/generate-script-sdk.mjs", "--check"], {
    cwd: root,
    stdio: "pipe"
  });
  const [surface, lowering, modules] = await Promise.all([
    readFile(new URL("packages/bindings/generated/defold-lua-registration-surface.json", root), "utf8").then(JSON.parse),
    readFile(new URL("packages/bindings/generated/defold-script-constant-lowering.json", root), "utf8").then(JSON.parse),
    readFile(new URL("packages/sdk/src/generated/script/modules.ts", root), "utf8")
  ]);
  const camera = lowering.entries.filter((entry) => entry.name.startsWith("camera."));
  assert.deepEqual(camera.map(({ name, state, value }) => ({ name, state, value })), [
    { name: "camera.ORTHO_MODE_AUTO_COVER", state: "inlined", value: 2 },
    { name: "camera.ORTHO_MODE_AUTO_FIT", state: "inlined", value: 1 },
    { name: "camera.ORTHO_MODE_FIXED", state: "inlined", value: 0 }
  ]);
  assert.ok(surface.targets["defold-engine-box2d-v3"].registeredConstants.length >= 400);
  assert.equal(lowering.counts.total, 483);
  assert.ok(lowering.counts.inlined > 300);
  const cameraFixed = lowering.entries.find(({ name }) => name === "camera.ORTHO_MODE_FIXED");
  assert.deepEqual(cameraFixed.profileAvailability, {
    kind: "compile-time-intrinsic",
    profileIndependent: true,
    runtimeProfiles: [
      "default-legacy-bullet", "v3-bullet", "legacy-no-bullet",
      "v3-no-bullet", "bullet-only", "no-physics"
    ],
    reason: "source-derived literal is registered by an unconditional core Lua table"
  });
  const physicsShape = lowering.entries.find(({ name }) => name === "physics.SHAPE_TYPE_MESH");
  assert.equal(physicsShape.profileAvailability.kind, "runtime-profile-gated");
  assert.deepEqual(physicsShape.registrationScopes.map(({ kind }) => kind), ["core-unconditional", "core-unconditional"]);
  assert.ok(physicsShape.profileAvailability.runtimeProfiles.includes("no-physics"));
  const box2dConstant = lowering.entries.find(({ name }) => name === "b2d.body.B2_STATIC_BODY");
  assert.deepEqual(box2dConstant.profileAvailability.runtimeProfiles.sort(), [
    "default-legacy-bullet", "legacy-no-bullet", "v3-bullet", "v3-no-bullet"
  ].sort());
  assert.match(modules, /get ORTHO_MODE_FIXED\(\) \{ return 0 as unknown as/);
  assert.match(modules, /get PROP_COLOR\(\) \{ return "color" as unknown as/);
  assert.match(modules, /get B2_DYNAMIC_BODY\(\) \{ return callScriptApi\(/);
});

test("profile-unavailable constant declarations retain a machine-readable availability record", async () => {
  const [report, modules, runtime] = await Promise.all([
    readFile(new URL("packages/bindings/generated/defold-script-constant-lowering.json", root), "utf8").then(JSON.parse),
    readFile(new URL("packages/sdk/src/generated/script/modules.ts", root), "utf8"),
    readFile(new URL("packages/sdk/src/generated/script/runtime.ts", root), "utf8")
  ]);
  assert.ok(report.entries.some((entry) => entry.state === "profile-unavailable" && entry.blocker.code === "constant-not-registered"));
  assert.match(modules, /get ACTIVE_TAG\(\) \{ return callScriptApi\(/);
  assert.match(runtime, /DEHERM_SCRIPT_CONSTANT_NOT_INLINED/);
});

test("equal literals from an optional module remain runtime-backed", () => {
  const optionalFeatures = new Map([["future", new Set(["future-module"])]]);
  assert.deepEqual(registrationScopeForConstant("future.widget.VALUE", "future/src/future_script.cpp", optionalFeatures), {
    kind: "feature-gated",
    features: ["future-module"]
  });
  const source = generateModules(new Map([["future", {
    fields: [{ rawName: "VALUE", source: "future.lua", line: 1 }],
    functions: [],
    children: new Map()
  }]]), new Map([[
    "future.VALUE",
    {
      state: "runtime-backed",
      valueKind: "number",
      value: 7,
      stableId: 123
    }
  ]]));
  assert.match(source, /get VALUE\(\) \{ return callScriptApi\(123, \[\] as const\)/);
  assert.doesNotMatch(source, /return 7 as unknown as/);
});
