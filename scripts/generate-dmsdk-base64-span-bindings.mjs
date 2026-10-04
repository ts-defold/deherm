import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { DMSDK_UNIVERSAL_FALLBACK_PATTERN } from "../packages/compiler/src/dmsdk-pattern-selector.mjs";
import { indexDmSdkBoundedSpanPlan } from "../packages/compiler/src/dmsdk-bounded-span-plan.mjs";
import {
  analyzeBase64SpanRecipe,
  createDmSdkFallbackAudit,
} from "../packages/compiler/src/dmsdk-bounded-span-recipes.mjs";
import { base64SpanPattern } from "../packages/compiler/src/dmsdk-pattern-catalog.mjs";
import {
  createDmSdkBoundedRecipeFacts,
  renderDmSdkBoundedOutputs,
} from "../packages/compiler/src/dmsdk-bounded-output-emitter.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaults = {
  ir: "packages/bindings/generated/defold-sdk-ir.json",
  shapes: "packages/bindings/generated/defold-dmsdk-abi-shapes.json",
  sourceFacts: "packages/bindings/generated/defold-dmsdk-source-semantic-facts.json",
  plan: "packages/bindings/generated/defold-dmsdk-bounded-span-plan.json",
  policy: "packages/bindings/overrides/dmsdk-base64-span-bindings.json",
};

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const snake = (value) =>
  value
    .replace(/::/g, "_")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();

function parseArgs(argv) {
  const options = { ...defaults, outRoot: root, check: false };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") {
      options.check = true;
    } else if (["--ir", "--shapes", "--source-facts", "--plan", "--policy", "--out-root"].includes(argument)) {
      const key = argument.slice(2).replace(/-([a-z])/g, (_, character) => character.toUpperCase());
      options[key] = resolve(argv[++index]);
    } else {
      throw new Error(`Unknown argument ${argument}`);
    }
  }

  for (const key of Object.keys(defaults)) {
    options[key] = resolve(root, options[key]);
  }
  return options;
}

async function readInputs(options) {
  return Object.fromEntries(
    await Promise.all(Object.keys(defaults).map(async (key) => [key, await readFile(options[key], "utf8")])),
  );
}

function validateProvenance(ir, shapes, contents) {
  if (ir.defoldRevision !== shapes.defoldRevision) {
    throw new Error("Defold revisions differ between IR and ABI-shape census");
  }
  if (sha256(contents.ir) !== shapes.sourceHashes.ir) {
    throw new Error("IR hash does not match ABI-shape census provenance");
  }

  const declarationIds = ir.declarations.map(({ id }) => id);
  const shapeIds = shapes.rows.map(({ id }) => id);
  if (new Set(declarationIds).size !== declarationIds.length || new Set(shapeIds).size !== shapeIds.length) {
    throw new Error("IR or ABI-shape census contains duplicate declaration ids");
  }
}

export function extractBase64SpanSemantics(declaration, candidate, recipe, sourceFacts) {
  return analyzeBase64SpanRecipe(declaration, candidate, recipe, sourceFacts).semantics;
}

function createEntries(rows, declarations, planById) {
  const patterns = [base64SpanPattern(), DMSDK_UNIVERSAL_FALLBACK_PATTERN];
  const entries = [];
  const blocked = [];
  let structurallyEligible = 0;
  for (const candidate of [...rows].sort((left, right) => left.id.localeCompare(right.id))) {
    const decision = planById.get(candidate.id);
    if (!decision?.structuralCandidates.includes("span.bounded-byte-transform")) continue;
    structurallyEligible += 1;
    const declaration = declarations.get(candidate.id);
    if (!declaration) throw new Error(`Base64-span candidate is absent from dmSDK IR: ${candidate.id}`);
    const semantics = decision.patternId === "span.bounded-byte-transform" ? decision.semantics : null;
    if (decision.patternId !== "span.bounded-byte-transform") {
      blocked.push({
        ...candidate,
        emitted: false,
        blocker: "base64-span-evidence-withdrawn",
        patternDecision: decision.patternId,
        fallbackAudit: createDmSdkFallbackAudit({
          candidate,
          family: "base64-span",
          patternId: "span.bounded-byte-transform",
          emitter: "scripts/generate-dmsdk-base64-span-bindings.mjs",
          missingFacts: decision.missingFacts,
        }),
      });
      continue;
    }
    entries.push({
      id: entries.length,
      candidate,
      declaration,
      mode: semantics.mode,
      requirePaddedInput: semantics.requirePaddedInput,
      evidence: semantics.evidence,
      patternDecision: decision.patternId,
      wrapper: `deherm_dmsdk_base64_span_${snake(declaration.name)}`,
    });
  }
  return { entries, blocked, structurallyEligible, patterns };
}

