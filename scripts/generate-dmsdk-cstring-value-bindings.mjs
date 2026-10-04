import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  indexDmSdkCStringValuePlan,
  validateDmSdkCStringValuePolicy,
} from "../packages/compiler/src/dmsdk-cstring-value-plan.mjs";
import {
  createDmSdkCStringValueRecipeFacts,
  DMSDK_CSTRING_VALUE_RECIPE_FACTS_NAME,
  renderDmSdkCStringValueOutputs,
} from "../packages/compiler/src/dmsdk-cstring-value-output-emitter.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const relative = Object.freeze({
  projection: "packages/bindings/generated/defold-dmsdk-projection-ir.json",
  sdkIr: "packages/bindings/generated/defold-sdk-ir.json",
  plan: "packages/bindings/generated/defold-dmsdk-cstring-value-plan.json",
  policy: "packages/bindings/overrides/dmsdk-cstring-value-bindings.json",
  report: "packages/bindings/generated/defold-dmsdk-cstring-value-bindings.json",
  header: "defold/defold_hermes/include/defold_hermes/generated_dmsdk_cstring_value.h",
  runtime: "defold/defold_hermes/src/generated_dmsdk_cstring_value_runtime.cpp",
  native: "defold/defold_hermes/src/generated_dmsdk_cstring_value.cpp",
  jsiHeader: "defold/defold_hermes/include/defold_hermes/generated_dmsdk_cstring_value_jsi.hpp",
  jsi: "defold/defold_hermes/src/generated_dmsdk_cstring_value_jsi.cpp",
  browser: "defold/defold_hermes/lib/web/generated_dmsdk_cstring_value.js",
  typescript: "packages/sdk/src/generated/dmsdk/cstring-value.ts",
  staticHermes: "packages/static-hermes/src/generated/dmsdk-cstring-value.ts",
});

