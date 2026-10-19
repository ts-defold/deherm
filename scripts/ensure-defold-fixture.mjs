#!/usr/bin/env node

// Pinned contributor/CI inputs, never part of consumer policy realization.
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import { readLockKeys } from "./lib/upstream-lock.mjs";
import { fileSha256 } from "./publish-defold-bob-mirror.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = {
  "ref-doc": { asset: "ref-doc.zip", pin: "DEFOLD_REF_DOC" },
  "defold-sdk": { asset: "defoldsdk.zip", pin: "DEFOLD_SDK" },
};

export async function defoldFixtureCoordinates(kind, workspace = root) {
  const fixture = fixtures[kind];
  if (!fixture) throw new Error(`Unknown Defold fixture ${kind}; expected ref-doc or defold-sdk`);
  const pins = await readLockKeys(path.join(workspace, "upstream.lock"), [
    "DEFOLD_REV",
    `${fixture.pin}_URL`,
    `${fixture.pin}_SHA256`,
  ]);
  const revision = pins.DEFOLD_REV;
  const sha256 = pins[`${fixture.pin}_SHA256`];
  const url = pins[`${fixture.pin}_URL`];
  if (!/^[a-f0-9]{40}$/.test(revision) || !/^[a-f0-9]{64}$/.test(sha256) || !url.startsWith("https://"))
    throw new Error(`Invalid pinned Defold ${kind} coordinates`);
  const tag = `defold-fixtures-${revision}`;
  return {
    ...fixture,
    revision,
    sha256,
    url,
    tag,
    file: path.join(workspace, "upstream", fixture.asset),
    mirrorUrl: `https://github.com/ts-defold/deherm/releases/download/${tag}/${fixture.asset}`,
  };
}

export async function ensureDefoldFixture(kind, workspace = root, fetchImpl = fetch) {
  const input = await defoldFixtureCoordinates(kind, workspace);
  const cached = await fileSha256(input.file).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (cached === input.sha256) return input.file;
  await mkdir(path.dirname(input.file), { recursive: true });
  const temporary = `${input.file}.download-${process.pid}`;
  const failures = [];
  try {
    for (const url of [input.url, input.mirrorUrl]) {
      await rm(temporary, { force: true });
      try {
        const response = await fetchImpl(url, { signal: AbortSignal.timeout(180_000) });
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
        await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: "wx" }));
        const actual = await fileSha256(temporary);
        if (actual !== input.sha256) throw new Error(`SHA-256 mismatch: expected ${input.sha256}, got ${actual}`);
        await rename(temporary, input.file);
        return input.file;
      } catch (error) {
        failures.push(`${url}: ${error.message}`);
      }
    }
    throw new Error(`Cannot obtain pinned ${kind}: ${failures.join("; ")}`);
  } finally {
    await rm(temporary, { force: true });
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  console.log(await ensureDefoldFixture(process.argv[2]));
