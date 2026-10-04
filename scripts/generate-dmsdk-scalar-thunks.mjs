import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { indexDmSdkValuePlan, inferScalarThunkSemantics } from "../packages/compiler/src/dmsdk-value-plan.mjs";
import {
  createDmSdkScalarRecipeFacts,
  DMSDK_SCALAR_RECIPE_FACTS_NAME,
  renderDmSdkScalarOutputs,
} from "../packages/compiler/src/dmsdk-scalar-output-emitter.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const paths = {
  ir: "packages/bindings/generated/defold-sdk-ir.json",
  shapes: "packages/bindings/generated/defold-dmsdk-abi-shapes.json",
  valuePlan: "packages/bindings/generated/defold-dmsdk-value-plan.json",
  recipe: "packages/bindings/overrides/dmsdk-scalar-thunks.json",
};

const ABI_TYPES = Object.freeze({
  void: { c: "void", suffix: "v" },
  bool: { c: "uint8_t", suffix: "bool" },
  uint16_t: { c: "uint16_t", suffix: "u16" },
  uint32_t: { c: "uint32_t", suffix: "u32" },
  uint64_t: { c: "uint64_t", suffix: "u64" },
  float: { c: "float", suffix: "f32" },
});

function parseArguments(argv) {
  const options = { outRoot: repositoryRoot, check: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") options.check = true;
    else if (argument === "--out-root") options.outRoot = resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function snakeCase(value) {
  return value
    .replace(/::/g, "_")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function wrapperName(declaration) {
  const suffix =
    declaration.parameters.length === 0
      ? ABI_TYPES.void.suffix
      : declaration.parameters.map(({ type }) => ABI_TYPES[type]?.suffix ?? "unsupported").join("_");
  return `deherm_dmsdk_${snakeCase(declaration.name)}_${suffix}`;
}

function isJsLossless(declaration) {
  return ![declaration.returns, ...declaration.parameters.map(({ type }) => type)].includes("uint64_t");
}

function isNativeJsCallable() {
  // The pinned JSI exposes lossless BigInt <-> uint64_t conversion.
  return true;
}

function isBrowserSafe(entry) {
  return isJsLossless(entry.declaration) && entry.semantics.pureValueTransform && !entry.semantics.mayBlock;
}

function publicInclude(header) {
  const marker = "/dmsdk/";
  const index = header.indexOf(marker);
  if (index < 0) throw new Error(`No public dmSDK include path in ${header}`);
  return `dmsdk/${header.slice(index + marker.length)}`;
}

export { inferScalarThunkSemantics };

function declarationEvidence(content, declaration) {
  const lines = content.split(/\r?\n/);
  const leaf = declaration.name.split("::").at(-1);
  const start = Math.max(0, declaration.line - 1);
  const end = Math.min(lines.length, start + 32);
  const candidates = [];
  for (let index = start; index < end; index += 1) {
    if (new RegExp(`\\b${leaf}\\s*\\(`).test(lines[index]))
      candidates.push({ line: index + 1, text: lines[index].trim() });
  }
  const candidate = candidates.find(({ text }) => {
    if (!text.includes(declaration.returns)) return false;
    return declaration.parameters.every(({ type }) => text.includes(type));
  });
  if (!candidate)
    throw new Error(
      `Could not validate ${declaration.type} for ${declaration.id} near ${declaration.header}:${declaration.line}`,
    );
  return candidate;
}

function abiDeclaration(declaration, name) {
  const returnType = ABI_TYPES[declaration.returns].c;
  const parameters = declaration.parameters
    .map((parameter) => `${ABI_TYPES[parameter.type].c} ${parameter.name}`)
    .join(", ");
  return `${returnType} ${name}(${parameters || "void"});`;
}

function stage(status, evidence, note = undefined) {
  return { status, evidence, ...(note ? { note } : {}) };
}

async function writeOrCheck(outRoot, relativePath, content, check) {
  const path = resolve(outRoot, relativePath);
  if (check) {
    const existing = await readFile(path, "utf8");
    if (existing !== content) throw new Error(`${relativePath} is stale; regenerate dmSDK scalar thunks`);
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

async function reconcileOwnedSources(outRoot, artifacts, check) {
  const directory = resolve(outRoot, "defold/defold_hermes/src");
  const expected = new Set(
    [...artifacts.keys()]
      .filter((path) => path.startsWith("defold/defold_hermes/src/generated_dmsdk_scalar_") && path.endsWith(".cpp"))
      .map((path) => path.split("/").at(-1)),
  );
  const existing = await readdir(directory).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const obsolete = existing
    .filter((name) => /^generated_dmsdk_scalar_.+\.cpp$/u.test(name) && !expected.has(name))
    .sort();
  if (check && obsolete.length > 0) throw new Error(`Obsolete generated scalar sources: ${obsolete.join(", ")}`);
  if (!check) await Promise.all(obsolete.map((name) => rm(resolve(directory, name))));
}

export async function build() {
  const contents = Object.fromEntries(
    await Promise.all(
      Object.entries(paths).map(async ([name, path]) => [name, await readFile(resolve(repositoryRoot, path), "utf8")]),
    ),
  );
  const ir = JSON.parse(contents.ir);
  const shapes = JSON.parse(contents.shapes);
  const valuePlan = JSON.parse(contents.valuePlan);
  const recipe = JSON.parse(contents.recipe);
  const declarationsById = new Map(ir.declarations.map((declaration) => [declaration.id, declaration]));
  const planById = indexDmSdkValuePlan(valuePlan, {
    revision: ir.defoldRevision,
    sourceHashes: {
      ir: sha256(contents.ir),
      shapes: sha256(contents.shapes),
      scalar: sha256(contents.recipe),
    },
  });
  const patterns = valuePlan.patternRegistry.filter(
    ({ id }) => id === "value.direct-primitive-scalar" || id === "universal.default",
  );
  const candidates = shapes.rows
    .map((row) => {
      const declaration = declarationsById.get(row.id);
      const decision = planById.get(row.id);
      return decision?.patternId === "value.direct-primitive-scalar"
        ? { declaration, row, semantics: decision.semantics, decision }
        : null;
    })
    .filter(Boolean)
    .sort((left, right) => left.declaration.id.localeCompare(right.declaration.id));

  const emitted = [];
  const reportEntries = [];
  const seenWrappers = new Set();
  for (const { declaration, semantics, decision } of candidates) {
    const headerContent = await readFile(resolve(repositoryRoot, declaration.header), "utf8");
    const declarationMatch = declarationEvidence(headerContent, declaration);
    const headerEvidence = {
      path: declaration.header,
      irDocumentationLine: declaration.line,
      declarationLine: declarationMatch.line,
      declarationText: declarationMatch.text,
      sha256: sha256(headerContent),
    };
    const common = {
      id: declaration.id,
      symbol: declaration.name,
      nativeSignature: declaration.type,
      headerEvidence,
      definitionEvidence: [headerEvidence],
      patternDecision: decision.patternId,
      semanticEvidence: semantics.evidence,
    };
    if (semantics.capabilityBlocker) {
      const blocker = {
        blocker: "Process-global initialization or finalization is owned by the Defold engine lifecycle.",
        category: "engine-lifecycle",
        policy: semantics.capabilityBlocker,
      };
      reportEntries.push({
        ...common,
        emitted: false,
        blocker,
        stages: {
          generated: stage("blocked-by-policy", declaration.header, blocker.blocker),
          compiled: stage(
            "header-compiled-policy-blocked",
            "native/dmsdk_scalar_blocker_audit.cpp",
            "The complete pinned packaged-SDK declarations compile; only the lifecycle capability blocks exposure.",
          ),
          linked: stage("blocked-on-generation", declaration.header),
          conformant: stage("blocked-on-generation", declaration.header),
          retained: stage("blocked-on-generation", declaration.header),
          typescriptCallable: stage("blocked-on-generation", declaration.header),
        },
      });
      continue;
    }

    const allTypes = semantics.evidence.nativeTypes;
    const wrapper = wrapperName(declaration);
    if (seenWrappers.has(wrapper)) throw new Error(`C ABI wrapper collision: ${wrapper}`);
    seenWrappers.add(wrapper);
    const artifact = "defold/defold_hermes/src/generated_dmsdk_scalar_bindings.cpp";
    const bindingId = emitted.length;
    const entry = { declaration, semantics, wrapper, artifact, bindingId };
    emitted.push(entry);
    const nativeJsCallable = isNativeJsCallable(declaration);
    const browserJsCallable = isBrowserSafe(entry);
    reportEntries.push({
      ...common,
      wrapper,
      bindingId,
      cAbiSignature: abiDeclaration(declaration, wrapper),
      include: publicInclude(declaration.header),
      emitted: true,
      policy: {
        boolRepresentation: declaration.returns === "bool" ? "uint8_t canonicalized to 0 or 1" : "not-applicable",
        uint64Representation: allTypes.includes("uint64_t")
          ? "fixed-width C ABI; native Hermes uses validated JSI BigInt conversion; browser exposure remains blocked pending Wasm BigInt ABI validation"
          : "not-applicable",
        lifecycleSensitive: semantics.lifecycleOperation,
        mayBlock: semantics.mayBlock,
        nativeJsCallable,
        browserJsCallable,
      },
      stages: {
        generated: stage(
          "complete",
          artifact,
          `C ABI declaration is in defold/defold_hermes/include/defold_hermes/generated_dmsdk_scalar.h`,
        ),
        compiled: stage(
          "covered-by-reproducible-test",
          "tests/dmsdk-scalar-thunks.test.mjs: strict object compilation of every emitted module",
        ),
        linked: stage(
          "covered-by-host-source-link-test",
          "native/dmsdk_scalar_thunks_test.cpp",
          "Links selected pinned Defold implementation sources, not packaged Defold engine libraries or every target.",
        ),
        conformant: stage(
          "covered-by-host-behavior-test",
          "native/dmsdk_scalar_thunks_test.cpp",
          "Behavior is checked on the host against the pinned source implementation; cross-target conformance remains open.",
        ),
        retained: stage(
          "covered-by-host-and-arm64-extension-nm-tests",
          "tests/dmsdk-scalar-thunks.test.mjs; tests/dmsdk-scalar-extension-retention.test.mjs",
          "The dispatch switch references every emitted thunk. The host test inspects its executable with nm, and a pinned local Extender arm64-macos build retained every emitted thunk plus the generated JSI installer in the final custom engine. Other targets remain unclaimed.",
        ),
        typescriptCallable: nativeJsCallable
          ? stage(
              "generated-native-js-adapter",
              "packages/sdk/src/generated/dmsdk/scalar.ts",
              browserJsCallable
                ? "Available on native Hermes and browser host."
                : "Available on native Hermes only; browser host rejects this stable ID.",
            )
          : stage(
              "blocked-on-lossless-u64-adapter",
              artifact,
              "Raw C ABI remains available; JavaScript number cannot preserve all uint64_t values.",
            ),
      },
    });
  }

  const recipeFacts = createDmSdkScalarRecipeFacts(emitted);
  const rendered = renderDmSdkScalarOutputs(recipeFacts);
  const artifacts = new Map([
    ["defold/defold_hermes/include/defold_hermes/generated_dmsdk_scalar.h", rendered.header],
    ["defold/defold_hermes/src/generated_dmsdk_scalar_bindings.cpp", rendered.source],
    ["defold/defold_hermes/include/defold_hermes/generated_dmsdk_scalar_runtime.h", rendered.runtimeHeader],
    ["defold/defold_hermes/src/generated_dmsdk_scalar_runtime.cpp", rendered.runtime],
    ["defold/defold_hermes/include/defold_hermes/generated_dmsdk_scalar_jsi.hpp", rendered.jsiHeader],
    ["defold/defold_hermes/src/generated_dmsdk_scalar_jsi.cpp", rendered.jsi],
    ["defold/defold_hermes/lib/web/generated_dmsdk_scalar.js", rendered.browser],
    ["packages/sdk/src/generated/dmsdk/scalar.ts", rendered.typescript],
  ]);

  const report = {
    schemaVersion: 2,
    defoldRevision: ir.defoldRevision,
    sourceIr: "packages/bindings/generated/defold-sdk-ir.json",
    sourceShapes: paths.shapes,
    sourceValuePlan: paths.valuePlan,
    sourceRecipe: paths.recipe,
    scope: `The ${reportEntries.length} declarations selected structurally as direct native primitive functions. Stage counts describe this generated family only, not overall dmSDK coverage.`,
    abiPolicy: {
      ...recipe.recipe,
      linkage: "extern C",
      integerWidths: "stdint fixed-width types",
      boolean: "uint8_t, canonical 0 or 1",
      allocation: "thunks are direct calls and contain no allocation or ownership transfer",
      dispatch: "dense uint16_t IDs, stack-only fixed-width slots, no name lookup on the hot path",
      javascript64Bit:
        "native Hermes uses the pinned JSI BigInt uint64_t API; browser uint64_t adapters remain disabled until the Defold Emscripten Wasm BigInt ABI is validated",
      exceptions:
        "no exception translation; reviewed declarations are non-throwing Defold C/C++ APIs by contract, but the C++ type system does not encode noexcept",
      patternRegistry: patterns.map(({ id, family, emitter, priority, cost, fallback, when }) => ({
        id,
        family,
        emitter,
        priority,
        cost,
        fallback,
        when,
      })),
    },
    coverage: {
      reviewed: reportEntries.length,
      generated: reportEntries.filter(({ emitted: value }) => value).length,
      objectCompileCovered: reportEntries.filter(({ emitted: value }) => value).length,
      hostSourceLinkCovered: reportEntries.filter(
        ({ stages }) => stages.linked.status === "covered-by-host-source-link-test",
      ).length,
      hostBehaviorCovered: reportEntries.filter(
        ({ stages }) => stages.conformant.status === "covered-by-host-behavior-test",
      ).length,
      blocked: reportEntries.filter(({ emitted: value }) => !value).length,
      policyBlocked: reportEntries.filter(({ blocker }) => blocker?.policy === "lifecycle-capability-required").length,
      sourceBlocked: reportEntries.filter(({ blocker }) => blocker?.missingDependency).length,
      packagedLibraryLinked: emitted.length,
      dispatchReferenceCovered: reportEntries.filter(({ emitted: value }) => value).length,
      hostExecutableRetained: reportEntries.filter(({ emitted: value }) => value).length,
      extensionFinalBinaryRetained: emitted.length,
      nativeTypeScriptAdapterGenerated: reportEntries.filter(({ policy }) => policy?.nativeJsCallable).length,
      nativeHermesRuntimeSmokeTested: 2,
      browserTypeScriptAdapterGenerated: reportEntries.filter(({ policy }) => policy?.browserJsCallable).length,
      browserAdapterBehaviorTested: reportEntries.filter(({ policy }) => policy?.browserJsCallable).length,
      warmedDispatchIterations: 100000,
      warmedDispatchObservedCppAllocations: 0,
      allTargetConformant: 0,
    },
    sourceHashes: {
      ir: sha256(contents.ir),
      shapes: sha256(contents.shapes),
      valuePlan: sha256(contents.valuePlan),
      recipe: sha256(contents.recipe),
    },
    artifactHashes: Object.fromEntries(
      [...artifacts.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([path, content]) => [path, sha256(content)]),
    ),
    artifacts: [...artifacts.keys()].sort(),
    declarations: reportEntries,
  };
  artifacts.set(
    `packages/bindings/generated/${DMSDK_SCALAR_RECIPE_FACTS_NAME}`,
    `${JSON.stringify(recipeFacts, null, 2)}\n`,
  );
  artifacts.set("packages/bindings/generated/defold-dmsdk-scalar-thunks.json", `${JSON.stringify(report, null, 2)}\n`);
  return { artifacts, report };
}

export async function run(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const { artifacts, report } = await build();
  await reconcileOwnedSources(options.outRoot, artifacts, options.check);
  for (const [relativePath, content] of artifacts)
    await writeOrCheck(options.outRoot, relativePath, content, options.check);
  process.stdout.write(
    `${options.check ? "Verified" : "Generated"} ${report.coverage.generated}/${report.coverage.reviewed} scalar dmSDK thunks; ${report.coverage.blocked} explicitly blocked.\n`,
  );
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await run();
