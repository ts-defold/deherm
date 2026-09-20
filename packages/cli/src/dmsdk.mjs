import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { materializeDmSdkUsages } from "../../compiler/src/dmsdk-universal-materializer.mjs";
import { findProjectRoot } from "./project.mjs";

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

async function writePublishedSet(members, sentinel) {
  const staged = members.map(([target, contents]) => ({
    target,
    contents,
    temporary: `${target}.deherm-tmp-${process.pid}`,
  }));
  try {
    await Promise.all(staged.map(async ({ target, contents, temporary }) => {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(temporary, contents);
    }));
    for (const member of staged.filter(({ target }) => target !== sentinel)) {
      await rename(member.temporary, member.target);
    }
    const published = staged.find(({ target }) => target === sentinel);
    if (!published) throw new Error(`dmSDK output set has no sentinel ${sentinel}`);
    await rename(published.temporary, published.target);
  } finally {
    await Promise.all(staged.map(({ temporary }) => rm(temporary, { force: true })));
  }
}

async function resolveCatalogPath({ catalog, project, usagePath }) {
  if (catalog) return path.resolve(catalog);
  const projectRoot = await findProjectRoot(path.dirname(usagePath), project).catch(() => null);
  if (!projectRoot) {
    throw new Error("dmSDK materialization needs --catalog <defold-dmsdk-universal-bindings.json>, or a generated Defold project containing .deherm/ir/dmsdk-universal-bindings.json");
  }
  return path.join(projectRoot, ".deherm", "ir", "dmsdk-universal-bindings.json");
}

export async function materializeDmSdkUsageFile({ usage, output, catalog, project, check = false }) {
  if (!usage) throw new Error("dmSDK materialization requires --usage <path>");
  if (!output) throw new Error("dmSDK materialization requires --output <path>");
  const usagePath = path.resolve(usage);
  const outputPath = path.resolve(output);
  const reportPath = `${outputPath}.json`;
  const outputExtension = path.extname(outputPath);
  const outputStem = outputExtension ? outputPath.slice(0, -outputExtension.length) : outputPath;
  const verificationSourcePath = `${outputStem}.verify${outputExtension || ".cpp"}`;
  const verificationReportPath = `${outputStem}.verify.json`;
  const catalogPath = await resolveCatalogPath({ catalog, project, usagePath });
  const [usageSource, catalogSource] = await Promise.all([
    readFile(usagePath, "utf8"),
    readFile(catalogPath, "utf8")
  ]);
  let parsed;
  try {
    parsed = JSON.parse(usageSource);
  } catch (error) {
    throw new Error(`${usagePath}: invalid JSON: ${error.message}`);
  }
  const document = validateUsageDocument(parsed, usagePath);
  let catalogDocument;
  try {
    catalogDocument = JSON.parse(catalogSource);
  } catch (error) {
    throw new Error(`${catalogPath}: invalid JSON: ${error.message}`);
  }
  const generated = materializeDmSdkUsages(document.usages, {
    ...(document.options ?? {}),
    catalog: catalogDocument,
    catalogSha256: document.catalogSha256
  });
  const source = generated.source.endsWith("\n") ? generated.source : `${generated.source}\n`;
  const verificationSource = generated.verificationSource.endsWith("\n")
    ? generated.verificationSource
    : `${generated.verificationSource}\n`;
  const verificationReport = `${JSON.stringify(generated.verification, null, 2)}\n`;
  const report = `${JSON.stringify({
    schemaVersion: 1,
    source: "deherm-dmsdk-usage-materializer",
    usageSha256: sha256(usageSource),
    catalogSourceSha256: sha256(catalogSource),
    outputSha256: sha256(source),
    verificationOutputSha256: sha256(verificationSource),
    verificationReportSha256: sha256(verificationReport),
    verificationManifestSha256: generated.verification.manifestSha256,
    catalogSha256: generated.catalogSha256,
    provider: generated.provider,
    materializedCount: generated.manifest.length,
    declarations: generated.manifest,
  }, null, 2)}\n`;
  if (check) {
    const [existingSource, existingReport, existingVerificationSource, existingVerificationReport] = await Promise.all([
      readFile(outputPath, "utf8"),
      readFile(reportPath, "utf8"),
      readFile(verificationSourcePath, "utf8"),
      readFile(verificationReportPath, "utf8"),
    ]);
    if (existingSource !== source) throw new Error(`${outputPath} is stale; rerun dmSDK materialization`);
    if (existingReport !== report) throw new Error(`${reportPath} is stale; rerun dmSDK materialization`);
    if (existingVerificationSource !== verificationSource) {
      throw new Error(`${verificationSourcePath} is stale; rerun dmSDK materialization`);
    }
    if (existingVerificationReport !== verificationReport) {
      throw new Error(`${verificationReportPath} is stale; rerun dmSDK materialization`);
    }
  } else {
    await writePublishedSet([
      [outputPath, source],
      [verificationSourcePath, verificationSource],
      [verificationReportPath, verificationReport],
      [reportPath, report],
    ], reportPath);
  }
  return {
    usage: usagePath,
    catalog: catalogPath,
    output: outputPath,
    report: reportPath,
    verificationSource: verificationSourcePath,
    verificationReport: verificationReportPath,
    provider: generated.provider,
    verificationProvider: generated.verification.provider,
    materializedCount: generated.manifest.length,
    checked: check,
  };
}
