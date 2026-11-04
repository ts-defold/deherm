import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  loadExpectedPolicyIndex,
  loadPolicyExpectation,
  manifestUrl,
  waitForPublishedPolicy,
} from "../scripts/check-published-policy.mjs";

const revision = "a".repeat(40);
const policyRoot = "b".repeat(64);
const generator = `sha256:${"c".repeat(64)}`;
const expectedArtifactsSha256 = "e".repeat(64);

function fixtureIndex() {
  const entry = { defoldRevision: revision, policyRoot, generator };
  return {
    schemaVersion: 1,
    kind: "deherm.policy.index",
    base: {
      url: "https://policy.invalid/deherm",
      pathPrefix: "",
      layoutVersion: "v1",
      index: "v1/index/{defoldRevision}.json",
    },
    entries: [entry],
  };
}

function fixturePointer(artifactsSha256) {
  return {
    schemaVersion: 1,
    kind: "deherm.policy.index-entry",
    defoldRevision: revision,
    policyRoot,
    generator,
    artifactsSha256,
  };
}

async function writeExpectedIndex(directory, { pointer = fixturePointer(expectedArtifactsSha256) } = {}) {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "manifest.json"), `${JSON.stringify(fixtureIndex())}\n`);
  if (pointer) await writeFile(path.join(directory, `${revision}.json`), `${JSON.stringify(pointer)}\n`);
}

async function withTempDirectory(run) {
  const directory = await mkdtemp(path.join(tmpdir(), "published-policy-freshness-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("expected publication waits for the artifact pointer digest even when the manifest already matches", async () => {
  await withTempDirectory(async (directory) => {
    await writeExpectedIndex(directory);
    const { expected, artifactDigests } = await loadExpectedPolicyIndex(directory);
    const url = manifestUrl(expected);
    const pointerUrl = `https://policy.invalid/deherm/v1/index/${revision}.json`;
    const oldPointer = fixturePointer("d".repeat(64));
    let manifestRequests = 0;
    let pointerRequests = 0;
    const iterationSignals = [];
    const fetchImpl = async (requestedUrl, options) => {
      assert.equal(options.cache, "no-store");
      assert.ok(options.signal instanceof AbortSignal);
      if (requestedUrl === url) {
        manifestRequests += 1;
        iterationSignals.push(options.signal);
        return new Response(JSON.stringify(expected), { status: 200 });
      }
      assert.equal(requestedUrl, pointerUrl);
      pointerRequests += 1;
      assert.equal(options.signal, iterationSignals.at(-1), "manifest and pointer share one bounded iteration timeout");
      const pointer = pointerRequests === 1 ? oldPointer : fixturePointer(expectedArtifactsSha256);
      return new Response(JSON.stringify(pointer), { status: 200 });
    };

    const result = await waitForPublishedPolicy({
      expected,
      expectedArtifactDigests: artifactDigests,
      fetchImpl,
      timeoutMs: 100,
      intervalMs: 1,
      sleep: async () => {},
    });

    assert.equal(result.url, url);
    assert.equal(manifestRequests, 2);
    assert.equal(pointerRequests, 2);
    assert.notEqual(iterationSignals[0], iterationSignals[1]);
  });
});

test("expected publication snapshot rejects missing or incomplete revision pointers before polling", async () => {
  await withTempDirectory(async (directory) => {
    await writeExpectedIndex(directory, { pointer: null });
    await assert.rejects(loadExpectedPolicyIndex(directory), /incomplete: cannot read pointer/u);

    await writeFile(
      path.join(directory, `${revision}.json`),
      `${JSON.stringify({
        ...fixturePointer(expectedArtifactsSha256),
        artifactsSha256: undefined,
      })}\n`,
    );
    await assert.rejects(loadExpectedPolicyIndex(directory), /pointer .* is incomplete or inconsistent/u);
  });
});

test("callers without an expected snapshot retain manifest-only publication waiting", async () => {
  const expected = fixtureIndex();
  let requests = 0;
  const result = await waitForPublishedPolicy({
    expected,
    timeoutMs: 100,
    intervalMs: 1,
    fetchImpl: async (url) => {
      requests += 1;
      assert.equal(url, manifestUrl(expected));
      return new Response(JSON.stringify(expected), { status: 200 });
    },
  });

  assert.equal(result.url, manifestUrl(expected));
  assert.equal(requests, 1);
});

test("expected-index mode selects publisher snapshot instead of the installed package index", async () => {
  await withTempDirectory(async (directory) => {
    await writeExpectedIndex(directory);
    const { expected, artifactDigests } = await loadPolicyExpectation(directory);
    const manifestOnDisk = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
    assert.deepEqual(expected, manifestOnDisk);
    assert.equal(expected.entries[0].defoldRevision, revision);
    assert.equal(artifactDigests.get(revision), expectedArtifactsSha256);
  });
});
