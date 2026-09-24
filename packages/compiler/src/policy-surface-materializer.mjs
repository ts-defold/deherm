import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  buildApiTrees,
  createTypeRenderer as createScriptTypeRenderer,
  generateIndex as generateScriptIndex,
  generateModules as generateScriptModules,
  generateRuntime as generateScriptRuntime,
  generateTypes as generateScriptTypes
} from "./sdk/script-sdk.mjs";
import {
  createTypeRenderer as createDmSdkTypeRenderer,
  generateRuntime as generateDmSdkRuntime,
  generateTypes as generateDmSdkTypes
} from "./sdk/dmsdk-sdk.mjs";
import {
  generateDmSdkBrowserArena,
  generateDmSdkNamedScalar,
  generateDmSdkScalar,
  generateDmSdkUniversal,
  generateScriptBrowserTargetSupport,
  generateScriptHandleLowering,
  generateScriptUrlTargetSupport,
  generateScriptUniversalValue,
  generateScriptValueTargetSupport
} from "./sdk/support-sdk.mjs";
import { DEFOLD_REVISION_TOKEN, restoreDefoldRevision, sealObject } from "./api-policy.mjs";
import { stableBindingId } from "./binding-identity.mjs";
import { assertDmSdkUniversalStaticFrameCapacity } from "./dmsdk-universal-static-frame.mjs";
import { isRevisionOutput } from "./revision-output-layout.mjs";
import { nativeArtifactCompatibility } from "./defold-toolchain-pins.mjs";
import {
  generateRevisionOutput,
  LOCALLY_RENDERED_OUTPUT_RECIPES
} from "./revision-output-emitter.mjs";
import {
  BINDING_LOWERING_RECIPE_CAPABILITY,
  BINDING_LOWERING_RECIPE_NAME,
  emitBindingLoweringPlan,
  emitBindingLoweringPlanSentinel
} from "./binding-lowering-plan-recipe.mjs";

