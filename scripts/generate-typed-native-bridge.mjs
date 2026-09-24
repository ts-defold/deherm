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

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const relativeInputs = {
  plan: "packages/bindings/generated/defold-binding-lowering-plan.json",
  universal: "packages/bindings/generated/defold-script-universal-value-bindings.json",
  capi: "defold/defold_hermes/include/defold_hermes/script_bridge_capi.hpp"
};
const relativeOutputs = {
  typescript: "packages/static-hermes/src/generated/script-typed-native-bridge.ts",
  report: "packages/bindings/generated/defold-typed-native-bridge.json"
};

// Mirrors of the exact C ABI tags. They are asserted against the pinned header
// below rather than trusted, because a silent drift here would mis-tag values
// crossing the frame instead of failing.
const kHandleKindHash = 1;
const kHandleKindUrl = 2;
const kHandleKindGuiNode = 3;
const kHandleKindLuaSemantic = 6;
const kSemanticHandleKindGuiNode = 14;
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
    assert.ok(Number.isInteger(stableId) && stableId >= 0 && stableId <= 0xffffffff,
      `${unit.identity.id} has no stable ID`);
    const binding = universalById.get(stableId);
    if (!binding && !sameRevision) {
      declined.push({
        id: unit.identity.id,
        stableId,
        reason: "canonical-route-absent-from-derived-revision"
      });
      continue;
    }
    assert.ok(binding, `${unit.identity.id}: canonical typed-native selection has no universal-value frame`);
    const unsupported = binding.shapeKinds.filter((kind) => kUnsupportedShapeKinds.has(kind));
    assert.deepEqual(unsupported, [],
      `${unit.identity.id}: canonical typed-native selection contains unrepresentable shapes`);
    if (binding.variadic) {
      // Universal-value variadics are not unbounded: their generated operation
      // descriptor fixes the same policy-owned maximum the native frame checks.
      // The adapter below already walks the runtime argument array, so these
      // routes need no handwritten arity expansion; they share this mechanical
      // bounded adapter with every fixed-arity route.
      assert.equal(binding.maximumArgumentCount, universal.bounds.maximumArguments,
        `${unit.identity.id}: variadic bound differs from the universal frame capacity`);
    }
    assert.ok(Number.isInteger(binding.maximumArgumentCount) && binding.maximumArgumentCount >= 0 &&
      binding.maximumArgumentCount <= universal.bounds.maximumArguments,
      `${unit.identity.id}: argument bound exceeds the universal frame capacity`);
    claimed.push({
      id: unit.identity.id,
      stableId,
      maximumArgumentCount: binding.maximumArgumentCount,
      ...(binding.variadic ? { arity: "bounded-variadic" } : {})
    });
  }
  claimed.sort((left, right) => left.stableId - right.stableId);
  declined.sort((left, right) => left.stableId - right.stableId);
  const maximumArgumentCount = claimed.reduce(
    (maximum, route) => Math.max(maximum, route.maximumArgumentCount), 0);
  return { claimed, declined, maximumArgumentCount, planRevisionMatched: sameRevision };
}

