import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { verifyDmSdkCallSymbolIndex } from "../../compiler/src/dmsdk-call-symbol-index.mjs";
import { materializeDmSdkGeneratedAdapterUsages } from "../../compiler/src/dmsdk-concrete-call-plan.mjs";
import { renderDmSdkUniversalJsiExactRunner } from "../../compiler/src/dmsdk-universal-jsi-exact-runner.mjs";
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
  if (value.generator === "@ts-defold/deherm ttsc/dmsdk-usage/v1") {
    if (value.profile !== "release") {
      throw new Error(`${source}: checker-generated dmSDK usage must come from a release-profile typecheck`);
    }
    if (value.usageCount !== value.usages.length) {
      throw new Error(`${source}: usageCount does not match the checker-generated usages array`);
    }
    for (const key of ["ambiguousSites", "unresolvedSites", "specializationRequiredSites"]) {
      if (!Array.isArray(value[key])) throw new Error(`${source}: checker-generated dmSDK usage is missing ${key}`);
      if (value[key].length) {
        throw new Error(`${source}: checker-generated dmSDK usage has ${value[key].length} ${key}; fix the reported call sites before materialization`);
      }
    }
    if (!/^[0-9a-f]{64}$/.test(value.symbolIndexSourceSha256 ?? "")) {
      throw new Error(`${source}: checker-generated dmSDK usage needs the actual symbol-index source SHA-256`);
    }
    for (const usage of value.usages) {
      if (!["universal-ready", "generated-adapter"].includes(usage?.materialization?.state)) {
        throw new Error(`${source}: checker-generated usage ${usage?.declarationId ?? "<unknown>"} has no executable lowering state`);
      }
    }
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

async function readCheckerSymbolIndex({ document, project, usagePath }) {
  const candidates = [path.join(path.dirname(usagePath), "dmsdk-call-symbol-index.json")];
  const projectRoot = await findProjectRoot(path.dirname(usagePath), project).catch(() => null);
  if (projectRoot) candidates.push(path.join(projectRoot, ".deherm", "generated", "dmsdk-call-symbol-index.json"));
  let lastError;
  for (const candidate of [...new Set(candidates)]) {
    try {
      const source = await readFile(candidate, "utf8");
      const sourceSha256 = sha256(source);
      if (sourceSha256 !== document.symbolIndexSourceSha256) {
        throw new Error(`${candidate}: source SHA-256 does not match the release typecheck manifest`);
      }
      let parsed;
      try {
        parsed = JSON.parse(source);
      } catch (error) {
        throw new Error(`${candidate}: invalid JSON: ${error.message}`);
      }
      const index = verifyDmSdkCallSymbolIndex(parsed, candidate);
      if (document.catalogSha256 !== index.catalogSha256 || document.defoldRevision !== index.defoldRevision ||
          document.surfaceRecipeCount !== index.recipeCount) {
        throw new Error(`${candidate}: checker manifest identities do not match the authenticated symbol index`);
      }
      for (const usage of document.usages) {
        const exact = index.declarations[usage.declarationId];
        if (!exact || exact.numericId !== usage.numericId || exact.symbol !== usage.symbol ||
            !isDeepStrictEqual(exact.materialization, usage.materialization)) {
          throw new Error(`${candidate}: checker usage '${usage.declarationId}' does not match the authenticated symbol index`);
        }
      }
      return { file: candidate, index, sourceSha256 };
    } catch (error) {
      if (error?.code === "ENOENT") {
        lastError = error;
        continue;
      }
      throw error;
    }
  }
  throw new Error(`${usagePath}: checker-generated dmSDK usage requires its generated dmsdk-call-symbol-index.json (${lastError?.message ?? "not found"})`);
}

export async function materializeDmSdkUsageFile({ usage, output, catalog, project, check = false }) {
  let projectRoot;
  if (!usage || !output) {
    projectRoot = await findProjectRoot(process.cwd(), project);
  }
  const usagePath = path.resolve(usage ?? path.join(projectRoot, ".deherm", "generated", "dmsdk-usage.json"));
  const outputPath = path.resolve(output ?? path.join(projectRoot, ".deherm", "generated", "dmsdk-reachable.cpp"));
  const reportPath = `${outputPath}.json`;
  const outputExtension = path.extname(outputPath);
  const outputStem = outputExtension ? outputPath.slice(0, -outputExtension.length) : outputPath;
  const verificationSourcePath = `${outputStem}.verify${outputExtension || ".cpp"}`;
  const verificationReportPath = `${outputStem}.verify.json`;
  const jsiVerificationSourcePath = `${outputStem}.verify.jsi${outputExtension || ".cpp"}`;
  const jsiVerificationReportPath = `${outputStem}.verify.jsi.json`;
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
  const checkerGenerated = document.generator === "@ts-defold/deherm ttsc/dmsdk-usage/v1";
  const symbolIndex = checkerGenerated
    ? await readCheckerSymbolIndex({ document, project, usagePath })
    : null;
  const materializerUsages = checkerGenerated
    ? document.usages.filter(({ materialization }) => materialization.state === "universal-ready")
    : document.usages;
  const generatedAdapterUsages = checkerGenerated
    ? document.usages.filter(({ materialization }) => materialization.state === "generated-adapter")
    : [];
  let catalogDocument;
  try {
    catalogDocument = JSON.parse(catalogSource);
  } catch (error) {
    throw new Error(`${catalogPath}: invalid JSON: ${error.message}`);
  }
  const generated = materializeDmSdkUsages(materializerUsages, {
    ...(document.options ?? {}),
    catalog: catalogDocument,
    catalogSha256: document.catalogSha256
  });
  const generatedAdapters = materializeDmSdkGeneratedAdapterUsages(generatedAdapterUsages, {
    ...(document.options ?? {}),
    recipes: catalogDocument.recipes,
    catalogSha256: document.catalogSha256
  });
  const sourceBody = `${generated.source}${generatedAdapters.source}`;
  const source = sourceBody.endsWith("\n") ? sourceBody : `${sourceBody}\n`;
  const verificationSourceBody = `${generated.verificationSource}${generatedAdapters.source}`;
  const verificationSource = verificationSourceBody.endsWith("\n")
    ? verificationSourceBody
    : `${verificationSourceBody}\n`;
  const verification = {
    ...generated.verification,
    materializedCallCount: generated.manifest.length + generatedAdapters.manifest.length,
    generatedAdapters: generatedAdapters.verification,
  };
  const verificationReport = `${JSON.stringify(verification, null, 2)}\n`;
  const jsiVerification = renderDmSdkUniversalJsiExactRunner(generated, {
    verificationInclude: path.basename(verificationSourcePath),
  });
  const jsiVerificationSource = jsiVerification.source.endsWith("\n")
    ? jsiVerification.source
    : `${jsiVerification.source}\n`;
  const jsiVerificationReport = `${JSON.stringify(jsiVerification.report, null, 2)}\n`;
  const report = `${JSON.stringify({
    schemaVersion: 1,
    source: "deherm-dmsdk-usage-materializer",
    usageSha256: sha256(usageSource),
    catalogSourceSha256: sha256(catalogSource),
    symbolIndexSourceSha256: symbolIndex?.sourceSha256 ?? null,
    outputSha256: sha256(source),
    verificationOutputSha256: sha256(verificationSource),
    verificationReportSha256: sha256(verificationReport),
    verificationManifestSha256: generated.verification.manifestSha256,
    generatedAdapterManifestSha256: generatedAdapters.verification.manifestSha256,
    jsiVerificationOutputSha256: sha256(jsiVerificationSource),
    jsiVerificationReportSha256: sha256(jsiVerificationReport),
    catalogSha256: generated.catalogSha256,
    provider: generated.provider,
    materializedCount: generated.manifest.length + generatedAdapters.manifest.length,
    universalMaterializedCount: generated.manifest.length,
    generatedAdapterCount: generatedAdapters.manifest.length,
    declarations: [...generated.manifest, ...generatedAdapters.manifest]
      .sort((left, right) => left.numericId - right.numericId),
  }, null, 2)}\n`;
  if (check) {
    const [
      existingSource,
      existingReport,
      existingVerificationSource,
      existingVerificationReport,
      existingJsiVerificationSource,
      existingJsiVerificationReport,
    ] = await Promise.all([
      readFile(outputPath, "utf8"),
      readFile(reportPath, "utf8"),
      readFile(verificationSourcePath, "utf8"),
      readFile(verificationReportPath, "utf8"),
      readFile(jsiVerificationSourcePath, "utf8"),
      readFile(jsiVerificationReportPath, "utf8"),
    ]);
    if (existingSource !== source) throw new Error(`${outputPath} is stale; rerun dmSDK materialization`);
    if (existingReport !== report) throw new Error(`${reportPath} is stale; rerun dmSDK materialization`);
    if (existingVerificationSource !== verificationSource) {
      throw new Error(`${verificationSourcePath} is stale; rerun dmSDK materialization`);
    }
    if (existingVerificationReport !== verificationReport) {
      throw new Error(`${verificationReportPath} is stale; rerun dmSDK materialization`);
    }
    if (existingJsiVerificationSource !== jsiVerificationSource) {
      throw new Error(`${jsiVerificationSourcePath} is stale; rerun dmSDK materialization`);
    }
    if (existingJsiVerificationReport !== jsiVerificationReport) {
      throw new Error(`${jsiVerificationReportPath} is stale; rerun dmSDK materialization`);
    }
  } else {
    await writePublishedSet([
      [outputPath, source],
      [verificationSourcePath, verificationSource],
      [verificationReportPath, verificationReport],
      [jsiVerificationSourcePath, jsiVerificationSource],
      [jsiVerificationReportPath, jsiVerificationReport],
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
    jsiVerificationSource: jsiVerificationSourcePath,
    jsiVerificationReport: jsiVerificationReportPath,
    provider: generated.provider,
    verificationProvider: generated.verification.provider,
    materializedCount: generated.manifest.length + generatedAdapters.manifest.length,
    universalMaterializedCount: generated.manifest.length,
    generatedAdapterCount: generatedAdapters.manifest.length,
    checked: check,
  };
}