const SCRIPT_IR = "defold-script-api-ir.json";
const SCRIPT_CONSTANT_LOWERING = "defold-script-constant-lowering.json";
const SCRIPT_DOCUMENTATION = "defold-script-sdk-documentation.json";
const DMSDK_IR = "defold-sdk-ir.json";
const DMSDK_DOCUMENTATION = "defold-dmsdk-sdk-documentation.json";
const HANDLE_LOWERING = "defold-script-handle-lowering.json";
const DOCUMENT_RECIPE = "policy.compiler-document.copy-json.v1";
const DOCUMENT_RECIPES = new Set([
  DOCUMENT_RECIPE,
  BINDING_LOWERING_RECIPE_CAPABILITY,
  "policy.compiler-document.component-proxy-contract.v1",
  "policy.compiler-document.component-proxy-contract.v2",
  "policy.compiler-document.defold-value-layouts.v1",
  "policy.compiler-document.defold-value-layouts.v2",
  "policy.compiler-document.dmsdk-universal.v1"
]);
const OUTPUT_RECIPE = "output.compatibility-source.copy.v1";
const SDK_RECIPES = Object.freeze({
  "script/types.ts": "sdk.script.types.render.v1",
  "script/modules.ts": "sdk.script.modules.render.v1",
  "script/runtime.ts": "sdk.script.runtime.render.v1",
  "script/index.ts": "sdk.script.index.render.v1",
  "dmsdk/types.ts": "sdk.dmsdk.types.render.v1",
  "dmsdk/runtime.ts": "sdk.dmsdk.runtime.render.v1",
  "dmsdk/index.ts": "sdk.dmsdk.index.render.v1",
  "script/handle-lowering.ts": "sdk.script.handle-lowering.render.v1",
  "script/universal-value-bindings.ts": "sdk.script.universal-value.render.v1",
  "script/browser-target-support.ts": "sdk.script.browser-target-support.render.v1",
  "dmsdk/scalar.ts": "sdk.dmsdk.scalar.render.v1",
  "dmsdk/universal.ts": "sdk.dmsdk.universal.render.v1",
  "dmsdk/browser-arena.ts": "sdk.dmsdk.browser-arena.render.v1",
  "dmsdk/named-scalar.ts": "sdk.dmsdk.named-scalar.render.v1",
  "script/url-target-support.ts": "sdk.script.url-target-support.render.v1",
  "script/value-target-support.ts": "sdk.script.value-target-support.render.v1"
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function manifestTreeSha256(entries) {
  return sha256(JSON.stringify(Object.entries(entries)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => [name, value.sha256])));
}

function documentationEntries(ir, documentation, { kind, collection }) {
  if (documentation?.schemaVersion !== 1 || documentation?.kind !== kind ||
      documentation?.defoldRevision !== ir.defoldRevision || !Array.isArray(documentation?.[collection])) {
    throw new Error(`${collection}: invalid SDK documentation recipe input`);
  }
  const known = new Set((collection === "functions" ? ir.functions : ir.declarations).map(({ id }) => id));
  const allowed = new Set(collection === "functions" ? ["id", "deprecated"] : ["id", "deprecated", "notes"]);
  const entries = new Map();
  for (const record of documentation[collection]) {
    if (!record || typeof record.id !== "string" || !known.has(record.id) || entries.has(record.id)) {
      throw new Error(`${collection}: invalid or duplicate SDK documentation identity ${JSON.stringify(record?.id)}`);
    }
    if (Object.keys(record).some((key) => !allowed.has(key)) ||
        (record.deprecated !== undefined && typeof record.deprecated !== "string") ||
        (record.notes !== undefined && (!Array.isArray(record.notes) || record.notes.some((note) => typeof note !== "string")))) {
      throw new Error(`${collection}: invalid SDK documentation fields for ${record.id}`);
    }
    entries.set(record.id, record);
  }
  return entries;
}

function scriptModel(ir, documentation) {
  const docs = documentationEntries(ir, documentation, {
    kind: "deherm.script-sdk-documentation",
    collection: "functions"
  });
  return {
    files: [],
    classes: ir.types.filter(({ kind }) => kind === "class"),
    aliases: ir.types.filter(({ kind }) => kind === "alias"),
    enums: ir.types.filter(({ kind }) => kind === "enum"),
    functions: ir.functions.map((fn) => ({ ...fn, ...docs.get(fn.id), stableId: stableBindingId(fn.id) })),
    globals: [],
    duplication: []
  };
}

function semanticHandleTypes(handleLowering) {
  const result = new Map();
  for (const kind of handleLowering.handleKinds ?? []) {
    for (const rawType of kind.rawTypes ?? []) result.set(rawType, kind.id);
  }
  return result;
}

function renderScriptSdk(scriptIr, documentation, handleLowering, constantLowering) {
  const model = scriptModel(scriptIr, documentation);
  const renderer = createScriptTypeRenderer(model);
  const trees = buildApiTrees(model);
  return {
    "script/types.ts": generateScriptTypes(model, renderer, trees, semanticHandleTypes(handleLowering)),
    "script/modules.ts": generateScriptModules(trees, new Map(
      constantLowering.entries.map((entry) => [entry.name, entry]))),
    "script/runtime.ts": generateScriptRuntime(),
    "script/index.ts": generateScriptIndex(trees)
  };
}

function renderDmSdk(ir, documentation) {
  const docs = documentationEntries(ir, documentation, {
    kind: "deherm.dmsdk-sdk-documentation",
    collection: "declarations"
  });
  const documentedIr = {
    ...ir,
    declarations: ir.declarations.map((declaration) => ({ ...declaration, ...docs.get(declaration.id) }))
  };
  const renderer = createDmSdkTypeRenderer(documentedIr);
  const normalize = (source) => source.endsWith("\n") ? source : `${source}\n`;
  return {
    "dmsdk/types.ts": normalize(generateDmSdkTypes(documentedIr, renderer)),
    "dmsdk/runtime.ts": normalize(generateDmSdkRuntime(documentedIr, renderer)),
    "dmsdk/index.ts": "// Generated by packages/compiler/src/sdk/dmsdk-sdk.mjs. Do not edit.\nexport * from \"./types\";\nexport * from \"./runtime\";\nexport * from \"./scalar\";\nexport * from \"./enum-value\";\nexport * from \"./universal\";\n"
  };
}

function compilerObject(resolvedPolicy) {
  const object = resolvedPolicy?.objects?.get?.("@compiler")?.value ?? resolvedPolicy?.compiler;
  if (!object || object.kind !== "deherm.policy.compiler-surface") {
    throw new Error("The resolved policy has no authenticated @compiler surface");
  }
  return object;
}

function toolchainObject(resolvedPolicy, revision) {
  const object = resolvedPolicy?.objects?.get?.("@toolchain")?.value;
  if (!object || object.kind !== "deherm.policy.toolchain") {
    throw new Error("The resolved policy has no authenticated @toolchain surface");
  }
  return restoreDefoldRevision(object, revision);
}

function confinedRelativePath(value, label, extension) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\") ||
      path.posix.isAbsolute(value) || path.posix.normalize(value) !== value ||
      value === ".." || value.startsWith("../") || (extension && !value.endsWith(extension))) {
    throw new Error(`${label}: unsafe relative path ${JSON.stringify(value)}`);
  }
  return value;
}