export function renderTypescript({ claimed, maximumArgumentCount }) {
  const ids = claimed.map(({ stableId }) => stableId);
  // Rendered in ascending order so the lookup below can be a binary search
  // rather than a hash map: the table is static, and a compiled comparison
  // ladder costs less than materialising a Map at unit evaluation time.
  const table = [];
  for (let index = 0; index < ids.length; index += 8) {
    table.push(`  ${ids.slice(index, index + 8).join(", ")}${index + 8 < ids.length ? "," : ""}`);
  }
  return `// Generated by scripts/generate-typed-native-bridge.mjs. Do not edit.
//
// Appended to the universal-value lane and compiled as one sound-typed unit by
// \`shermes -typed -strict -O -emit-c\`. Every \`dispatchScriptUniversalValue\`
// call below therefore lowers to a direct C call through \`LiteralNativeExtern\`,
// with no JSI host function and no bytecode dispatch on the path.
"use strict";

/** Ascending stable IDs the lowering plan lowered to \`staticHermesCAbi\`. */
const __dehermTypedNativeRoutes: Array<number> = [
${table.join("\n")}
];

/** Largest declared argument count across the claimed routes. */
const __DEHERM_TYPED_NATIVE_MAX_ARGUMENTS: number = ${maximumArgumentCount};

/** Deepest value graph this transport will marshal before declining. */
const __DEHERM_TYPED_NATIVE_MAX_DEPTH: number = 8;

// Public GUI nodes retain the SDK's generation-checked host-object shape while
// carrying the private Static lease that must be released exactly once.  The
// lease is deliberately kept separate from the public \`kind\` brand: callers
// see \`"gui-node"\`, while the frame still receives the ABI's numeric kind 3.
class DehermStaticGuiNode {
  runtime: number;
  slot: number;
  generation: number;
  kind: string;
  lease: DehermStaticHandle;
  constructor(lease: DehermStaticHandle) {
    this.lease = lease;
    this.runtime = lease.runtime;
    this.slot = lease.payloadLow;
    this.generation = lease.payloadHigh;
    this.kind = "gui-node";
  }
  dispose(): void { this.lease.dispose(); }
}

function __dehermTypedNativeClaims(stableId: number): boolean {
  let low: number = 0;
  let high: number = __dehermTypedNativeRoutes.length - 1;
  while (low <= high) {
    const mid: number = (low + high) >> 1;
    const probe: number = __dehermTypedNativeRoutes[mid];
    if (probe === stableId) return true;
    if (probe < stableId) { low = mid + 1; } else { high = mid - 1; }
  }
  return false;
}

const __dehermGlobal: any = globalThis;
// \`Array\` is generic in the sound-typed dialect, so its type cannot be named
// here; the value is still the ordinary intrinsic and \`isArray\` is the exact
// predicate the JSI encoder uses to separate sequences from records.
const __dehermIsArray: any = __dehermGlobal.Array.isArray;
// Prototype identity is the structural test that separates a plain record from
// every other object. The JSI encoder knows three object shapes - sequence,
// \`Map\`, and plain record - and enumerating anything else here would encode an
// empty table instead of refusing, which is a silent wrong value rather than a
// declined one.
const __dehermGetPrototypeOf: any = __dehermGlobal.Object.getPrototypeOf;
const __dehermRecordPrototype: any = __dehermGlobal.Object.prototype;
// The exact constructor the JSI encoder tests against, so a \`Map\` is the same
// table kind on both transports rather than two spellings of "an object".
const __dehermMap: any = __dehermGlobal.Map;
const __dehermMapPrototype: any = __dehermMap.prototype;
const __DEHERM_U32: any = BigInt(0xffffffff);
const __DEHERM_SHIFT32: any = BigInt(32);

/**
 * Set when a value cannot be represented on this transport. The caller checks
 * it before anything touches the native frame, so declining is always a pure
 * decision: no argument has been encoded and no dispatch has run.
 */
let __dehermTypedNativeDeclined: boolean = false;

function __dehermSplitLow(value: any): number { return Number(value & __DEHERM_U32); }
function __dehermSplitHigh(value: any): number { return Number((value >> __DEHERM_SHIFT32) & __DEHERM_U32); }
function __dehermJoin(low: number, high: number): any {
  return (BigInt(high) << __DEHERM_SHIFT32) | BigInt(low);
}

function __dehermToStatic(value: any, depth: number): DehermStaticValue {
  if (value === null) return new DehermStaticNull();
  const kind: string = typeof value;
  if (kind === "undefined") return new DehermStaticUndefined();
  if (kind === "number") { const scalar: number = value; return new DehermStaticNumber(scalar); }
  if (kind === "boolean") { const flag: boolean = value; return new DehermStaticBoolean(flag); }
  if (kind === "string") { const text: string = value; return new DehermStaticString(text); }
  if (kind === "bigint") {
    // An unsigned 64-bit bigint is exactly how the JSI bridge spells a
    // \`dmhash_t\`, so the two transports agree on the wire value by construction.
    return new DehermStaticHandle(${kHandleKindHash}, 0, 0, __dehermSplitLow(value), __dehermSplitHigh(value));
  }
  if (value instanceof DehermStaticGuiNode) {
    const node: any = value;
    return node.lease;
  }
  // GUI nodes are generated HostObjects on the JSI twin.  Static Hermes has
  // no host-object RTTI, so the generated handle ABI is recognized by the
  // same immutable runtime/slot/generation/kind shape exposed by that host
  // object.  A handle produced by this frame is accepted directly as well;
  // both paths preserve the registry token and its explicit dispose lease.
  if (value instanceof DehermStaticHandle) return value;
  if (kind !== "object" || depth > __DEHERM_TYPED_NATIVE_MAX_DEPTH) {
    __dehermTypedNativeDeclined = true;
    return new DehermStaticUndefined();
  }
  const handleName: any = value.kind;
  const handleRuntime: any = value.runtime;
  const handleSlot: any = value.slot;
  const handleGeneration: any = value.generation;
  if (handleName === "gui-node" && typeof handleRuntime === "number" &&
      typeof handleSlot === "number" && typeof handleGeneration === "number" &&
      Number.isSafeInteger(handleRuntime) && Number.isSafeInteger(handleSlot) &&
      Number.isSafeInteger(handleGeneration) && handleRuntime > 0 &&
      handleSlot >= 0 && handleGeneration > 0 && typeof value.dispose === "function") {
    return new DehermStaticHandle(${kHandleKindGuiNode}, 0,
      handleRuntime, handleSlot, handleGeneration);
  }
  // The Dynamic Hermes/browser twin exposes the same borrowed node as a
  // numeric __dehermHandleV1 token. Accept that shape structurally too, so a
  // node returned before a transport switch remains usable by a claimed
  // Static setter without admitting other retained-handle kinds.
  const handleV1: any = value.__dehermHandleV1;
  const handleNumericKind: any = value.kind;
  const handlePayload: any = value.payload;
  if (handleV1 === true && handleNumericKind === ${kHandleKindGuiNode} &&
      typeof handleRuntime === "number" && Number.isSafeInteger(handleRuntime) &&
      handleRuntime > 0 && typeof handlePayload === "bigint" &&
      handlePayload >= BigInt(0) && handlePayload <= BigInt("0xffffffffffffffff")) {
    return new DehermStaticHandle(${kHandleKindGuiNode},
      Number.isSafeInteger(value.semanticKind) ? value.semanticKind : 0,
      handleRuntime, __dehermSplitLow(handlePayload), __dehermSplitHigh(handlePayload));
  }
  const valueKind: any = value.__dehermValueKind;
  if (typeof valueKind === "string") {
    const name: string = valueKind;
    const x: any = value.x;
    const y: any = value.y;
    const z: any = value.z;
    if (typeof x === "number" && typeof y === "number" && typeof z === "number") {
      if (name === "vector3") return new DehermStaticDefoldValue(${kDefoldKindVector3}, x, y, z, 0);
      const w: any = value.w;
      if (typeof w === "number") {
        if (name === "vector4") return new DehermStaticDefoldValue(${kDefoldKindVector4}, x, y, z, w);
        if (name === "quaternion") return new DehermStaticDefoldValue(${kDefoldKindQuaternion}, x, y, z, w);
      }
    }
    __dehermTypedNativeDeclined = true;
    return new DehermStaticUndefined();
  }
  if (value.__dehermUrlV1 === true) {
    const socket: any = value.socket;
    const reserved: any = value.reserved;
    const routePath: any = value.path;
    const fragment: any = value.fragment;
    if (typeof socket === "bigint" && typeof reserved === "bigint" &&
        typeof routePath === "bigint" && typeof fragment === "bigint") {
      return new DehermStaticUrl(
        __dehermSplitLow(socket), __dehermSplitHigh(socket),
        __dehermSplitLow(reserved), __dehermSplitHigh(reserved),
        __dehermSplitLow(routePath), __dehermSplitHigh(routePath),
        __dehermSplitLow(fragment), __dehermSplitHigh(fragment));
    }
    __dehermTypedNativeDeclined = true;
    return new DehermStaticUndefined();
  }
  if (__dehermIsArray(value)) {
    const source: any = value;
    const length: number = source.length;
    if (length === 16) {
      // The JSI encoder reads a 16-element numeric array as a column-major
      // Matrix4. Agreeing with it is what keeps the two transports one
      // semantics rather than two.
      let numeric: boolean = true;
      for (let index: number = 0; index < 16; ++index) {
        if (typeof source[index] !== "number") { numeric = false; break; }
      }
      if (numeric) {
        const elements: Array<number> = [];
        for (let index: number = 0; index < 16; ++index) elements.push(source[index]);
        return new DehermStaticMatrix4(elements);
      }
    }
    const items: Array<DehermStaticValue> = [];
    for (let index: number = 0; index < length; ++index) {
      items.push(__dehermToStatic(source[index], depth + 1));
      if (__dehermTypedNativeDeclined) return new DehermStaticUndefined();
    }
    return new DehermStaticArray(items);
  }
  const prototype: any = __dehermGetPrototypeOf(value);
  if (prototype === __dehermMapPrototype) {
    // The JSI encoder walks \`Map.entries()\` and tags the table \`kMap\`, keys
    // encoded as values rather than as strings. Doing the same here is what
    // makes a property table sent over this transport the same Lua table the
    // engine would have received over JSI.
    const source: any = value;
    const mapKeys: Array<DehermStaticValue> = [];
    const mapValues: Array<DehermStaticValue> = [];
    const iterator: any = source.entries();
    for (;;) {
      const step: any = iterator.next();
      if (step.done === true) break;
      const pair: any = step.value;
      const key: DehermStaticValue = __dehermToStatic(pair[0], depth + 1);
      if (__dehermTypedNativeDeclined) return new DehermStaticUndefined();
      mapValues.push(__dehermToStatic(pair[1], depth + 1));
      if (__dehermTypedNativeDeclined) return new DehermStaticUndefined();
      mapKeys.push(key);
    }
    return new DehermStaticMap(mapKeys, mapValues);
  }
  // Everything else that reaches here must be a plain record. A \`Set\` or a
  // class instance enumerates to nothing, so encoding it would hand the engine
  // an empty table and lose the caller's data without a word; the JSI bridge
  // does know more shapes than this one, so declining the whole call is what
  // keeps one observable behaviour across the two transports.
  if (prototype !== __dehermRecordPrototype && prototype !== null) {
    __dehermTypedNativeDeclined = true;
    return new DehermStaticUndefined();
  }
  const keys: Array<string> = [];
  const values: Array<DehermStaticValue> = [];
  for (const key in value) {
    keys.push(key);
    values.push(__dehermToStatic(value[key], depth + 1));
    if (__dehermTypedNativeDeclined) return new DehermStaticUndefined();
  }
  return new DehermStaticRecord(keys, values);
}

function __dehermFromStatic(value: DehermStaticValue): any {
  // \`instanceof\` does not narrow in the sound-typed dialect, so the checked
  // instance is re-bound through \`any\`. The check itself is still the exact
  // discrimination; only the binding is untyped.
  const raw: any = value;
  if (value instanceof DehermStaticNumber) { const item: DehermStaticNumber = raw; return item.value; }
  if (value instanceof DehermStaticString) { const item: DehermStaticString = raw; return item.value; }
  if (value instanceof DehermStaticBoolean) { const item: DehermStaticBoolean = raw; return item.value; }
  if (value instanceof DehermStaticNull) return null;
  if (value instanceof DehermStaticUndefined) return undefined;
  if (value instanceof DehermStaticDefoldValue) {
    const item: DehermStaticDefoldValue = raw;
    const out: any = {};
    out.x = item.x;
    out.y = item.y;
    out.z = item.z;
    if (item.kind === ${kDefoldKindVector3}) {
      out.__dehermValueKind = "vector3";
      return out;
    }
    out.w = item.w;
    out.__dehermValueKind = item.kind === ${kDefoldKindVector4} ? "vector4" : "quaternion";
    return out;
  }
  if (value instanceof DehermStaticMatrix4) {
    const item: DehermStaticMatrix4 = raw;
    const out: Array<number> = [];
    for (let index: number = 0; index < 16; ++index) out.push(item.elements[index]);
    return out;
  }
  if (value instanceof DehermStaticHandle) {
    const item: DehermStaticHandle = raw;
    if (item.kind === ${kHandleKindGuiNode} ||
        (item.kind === ${kHandleKindLuaSemantic} && item.semanticKind === ${kSemanticHandleKindGuiNode})) {
      return new DehermStaticGuiNode(item);
    }
    if (item.kind !== ${kHandleKindHash}) {
      // A retained engine handle has no sound-typed representation. The
      // lowering plan is supposed to keep such a route off this transport, so
      // reaching here is a generation defect and is reported as one.
      throw "deherm typed-native route returned a retained engine handle";
    }
    return __dehermJoin(item.payloadLow, item.payloadHigh);
  }
  if (value instanceof DehermStaticUrl) {
    const item: DehermStaticUrl = raw;
    const out: any = {};
    out.socket = __dehermJoin(item.socketLow, item.socketHigh);
    out.reserved = __dehermJoin(item.reservedLow, item.reservedHigh);
    out.path = __dehermJoin(item.pathLow, item.pathHigh);
    out.fragment = __dehermJoin(item.fragmentLow, item.fragmentHigh);
    out.__dehermUrlV1 = true;
    return out;
  }
  if (value instanceof DehermStaticArray) {
    const item: DehermStaticArray = raw;
    const out: Array<any> = [];
    for (let index: number = 0; index < item.values.length; ++index) {
      out.push(__dehermFromStatic(item.values[index]));
    }
    return out;
  }
  if (value instanceof DehermStaticRecord) {
    const item: DehermStaticRecord = raw;
    const out: any = {};
    for (let index: number = 0; index < item.values.length; ++index) {
      out[item.keys[index]] = __dehermFromStatic(item.values[index]);
    }
    return out;
  }
  if (value instanceof DehermStaticMap) {
    // A \`kMap\` table keeps its key values, so the JSI decoder builds a real
    // \`Map\` rather than an object with stringified keys. Same here.
    const item: DehermStaticMap = raw;
    const out: any = new __dehermMap();
    for (let index: number = 0; index < item.values.length; ++index) {
      out.set(__dehermFromStatic(item.keys[index]), __dehermFromStatic(item.values[index]));
    }
    return out;
  }
  throw "deherm typed-native route returned a value shape this transport cannot decode";
}

/** The JSI bridge this unit is layered over. Every declined route lands here. */
const __dehermJsiBridge: any = __dehermGlobal.__defoldScriptBridgeV1;

// Static Hermes is normally layered over the captured JSI bridge, but a
// standalone typed-native bundle may not install one.  Declined values must
// then fail closed explicitly instead of turning a missing fallback into an
// accidental native-frame call or an opaque TypeError.
function __dehermDeclineToJsi(stableId: number, args: any): any {
  if (!__dehermJsiBridge || typeof __dehermJsiBridge.call !== "function") {
    throw "deherm typed-native route declined: JSI bridge unavailable";
  }
  return __dehermJsiBridge.call(stableId, args);
}

function __dehermTypedNativeCall(stableId: number, args: any): any {
  const count: number = args.length;
  if (count > __DEHERM_TYPED_NATIVE_MAX_ARGUMENTS || !__dehermTypedNativeClaims(stableId)) {
    return __dehermDeclineToJsi(stableId, args);
  }
  __dehermTypedNativeDeclined = false;
  const values: Array<DehermStaticValue> = [];
  for (let index: number = 0; index < count; ++index) {
    values.push(__dehermToStatic(args[index], 0));
    if (__dehermTypedNativeDeclined) return __dehermDeclineToJsi(stableId, args);
  }
  const results: Array<DehermStaticValue> = dispatchScriptUniversalValue(stableId, values);
  const resultCount: number = results.length;
  if (resultCount === 0) return undefined;
  if (resultCount === 1) return __dehermFromStatic(results[0]);
  const out: Array<any> = [];
  for (let index: number = 0; index < resultCount; ++index) out.push(__dehermFromStatic(results[index]));
  return out;
}

if (__dehermJsiBridge) {
  const bridge: any = {};
  // \`target\` and \`get\` stay the JSI bridge's own: the target gate and the
  // name-addressed constant surface are unchanged by the transport choice.
  bridge.target = __dehermJsiBridge.target;
  bridge.get = __dehermJsiBridge.get;
  bridge.call = __dehermTypedNativeCall;
  bridge.__dehermTypedNativeRouteCount = __dehermTypedNativeRoutes.length;
  __dehermGlobal.__defoldScriptBridgeV1 = bridge;
}
`;
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
    readFile(path.join(repositoryRoot, relativeInputs.capi), "utf8")
  ]);
  assertAbiTags(capiHeader);
  const plan = JSON.parse(planRaw);
  const universal = JSON.parse(universalRaw);
  const selection = selectClaimedRoutes(plan, universal);
  const planScriptTypedNativeEmit = plan.units.filter((unit) =>
    unit.identity.surface === "script" &&
    unit.backends?.staticHermesCAbi?.selection === "emit").length;
  if (selection.planRevisionMatched) {
    assert.equal(selection.claimed.length, planScriptTypedNativeEmit,
      "typed-native bridge selection differs from the canonical script plan");
    assert.equal(selection.declined.length, 0,
      "typed-native bridge cannot decline a route selected by the canonical script plan");
  } else {
    assert.equal(selection.claimed.length + selection.declined.length, planScriptTypedNativeEmit,
      "typed-native fallback does not account for every canonical script route");
  }
  const typescript = renderTypescript(selection);
  const body = {
    schemaVersion: 1,
    generator: "scripts/generate-typed-native-bridge.mjs",
    transport: "typed-native",
    defoldRevision: universal.defoldRevision,
    canonicalPlanRevision: plan.defoldRevision,
    inputHashes: {
      [relativeInputs.plan]: sha256(planRaw),
      [relativeInputs.universal]: sha256(universalRaw),
      [relativeInputs.capi]: sha256(capiHeader)
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
      runtime: "not-claimed"
    }
  };
  const report = `${JSON.stringify({ ...body, reportSha256: sha256(JSON.stringify(body)) }, null, 2)}\n`;
  await writeOrCheck(path.join(repositoryRoot, relativeOutputs.typescript), typescript, check);
  await writeOrCheck(path.join(repositoryRoot, relativeOutputs.report), report, check);
  console.log(
    `typed-native bridge claims all ${selection.claimed.length} canonical script routes (${selection.declined.length} declined)`);
  return body;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await run();
