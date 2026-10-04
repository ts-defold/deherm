#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  indexDmSdkHashStatePlan,
  validateDmSdkHashStatePolicy,
} from "../packages/compiler/src/dmsdk-hash-state-plan.mjs";
import {
  createDmSdkHashStateRecipeFacts,
  renderDmSdkHashStateOutputs,
} from "../packages/compiler/src/dmsdk-hash-state-output-emitter.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaults = Object.freeze({
  shapes: "packages/bindings/generated/defold-dmsdk-abi-shapes.json",
  plan: "packages/bindings/generated/defold-dmsdk-hash-state-plan.json",
  policy: "packages/bindings/overrides/dmsdk-hash-state-bindings.json",
});
const artifactPaths = Object.freeze({
  report: "packages/bindings/generated/defold-dmsdk-hash-state-bindings.json",
  header: "defold/defold_hermes/include/defold_hermes/generated_dmsdk_hash_state.h",
  source: "defold/defold_hermes/src/generated_dmsdk_hash_state.cpp",
  exact: "tests/fixtures/generated_dmsdk_hash_state_exact.cpp",
});
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function parseArgs(argv) {
  const options = { ...defaults, outRoot: root, check: false };
  for (let i = 0; i < argv.length; ++i) {
    if (argv[i] === "--check") options.check = true;
    else if (argv[i] === "--out-root") options.outRoot = path.resolve(argv[++i]);
    else if (["--shapes", "--plan", "--policy"].includes(argv[i])) options[argv[i].slice(2)] = path.resolve(argv[++i]);
    else throw new Error(`Unknown argument ${argv[i]}`);
  }
  for (const key of Object.keys(defaults)) options[key] = path.resolve(root, options[key]);
  return options;
}

function validate(inputs, parsed) {
  const { shapes, plan, policy } = parsed;
  validateDmSdkHashStatePolicy(policy);
  if (shapes.defoldRevision !== plan.defoldRevision) throw new Error("hash-state emitter input revisions differ");
  const decisions = indexDmSdkHashStatePlan(plan, {
    revision: shapes.defoldRevision,
    sourceHashes: { shapes: sha256(inputs.shapes), policy: sha256(inputs.policy) },
  });
  const rows = new Map(shapes.rows.map((row) => [row.id, row]));
  const entries = [];
  const blocked = [];
  for (const decision of decisions.values()) {
    const row = rows.get(decision.declarationId);
    if (!row) throw new Error(`hash-state plan declaration is absent from ABI shapes: ${decision.declarationId}`);
    const semantics = decision.semantics;
    if (decision.fallback) {
      blocked.push({
        ...row,
        disposition: "blocked",
        blocker: decision.blocker,
        universalFallback: "retained",
        stages: {
          generated: "universal-fallback-only",
          compiled: "not-claimed",
          linked: "not-claimed",
          runtime: "not-claimed",
          allocation: "not-claimed",
        },
      });
      continue;
    }
    entries.push({
      ...row,
      denseId: entries.length,
      operation: semantics.operation,
      width: semantics.width,
      stateType: semantics.stateType,
      evidence: semantics.evidence,
      patternDecision: decision.patternId,
      disposition: "generated",
      wrapper: row.symbol,
    });
  }
  return { entries, blocked, discovered: decisions.size, patterns: plan.patternRegistry };
}

async function build(options = {}) {
  const inputs = Object.fromEntries(
    await Promise.all(
      Object.keys(defaults).map(async (key) => {
        const value = options[key] ?? path.resolve(root, defaults[key]);
        return [
          key,
          typeof value === "string" && value.trimStart().startsWith("{") ? value : await readFile(value, "utf8"),
        ];
      }),
    ),
  );
  const parsed = Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, JSON.parse(value)]));
  const { entries, blocked, discovered, patterns } = validate(inputs, parsed);
  const recipeFacts = createDmSdkHashStateRecipeFacts({
    defoldRevision: parsed.plan.defoldRevision,
    entries,
    capacityPerWidth: parsed.policy.registry.capacityPerWidth,
  });
  const artifacts = renderDmSdkHashStateOutputs(recipeFacts);
  const report = {
    schemaVersion: 1,
    policyVersion: parsed.policy.policyVersion,
    defoldRevision: parsed.plan.defoldRevision,
    sources: defaults,
    sourceHashes: {
      ...parsed.plan.sourceHashes,
      shapes: sha256(inputs.shapes),
      policy: sha256(inputs.policy),
      plan: sha256(inputs.plan),
    },
    policy: {
      ...parsed.policy,
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
      discovered,
      generated: entries.length,
      blocked: blocked.length,
      registryCapacityPerWidth: parsed.policy.registry.capacityPerWidth,
      exactFixtureCount: entries.length,
    },
    artifacts: [...artifacts.keys()].sort(),
    artifactHashes: Object.fromEntries([...artifacts].sort().map(([name, value]) => [name, sha256(value)])),
    declarations: entries,
    blockedDeclarations: blocked,
  };
  artifacts.set(artifactPaths.report, `${JSON.stringify(report, null, 2)}\n`);
  artifacts.set(
    "packages/bindings/generated/defold-dmsdk-hash-state-recipe-facts.json",
    `${JSON.stringify(recipeFacts, null, 2)}\n`,
  );
  return { artifacts, report };
}

async function run(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const { artifacts, report } = await build(options);
  for (const [relative, content] of artifacts) {
    const output = path.resolve(options.outRoot, relative);
    if (options.check) {
      if ((await readFile(output, "utf8")) !== content) throw new Error(`${relative} is stale`);
    } else {
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, content);
    }
  }
  process.stdout.write(
    `${options.check ? "Verified" : "Generated"} ${report.coverage.generated}/${report.coverage.discovered} dmHash state bindings.\n`,
  );
  return report;
}
export { build, run };
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  run().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