function confinedOutputPath(value) {
  confinedRelativePath(value, "compiler output");
  if (!isRevisionOutput(value)) {
    throw new Error(`compiler output: unsupported owned root ${JSON.stringify(value)}`);
  }
  return value;
}

function referencedObject(resolvedPolicy, key, kind, name) {
  const object = resolvedPolicy?.objects?.get?.(key)?.value;
  if (!object || object.kind !== kind || object.namespace !== key || object.name !== name) {
    throw new Error(`${name}: invalid or missing authenticated policy object ${JSON.stringify(key)}`);
  }
  return object;
}

/** Validate and resolve the compiler-owned surface manifest without filesystem I/O. */
export function resolveCompilerSurface(resolvedPolicy, revision) {
  const compiler = restoreDefoldRevision(compilerObject(resolvedPolicy), revision);
  if (compiler.manifestVersion !== 2) {
    return compiler;
  }
  if (compiler.documents?.schemaVersion !== 1 ||
      compiler.documents?.kind !== "deherm.policy.compiler-document-manifest" ||
      compiler.sdk?.schemaVersion !== 1 || compiler.sdk?.kind !== "deherm.policy.sdk-manifest" ||
      compiler.outputs?.schemaVersion !== 1 || compiler.outputs?.kind !== "deherm.policy.output-manifest") {
    throw new Error("Policy compiler surface has an unsupported manifest schema");
  }
  const recipes = compiler.realizationRecipes;
  if (!recipes || typeof recipes !== "object") throw new Error("Policy compiler surface has no realization recipes");
  const documentEntries = compiler.documents.entries ?? {};
  const sdkEntries = compiler.sdk.entries ?? {};
  const outputEntries = compiler.outputs.entries ?? {};
  const documents = {};
  for (const [name, record] of Object.entries(documentEntries)) {
    confinedRelativePath(name, "compiler document", ".json");
    if (!record || typeof record.object !== "string" || record.recipe !== recipes.documents?.[name] ||
        !DOCUMENT_RECIPES.has(record.recipe)) {
      throw new Error(`${name}: invalid compiler-document manifest record`);
    }
    const object = referencedObject(resolvedPolicy, record.object, "deherm.policy.compiler-document", name);
    documents[name] = restoreDefoldRevision(object.value, revision);
  }
  const staleDocumentRecipes = Object.keys(recipes.documents ?? {}).filter((name) => !(name in documentEntries));
  if (staleDocumentRecipes.length > 0) {
    throw new Error(`Compiler-document recipes name absent entries: ${staleDocumentRecipes.join(", ")}`);
  }
  const sdk = {};
  for (const [relative, record] of Object.entries(sdkEntries)) {
    confinedRelativePath(relative, "SDK output", ".ts");
    if (!record || !/^[0-9a-f]{64}$/u.test(record.sha256 ?? "") ||
        record.recipe !== recipes.sdk?.[relative] || !Array.isArray(record.inputs) ||
        record.inputs.some((input) => !(input in documentEntries))) {
      throw new Error(`${relative}: invalid SDK manifest record`);
    }
    const expectedRecipe = record.mode === "render-and-verify"
      ? SDK_RECIPES[relative]
      : record.mode === "authenticated-compatibility-source"
        ? "sdk.compatibility-source.copy.v1"
        : undefined;
    if (!expectedRecipe || record.recipe !== expectedRecipe) {
      throw new Error(`${relative}: unsupported SDK realization recipe ${JSON.stringify(record.recipe)}`);
    }
    let source;
    if (record.mode === "authenticated-compatibility-source") {
      if (record.recipeInput !== undefined) {
        throw new Error(`${relative}: compatibility SDK source may not carry a recipe input`);
      }
      const object = referencedObject(
        resolvedPolicy, record.sourceObject, "deherm.policy.compiler-sdk-source", relative);
      source = restoreDefoldRevision(object.source, revision);
    } else if (record.sourceObject !== undefined) {
      throw new Error(`${relative}: locally rendered SDK output may not carry a source object`);
    }
    sdk[relative] = { ...record, source };
  }
  const staleSdkRecipes = Object.keys(recipes.sdk ?? {}).filter((name) => !(name in sdkEntries));
  if (staleSdkRecipes.length > 0) {
    throw new Error(`SDK recipes name absent entries: ${staleSdkRecipes.join(", ")}`);
  }
  const outputs = {};
  for (const [relative, record] of Object.entries(outputEntries)) {
    confinedOutputPath(relative);
    const inputs = record?.inputs ?? [];
    if (!record || !/^[0-9a-f]{64}$/u.test(record.sha256 ?? "") ||
        record.recipe !== recipes.outputs?.[relative] || !Array.isArray(inputs) ||
        inputs.some((input) => !(input in documentEntries))) {
      throw new Error(`${relative}: invalid compiler-output manifest record`);
    }
    if (record.mode === "authenticated-compatibility-source" && record.recipe === OUTPUT_RECIPE) {
      const object = referencedObject(
        resolvedPolicy, record.sourceObject, "deherm.policy.compiler-output-source", relative);
      outputs[relative] = { ...record, inputs, source: restoreDefoldRevision(object.source, revision) };
    } else if (record.mode === "render-and-verify" &&
        record.recipe === LOCALLY_RENDERED_OUTPUT_RECIPES[relative] &&
        record.sourceObject === undefined) {
      outputs[relative] = { ...record, inputs };
    } else {
      throw new Error(`${relative}: unsupported compiler-output realization recipe ${JSON.stringify(record.recipe)}`);
    }
  }
  const staleOutputRecipes = Object.keys(recipes.outputs ?? {}).filter((name) => !(name in outputEntries));
  if (staleOutputRecipes.length > 0) {
    throw new Error(`Compiler-output recipes name absent entries: ${staleOutputRecipes.join(", ")}`);
  }
  return { ...compiler, documents, sdk, outputs };
}

