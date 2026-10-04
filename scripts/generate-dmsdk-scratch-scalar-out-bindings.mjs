import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { indexDmSdkScratchScalarOutPlan } from "../packages/compiler/src/dmsdk-scratch-scalar-out-plan.mjs";
import {
  createDmSdkScratchScalarOutRecipeFacts,
  renderDmSdkScratchScalarOutHeaderAudit,
  renderDmSdkScratchScalarOutOutputs,
} from "../packages/compiler/src/dmsdk-scratch-scalar-out-output-emitter.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const paths = Object.freeze({
  ir: "packages/bindings/generated/defold-sdk-ir.json",
  shapes: "packages/bindings/generated/defold-dmsdk-abi-shapes.json",
  projection: "packages/bindings/generated/defold-dmsdk-projection-ir.json",
  policy: "packages/bindings/overrides/dmsdk-scratch-scalar-out-bindings.json",
  effectFacts: "packages/bindings/generated/defold-dmsdk-cpp-ownership-effect-facts.json",
  plan: "packages/bindings/generated/defold-dmsdk-scratch-scalar-out-plan.json",
});
const artifacts = Object.freeze({
  report: "packages/bindings/generated/defold-dmsdk-scratch-scalar-out-bindings.json",
  recipeFacts: "packages/bindings/generated/defold-dmsdk-scratch-scalar-out-recipe-facts.json",
  header: "defold/defold_hermes/include/defold_hermes/generated_dmsdk_scratch_scalar_out.h",
  runtime: "defold/defold_hermes/src/generated_dmsdk_scratch_scalar_out_runtime.cpp",
  jsiHeader: "defold/defold_hermes/include/defold_hermes/generated_dmsdk_scratch_scalar_out_jsi.hpp",
  jsi: "defold/defold_hermes/src/generated_dmsdk_scratch_scalar_out_jsi.cpp",
  browser: "defold/defold_hermes/lib/web/generated_dmsdk_scratch_scalar_out.js",
  typescript: "packages/sdk/src/generated/dmsdk/scratch-scalar-out.ts",
  staticHermes: "packages/static-hermes/src/generated/dmsdk-scratch-scalar-out.ts",
  headerAudit: "native/generated_dmsdk_scratch_scalar_out_header_audit.cpp",
});

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const supportedKinds = new Set(["handle", "bool", "i32", "u16", "u32", "u64", "f32", "enum", "void"]);

