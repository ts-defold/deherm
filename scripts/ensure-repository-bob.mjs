#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ensureBob } from "../packages/cli/src/dev/defold-builder.mjs";
import { readLockKeys } from "./lib/upstream-lock.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function ensureRepositoryBob(root = repositoryRoot, options = {}) {
  const pins = await readLockKeys(path.join(root, "upstream.lock"), [
    "DEFOLD_REV",
    "DEFOLD_BOB_URL",
    "DEFOLD_BOB_SHA256",
  ]);
  return ensureBob(
    root,
    {
      defoldRevision: pins.DEFOLD_REV,
      toolchain: { bob: { url: pins.DEFOLD_BOB_URL, sha256: pins.DEFOLD_BOB_SHA256 } },
    },
    {
      ...options,
      cacheDirectory: path.join(root, "build", "tooling"),
    },
  );
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  console.log(await ensureRepositoryBob());
}
