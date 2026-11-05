#!/usr/bin/env node

// Reconcile desired compatibility-specific mappings against immutable release
// assets. Policy-site history is fallback data; it never suppresses production
// for a desired recipe whose current assets are still incomplete.

import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { validateArtifactReferences } from "./build-policy-site.mjs";
import { buildArtifactReferences } from "../packages/generator/src/policy/artifact-references.mjs";
import { artifactAssetRows } from "./project-artifact-references.mjs";
import { nativeArtifactErrorCodes } from "./lib/artifact-releases.mjs";

const HASH = /^[a-f0-9]{64}$/u;

function compatibilitySha(references) {
  const sha = references?.["native-artifacts"]?.compatibility?.sha256;
  return HASH.test(sha ?? "") ? sha : null;
}

/**
 * Prefer newly authenticated mappings over older mappings for the same
 * compatibility. The worklist is determined by the desired current recipes,
 * not by whether some historical mapping happens to be available.
 */
export function reconcilePolicyNativeArtifactMappings({ inputs, artifactHistory, completedMappings, workItems }) {
  if (!Array.isArray(inputs) || !Array.isArray(artifactHistory) || !Array.isArray(completedMappings)) {
    throw new Error("Policy native-artifact reconciliation requires input and mapping arrays");
  }
  const mappings = new Map();
  for (const references of artifactHistory) {
    validateArtifactReferences(references, "historical artifact mapping", { requireIntegrity: true });
    const sha = compatibilitySha(references);
    if (sha && !mappings.has(sha)) mappings.set(sha, references);
  }
  for (const references of completedMappings) {
    validateArtifactReferences(references, "reconciled artifact mapping", { requireIntegrity: true });
    const sha = compatibilitySha(references);
    if (!sha) throw new Error("Reconciled artifact mapping has no native compatibility digest");
    mappings.set(sha, references);
  }

  const uniqueWork = new Map();
  for (const item of workItems ?? []) {
    const sha = item?.compatibility?.sha256;
    const revision = item?.defoldRevision;
    if (!HASH.test(sha ?? "") || !/^[a-f0-9]{40}$/u.test(revision ?? "")) {
      throw new Error("Native-artifact work item requires an exact compatibility and Defold revision");
    }
    if (!uniqueWork.has(sha)) uniqueWork.set(sha, { defoldRevision: revision, compatibilitySha256: sha });
  }
  for (const input of inputs) {
    if (!HASH.test(input?.compatibility?.sha256 ?? "")) {
      throw new Error("Indexed policy input has no native compatibility digest");
    }
  }
  return {
    artifactHistory: [...mappings.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, references]) => references),
    workItems: [...uniqueWork.values()].sort((left, right) =>
      left.compatibilitySha256.localeCompare(right.compatibilitySha256),
    ),
  };
}

export function releaseLookupWasNotFound(error) {
  return error?.httpStatus === 404;
}