async function assertNoSymlinkComponents(boundary, target) {
  const boundaryStatus = await lstat(boundary)
    .catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (boundaryStatus?.isSymbolicLink()) {
    throw new Error(`Policy materialization refuses symbolic link ${boundary}`);
  }
  const relative = path.relative(boundary, target);
  if (relative === "" || relative === ".") return;
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Policy materialization target escapes its output boundary: ${target}`);
  }
  let cursor = boundary;
  for (const component of relative.split(path.sep)) {
    cursor = path.join(cursor, component);
    const status = await lstat(cursor).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
    if (!status) break;
    if (status.isSymbolicLink()) throw new Error(`Policy materialization refuses symbolic link ${cursor}`);
  }
}

async function writeStable(file, source, boundary) {
  await assertNoSymlinkComponents(boundary, file);
  await mkdir(path.dirname(file), { recursive: true });
  await assertNoSymlinkComponents(boundary, file);
  const current = await readFile(file, "utf8").catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (current === source) return false;
  await writeFile(file, source);
  return true;
}

async function realizeCompilerDocuments(input) {
  const documents = structuredClone(input);
  const planName = "defold-binding-lowering-plan.json";
  const sentinelName = "defold-binding-lowering-plan.sentinel.json";
  const recipeFacts = documents[BINDING_LOWERING_RECIPE_NAME];
  if (recipeFacts) {
    const emitted = emitBindingLoweringPlan(recipeFacts);
    const emitterSource = await readFile(new URL("./binding-lowering-plan-recipe.mjs", import.meta.url));
    delete documents[BINDING_LOWERING_RECIPE_NAME];
    documents[planName] = emitted.plan;
    documents[sentinelName] = emitBindingLoweringPlanSentinel(recipeFacts, emitted, emitterSource);
    return documents;
  }
  const plan = documents[planName];
  const previousSentinel = documents[sentinelName];
  if (!plan || !previousSentinel) return documents;

  // Policy serialization canonicalizes object keys. The historical plan digest
  // is insertion-order-sensitive JSON, so copying it after canonicalization
  // creates a self-inconsistent plan. Realize both identities from the selected
  // facts and this package's emitter instead of retaining checkout bytes.
  const { planSha256: _oldPlanSha256, ...planBody } = plan;
  const realizedPlan = { ...planBody, planSha256: sha256(JSON.stringify(planBody)) };
  const planSource = json(realizedPlan);
  const generatorSource = await readFile(new URL("./generate-binding-lowering-plan.mjs", import.meta.url));
  const generatorSha256 = sha256(generatorSource);
  const inputPaths = previousSentinel.inputPaths;
  const inputHashes = realizedPlan.inputHashes;
  if (!inputPaths || !inputHashes) throw new Error("Lowering-plan policy has no cache identity inputs");
  const cacheKey = sha256(JSON.stringify({ generatorSha256, inputHashes, inputPaths, rootSchema: 1 }));
  documents[planName] = realizedPlan;
  documents[sentinelName] = {
    schemaVersion: 1,
    generator: "packages/compiler/src/generate-binding-lowering-plan.mjs",
    generatorSha256,
    inputPaths,
    inputHashes,
    cacheKey,
    output: "packages/bindings/generated/defold-binding-lowering-plan.json",
    outputBytes: Buffer.byteLength(planSource),
    outputSha256: sha256(planSource),
    planSha256: realizedPlan.planSha256
  };
  return documents;
}

/**
 * Materialize one complete, revision-keyed engine surface from authenticated
 * policy objects and compiler code shipped in the npm package.
 *
 * Core SDK files are rendered locally and checked against policy hashes.
 * Remaining support files are explicitly tagged compatibility snapshots until
 * their emitters are moved behind this package boundary; callers can therefore
 * distinguish local generation from authenticated materialization.
 */
export async function materializePolicySurface(resolvedPolicy, options = {}) {
  const revision = String(options.revision ?? resolvedPolicy?.revision ?? "").toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error(`Invalid Defold revision ${JSON.stringify(revision)}`);
  const outputRoot = path.resolve(options.outputRoot);
  const outputBoundary = path.resolve(options.outputBoundary ?? outputRoot);
  await assertNoSymlinkComponents(outputBoundary, outputRoot);
  const compiler = resolveCompilerSurface(resolvedPolicy, revision);
  const toolchain = toolchainObject(resolvedPolicy, revision);
  const documents = await realizeCompilerDocuments(compiler.documents ?? {});
  const recipes = compiler.realizationRecipes;
  if (!recipes || typeof recipes !== "object") throw new Error("Policy compiler surface has no realization recipes");
  for (const required of [SCRIPT_IR, SCRIPT_CONSTANT_LOWERING, SCRIPT_DOCUMENTATION, DMSDK_IR, DMSDK_DOCUMENTATION, HANDLE_LOWERING]) {
    if (!documents[required]) throw new Error(`Policy compiler surface is missing ${required}`);
  }
  const constantLowering = documents[SCRIPT_CONSTANT_LOWERING];
  if (constantLowering.schemaVersion !== 1 || constantLowering.kind !== "deherm.script-constant-lowering" ||
      constantLowering.defoldRevision !== revision || !Array.isArray(constantLowering.entries)) {
    throw new Error(`${SCRIPT_CONSTANT_LOWERING}: invalid policy constant-lowering document`);
  }
  assertDmSdkUniversalStaticFrameCapacity(documents["defold-dmsdk-universal-bindings.json"]);
  for (const name of Object.keys(documents)) {
    const loweringOutput = name === "defold-binding-lowering-plan.json" ||
      name === "defold-binding-lowering-plan.sentinel.json";
    const recipe = loweringOutput && recipes.documents?.[BINDING_LOWERING_RECIPE_NAME]
      ? recipes.documents[BINDING_LOWERING_RECIPE_NAME]
      : recipes.documents?.[name];
    if (!DOCUMENT_RECIPES.has(recipe)) {
      throw new Error(`${name}: unsupported compiler-document recipe ${JSON.stringify(recipes.documents?.[name])}`);
    }
  }

  const rendered = {
    ...renderScriptSdk(documents[SCRIPT_IR], documents[SCRIPT_DOCUMENTATION], documents[HANDLE_LOWERING], constantLowering),
    ...renderDmSdk(documents[DMSDK_IR], documents[DMSDK_DOCUMENTATION]),
    "script/handle-lowering.ts": generateScriptHandleLowering(documents[HANDLE_LOWERING]),
    "script/universal-value-bindings.ts": generateScriptUniversalValue(documents["defold-script-universal-value-bindings.json"]),
    "script/browser-target-support.ts": generateScriptBrowserTargetSupport(documents["defold-script-universal-value-bindings.json"]),
    ...(compiler.sdk?.["script/url-target-support.ts"]?.mode === "render-and-verify" ? {
      "script/url-target-support.ts": generateScriptUrlTargetSupport(compiler.sdk["script/url-target-support.ts"].recipeInput)
    } : {}),
    ...(compiler.sdk?.["script/value-target-support.ts"]?.mode === "render-and-verify" ? {
      "script/value-target-support.ts": generateScriptValueTargetSupport(compiler.sdk["script/value-target-support.ts"].recipeInput)
    } : {}),
    ...(compiler.sdk?.["dmsdk/named-scalar.ts"]?.mode === "render-and-verify" ? {
      "dmsdk/named-scalar.ts": generateDmSdkNamedScalar(compiler.sdk["dmsdk/named-scalar.ts"].recipeInput)
    } : {}),
    "dmsdk/scalar.ts": generateDmSdkScalar(documents["defold-dmsdk-scalar-thunks.json"], documents[DMSDK_IR]),
    "dmsdk/universal.ts": generateDmSdkUniversal(documents["defold-dmsdk-universal-bindings.json"]),
    "dmsdk/browser-arena.ts": generateDmSdkBrowserArena(documents["defold-dmsdk-universal-bindings.json"])
  };
  const sdk = compiler.sdk ?? {};
  const writes = [];
  for (const [relative, record] of Object.entries(sdk).sort(([left], [right]) => left.localeCompare(right))) {
    const expectedRecipe = record.mode === "render-and-verify"
      ? SDK_RECIPES[relative]
      : record.mode === "authenticated-compatibility-source"
        ? "sdk.compatibility-source.copy.v1"
        : undefined;
    if (!expectedRecipe || recipes.sdk?.[relative] !== expectedRecipe) {
      throw new Error(`${relative}: unsupported SDK realization recipe ${JSON.stringify(recipes.sdk?.[relative])}`);
    }
    const source = record.mode === "render-and-verify" ? rendered[relative] : record.source;
    if (typeof source !== "string") throw new Error(`${relative}: policy SDK record has no ${record.mode === "render-and-verify" ? "local renderer" : "authenticated source"}`);
    const canonicalSource = source.split(revision).join(DEFOLD_REVISION_TOKEN);
    const actual = sha256(canonicalSource);
    if (actual !== record.sha256) throw new Error(`${relative}: materialized SHA-256 ${actual} does not match policy ${record.sha256}`);
    if (await writeStable(path.join(outputRoot, "sdk", "generated", relative), source, outputBoundary)) writes.push(`sdk/generated/${relative}`);
  }
  for (const [relative, value] of Object.entries(documents).sort(([left], [right]) => left.localeCompare(right))) {
    if (await writeStable(path.join(outputRoot, "ir", relative), json(value), outputBoundary)) writes.push(`ir/${relative}`);
  }
  const sealedPolicyRoot = sealObject(resolvedPolicy.policy);
  const declaredPolicyRoot = resolvedPolicy?.entry?.policyRoot ?? resolvedPolicy?.policy?.rootHash ?? null;
  if (sealedPolicyRoot.hash !== declaredPolicyRoot) {
    throw new Error("Materialized policy root does not match its content-addressed index entry");
  }
  if (await writeStable(path.join(outputRoot, "policy-root.json"), sealedPolicyRoot.bytes, outputBoundary)) {
    writes.push("policy-root.json");
  }
  const sealedCompilerObject = sealObject(compilerObject(resolvedPolicy));
  if (sealedCompilerObject.hash !== resolvedPolicy.policy.subtrees?.["@compiler"]) {
    throw new Error("Compiler surface does not match the object authenticated by the policy root");
  }
  if (await writeStable(path.join(outputRoot, "compiler-object.json"), sealedCompilerObject.bytes, outputBoundary)) {
    writes.push("compiler-object.json");
  }
  const toolchainSource = json(toolchain);
  if (await writeStable(path.join(outputRoot, "ir", "defold-toolchain.json"), toolchainSource, outputBoundary)) {
    writes.push("ir/defold-toolchain.json");
  }
  let artifactsSource = null;
  if (options.artifacts) {
    if (options.artifacts.kind !== "deherm.policy.artifacts" || options.artifacts.defoldRevision !== revision) {
      throw new Error("Published artifact mapping does not describe the materialized Defold revision");
    }
    const declared = options.artifacts.artifacts?.["native-artifacts"]?.compatibility;
    const expected = nativeArtifactCompatibility(toolchain);
    if (declared?.kind !== expected.kind || declared.sha256 !== expected.sha256) {
      throw new Error("Published native artifacts are incompatible with the selected Defold toolchain policy");
    }
    artifactsSource = json(options.artifacts);
    if (await writeStable(path.join(outputRoot, "ir", "defold-artifacts.json"), artifactsSource, outputBoundary)) {
      writes.push("ir/defold-artifacts.json");
    }
  }
  const outputs = compiler.outputs ?? {};
  for (const [relative, record] of Object.entries(outputs).sort(([left], [right]) => left.localeCompare(right))) {
    const source = record.mode === "render-and-verify"
      ? generateRevisionOutput(relative, record.recipe, documents)
      : record.source;
    if (typeof source !== "string") throw new Error(`${relative}: compiler-output recipe has no source`);
    const canonicalSource = source.split(revision).join(DEFOLD_REVISION_TOKEN);
    const actual = sha256(canonicalSource);
    if (actual !== record.sha256) {
      throw new Error(`${relative}: materialized SHA-256 ${actual} does not match policy ${record.sha256}`);
    }
    const destination = path.join(outputRoot, "repository", relative);
    if (await writeStable(destination, source, outputBoundary)) writes.push(`repository/${relative}`);
  }

  const descriptor = {
    schemaVersion: 2,
    kind: "deherm.materialized-defold-surface",
    defoldRevision: revision,
    policyRoot: declaredPolicyRoot,
    compilerObjectSha256: resolvedPolicy.policy.subtrees?.["@compiler"] ?? null,
    documents: Object.keys(documents).sort(),
    ir: Object.fromEntries(Object.entries(documents).sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => [name, { sha256: sha256(json(value)) }])),
    toolchainSha256: sha256(toolchainSource),
    artifactsSha256: artifactsSource ? sha256(artifactsSource) : null,
    sdk: Object.fromEntries(Object.entries(sdk).sort(([left], [right]) => left.localeCompare(right)).map(([name, value]) => [name, {
      mode: value.mode,
      sha256: value.sha256
    }])),
    outputs: Object.fromEntries(Object.entries(outputs).sort(([left], [right]) => left.localeCompare(right)).map(([name, value]) => [name, {
      mode: value.mode,
      sha256: value.sha256,
      recipe: value.recipe
    }])),
    sdkTreeSha256: manifestTreeSha256(sdk),
    outputTreeSha256: manifestTreeSha256(outputs)
  };
  if (await writeStable(path.join(outputRoot, "surface.json"), json(descriptor), outputBoundary)) writes.push("surface.json");
  return { revision, outputRoot, descriptor, written: writes };
}
