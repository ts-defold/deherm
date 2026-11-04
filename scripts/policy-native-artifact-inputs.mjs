#!/usr/bin/env node

// Project native build inputs from the immutable policy store. This keeps a
// policy revision's SDK and target matrix recoverable after its derivation run
// artifact expires or a channel moves on to a newer revision.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { nativeArtifactCompatibility } from "../packages/compiler/src/defold-toolchain-pins.mjs";
import { objectPath, policyPath, restoreDefoldRevision } from "../packages/compiler/src/api-policy.mjs";
import { readStore, storeRoot } from "./generate-api-policy.mjs";

const SDK_FIELDS = Object.freeze([
  ["androidNdkVersion", "ANDROID_NDK_VERSION"],
  ["androidNdkApiVersion", "ANDROID_NDK_API_VERSION"],
  ["android64NdkApiVersion", "ANDROID_64_NDK_API_VERSION"],
  ["androidTargetApiLevel", "ANDROID_TARGET_API_LEVEL"],
  ["iphoneosVersionMin", "VERSION_IPHONEOS_MIN"],
  ["macosxVersionMin", "VERSION_MACOSX_MIN"],
]);

const REVISION = /^[a-f0-9]{40}$/u;
const HASH = /^[a-f0-9]{64}$/u;

function fail(message) {
  throw new Error(message);
}

export function policyBundleTargetsFromToolchain(toolchain, revision, toolchainHash) {
  const pins = toolchain?.pins;
  const targets = toolchain?.targetMatrix?.targets;
  if (!pins || typeof pins !== "object") fail(`${revision} policy toolchain has no Defold SDK pins`);
  if (!Array.isArray(targets) || targets.length === 0) fail(`${revision} policy toolchain has no target matrix`);

  const sdk = Object.fromEntries(
    SDK_FIELDS.map(([field, symbol]) => {
      if (pins[symbol] === undefined) fail(`${revision} policy toolchain has no ${symbol} native artifact pin`);
      return [field, pins[symbol]];
    }),
  );
  const targetNames = new Set();
  for (const row of targets) {
    if (
      !row ||
      typeof row.target !== "string" ||
      typeof row.architecture !== "string" ||
      typeof row.group !== "string" ||
      !["bundle", "retired"].includes(row.kind)
    ) {
      fail(`${revision} policy toolchain has a malformed target row`);
    }
    if (targetNames.has(row.target)) fail(`${revision} policy toolchain repeats target ${row.target}`);
    targetNames.add(row.target);
  }

  return {
    schemaVersion: 1,
    source: "policy-store:@toolchain",
    // The object path itself is content-addressed and was authenticated by
    // readStore before it is used here.
    sourceSha256: toolchainHash,
    defoldRevision: revision,
    sdk,
    groups: [...new Set(targets.map(({ group }) => group).filter((group) => group !== "common"))].sort(),
    targets,
  };
}

async function policyInputForEntry({ storeDirectory, layoutVersion, entry }) {
  const policyFile = path.join(storeDirectory, policyPath(layoutVersion, entry.policyRoot));
  const policy = JSON.parse(await readFile(policyFile, "utf8"));
  const toolchainHash = policy.subtrees?.["@toolchain"];
  if (!HASH.test(toolchainHash ?? "")) fail(`${entry.defoldRevision} has no authenticated @toolchain object`);
  const toolchainFile = path.join(storeDirectory, objectPath(layoutVersion, toolchainHash));
  const toolchain = JSON.parse(await readFile(toolchainFile, "utf8"));
  const restoredToolchain = restoreDefoldRevision(toolchain, entry.defoldRevision);
  const bundleTargets = policyBundleTargetsFromToolchain(restoredToolchain, entry.defoldRevision, toolchainHash);
  const compatibility = nativeArtifactCompatibility(restoredToolchain);
  return {
    schemaVersion: 1,
    kind: "deherm.policy-native-artifact-input",
    defoldRevision: entry.defoldRevision,
    policyRoot: entry.policyRoot,
    toolchainHash,
    compatibility,
    bundleTargets,
  };
}

