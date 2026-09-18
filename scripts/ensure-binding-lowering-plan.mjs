import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  generateBindingLoweringPlan,
  inputPaths,
  loadBindingLoweringInputs
} from "./generate-binding-lowering-plan.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const generatorPath = resolve(scriptDirectory, "generate-binding-lowering-plan.mjs");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseArguments(argv) {
  const options = {
    root: repositoryRoot,
    output: resolve(repositoryRoot, "bindings/generated/defold-binding-lowering-plan.json"),
    sentinel: resolve(repositoryRoot, "bindings/generated/defold-binding-lowering-plan.sentinel.json"),
    check: false,
    deepCheck: false,
    force: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") options.check = true;
    else if (argument === "--deep-check") options.deepCheck = true;
    else if (argument === "--force") options.force = true;
    else if (argument === "--root") options.root = resolve(argv[++index]);
    else if (argument === "--output") options.output = resolve(argv[++index]);
    else if (argument === "--sentinel") options.sentinel = resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if ((options.check || options.deepCheck) && options.force) throw new Error("check modes and --force are mutually exclusive");
  return options;
}

async function readIfPresent(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function statIfPresent(path) {
  try {
    return await stat(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function atomicWrite(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, content);
  await rename(temporary, path);
}

async function cacheIdentity(root, inputs) {
  const generatorSource = await readFile(generatorPath, "utf8");
  const inputHashes = Object.fromEntries(Object.entries(inputs).map(([name, content]) => [name, sha256(content)]));
  const generatorSha256 = sha256(generatorSource);
  return {
    schemaVersion: 1,
    generator: "scripts/generate-binding-lowering-plan.mjs",
    generatorSha256,
    inputPaths,
    inputHashes,
    cacheKey: sha256(JSON.stringify({ generatorSha256, inputHashes, inputPaths, rootSchema: 1 }))
  };
}

function validateCurrent(identity, sentinel, outputStat) {
  if (!sentinel || sentinel.schemaVersion !== 1) return "missing-or-invalid-sentinel";
  if (sentinel.cacheKey !== identity.cacheKey) return "input-or-generator-key-changed";
  if (!outputStat?.isFile()) return "output-missing";
  if (sentinel.outputBytes !== outputStat.size) return "output-size-mismatch";
  return null;
}

export async function ensureBindingLoweringPlan(options = {}) {
  const root = resolve(options.root ?? repositoryRoot);
  const outputPath = resolve(options.output ?? resolve(root, "bindings/generated/defold-binding-lowering-plan.json"));
  const sentinelPath = resolve(options.sentinel ?? resolve(root, "bindings/generated/defold-binding-lowering-plan.sentinel.json"));
  const inputs = await loadBindingLoweringInputs(root);
  const identity = await cacheIdentity(root, inputs);
  const [sentinelText, outputStat] = await Promise.all([readIfPresent(sentinelPath), statIfPresent(outputPath)]);
  let sentinel = null;
  if (sentinelText) {
    try { sentinel = JSON.parse(sentinelText); } catch { sentinel = null; }
  }
  let staleReason = options.force ? "forced" : validateCurrent(identity, sentinel, outputStat);
  if (!staleReason && options.deepCheck) {
    const outputText = await readFile(outputPath, "utf8");
    if (sentinel.outputSha256 !== sha256(outputText)) staleReason = "output-digest-mismatch";
    else {
      try {
        const output = JSON.parse(outputText);
        const { planSha256, ...planBody } = output;
        const calculatedPlanSha256 = sha256(JSON.stringify(planBody));
        if (planSha256 !== calculatedPlanSha256) staleReason = "plan-internal-digest-mismatch";
        else if (sentinel.planSha256 !== planSha256) staleReason = "plan-identity-mismatch";
        else if (JSON.stringify(output.inputHashes) !== JSON.stringify(identity.inputHashes)) staleReason = "plan-input-hashes-mismatch";
        else {
          const expected = `${JSON.stringify(generateBindingLoweringPlan(inputs), null, 2)}\n`;
          if (outputText !== expected) staleReason = "output-does-not-match-declared-inputs";
        }
      } catch {
        staleReason = "output-invalid-json";
      }
    }
  }
  if (!staleReason) {
    return { action: "current", reason: null, cacheKey: identity.cacheKey, planSha256: sentinel.planSha256 };
  }
  if (options.check || options.deepCheck) throw new Error(`Binding lowering plan is stale: ${staleReason}`);

  const plan = generateBindingLoweringPlan(inputs);
  const serialized = `${JSON.stringify(plan, null, 2)}\n`;
  const nextSentinel = {
    ...identity,
    output: "bindings/generated/defold-binding-lowering-plan.json",
    outputBytes: Buffer.byteLength(serialized),
    outputSha256: sha256(serialized),
    planSha256: plan.planSha256
  };
  await atomicWrite(outputPath, serialized);
  await atomicWrite(sentinelPath, `${JSON.stringify(nextSentinel, null, 2)}\n`);
  return { action: "regenerated", reason: staleReason, cacheKey: identity.cacheKey, planSha256: plan.planSha256 };
}

export async function run(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const result = await ensureBindingLoweringPlan(options);
  process.stdout.write(result.action === "current"
    ? `Binding lowering plan is current (${result.cacheKey}). No files written.\n`
    : `Regenerated binding lowering plan (${result.reason}; ${result.cacheKey}).\n`);
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await run();