function createReport(contents, ir, shapes, policy, entries, blocked, structurallyEligible, patterns, artifacts) {
  return {
    schemaVersion: 1,
    policyVersion: policy.policyVersion,
    defoldRevision: ir.defoldRevision,
    sources: defaults,
    sourceHashes: Object.fromEntries(Object.entries(contents).map(([key, value]) => [key, sha256(value)])),
    policy: {
      recipe: policy.recipe,
      patternRegistry: patterns.map(({ id, family, emitter, priority, cost, fallback, when }) => ({
        id,
        family,
        emitter,
        priority,
        cost,
        fallback,
        when,
      })),
      cAbi: "const uint8_t* plus uint32_t input length; caller-owned uint8_t* plus explicit uint32_t capacity/output length",
      ownership: "both spans are borrowed only for the synchronous call; no pointer escapes",
      decode:
        "unpadded-input support is derived from the revision implementation; otherwise glue conservatively requires canonical padding",
      query: "zero output capacity preserves the documented size-query protocol but does not claim input validity",
      allocation:
        "generated glue has no heap primitive; the warmed harness observes zero C++ operator new calls, while native and Objective-C allocations are unmeasured",
      jsi: "not-generated pending typed-array lifetime and installer policy",
      html5: "not-claimed pending target compile/link matrix",
    },
    coverage: {
      baselineRuntimePending: shapes.coverage.runtimePending,
      discovered: structurallyEligible,
      structurallyEligible,
      emitted: entries.length,
      policyBlocked: blocked.length,
      hostBehaviorVerified: entries.length,
      remainingWithoutGeneratedAdapters: shapes.coverage.runtimePending - 26 - 7 - 4 - entries.length,
    },
    artifactHashes: Object.fromEntries(
      [...artifacts]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([path, content]) => [path, sha256(content)]),
    ),
    artifacts: [...artifacts.keys()].sort(),
    fallbackAudit: {
      retainedImplementation: "@deherm/compiler/dmsdk-universal-materializer",
      count: blocked.length,
      entries: blocked.map(({ fallbackAudit }) => fallbackAudit),
    },
    declarations: [
      ...entries.map(({ id, candidate, mode, requirePaddedInput, evidence, patternDecision, wrapper }) => ({
        ...candidate,
        bindingId: id,
        mode,
        requirePaddedInput,
        evidence,
        patternDecision,
        wrapper,
        stages: {
          generated: "complete",
          compiled: "packaged-sdk-object-test",
          linked: "packaged-sdk-host-link-test",
          runtime: "packaged-sdk-host-behavior-test",
          allocation: "100000-warmed-canonical-dispatch-zero-cpp-operator-new",
        },
      })),
      ...blocked,
    ],
  };
}

async function build(options) {
  const contents = await readInputs(options);
  const ir = JSON.parse(contents.ir);
  const shapes = JSON.parse(contents.shapes);
  const plan = JSON.parse(contents.plan);
  const policy = JSON.parse(contents.policy);
  validateProvenance(ir, shapes, contents);
  const planById = indexDmSdkBoundedSpanPlan(plan, {
    revision: ir.defoldRevision,
    sourceHashes: {
      ir: sha256(contents.ir),
      shapes: sha256(contents.shapes),
      sourceFacts: sha256(contents.sourceFacts),
      base64: sha256(contents.policy),
    },
  });

  const declarations = new Map(ir.declarations.map((declaration) => [declaration.id, declaration]));
  if (
    policy.schemaVersion !== 1 ||
    policy.policyVersion !== "base64-span-v5" ||
    policy.family !== "bounded-byte-transform" ||
    policy.recipe?.input !== "borrowed-counted-bytes" ||
    policy.recipe?.output !== "caller-owned-capacity-inout" ||
    policy.recipe?.decodeInput !== "derive-from-implementation" ||
    policy.recipe?.sizeQuery !== "zero-output-capacity" ||
    policy.recipe?.ownership !== "synchronous-noescape" ||
    policy.recipe?.fallback !== "universal-recipe"
  ) {
    throw new Error("Unsupported base64-span semantic policy");
  }
  const { entries, blocked, structurallyEligible, patterns } = createEntries(shapes.rows, declarations, planById);
  const recipeFacts = createDmSdkBoundedRecipeFacts({
    defoldRevision: ir.defoldRevision,
    family: "base64-span",
    entries,
  });
  const artifacts = renderDmSdkBoundedOutputs(recipeFacts);
  const report = createReport(
    contents,
    ir,
    shapes,
    policy,
    entries,
    blocked,
    structurallyEligible,
    patterns,
    artifacts,
  );
  artifacts.set(
    "packages/bindings/generated/defold-dmsdk-base64-span-bindings.json",
    `${JSON.stringify(report, null, 2)}\n`,
  );
  artifacts.set(
    "packages/bindings/generated/defold-dmsdk-base64-span-recipe-facts.json",
    `${JSON.stringify(recipeFacts, null, 2)}\n`,
  );
  return { artifacts, report };
}

async function writeOrCheck(outRoot, relative, content, check) {
  const path = resolve(outRoot, relative);
  if (check) {
    if ((await readFile(path, "utf8")) !== content) {
      throw new Error(`${relative} is stale`);
    }
    return;
  }

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

export async function run(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const { artifacts, report } = await build(options);
  for (const [path, content] of artifacts) {
    await writeOrCheck(options.outRoot, path, content, options.check);
  }
  process.stdout.write(
    `${options.check ? "Verified" : "Generated"} ${report.coverage.emitted}/${report.coverage.discovered} base64-span dmSDK bindings.\n`,
  );
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await run();
}