function options(argv) {
  const value = {
    check: false,
    outputRoot: root,
    projection: relative.projection,
    sdkIr: relative.sdkIr,
    plan: relative.plan,
    policy: relative.policy,
  };
  for (let index = 0; index < argv.length; ++index) {
    if (argv[index] === "--check") value.check = true;
    else if (argv[index] === "--output-root") value.outputRoot = path.resolve(argv[++index]);
    else if (argv[index] === "--projection") value.projection = path.resolve(argv[++index]);
    else if (argv[index] === "--sdk-ir") value.sdkIr = path.resolve(argv[++index]);
    else if (argv[index] === "--plan") value.plan = path.resolve(argv[++index]);
    else if (argv[index] === "--policy") value.policy = path.resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  return value;
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
function stableId(row) {
  return Number.parseInt(sha256(row.projectionId).slice(0, 8), 16) >>> 0;
}

function enumDomains(entries, sdkIr) {
  const required = [
    ...new Set(
      entries
        .flatMap(({ row }) => row.signature.parameters.map(({ type }) => type))
        .filter(({ kind: value }) => value === "enum")
        .map(({ name }) => name),
    ),
  ].sort();
  const declarations = new Map(
    sdkIr.declarations.filter(({ kind }) => kind === "enum").map((declaration) => [declaration.name, declaration]),
  );
  return required.map((name) => {
    const declaration = declarations.get(name);
    assert.ok(declaration, `Missing SDK IR enum declaration for ${name}`);
    const members = declaration.members.filter(({ name: member }) => !/(?:^|_)(?:MAX|COUNT|NUM)(?:_|$)/.test(member));
    assert.ok(members.length > 0, `${name}: no callable enum members after sentinel filtering`);
    const scope = name.includes("::") ? name.slice(0, name.lastIndexOf("::")) : "";
    return {
      name,
      members: members.map(({ name: member, value }) => ({
        name: `${scope ? `${scope}::` : ""}${member}`,
        value,
      })),
    };
  });
}

function storageShape(entries) {
  const counts = entries.map(({ row }) => ({
    strings: row.signature.parameters.filter(({ type }) => type.kind === "cstring").length,
    scalars: row.signature.parameters.filter(({ type }) => type.kind !== "cstring").length,
  }));
  return {
    strings: Math.max(1, ...counts.map(({ strings }) => strings)),
    scalars: Math.max(1, ...counts.map(({ scalars }) => scalars)),
  };
}

async function writeOrCheck(outputRoot, name, content, check) {
  const target = path.join(outputRoot, name);
  if (check) assert.equal(await readFile(target, "utf8"), content, `${name} is stale`);
  else {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

async function main() {
  const opt = options(process.argv.slice(2));
  const inputPath = (value) => (path.isAbsolute(value) ? value : path.join(root, value));
  const [projectionRaw, irRaw, planRaw, policyRaw] = await Promise.all([
    readFile(inputPath(opt.projection), "utf8"),
    readFile(inputPath(opt.sdkIr), "utf8"),
    readFile(inputPath(opt.plan), "utf8"),
    readFile(inputPath(opt.policy), "utf8"),
  ]);
  const projection = JSON.parse(projectionRaw);
  const sdkIr = JSON.parse(irRaw);
  const plan = JSON.parse(planRaw);
  const policy = JSON.parse(policyRaw);
  assert.equal(projection.schemaVersion, 1, "C-string projection schema drifted");
  assert.equal(sdkIr.schemaVersion, 1, "C-string SDK IR schema drifted");
  assert.equal(projection.defoldRevision, sdkIr.defoldRevision, "C-string projection and SDK IR revisions differ");
  validateDmSdkCStringValuePolicy(policy);
  const recipe = policy.recipe;
  const decisions = indexDmSdkCStringValuePlan(plan, {
    revision: projection.defoldRevision,
    sourceHashes: { projection: sha256(projectionRaw), sdkIr: sha256(irRaw), policy: sha256(policyRaw) },
    inputs: {
      projection,
      sdkIr,
      policy,
      texts: { projection: projectionRaw, sdkIr: irRaw, policy: policyRaw },
    },
  });
  const rows = new Map(projection.rows.map((row) => [row.id, row]));
  const classified = [...decisions.values()].map((decision) => {
    const row = rows.get(decision.declarationId);
    assert.ok(row, `C-string plan declaration is absent from the projection: ${decision.declarationId}`);
    return {
      row,
      rule: decision.fallback ? { id: decision.blocker } : null,
      contract: decision.contract,
      semantics: decision.semantics,
      typescriptName: decision.typescriptName,
      patternDecision: {
        schemaVersion: 1,
        declarationId: decision.declarationId,
        patternId: decision.patternId,
        family: decision.family,
        emitter: decision.emitter,
        fallback: decision.fallback,
        priority: decision.priority,
        cost: decision.cost,
        trace: decision.trace,
      },
      stableId: stableId(row),
    };
  });
  const entries = classified.filter(({ rule }) => !rule);
  const blocked = classified.filter(({ rule }) => rule);
  assert.equal(new Set(classified.map(({ stableId: value }) => value)).size, classified.length, "Stable ID collision");
  const storage = storageShape(entries);
  const domains = enumDomains(entries, sdkIr);
  const recipeFacts = createDmSdkCStringValueRecipeFacts(entries, recipe, domains);
  const rendered = renderDmSdkCStringValueOutputs(recipeFacts);
  const artifacts = new Map([
    [relative.header, rendered.header],
    [relative.runtime, rendered.runtime],
    [relative.native, rendered.native],
    [relative.jsiHeader, rendered.jsiHeader],
    [relative.jsi, rendered.jsi],
    [relative.browser, rendered.browser],
    [relative.typescript, rendered.typescript],
    [relative.staticHermes, rendered.staticHermes],
  ]);
  const report = {
    schemaVersion: 1,
    defoldRevision: projection.defoldRevision,
    sources: {
      projection: relative.projection,
      sdkIr: relative.sdkIr,
      plan: relative.plan,
      policy: relative.policy,
      hashes: {
        projection: sha256(projectionRaw),
        sdkIr: sha256(irRaw),
        plan: sha256(planRaw),
        policy: sha256(policyRaw),
      },
    },
    selector: plan.eligibility,
    coverage: {
      candidates: decisions.size,
      generated: entries.length,
      blocked: blocked.length,
      nativeAbiGenerated: entries.length,
      headerObjectCompiled: 0,
      pinnedEngineLinked: 0,
      stubAbiLinkedAndRuntimeTested: 0,
      nativeDynamicHermesAdapterGenerated: entries.length,
      nativeStaticHermesDirectMemoryAbiGenerated: entries.length,
      browserDirectMemoryDescriptorGenerated: entries.length,
      allTargetConformant: 0,
    },
    stringPolicy: {
      input:
        "The staged JavaScript adapter deliberately narrows const char* inputs to non-null JavaScript strings, uses the host JSI UTF-8 conversion, rejects embedded NUL, and synthesizes the terminator. Lone-surrogate handling therefore follows the selected JSI engine and remains outside cross-target conformance until a shared UTF-16-to-UTF-8 policy is generated. The C ABI itself continues to accept exact caller-provided non-NUL byte views; this policy does not claim every native byte domain is intrinsically UTF-8.",
      result:
        "Revision-derived result contracts explicitly choose nullable or non-null and decode copied null-terminated native bytes as UTF-8. Public IR documentation supplies the semantic evidence; it does not prove arbitrary engine-returned bytes are valid Unicode.",
      unresolved:
        "A candidate whose revision documentation and ABI shape do not select one structural recipe is blocked as cstring-semantic-contract-unresolved.",
    },
    abi: {
      input:
        "exact byte view; null data is valid only with zero length and means an empty string; embedded NUL rejected; terminator synthesized in bounded caller/TLS scratch",
      enumInput:
        "exact declared-value membership generated from pinned SDK IR; sentinel COUNT/MAX/NUM enumerators are rejected",
      enumDomains: Object.fromEntries(domains.map(({ name, members }) => [name, members])),
      output:
        "immediate overlap-safe copy to caller-owned dst/capacity/out_required/present; capacity includes the required trailing NUL, so capacity == required is too small for a present result",
      browserDescriptor:
        "route-specific scalar/enum input kinds, exact result lane width, result nullability, memory layouts, and string policy are generated; the descriptor remains private and unregistered",
      status: "fixed-width uint32_t / Static Hermes c_uint",
      storage,
      tlsScratchCapacity: recipe.scratchCapacity,
      reentrant: "mark/reset frames on thread-local or caller-owned scratch",
      allocation:
        "generated C ABI contains no explicit allocation primitive; an independent test observes zero warmed C++ operator-new calls. Caller-owned scratch is the strict caller-controlled capacity path; TLS scratch is a bounded convenience path. Engine implementations and JS string conversion are outside this claim",
    },
    truthBoundary:
      "Private staging only: the TypeScript wrapper is not exported from the SDK barrel, the JSI installer is not registered, the Static Hermes artifact is not compiled into an application, the browser descriptor is not installed by a public module, and the guarded native sources are not linked into a production runtime target. This generated report claims generation only and intentionally records compile/link/runtime evidence as zero. tests/dmsdk-cstring-value-bindings.test.mjs independently object-compiles the generated native, runtime, and JSI units against pinned headers and links/runs every native adapter against ABI-compatible stubs. Pinned Defold engine linkage, extension retention, target execution, and engine-allocation observations remain unproven; generated does not mean engine-proven.",
    declarations: classified.map(({ row, rule, contract, semantics, patternDecision, stableId: value }) => ({
      id: row.id,
      projectionId: row.projectionId,
      stableId: value,
      denseId: rule ? null : entries.findIndex(({ row: candidateRow }) => candidateRow.id === row.id),
      symbol: row.symbol,
      provenance: row.provenance,
      disposition: rule ? "blocked" : "generated",
      blocker: rule?.id ?? null,
      universalFallback: rule ? "retained" : "retained-usage-materialized-recipe",
      stringContract: contract ? { ...contract, semanticEvidence: semantics.evidence } : null,
      blockerEvidence: rule ? semantics.evidence : null,
      patternDecision,
      targetDisposition: rule
        ? { nativeDynamicHermes: "blocked", nativeStaticHermes: "blocked", html5BrowserHost: "blocked" }
        : {
            typescriptSdk: "staged-private-not-barrel-exported",
            nativeDynamicHermes: "staged-private-jsi-unregistered-unlinked",
            nativeStaticHermes: "staged-private-c-abi-uncompiled-unlinked",
            html5BrowserHost: "staged-private-descriptor-unregistered-unlinked",
          },
    })),
    artifacts: [...artifacts.keys()],
    artifactHashes: Object.fromEntries([...artifacts].map(([name, content]) => [name, sha256(content)])),
  };
  artifacts.set(
    `packages/bindings/generated/${DMSDK_CSTRING_VALUE_RECIPE_FACTS_NAME}`,
    `${JSON.stringify(recipeFacts, null, 2)}\n`,
  );
  artifacts.set(relative.report, `${JSON.stringify(report, null, 2)}\n`);
  for (const [name, content] of artifacts) await writeOrCheck(opt.outputRoot, name, content, opt.check);
  process.stdout.write(
    `${opt.check ? "Verified" : "Generated"} ${entries.length}/${decisions.size} dmSDK C-string/value adapters; ${blocked.length} fail closed.\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