export function isUnsupportedNativeRecipe(error) {
  return (
    error?.code === nativeArtifactErrorCodes.unsupportedTarget ||
    error?.code === nativeArtifactErrorCodes.unsupportedRecipe
  );
}

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export async function githubReleaseAssets(
  tag,
  repository,
  {
    token = process.env.GH_TOKEN,
    apiRoot = process.env.GITHUB_API_URL ?? "https://api.github.com",
    fetchImpl = globalThis.fetch,
  } = {},
) {
  if (!token) {
    const error = new Error("GH_TOKEN is required to inspect immutable release assets");
    error.code = "ERR_RELEASE_INVENTORY_AUTH";
    throw error;
  }
  if (typeof fetchImpl !== "function") {
    const error = new Error("The runtime does not provide an HTTP fetch implementation");
    error.code = "ERR_RELEASE_INVENTORY_UNAVAILABLE";
    throw error;
  }
  const [owner, name, ...rest] = repository.split("/");
  if (!owner || !name || rest.length) throw new Error(`Invalid GitHub repository identity ${repository}`);
  const apiBase = apiRoot.replace(/\/+$/u, "");
  const url = `${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/releases/tags/${encodeURIComponent(tag)}`;
  let response;
  try {
    response = await fetchImpl(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (cause) {
    const error = new Error(`Cannot inspect release ${tag}: GitHub API transport failed`, { cause });
    error.code = "ERR_RELEASE_INVENTORY_UNAVAILABLE";
    throw error;
  }
  if (!response.ok) {
    const error = new Error(`Cannot inspect release ${tag}: GitHub API returned HTTP ${response.status}`);
    error.code = response.status === 404 ? "ERR_RELEASE_NOT_FOUND" : "ERR_RELEASE_INVENTORY_HTTP";
    error.httpStatus = response.status;
    throw error;
  }
  let release;
  try {
    release = await response.json();
  } catch (cause) {
    const error = new Error(`Cannot inspect release ${tag}: GitHub API returned invalid JSON`, { cause });
    error.code = "ERR_RELEASE_INVENTORY_RESPONSE";
    throw error;
  }
  if (!Array.isArray(release?.assets) || release.assets.some((asset) => typeof asset?.name !== "string")) {
    const error = new Error(`Cannot inspect release ${tag}: GitHub API returned a malformed asset inventory`);
    error.code = "ERR_RELEASE_INVENTORY_RESPONSE";
    throw error;
  }
  return new Set(release.assets.map(({ name: asset }) => asset));
}

export async function inspectPolicyNativeReleaseMapping(
  input,
  { repository, integrityRoot, listAssets, downloadSidecar },
) {
  const references = await buildArtifactReferences({ bundleTargets: input.bundleTargets });
  const expected = artifactAssetRows(references, { includeIntegrity: true });
  const inventory = new Map();
  for (const row of expected) {
    if (!inventory.has(row.tag)) inventory.set(row.tag, await listAssets(row.tag, repository));
  }
  const missing = expected.filter((row) => !inventory.get(row.tag)?.has(row.asset));
  if (missing.length) return { missingDesired: true, missing };

  for (const row of artifactAssetRows(references)) {
    const sidecar = `${row.asset}.integrity.json`;
    await downloadSidecar({ tag: row.tag, family: row.family, asset: sidecar, integrityRoot, repository });
  }
  const authenticated = await buildArtifactReferences({ bundleTargets: input.bundleTargets, integrityRoot });
  validateArtifactReferences(authenticated, "newly published artifact mapping", { requireIntegrity: true });
  return { references: authenticated, missingDesired: false, missing: [] };
}

async function main(argv = process.argv.slice(2)) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--inputs") options.inputs = path.resolve(argv[++index]);
    else if (argument === "--history") options.history = path.resolve(argv[++index]);
    else if (argument === "--complete-directory") options.completeDirectory = path.resolve(argv[++index]);
    else if (argument === "--history-out") options.historyOut = path.resolve(argv[++index]);
    else if (argument === "--work-out") options.workOut = path.resolve(argv[++index]);
    else if (argument === "--health-out") options.healthOut = path.resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  for (const name of ["inputs", "history", "completeDirectory", "historyOut", "workOut", "healthOut"]) {
    if (!options[name])
      throw new Error(
        `Usage: reconcile-policy-native-artifacts.mjs --inputs <json> --history <json> --complete-directory <dir> --history-out <json> --work-out <json>`,
      );
  }
  const inputs = JSON.parse(await readFile(options.inputs, "utf8"));
  const artifactHistory = JSON.parse(await readFile(options.history, "utf8"));
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) throw new Error("GITHUB_REPOSITORY is required to inspect native-artifact releases");
  await mkdir(options.completeDirectory, { recursive: true });
  const runTemporary = await mkdtemp(path.join(os.tmpdir(), "deherm-policy-native-artifacts-"));
  try {
    const releaseAssets = new Map();
    const listAssets = async (tag, repo) => {
      if (!releaseAssets.has(tag)) {
        releaseAssets.set(
          tag,
          (async () => {
            try {
              return await githubReleaseAssets(tag, repo);
            } catch (error) {
              if (!releaseLookupWasNotFound(error)) {
                const failure = new Error(
                  `Cannot inspect release ${tag}: ${error instanceof Error ? error.message : error}`,
                  { cause: error },
                );
                failure.code = error?.code ?? "ERR_RELEASE_INVENTORY_UNAVAILABLE";
                failure.httpStatus = error?.httpStatus;
                throw failure;
              }
              // A genuinely absent tag is an incomplete desired mapping and will be queued.
              return new Set();
            }
          })(),
        );
      }
      return releaseAssets.get(tag);
    };
    const sidecarCache = new Map();
    const completedMappings = [];
    const workItems = [];
    const health = { failures: [], unsupported: [] };
    for (const input of inputs) {
      const sha = input.compatibility.sha256;
      const integrityRoot = path.join(runTemporary, sha);
      try {
        const result = await inspectPolicyNativeReleaseMapping(input, {
          repository,
          integrityRoot,
          listAssets,
          downloadSidecar: async ({ tag, family, asset, integrityRoot: root, repository: repo }) => {
            const directory = path.join(root, family);
            await mkdir(directory, { recursive: true });
            const cacheKey = `${tag}\0${asset}`;
            if (!sidecarCache.has(cacheKey)) {
              sidecarCache.set(
                cacheKey,
                (async () => {
                  const cachedDirectory = path.join(runTemporary, "sidecars", tag);
                  await mkdir(cachedDirectory, { recursive: true });
                  gh(["release", "download", tag, "--repo", repo, "--pattern", asset, "--dir", cachedDirectory]);
                  return path.join(cachedDirectory, asset);
                })(),
              );
            }
            await copyFile(await sidecarCache.get(cacheKey), path.join(directory, asset));
          },
        });
        if (result.references) {
          completedMappings.push(result.references);
          await writeFile(
            path.join(options.completeDirectory, `${sha}.json`),
            `${JSON.stringify(result.references, null, 2)}\n`,
          );
        } else if (result.missingDesired) {
          workItems.push({ defoldRevision: input.revisions[0], compatibility: input.compatibility });
        }
      } catch (error) {
        const row = {
          compatibilitySha256: sha,
          revision: input.revisions[0],
          message: error instanceof Error ? error.message : String(error),
        };
        if (isUnsupportedNativeRecipe(error)) health.unsupported.push(row);
        else health.failures.push(row);
        process.stderr.write(
          `${sha}: native mapping reconciliation ${isUnsupportedNativeRecipe(error) ? "unsupported" : "failed"}: ${row.message}\n`,
        );
      }
    }
    const reconciled = reconcilePolicyNativeArtifactMappings({ inputs, artifactHistory, completedMappings, workItems });
    await Promise.all([
      writeFile(options.historyOut, `${JSON.stringify(reconciled.artifactHistory, null, 2)}\n`),
      writeFile(options.workOut, `${JSON.stringify(reconciled.workItems, null, 2)}\n`),
      writeFile(options.healthOut, `${JSON.stringify(health, null, 2)}\n`),
    ]);
    process.stdout.write(
      `reconciled ${completedMappings.length}/${inputs.length} desired mapping(s); ${reconciled.workItems.length} compatibility build request(s) remain\n`,
    );
  } finally {
    await rm(runTemporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
