import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createIncrementalCompiler } from "../packages/cli/src/dev/compiler.mjs";
import { HotReloadCoordinator } from "../packages/cli/src/dev/coordinator.mjs";

test("incremental compiler fingerprints, mirrors, and reports bundle deltas", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "deherm-compiler-"));
  const entry = path.join(root, "main.ts");
  const output = path.join(root, ".deherm", "dev", "app.js");
  const mirror = path.join(root, "build", "app.js");
  await writeFile(entry, 'declare const __DEFOLD_HERMES_BUILD_FINGERPRINT__: string; console.log(`bundle:${__DEFOLD_HERMES_BUILD_FINGERPRINT__}`, __DEFOLD_HERMES_BUILD_FINGERPRINT__, 42);\n');
  const compiler = await createIncrementalCompiler({
    entryPoint: entry,
    outputFile: output,
    mirrors: [mirror],
    resourcePath: "/app.js",
    useTtsc: false
  });
  t.after(() => compiler.dispose());
  const first = await compiler.rebuild();
  assert.match(first.fingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(first.resourcePaths, ["/app.js"]);
  assert.equal(await readFile(output, "utf8"), await readFile(mirror, "utf8"));
  assert.match(await readFile(output, "utf8"), new RegExp(first.fingerprint));
  assert.equal(first.metrics.moduleCount, 1);
  assert.equal((await readdir(path.dirname(output))).some((file) => file.includes(".deherm-tmp-")), false);

  await writeFile(entry, 'declare const __DEFOLD_HERMES_BUILD_FINGERPRINT__: string; console.log(`bundle:${__DEFOLD_HERMES_BUILD_FINGERPRINT__}`, __DEFOLD_HERMES_BUILD_FINGERPRINT__, 4200);\n');
  const second = await compiler.rebuild();
  assert.notEqual(second.fingerprint, first.fingerprint);
  assert.notEqual(second.metrics.byteDelta, 0);

  const lastGoodOutput = await readFile(output, "utf8");
  await writeFile(entry, "const broken: = ;\n");
  await assert.rejects(() => compiler.rebuild());
  assert.equal(await readFile(output, "utf8"), lastGoodOutput);
});

test("fingerprints are stable across compiler instances and do not require an application reference", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deherm-fingerprint-"));
  const entry = path.join(root, "main.ts");
  await writeFile(entry, "console.log('same source');\n");
  const compile = async (name) => {
    const compiler = await createIncrementalCompiler({
      entryPoint: entry,
      outputFile: path.join(root, name, "app.js"),
      sourcemap: false,
      useTtsc: false
    });
    try {
      return await compiler.rebuild();
    } finally {
      await compiler.dispose();
    }
  };
  const first = await compile("one");
  const second = await compile("two");
  assert.equal(first.fingerprint, second.fingerprint);
});

test("coordinator coalesces edits and never applies a failed build", async () => {
  const events = [];
  const reloads = [];
  let builds = 0;
  const compiler = {
    async rebuild() {
      builds += 1;
      if (builds === 1) throw new Error("typed compile failed");
      return { fingerprint: "ok", resourcePaths: ["/app.js"], metrics: { bytes: 12 } };
    },
    async dispose() {}
  };
  const coordinator = new HotReloadCoordinator({
    compiler,
    targets: new Map([["local", { url: "http://localhost:8001" }]]),
    emit: (event) => events.push(event),
    postReload: async (url, resources) => reloads.push({ url, resources })
  });
  await coordinator.requestBuild(["bad.ts"]);
  assert.equal(reloads.length, 0);
  await coordinator.requestBuild(["good.ts"]);
  assert.equal(reloads.length, 1);
  assert.deepEqual(events.map(({ type }) => type), [
    "build-started", "build-failed",
    "build-started", "build-succeeded", "reload-started", "target-connected", "reload-signalled"
  ]);
  await coordinator.close();
});

test("coordinator preserves a forced rebuild requested during an active build", async () => {
  let releaseFirst;
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  const changed = [];
  const compiler = {
    async rebuild(files) {
      changed.push(files);
      if (changed.length === 1) await gate;
      return { fingerprint: `build-${changed.length}`, resourcePaths: [], metrics: {} };
    },
    async dispose() {}
  };
  const coordinator = new HotReloadCoordinator({ compiler });
  const first = coordinator.requestBuild(["first.ts"]);
  const forced = coordinator.requestBuild([]);
  const coalesced = coordinator.requestBuild(["z.ts", "a.ts", "a.ts"]);
  releaseFirst();
  await Promise.all([first, forced, coalesced]);
  assert.deepEqual(changed, [["first.ts"], ["a.ts", "z.ts"]]);
  await coordinator.close();
});

test("coordinator signals targets in parallel", async () => {
  let releaseSlow;
  const slow = new Promise((resolve) => { releaseSlow = resolve; });
  let resolveFast;
  const fastSignalled = new Promise((resolve) => { resolveFast = resolve; });
  const events = [];
  const coordinator = new HotReloadCoordinator({
    compiler: {
      async rebuild() { return { fingerprint: "ok", resourcePaths: ["/app.js"], metrics: {} }; },
      async dispose() {}
    },
    targets: new Map([
      ["slow", { url: "http://slow.invalid" }],
      ["fast", { url: "http://fast.invalid" }]
    ]),
    emit(event) {
      events.push(event);
      if (event.type === "reload-signalled" && event.id === "fast") resolveFast();
    },
    async postReload(url) {
      if (url.includes("slow")) await slow;
    }
  });
  const build = coordinator.requestBuild(["main.ts"]);
  await Promise.race([
    fastSignalled,
    new Promise((_, reject) => setTimeout(() => reject(new Error("fast target was serialized behind slow target")), 500))
  ]);
  assert.equal(events.some(({ type, id }) => type === "reload-signalled" && id === "slow"), false);
  releaseSlow();
  await build;
  assert.equal(events.some(({ type, id }) => type === "reload-signalled" && id === "slow"), true);
  await coordinator.close();
});
