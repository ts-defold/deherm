import { createHash } from "node:crypto";

export const BINDING_LOWERING_RECIPE_KIND = "deherm.policy.binding-lowering-recipe-facts";
export const BINDING_LOWERING_RECIPE_NAME = "defold-binding-lowering-recipe-facts.json";
export const BINDING_LOWERING_RECIPE_CAPABILITY = "policy.compiler-document.binding-lowering-plan.v1";
export const BINDING_LOWERING_RECIPE_EMITTER = "packages/compiler/src/binding-lowering-plan-recipe.mjs";

const RECIPE_SCHEMA_VERSION = 1;
const ARRAY_TAG = -1;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Normalize the revision-owned lowering decisions into a dense fact stream.
 *
 * Strings are interned, object shapes are interned, and arrays retain their
 * source order. The representation deliberately contains no compressed copy of
 * the old JSON document: it is a schema-and-value recipe interpreted by the
 * package emitter below. Object property order lives in `shapes`, so policy
 * canonicalization cannot perturb the byte-exact historical rendering.
 */
export function createBindingLoweringRecipeFacts(plan, sentinel) {
  if (!plan || plan.schemaVersion !== 2 || typeof plan.planSha256 !== "string") {
    throw new Error("Lowering-recipe extraction requires canonical lowering-plan schema v2");
  }
  const { planSha256, ...body } = plan;
  if (sha256(JSON.stringify(body)) !== planSha256) {
    throw new Error("Lowering-recipe extraction requires a plan with a valid internal digest");
  }
  if (!sentinel || sentinel.schemaVersion !== 1 || !sentinel.inputPaths ||
      JSON.stringify(sentinel.inputHashes) !== JSON.stringify(plan.inputHashes)) {
    throw new Error("Lowering-recipe extraction requires matching cache identity facts");
  }

  const strings = [];
  const stringIndices = new Map();
  const shapes = [];
  const shapeIndices = new Map();

  const encode = (value) => {
    if (typeof value === "string") {
      let index = stringIndices.get(value);
      if (index === undefined) {
        index = strings.length;
        strings.push(value);
        stringIndices.set(value, index);
      }
      return -index - 1;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new Error("Lowering-recipe facts may contain only finite numbers");
      // Negative integers occur in generated enum domains. Raw strings are
      // otherwise unused by the encoded stream, so they are an unambiguous and
      // compact escape without stealing a numeric value from the source data.
      return value < 0 ? `!${JSON.stringify(value)}` : value;
    }
    if (Array.isArray(value)) return [ARRAY_TAG, ...value.map(encode)];
    if (value && typeof value === "object") {
      const keys = Object.keys(value);
      const signature = JSON.stringify(keys);
      let shape = shapeIndices.get(signature);
      if (shape === undefined) {
        shape = shapes.length;
        shapes.push(keys);
        shapeIndices.set(signature, shape);
      }
      return [shape, ...keys.map((key) => encode(value[key]))];
    }
    if (value === null || typeof value === "boolean") return value;
    throw new Error(`Lowering-recipe facts cannot encode ${typeof value}`);
  };

  return {
    schemaVersion: RECIPE_SCHEMA_VERSION,
    kind: BINDING_LOWERING_RECIPE_KIND,
    inputPaths: structuredClone(sentinel.inputPaths),
    strings,
    shapes,
    root: encode(body)
  };
}

/** Reconstruct the canonical lowering plan using package code only. */
export function emitBindingLoweringPlan(facts) {
  if (!facts || facts.schemaVersion !== RECIPE_SCHEMA_VERSION ||
      facts.kind !== BINDING_LOWERING_RECIPE_KIND || !Array.isArray(facts.strings) ||
      !Array.isArray(facts.shapes) || !Array.isArray(facts.root) || !facts.inputPaths) {
    throw new Error("Unsupported binding-lowering recipe facts");
  }
  if (facts.strings.some((value) => typeof value !== "string") ||
      facts.shapes.some((shape) => !Array.isArray(shape) ||
        shape.some((key) => typeof key !== "string" || key.length === 0))) {
    throw new Error("Binding-lowering recipe dictionaries are malformed");
  }

  const decode = (encoded) => {
    if (typeof encoded === "number") {
      if (!Number.isInteger(encoded)) return encoded;
      if (encoded >= 0) return encoded;
      const value = facts.strings[-encoded - 1];
      if (value === undefined) throw new Error(`Binding-lowering recipe string index is out of range: ${encoded}`);
      return value;
    }
    if (typeof encoded === "string") {
      if (!/^!-(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$/iu.test(encoded)) {
        throw new Error("Binding-lowering recipe contains an invalid numeric escape");
      }
      return Number(encoded.slice(1));
    }
    if (encoded === null || typeof encoded === "boolean") return encoded;
    if (!Array.isArray(encoded) || encoded.length === 0 || !Number.isInteger(encoded[0])) {
      throw new Error("Binding-lowering recipe contains an invalid node");
    }
    if (encoded[0] === ARRAY_TAG) return encoded.slice(1).map(decode);
    const shape = facts.shapes[encoded[0]];
    if (!shape || encoded.length !== shape.length + 1) {
      throw new Error(`Binding-lowering recipe shape is invalid: ${encoded[0]}`);
    }
    return Object.fromEntries(shape.map((key, index) => [key, decode(encoded[index + 1])]));
  };

  const body = decode(facts.root);
  if (!body || body.schemaVersion !== 2 || !body.inputHashes || !Array.isArray(body.units)) {
    throw new Error("Binding-lowering recipe did not reconstruct canonical plan schema v2");
  }
  const plan = { ...body, planSha256: sha256(JSON.stringify(body)) };
  return { plan, source: json(plan) };
}

/** Build the content key and sentinel for the locally emitted plan. */
export function emitBindingLoweringPlanSentinel(facts, emitted, emitterSource) {
  if (!emitted?.plan || typeof emitted.source !== "string") {
    throw new Error("Lowering-plan sentinel requires an emitted plan and source bytes");
  }
  const generatorSha256 = sha256(emitterSource);
  const inputHashes = emitted.plan.inputHashes;
  const inputPaths = facts.inputPaths;
  const cacheKey = sha256(JSON.stringify({ generatorSha256, inputHashes, inputPaths, rootSchema: 1 }));
  return {
    schemaVersion: 1,
    generator: BINDING_LOWERING_RECIPE_EMITTER,
    generatorSha256,
    inputPaths,
    inputHashes,
    cacheKey,
    output: "packages/bindings/generated/defold-binding-lowering-plan.json",
    outputBytes: Buffer.byteLength(emitted.source),
    outputSha256: sha256(emitted.source),
    planSha256: emitted.plan.planSha256
  };
}