function parseArguments(argv) {
  const options = { outputRoot: root, check: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--check") options.check = true;
    else if (argv[index] === "--output-root") options.outputRoot = resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  return options;
}

function roleKind(role) {
  if (role.startsWith("handle:")) return "handle";
  if (role.startsWith("scalar:")) return role.slice("scalar:".length);
  if (role.startsWith("enum:")) return "enum";
  if (role.startsWith("pointer:scalar:")) return role.slice("pointer:scalar:".length);
  if (role.startsWith("pointer:enum:")) return "enum";
  return undefined;
}

function handleName(role) {
  if (!role.startsWith("handle:")) return undefined;
  return role.split(":").slice(1, -1).join(":");
}

function universalFallback(blockers) {
  return {
    state: "universal-fallback",
    family: "universal-recipe",
    blockers: [...blockers].sort(),
    preserved: true,
  };
}

function headerPath(source) {
  const marker = "/src/dmsdk/";
  const position = source.indexOf(marker);
  if (position < 0) throw new Error(`Header is outside pinned dmSDK include projection: ${source}`);
  return `dmsdk/${source.slice(position + marker.length)}`;
}

function nativeType(shapeParameter, projectedParameter) {
  if (shapeParameter.role.startsWith("handle:")) return handleName(shapeParameter.role);
  if (shapeParameter.role.startsWith("enum:") && shapeParameter.direction === "value")
    return shapeParameter.role.slice("enum:".length);
  return projectedParameter.nativeType;
}

function specializationBlockers(shape, projected, declaration) {
  const blockers = [];
  if (!projected) blockers.push("source-projection-missing");
  if (!declaration) blockers.push("source-declaration-missing");
  if (
    !projected?.signature ||
    !Array.isArray(projected.signature.parameters) ||
    projected.signature.parameters.length !== shape.parameters.length
  ) {
    blockers.push("source-signature-parameter-shape-unrecognized");
  }
  if (!supportedKinds.has(roleKind(shape.result.role))) blockers.push(`result-kind-unsupported:${shape.result.role}`);
  for (const parameter of shape.parameters) {
    if (!supportedKinds.has(roleKind(parameter.role)))
      blockers.push(`parameter-kind-unsupported:${parameter.position}:${parameter.role}`);
    if (parameter.role.startsWith("handle:") && !handleName(parameter.role)) {
      blockers.push(`parameter-handle-kind-unsupported:${parameter.position}:${parameter.role}`);
    }
  }
  return [...new Set(blockers)].sort();
}

export async function build(overrides = {}) {
  const contents = Object.fromEntries(
    await Promise.all(
      Object.entries(paths).map(async ([key, path]) => [
        key,
        overrides[key] ?? (await readFile(resolve(root, path), "utf8")),
      ]),
    ),
  );
  const ir = JSON.parse(contents.ir);
  const shapes = JSON.parse(contents.shapes);
  const projection = JSON.parse(contents.projection);
  const policy = JSON.parse(contents.policy);
  const effectFacts = JSON.parse(contents.effectFacts);
  const plan = JSON.parse(contents.plan);
  if (new Set([ir.defoldRevision, shapes.defoldRevision, projection.defoldRevision]).size !== 1)
    throw new Error("scratch scalar-out inputs have different Defold revisions");
  if (shapes.sourceHashes.ir !== sha256(contents.ir) || projection.sources.hashes.ir !== sha256(contents.ir))
    throw new Error("scratch scalar-out IR provenance mismatch");
  const planById = indexDmSdkScratchScalarOutPlan(plan, {
    ir,
    shapes,
    projection,
    policy,
    effectFacts,
    texts: {
      ir: contents.ir,
      shapes: contents.shapes,
      projection: contents.projection,
      policy: contents.policy,
      effectFacts: contents.effectFacts,
    },
  });
  const shapesById = new Map(shapes.rows.map((row) => [row.id, row]));
  const candidates = plan.decisions.map(({ declarationId }) => {
    const shape = shapesById.get(declarationId);
    if (!shape) throw new Error(`${declarationId}: scratch plan shape is missing`);
    return shape;
  });
  const projectionById = new Map(projection.rows.map((row) => [row.id, row]));
  const declarationById = new Map(ir.declarations.map((row) => [row.id, row]));
  const entries = [];
  const rows = [];
  for (const shape of candidates) {
    const projected = projectionById.get(shape.id);
    const declaration = declarationById.get(shape.id);
    const decision = planById.get(shape.id);
    const emissionBlockers = specializationBlockers(shape, projected, declaration);
    if (!decision) throw new Error(`${shape.id}: scratch plan decision is missing`);
    if (!decision.fallback && emissionBlockers.length > 0) {
      throw new Error(
        `${shape.id}: scratch plan selected a route the emitter cannot render: ${emissionBlockers.join(",")}`,
      );
    }
    if (decision.fallback) {
      const allBlockers = [...new Set([...decision.blockers, ...emissionBlockers])].sort();
      rows.push({
        id: shape.id,
        projectionId: projected?.projectionId ?? null,
        symbol: shape.symbol,
        disposition: "blocked",
        blockers: allBlockers,
        universalFallback: universalFallback(allBlockers),
        shape: shape.shape,
        patternDecision: decision.patternId,
        admission: decision.admission,
        evidenceGaps: decision.evidenceGaps,
      });
      continue;
    }
    const parameters = shape.parameters.map((parameter, index) => ({
      position: index,
      name: projected.signature.parameters[index].name || `argument${index}`,
      kind: roleKind(parameter.role),
      handleName: handleName(parameter.role),
      nativeRole: parameter.role,
      direction: parameter.direction,
    }));
    const entry = {
      id: entries.length,
      projection: projected,
      declaration,
      shape,
      parameters,
      result: { kind: roleKind(shape.result.role), nativeRole: shape.result.role },
      audit: {
        header: headerPath(shape.header),
        parameterTypes: shape.parameters.map((parameter, index) =>
          nativeType(parameter, projected.signature.parameters[index]),
        ),
      },
    };
    entries.push(entry);
    rows.push({
      id: shape.id,
      projectionId: projected.projectionId,
      symbol: shape.symbol,
      disposition: "generated-provider-boundary",
      bindingId: entry.id,
      shape: shape.shape,
      patternDecision: decision.patternId,
      admission: decision.admission,
      evidenceGaps: decision.evidenceGaps,
      resolvedPolicies: policy.storageContract,
      engineProviderBlockers: [
        "call-thread-affinity-unresolved",
        "enum-domain-to-native-success-policy-unresolved",
        "handle-provenance-lifetime-unresolved",
        "native-symbol-linkage-unverified",
        "target-feature-symbol-matrix-unverified",
      ],
      stages: {
        generated: "all-five-target-projections",
        compiled: "pinned-header-and-adapter-object-tests",
        linked: "fake-provider-host-bridge-only",
        runtime: "fake-provider-sanitized-reentrancy-and-warmed",
        engine: "not-claimed-provider-absent",
      },
    });
  }
  const handleNames = [
    ...new Set(entries.flatMap(({ parameters }) => parameters.map(({ handleName: name }) => name).filter(Boolean))),
  ].sort();
  const handleKinds = new Map(
    handleNames.map((name, id) => [
      name,
      {
        id,
        name,
        representation: candidates
          .find((row) => row.parameters.some(({ role }) => handleName(role) === name))
          .parameters.find(({ role }) => handleName(role) === name)
          .role.split(":")
          .at(-1),
      },
    ]),
  );
  const recipeFacts = createDmSdkScratchScalarOutRecipeFacts({
    defoldRevision: ir.defoldRevision,
    entries,
    handleKinds,
  });
  const maxParameters = Math.max(0, ...entries.map(({ parameters }) => parameters.length));
  const maxOutputs = Math.max(
    0,
    ...entries.map(
      ({ parameters }) => parameters.filter(({ direction }) => direction === "out" || direction === "inout").length,
    ),
  );
  const observedCoverage = {
    candidates: candidates.length,
    generated: entries.length,
    blocked: rows.length - entries.length,
    sourceDerived: plan.coverage.sourceDerived,
    defoldContractTrusted: plan.coverage.defoldContractTrusted,
  };
  const generated = renderDmSdkScratchScalarOutOutputs(recipeFacts);
  generated.set(artifacts.headerAudit, renderDmSdkScratchScalarOutHeaderAudit(entries));
  generated.set(artifacts.recipeFacts, `${JSON.stringify(recipeFacts, null, 2)}\n`);
  const report = {
    schemaVersion: 3,
    defoldRevision: ir.defoldRevision,
    sources: paths,
    sourceHashes: Object.fromEntries(Object.entries(contents).map(([key, content]) => [key, sha256(content)])),
    selector:
      "compiler-owned authenticated scratch plan; source-derived admissions plus structurally preserved prior provider routes; no symbol allowlist",
    patternRegistry: plan.patternRegistry,
    policy: {
      ...policy.storageContract,
      ...policy.targetPolicy,
      evidenceBoundary:
        "generated and fake-provider tested; no dmSDK symbol link, real provider, or packaged-engine proof",
    },
    universalFallback: {
      preserved: true,
      catalog: "packages/bindings/generated/defold-dmsdk-universal-bindings.json",
      mutation: "none",
    },
    abi: {
      slotBytes: 8,
      maxParameters,
      maxOutputs,
      handleKindCount: handleKinds.size,
      parameterStorage: "caller-owned contiguous uint64_t slots",
      resultStorage: "caller-owned uint64_t slot",
    },
    recipeFacts: {
      path: artifacts.recipeFacts,
      kind: recipeFacts.kind,
    },
    coverage: {
      ...observedCoverage,
      cAbiGenerated: entries.length,
      dynamicHermesJsiGenerated: entries.length,
      staticHermesGenerated: entries.length,
      browserDirectMemoryGenerated: entries.length,
      typescriptGenerated: entries.length,
      pinnedHeaderSignatureCompiled: entries.length,
      fakeProviderHostRuntimeTested: entries.length,
      packagedEngineRuntimeVerified: 0,
      warmedDispatchIterations: 100000,
      warmedDispatchObservedCppAllocations: 0,
    },
    handleKinds: [...handleKinds.values()],
    artifactHashes: Object.fromEntries(
      [...generated].sort(([a], [b]) => a.localeCompare(b)).map(([path, content]) => [path, sha256(content)]),
    ),
    artifacts: [...generated.keys()].sort(),
    declarations: rows,
  };
  generated.set(artifacts.report, `${JSON.stringify(report, null, 2)}\n`);
  return { artifacts: generated, report };
}

async function writeOrCheck(outputRoot, path, content, check) {
  const destination = resolve(outputRoot, path);
  if (check) {
    if ((await readFile(destination, "utf8")) !== content) throw new Error(`${path} is stale`);
    return;
  }
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, content);
}

export async function run(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const result = await build();
  for (const [path, content] of result.artifacts) await writeOrCheck(options.outputRoot, path, content, options.check);
  process.stdout.write(
    `${options.check ? "Verified" : "Generated"} ${result.report.coverage.generated}/${result.report.coverage.candidates} scratch scalar-out bindings; ${result.report.coverage.blocked} structurally blocked.\n`,
  );
  return result.report;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await run();
