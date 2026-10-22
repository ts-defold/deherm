import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import YAML from "yaml";

import { compileNativeComponentFixture, runReleasePreflight } from "../scripts/check-release-preflight.mjs";

const root = path.resolve(import.meta.dirname, "..");

test("release preflight fails at the first stale package input", async () => {
  const calls = [];
  await assert.rejects(
    runReleasePreflight({
      execute(_command, args) {
        calls.push(args[0]);
        if (args[0] === "scripts/generate-component-proxy-runtime-capability.mjs") {
          throw new Error("stale generated component capability");
        }
      },
    }),
    /Release preflight failed at package-owned generated component capability: stale generated component capability/,
  );
  assert.deepEqual(calls, [
    "scripts/check-release-readiness.mjs",
    "scripts/generate-component-proxy-runtime-capability.mjs",
  ]);
});

test("release and policy workflows gate expensive work on the preflight", async () => {
  const release = YAML.parse(await readFile(path.join(root, ".github/workflows/release-readiness.yml"), "utf8"));
  const policy = YAML.parse(await readFile(path.join(root, ".github/workflows/policy.yml"), "utf8"));
  assert.equal(release.jobs["portable-tooling"].needs, "preflight");
  assert.ok(release.jobs.preflight.steps.some((step) => step.run === "pnpm check:release-preflight"));
  const native = release.jobs["portable-tooling"].steps.find(
    (step) => step.name === "Compile native component ABI fixture before aggregate tests",
  );
  const aggregate = release.jobs["portable-tooling"].steps.find((step) => step.name === "Aggregate test gate");
  assert.ok(
    release.jobs["portable-tooling"].steps.indexOf(native) < release.jobs["portable-tooling"].steps.indexOf(aggregate),
  );
  assert.ok(policy.jobs.plan.steps.some((step) => step.run === "pnpm check:release-preflight"));
});

test("pull requests run the aggregate and prove one packed candidate without hosted Bob", async () => {
  const release = YAML.parse(await readFile(path.join(root, ".github/workflows/release-readiness.yml"), "utf8"));
  const portable = release.jobs["portable-tooling"].steps;
  const aggregate = portable.find((step) => step.name === "Aggregate test gate");
  assert.equal(aggregate.if, "runner.os == 'Linux'");

  const candidate = release.jobs["package-candidate"];
  assert.equal(candidate.needs, "preflight");
  const commands = candidate.steps.map((step) => step.run).filter(Boolean);
  assert.ok(commands.includes("bash scripts/bootstrap-upstreams.sh hermes"));
  assert.ok(commands.includes("node scripts/prove-npm-consumer.mjs --pack-only"));
  assert.ok(
    commands.some((command) =>
      command.includes('node scripts/prove-npm-consumer.mjs --candidate "$archive" --prepare-only'),
    ),
  );
  assert.equal(
    commands.some((command) => /prove-npm-snake|bob:|check-end-to-end/u.test(command)),
    false,
  );
});

test("native preflight rejects the prior pointer-shaped component ABI", async (context) => {
  try {
    await access(path.join(root, "upstream/defold/engine/dlib/src/dmsdk/dlib/hash.h"));
  } catch {
    context.skip("pinned Defold headers are not bootstrapped");
    return;
  }
  await compileNativeComponentFixture();
  const original = await readFile(path.join(root, "native/component_runtime_hermes_e2e.cpp"), "utf8");
  const signature = "game_object::HandleBits GameObjectCollection(void*, game_object::HandleBits) noexcept";
  assert.ok(original.includes(signature));
  const stale = original.replace(signature, "void* GameObjectCollection(void*, game_object::HandleBits) noexcept");
  const directory = await mkdtemp(path.join(tmpdir(), "deherm-release-preflight-"));
  try {
    const source = path.join(directory, "stale-component-runtime.cpp");
    await writeFile(source, stale);
    await assert.rejects(
      compileNativeComponentFixture({ source }),
      /invalid conversion|cannot initialize|incompatible|no known conversion/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
