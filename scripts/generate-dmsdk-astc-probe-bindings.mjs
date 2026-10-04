import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { DMSDK_UNIVERSAL_FALLBACK_PATTERN } from "../packages/compiler/src/dmsdk-pattern-selector.mjs";
import { indexDmSdkBoundedSpanPlan } from "../packages/compiler/src/dmsdk-bounded-span-plan.mjs";
import {
  analyzeAstcProbeRecipe,
  createDmSdkFallbackAudit,
} from "../packages/compiler/src/dmsdk-bounded-span-recipes.mjs";
import { astcProbePattern } from "../packages/compiler/src/dmsdk-pattern-catalog.mjs";
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
  policy: "packages/bindings/overrides/dmsdk-astc-probe-bindings.json",
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

export function extractAstcProbeSemantics(declaration, candidate, recipe, sourceFacts) {
  return analyzeAstcProbeRecipe(declaration, candidate, recipe, sourceFacts).semantics;
}

async function build(options) {
  const contents = Object.fromEntries(
    await Promise.all(Object.keys(defaults).map(async (key) => [key, await readFile(options[key], "utf8")])),
  );
  const ir = JSON.parse(contents.ir);
  const shapes = JSON.parse(contents.shapes);
  const plan = JSON.parse(contents.plan);
  const policy = JSON.parse(contents.policy);

  if (ir.defoldRevision !== shapes.defoldRevision) {
    throw new Error("Defold revisions differ between IR and ABI-shape census");
  }
  if (sha256(contents.ir) !== shapes.sourceHashes.ir) {
    throw new Error("IR hash does not match ABI-shape census provenance");
  }
  const planById = indexDmSdkBoundedSpanPlan(plan, {
    revision: ir.defoldRevision,
    sourceHashes: {
      ir: sha256(contents.ir),
      shapes: sha256(contents.shapes),
      sourceFacts: sha256(contents.sourceFacts),
      astc: sha256(contents.policy),
    },
  });
  if (
    policy.schemaVersion !== 1 ||
    policy.policyVersion !== "astc-probe-v4" ||
    policy.family !== "bounded-three-scalar-probe" ||
    policy.recipe?.input !== "borrowed-counted-bytes" ||
    policy.recipe?.output !== "caller-owned-three-u32" ||
    policy.recipe?.ownership !== "synchronous-noescape" ||
    policy.recipe?.fallback !== "universal-recipe"
  ) {
    throw new Error("Unsupported astc-probe semantic policy");
  }

  const declarationsById = new Map(ir.declarations.map((declaration) => [declaration.id, declaration]));
  const patterns = [astcProbePattern(), DMSDK_UNIVERSAL_FALLBACK_PATTERN];

  const entries = [];
  const blocked = [];
  let structurallyEligible = 0;
  for (const candidate of [...shapes.rows].sort((left, right) => left.id.localeCompare(right.id))) {
    const decision = planById.get(candidate.id);
    if (!decision?.structuralCandidates.includes("span.fixed-three-u32-probe")) continue;
    structurallyEligible += 1;
    const declaration = declarationsById.get(candidate.id);
    if (!declaration) throw new Error(`ASTC-probe candidate is absent from dmSDK IR: ${candidate.id}`);
    const semantics = decision.patternId === "span.fixed-three-u32-probe" ? decision.semantics : null;
    if (decision.patternId !== "span.fixed-three-u32-probe") {
      blocked.push({
        ...candidate,
        emitted: false,
        blocker: "astc-probe-evidence-withdrawn",
        patternDecision: decision.patternId,
        fallbackAudit: createDmSdkFallbackAudit({
          candidate,
          family: "astc-probe",
          patternId: "span.fixed-three-u32-probe",
          emitter: "scripts/generate-dmsdk-astc-probe-bindings.mjs",
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
      minimumHeaderBytes: semantics.minimumHeaderBytes,
      evidence: semantics.evidence,
      patternDecision: decision.patternId,
      wrapper: `deherm_dmsdk_astc_probe_${snake(declaration.name)}`,
    });
  }

  const headerMinimums = [...new Set(entries.map(({ minimumHeaderBytes }) => minimumHeaderBytes))].sort(
    (left, right) => left - right,
  );
  if (headerMinimums.length > 1) {
    throw new Error(`ASTC probes disagree on the implementation-derived header minimum: ${headerMinimums.join(", ")}`);
  }
  const minimumHeaderBytes = headerMinimums[0] ?? 0;

  const recipeFacts = createDmSdkBoundedRecipeFacts({
    defoldRevision: ir.defoldRevision,
    family: "astc-probe",
    entries,
  });
  const artifacts = renderDmSdkBoundedOutputs(recipeFacts);
  const report = {
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
      cAbi: "bounded uint8_t input span and caller-owned fixed three-u32 result",
      ownership: "input is synchronously borrowed; only scalar results return",
      safety: `generated preflight rejects null input and spans shorter than the implementation-derived ${minimumHeaderBytes}-byte header minimum`,
      allocation: "no generated or pinned image parser allocation",
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
      remainingWithoutGeneratedAdapters: shapes.coverage.runtimePending - 26 - 7 - 4 - 2 - entries.length,
    },
    artifactHashes: Object.fromEntries([...artifacts].map(([key, value]) => [key, sha256(value)])),
    artifacts: [...artifacts.keys()].sort(),
    fallbackAudit: {
      retainedImplementation: "@deherm/compiler/dmsdk-universal-materializer",
      count: blocked.length,
      entries: blocked.map(({ fallbackAudit }) => fallbackAudit),
    },
    declarations: [
      ...entries.map((entry) => ({
        ...entry.candidate,
        bindingId: entry.id,
        mode: entry.mode,
        minimumHeaderBytes: entry.minimumHeaderBytes,
        evidence: entry.evidence,
        patternDecision: entry.patternDecision,
        wrapper: entry.wrapper,
        stages: {
          generated: "complete",
          compiled: "pinned-source-object-test",
          linked: "pinned-source-host-link-test",
          runtime: "pinned-source-host-behavior-test",
          allocation: "100000-warmed-dispatch-zero-cpp-allocations",
        },
      })),
      ...blocked,
    ],
  };

  artifacts.set(
    "packages/bindings/generated/defold-dmsdk-astc-probe-bindings.json",
    `${JSON.stringify(report, null, 2)}\n`,
  );
  artifacts.set(
    "packages/bindings/generated/defold-dmsdk-astc-probe-recipe-facts.json",
    `${JSON.stringify(recipeFacts, null, 2)}\n`,
  );
  return { artifacts, report };
}

async function writeOrCheck(options, relativePath, content) {
  const path = resolve(options.outRoot, relativePath);
  if (options.check) {
    if ((await readFile(path, "utf8")) !== content) {
      throw new Error(`${relativePath} is stale`);
    }
  } else {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
}

export async function run(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const { artifacts, report } = await build(options);
  for (const [relativePath, content] of artifacts) {
    await writeOrCheck(options, relativePath, content);
  }
  process.stdout.write(
    `${options.check ? "Verified" : "Generated"} ${report.coverage.emitted}/${report.coverage.discovered} astc-probe dmSDK bindings.\n`,
  );
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await run();
}
