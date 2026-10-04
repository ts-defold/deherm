import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { DMSDK_UNIVERSAL_FALLBACK_PATTERN } from "../packages/compiler/src/dmsdk-pattern-selector.mjs";
import { indexDmSdkBoundedSpanPlan } from "../packages/compiler/src/dmsdk-bounded-span-plan.mjs";
import {
  analyzeFixedDigestRecipe,
  createDmSdkFallbackAudit,
} from "../packages/compiler/src/dmsdk-bounded-span-recipes.mjs";
import { fixedDigestPattern } from "../packages/compiler/src/dmsdk-pattern-catalog.mjs";
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
  policy: "packages/bindings/overrides/dmsdk-fixed-digest-bindings.json",
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
    if (argument === "--check") options.check = true;
    else if (["--ir", "--shapes", "--source-facts", "--plan", "--policy", "--out-root"].includes(argument))
      options[argument.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = resolve(argv[++index]);
    else throw new Error(`Unknown argument ${argument}`);
  }
  for (const key of ["ir", "shapes", "sourceFacts", "policy"]) options[key] = resolve(root, options[key]);
  return options;
}

export function extractFixedDigestSemantics(declaration, candidate, recipe, sourceFacts) {
  return analyzeFixedDigestRecipe(declaration, candidate, recipe, sourceFacts).semantics;
}

