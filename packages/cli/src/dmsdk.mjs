import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { materializeDmSdkUsages } from "../../compiler/src/dmsdk-universal-materializer.mjs";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function validateUsageDocument(value, source) {
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.usages)) {
    throw new Error(`${source}: expected a schemaVersion 1 dmSDK usage document with a usages array`);
  }
  if (!/^[0-9a-f]{64}$/.test(value.catalogSha256 ?? "")) {
    throw new Error(`${source}: catalogSha256 must be the exact 64-character generated catalog identity`);
  }
  const declarationIds = value.usages.map((usage) => usage?.declarationId);
  if (declarationIds.some((id) => typeof id !== "string" || !id)) {
    throw new Error(`${source}: every dmSDK usage needs a non-empty declarationId`);
  }
  if (new Set(declarationIds).size !== declarationIds.length) {
    throw new Error(`${source}: dmSDK usage declarationIds must be unique`);
  }
  if (value.options !== undefined) {
    if (!value.options || typeof value.options !== "object" || Array.isArray(value.options)) {
      throw new Error(`${source}: options must be an object`);
    }
    const allowed = new Set(["providerName", "installName", "maxArguments"]);
    const unknown = Object.keys(value.options).filter((key) => !allowed.has(key));
    if (unknown.length) throw new Error(`${source}: unsupported materializer option '${unknown[0]}'`);
    if (value.options.maxArguments !== undefined &&
        (!Number.isSafeInteger(value.options.maxArguments) || value.options.maxArguments <= 0 || value.options.maxArguments > 1024)) {
      throw new Error(`${source}: options.maxArguments must be an integer in 1..1024`);
    }
  }
  return value;
}

async function writeAtomically(target, contents) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.deherm-tmp-${process.pid}`;
  try {
    await writeFile(temporary, contents);
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function materializeDmSdkUsageFile({ usage, output, check = false }) {
  if (!usage) throw new Error("dmSDK materialization requires --usage <path>");
  if (!output) throw new Error("dmSDK materialization requires --output <path>");
  const usagePath = path.resolve(usage);
  const outputPath = path.resolve(output);
  const reportPath = `${outputPath}.json`;
  const usageSource = await readFile(usagePath, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(usageSource);
  } catch (error) {
    throw new Error(`${usagePath}: invalid JSON: ${error.message}`);
  }
  const document = validateUsageDocument(parsed, usagePath);
  const generated = materializeDmSdkUsages(document.usages, { ...(document.options ?? {}), catalogSha256: document.catalogSha256 });
  const source = generated.source.endsWith("\n") ? generated.source : `${generated.source}\n`;
  const report = `${JSON.stringify({
    schemaVersion: 1,
    source: "deherm-dmsdk-usage-materializer",
    usageSha256: sha256(usageSource),
    outputSha256: sha256(source),
    catalogSha256: generated.catalogSha256,
    provider: generated.provider,
    materializedCount: generated.manifest.length,
    declarations: generated.manifest,
  }, null, 2)}\n`;
  if (check) {
    const [existingSource, existingReport] = await Promise.all([
      readFile(outputPath, "utf8"),
      readFile(reportPath, "utf8"),
    ]);
    if (existingSource !== source) throw new Error(`${outputPath} is stale; rerun dmSDK materialization`);
    if (existingReport !== report) throw new Error(`${reportPath} is stale; rerun dmSDK materialization`);
  } else {
    await Promise.all([
      writeAtomically(outputPath, source),
      writeAtomically(reportPath, report),
    ]);
  }
  return {
    usage: usagePath,
    output: outputPath,
    report: reportPath,
    provider: generated.provider,
    materializedCount: generated.manifest.length,
    checked: check,
  };
}