async function readValidatedStore(storeDirectory, layoutVersion) {
  const store = await readStore(storeDirectory, layoutVersion);
  if (store.problems.length || store.orphans.length) {
    fail(
      [...store.problems, ...(store.orphans.length ? [`${store.orphans.length} orphaned policy object(s)`] : [])].join(
        "\n",
      ),
    );
  }
  return store;
}

/** Resolve one revision from its authenticated index/policy/@toolchain closure. */
export async function readPolicyNativeArtifactInput(options) {
  const storeDirectory = path.resolve(options.storeDirectory ?? storeRoot);
  const layoutVersion = options.layoutVersion ?? "v1";
  const revision = options.revision;
  if (!REVISION.test(revision ?? "")) fail(`Not a Defold revision: ${revision}`);
  const store = await readValidatedStore(storeDirectory, layoutVersion);
  const entry = store.entries.find((candidate) => candidate.defoldRevision === revision);
  if (!entry) fail(`${revision} is not indexed in the authenticated policy store`);
  return policyInputForEntry({ storeDirectory, layoutVersion, entry });
}

/** Resolve each distinct compatibility represented by the full policy store. */
export async function collectPolicyNativeArtifactInputs(options = {}) {
  const storeDirectory = path.resolve(options.storeDirectory ?? storeRoot);
  const layoutVersion = options.layoutVersion ?? "v1";
  const store = await readValidatedStore(storeDirectory, layoutVersion);
  const byCompatibility = new Map();
  for (const entry of store.entries) {
    const input = await policyInputForEntry({ storeDirectory, layoutVersion, entry });
    const identity = input.compatibility.sha256;
    const previous = byCompatibility.get(identity);
    if (previous) previous.revisions.push(entry.defoldRevision);
    else byCompatibility.set(identity, { ...input, revisions: [entry.defoldRevision] });
  }
  return [...byCompatibility.values()]
    .map((input) => ({ ...input, revisions: input.revisions.sort() }))
    .sort((left, right) => left.compatibility.sha256.localeCompare(right.compatibility.sha256));
}

function parseArguments(argv) {
  const options = { storeDirectory: storeRoot, layoutVersion: "v1" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--store-root") options.storeDirectory = argv[++index];
    else if (argument === "--layout") options.layoutVersion = argv[++index];
    else if (argument === "--all") options.all = true;
    else if (argument === "--revision") options.revision = argv[++index];
    else if (argument === "--compatibility") options.compatibility = argv[++index];
    else if (argument === "--manifest-out") options.manifestOut = path.resolve(argv[++index]);
    else if (argument === "--out") options.output = path.resolve(argv[++index]);
    else fail(`Unknown argument: ${argument}`);
  }
  if (options.all === Boolean(options.revision)) fail("Choose exactly one of --all or --revision");
  if (options.revision && !REVISION.test(options.revision)) fail("--revision must be a full Defold SHA");
  if (options.compatibility && !HASH.test(options.compatibility)) fail("--compatibility must be a SHA-256 digest");
  if (options.manifestOut && !options.revision) fail("--manifest-out requires --revision");
  return options;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  let result;
  if (options.all) {
    result = await collectPolicyNativeArtifactInputs(options);
  } else {
    result = await readPolicyNativeArtifactInput(options);
    if (options.compatibility && result.compatibility.sha256 !== options.compatibility) {
      fail(
        `${options.revision} resolves to native compatibility ${result.compatibility.sha256}, not ${options.compatibility}`,
      );
    }
    if (options.manifestOut) {
      await writeFile(options.manifestOut, `${JSON.stringify(result.bundleTargets, null, 2)}\n`);
    }
  }
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (options.output) await writeFile(options.output, serialized);
  else process.stdout.write(serialized);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