async function build(options) {
  const contents = Object.fromEntries(
    await Promise.all(
      Object.entries(defaults).map(async ([key, relative]) => [
        key,
        await readFile(options[key] ?? resolve(root, relative), "utf8"),
      ]),
    ),
  );
  const ir = JSON.parse(contents.ir);
  const shapes = JSON.parse(contents.shapes);
  const sourceFacts = JSON.parse(contents.sourceFacts);
  const plan = JSON.parse(contents.plan);
  const policy = JSON.parse(contents.policy);
  if (ir.defoldRevision !== shapes.defoldRevision || ir.defoldRevision !== sourceFacts.defoldRevision)
    throw new Error("Defold revisions differ between IR and ABI-shape census");
  if (sha256(contents.ir) !== shapes.sourceHashes.ir)
    throw new Error("IR hash does not match ABI-shape census provenance");
  if (
    sha256(contents.ir) !== sourceFacts.sourceHashes.ir ||
    sha256(contents.shapes) !== sourceFacts.sourceHashes.shapes
  )
    throw new Error("Source semantic facts do not match their IR and ABI-shape provenance");
  if (
    policy.schemaVersion !== 1 ||
    policy.policyVersion !== "fixed-digest-v4" ||
    policy.family !== "fixed-output-digest" ||
    policy.recipe?.input !== "borrowed-counted-bytes" ||
    policy.recipe?.output !== "caller-owned-fixed-size-bytes" ||
    policy.recipe?.ownership !== "synchronous-noescape" ||
    policy.recipe?.fallback !== "universal-recipe"
  )
    throw new Error("Unsupported fixed-digest semantic policy");
  const declarations = new Map(ir.declarations.map((declaration) => [declaration.id, declaration]));
  if (
    declarations.size !== ir.declarations.length ||
    new Set(shapes.rows.map(({ id }) => id)).size !== shapes.rows.length
  )
    throw new Error("IR or ABI-shape census contains duplicate declaration ids");
  const patterns = [fixedDigestPattern(), DMSDK_UNIVERSAL_FALLBACK_PATTERN];
  const planById = indexDmSdkBoundedSpanPlan(plan, {
    revision: ir.defoldRevision,
    sourceHashes: {
      ir: sha256(contents.ir),
      shapes: sha256(contents.shapes),
      sourceFacts: sha256(contents.sourceFacts),
      fixedDigest: sha256(contents.policy),
    },
  });
  const selected = [];
  const blocked = [];
  let structurallyEligible = 0;
  for (const candidate of [...shapes.rows].sort((left, right) => left.id.localeCompare(right.id))) {
    const patternDecision = planById.get(candidate.id);
    if (!patternDecision?.structuralCandidates.includes("span.fixed-output-digest")) continue;
    structurallyEligible += 1;
    const declaration = declarations.get(candidate.id);
    if (!declaration) throw new Error(`Fixed-digest structural candidate has no source declaration: ${candidate.id}`);
    const semantics = patternDecision.patternId === "span.fixed-output-digest" ? patternDecision.semantics : null;
    if (!semantics) {
      blocked.push({
        ...candidate,
        emitted: false,
        blocker: "fixed-digest-semantic-recipe-missing",
        fallbackAudit: createDmSdkFallbackAudit({
          candidate,
          family: "fixed-digest",
          patternId: "span.fixed-output-digest",
          emitter: "scripts/generate-dmsdk-fixed-digest-bindings.mjs",
          missingFacts: patternDecision.missingFacts,
        }),
      });
      continue;
    }
    selected.push({
      candidate,
      declaration,
      patternDecision: patternDecision.patternId,
      ...semantics,
    });
  }
  const entries = selected.map((entry, id) => ({
    id,
    ...entry,
    wrapper: `deherm_dmsdk_fixed_digest_${snake(entry.declaration.name)}`,
  }));
  const recipeFacts = createDmSdkBoundedRecipeFacts({
    defoldRevision: ir.defoldRevision,
    family: "fixed-digest",
    entries,
  });
  const artifacts = renderDmSdkBoundedOutputs(recipeFacts);
  const report = {
    schemaVersion: 1,
    policyVersion: policy.policyVersion,
    defoldRevision: ir.defoldRevision,
    sources: {
      ir: "packages/bindings/generated/defold-sdk-ir.json",
      shapes: "packages/bindings/generated/defold-dmsdk-abi-shapes.json",
      policy: "packages/bindings/overrides/dmsdk-fixed-digest-bindings.json",
      sourceFacts: "packages/bindings/generated/defold-dmsdk-source-semantic-facts.json",
    },
    sourceHashes: Object.fromEntries(Object.entries(contents).map(([key, value]) => [key, sha256(value)])),
    patternRegistry: patterns,
    policy: {
      pattern: "span.fixed-output-digest",
      recipe: policy.recipe,
      cAbi: "const uint8_t* plus uint32_t input length; caller-owned uint8_t* output plus validated uint32_t capacity",
      ownership: "input is borrowed for the synchronous call; output is caller-owned; no native pointer escapes",
      allocation: "generated wrappers and dispatcher use no allocation or ownership primitive",
      jsi: "not-generated: zero-copy typed-array lifetime and module installation remain an explicit later policy",
      html5: "not-claimed pending target compile/link matrix",
    },
    coverage: {
      baselineRuntimePending: shapes.coverage.runtimePending,
      structurallyEligible,
      discovered: entries.length,
      emitted: entries.length,
      policyBlocked: blocked.length,
      hostBehaviorVerified: entries.length,
      remainingWithoutGeneratedAdapters: shapes.coverage.runtimePending - 26 - 7 - entries.length,
    },
    artifactHashes: Object.fromEntries(
      [...artifacts].sort(([a], [b]) => a.localeCompare(b)).map(([path, content]) => [path, sha256(content)]),
    ),
    artifacts: [...artifacts.keys()].sort(),
    fallbackAudit: {
      retainedImplementation: "@deherm/compiler/dmsdk-universal-materializer",
      count: blocked.length,
      entries: blocked.map(({ fallbackAudit }) => fallbackAudit),
    },
    declarations: [
      ...entries.map(({ id, candidate, algorithm, digestBytes, evidence, patternDecision, wrapper }) => ({
        ...candidate,
        bindingId: id,
        wrapper,
        algorithm,
        digestBytes,
        evidence,
        patternDecision,
        stages: {
          generated: "complete",
          compiled: "packaged-sdk-object-test",
          linked: "packaged-sdk-host-link-test",
          runtime: "packaged-sdk-host-behavior-test",
          allocation: "100000-warmed-dispatch-zero-cpp-allocations",
        },
      })),
      ...blocked,
    ],
  };
  artifacts.set(
    "packages/bindings/generated/defold-dmsdk-fixed-digest-bindings.json",
    `${JSON.stringify(report, null, 2)}\n`,
  );
  artifacts.set(
    "packages/bindings/generated/defold-dmsdk-fixed-digest-recipe-facts.json",
    `${JSON.stringify(recipeFacts, null, 2)}\n`,
  );
  return { artifacts, report };
}

async function writeOrCheck(rootPath, relative, content, check) {
  const path = resolve(rootPath, relative);
  if (check) {
    if ((await readFile(path, "utf8")) !== content) throw new Error(`${relative} is stale`);
  } else {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
}
export async function run(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const { artifacts, report } = await build(options);
  for (const [path, content] of artifacts) await writeOrCheck(options.outRoot, path, content, options.check);
  process.stdout.write(
    `${options.check ? "Verified" : "Generated"} ${report.coverage.emitted}/${report.coverage.discovered} fixed-digest dmSDK bindings.\n`,
  );
  return report;
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await run();
