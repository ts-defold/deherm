import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { indexDmSdkBoundedSpanPlan } from "../packages/compiler/src/dmsdk-bounded-span-plan.mjs";
import {
  analyzeHashSpanRecipe,
  createDmSdkFallbackAudit,
} from "../packages/compiler/src/dmsdk-bounded-span-recipes.mjs";
import {
  createDmSdkBoundedRecipeFacts,
  renderDmSdkBoundedOutputs,
} from "../packages/compiler/src/dmsdk-bounded-output-emitter.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaults = {
  ir: "packages/bindings/generated/defold-sdk-ir.json",
  shapes: "packages/bindings/generated/defold-dmsdk-abi-shapes.json",
  plan: "packages/bindings/generated/defold-dmsdk-bounded-span-plan.json",
  policy: "packages/bindings/overrides/dmsdk-hash-span-bindings.json",
};
const previouslyGeneratedAdapters = 43;

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
    } else if (["--ir", "--shapes", "--plan", "--policy", "--out-root"].includes(argument)) {
      const key = argument.slice(2).replace(/-([a-z])/g, (_, character) => character.toUpperCase());
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${argument} requires a path`);
      options[key] = resolve(value);
      index += 1;
    } else {
      throw new Error(`Unknown argument ${argument}`);
    }
  }
  for (const key of Object.keys(defaults)) options[key] = resolve(root, options[key]);
  return options;
}

export function extractHashSpanSemantics(declaration, candidate, recipe) {
  return analyzeHashSpanRecipe(declaration, candidate, recipe).semantics;
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

function createEntries(rows, declarations, plan, planById) {
  const patterns = plan.patternRegistry.filter(
    ({ id }) => id === "span.fixed-width-hash" || id === "universal.default",
  );
  const entries = [];
  const blocked = [];
  let structurallyEligible = 0;
  for (const candidate of [...rows].sort((left, right) => left.id.localeCompare(right.id))) {
    const decision = planById.get(candidate.id);
    if (!decision?.structuralCandidates.includes("span.fixed-width-hash")) continue;
    structurallyEligible += 1;
    const declaration = declarations.get(candidate.id);
    if (!declaration) throw new Error(`Hash-span candidate is absent from dmSDK IR: ${candidate.id}`);
    const semantics = decision.patternId === "span.fixed-width-hash" ? decision.semantics : null;
    if (!semantics) {
      blocked.push({
        ...candidate,
        emitted: false,
        blocker: "hash-span-evidence-withdrawn",
        fallbackAudit: createDmSdkFallbackAudit({
          candidate,
          family: "hash-span",
          patternId: "span.fixed-width-hash",
          emitter: "scripts/generate-dmsdk-hash-span-bindings.mjs",
          missingFacts: decision.missingFacts,
        }),
      });
      continue;
    }
    entries.push({
      id: entries.length,
      candidate,
      declaration,
      resultBits: semantics.resultBits,
      evidence: semantics.evidence,
      patternDecision: decision.patternId,
      wrapper: `deherm_dmsdk_hash_span_${snake(declaration.name)}`,
    });
  }
  return { entries, blocked, structurallyEligible, patterns };
}

function createReport(contents, ir, shapes, policy, entries, blocked, structurallyEligible, patterns, artifacts) {
  return {
    schemaVersion: 1,
    policyVersion: policy.policyVersion,
    defoldRevision: ir.defoldRevision,
    sources: { ir: defaults.ir, shapes: defaults.shapes, policy: defaults.policy },
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
      cAbi: "borrowed const uint8_t* plus explicit uint32_t byte length; scalar result written to caller-owned uint64_t storage",
      ownership: "input and output are borrowed only for the synchronous call; no pointer escapes generated glue",
      allocation:
        "generated glue has no heap primitive; the packaged host harness verifies zero warmed C++ operator new calls under its default engine configuration, without making a global claim about Defold internals",
      jsi: "not-generated pending typed-array lifetime and installer policy",
      html5: "not-claimed pending target compile/link matrix",
    },
    coverage: {
      baselineRuntimePending: shapes.coverage.runtimePending,
      previouslyGeneratedAdapters,
      discovered: structurallyEligible,
      structurallyEligible,
      emitted: entries.length,
      policyBlocked: blocked.length,
      hostBehaviorVerified: entries.length,
      remainingWithoutGeneratedAdapters: shapes.coverage.runtimePending - previouslyGeneratedAdapters - entries.length,
    },
    artifactHashes: Object.fromEntries(
      [...artifacts]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([path, content]) => [path, sha256(content)]),
    ),
    artifacts: [...artifacts.keys()].sort(),
    declarations: [
      ...entries.map(({ id, candidate, resultBits, evidence, patternDecision, wrapper }) => ({
        ...candidate,
        bindingId: id,
        resultBits,
        evidence,
        patternDecision,
        wrapper,
        stages: {
          generated: "complete",
          compiled: "packaged-sdk-object-test",
          linked: "packaged-sdk-host-link-test",
          runtime: "packaged-sdk-host-behavior-test",
          allocation: "100000-warmed-dispatch-zero-cpp-operator-new-with-reverse-hashing-default-disabled",
        },
      })),
      ...blocked,
    ],
  };
}

export async function build(options) {
  const contents = Object.fromEntries(
    await Promise.all(Object.keys(defaults).map(async (key) => [key, await readFile(options[key], "utf8")])),
  );
  const ir = JSON.parse(contents.ir);
  const shapes = JSON.parse(contents.shapes);
  const plan = JSON.parse(contents.plan);
  const policy = JSON.parse(contents.policy);
  validateProvenance(ir, shapes, contents);
  if (
    policy.schemaVersion !== 1 ||
    policy.policyVersion !== "hash-span-v3" ||
    policy.family !== "fixed-width-buffer-hash" ||
    policy.recipe?.input !== "borrowed-counted-bytes" ||
    JSON.stringify(policy.recipe?.resultWidths) !== JSON.stringify([32, 64]) ||
    policy.recipe?.ownership !== "synchronous-noescape" ||
    policy.recipe?.fallback !== "universal-recipe"
  ) {
    throw new Error("Unsupported hash-span semantic policy");
  }
  const declarations = new Map(ir.declarations.map((declaration) => [declaration.id, declaration]));
  const planById = indexDmSdkBoundedSpanPlan(plan, {
    revision: ir.defoldRevision,
    sourceHashes: {
      ir: sha256(contents.ir),
      shapes: sha256(contents.shapes),
      hashSpan: sha256(contents.policy),
    },
  });
  const { entries, blocked, structurallyEligible, patterns } = createEntries(shapes.rows, declarations, plan, planById);
  const recipeFacts = createDmSdkBoundedRecipeFacts({
    defoldRevision: ir.defoldRevision,
    family: "hash-span",
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
    "packages/bindings/generated/defold-dmsdk-hash-span-bindings.json",
    `${JSON.stringify(report, null, 2)}\n`,
  );
  artifacts.set(
    "packages/bindings/generated/defold-dmsdk-hash-span-recipe-facts.json",
    `${JSON.stringify(recipeFacts, null, 2)}\n`,
  );
  return { artifacts, report };
}

async function writeOrCheck(outRoot, relative, content, check) {
  const path = resolve(outRoot, relative);
  if (check) {
    if ((await readFile(path, "utf8")) !== content) throw new Error(`${relative} is stale`);
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

export async function run(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const { artifacts, report } = await build(options);
  for (const [path, content] of artifacts) await writeOrCheck(options.outRoot, path, content, options.check);
  process.stdout.write(
    `${options.check ? "Verified" : "Generated"} ${report.coverage.emitted}/${report.coverage.discovered} hash-span dmSDK bindings.\n`,
  );
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
