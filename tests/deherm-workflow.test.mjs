import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";

const root = path.resolve(import.meta.dirname, "..");
const workflow = YAML.parse(fs.readFileSync(path.join(root, ".github/workflows/deherm-build.yml"), "utf8"));
const smoke = YAML.parse(fs.readFileSync(path.join(root, ".github/workflows/deherm-build-smoke.yml"), "utf8"));

function plan({ mode = "defold", server = "", targets = "[]", consumerTargets } = {}) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "deherm-workflow-"));
  try {
    const project = path.join(temporary, "project/game");
    fs.mkdirSync(project, { recursive: true });
    const ledger = JSON.parse(
      fs.readFileSync(path.join(root, "packages/toolchains/defold-bundle-targets.json"), "utf8"),
    );
    const selected = consumerTargets ?? ledger.targets;
    fs.writeFileSync(
      path.join(project, "deherm.lock"),
      JSON.stringify({
        toolchain: {
          targetMatrix: {
            authority: { targets: "consumer Defold build_input.yml", pairs: "consumer Bob Platform.java" },
            targets: selected,
            platformPairs: selected.map((row) => ({ extenderTarget: row.target, bobPlatform: row.target })),
          },
        },
      }),
    );
    const output = path.join(temporary, "output");
    const result = spawnSync("bash", ["-e", "-c", workflow.jobs.plan.steps.find((step) => step.id === "matrix").run], {
      cwd: temporary,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_OUTPUT: output,
        DEHERM_MODE: mode,
        DEHERM_BUILD_SERVER: server,
        DEHERM_TARGETS: targets,
        DEHERM_PROJECT: "game",
      },
    });
    const lines = result.status === 0 ? fs.readFileSync(output, "utf8").trim().split("\n") : [];
    const values = Object.fromEntries(
      lines.map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), JSON.parse(line.slice(separator + 1))];
      }),
    );
    return { ...result, values };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

test("reusable workflow has an explicit immutable action ref and runner-owned local Extender", () => {
  assert.equal(workflow.on.workflow_call.inputs["action-ref"].required, true);
  assert.equal(workflow.on.workflow_call.inputs["application-mode"].default, "dynamic");
  assert.match(
    workflow.jobs.nonapple.steps.find((step) => step.name === "Start pinned local Docker Extender").run,
    /docker compose/,
  );
  assert.match(
    workflow.jobs.apple.steps.find((step) => step.name === "Start pinned local Apple Extender").run,
    /extender-local\.sh start/,
  );
  assert.match(workflow.jobs.apple["runs-on"], /macos-26/);
  for (const job of [workflow.jobs.nonapple, workflow.jobs.apple]) {
    assert.match(job.steps.find((step) => step.name === "Install caller project dependencies").run, /pnpm install/);
    assert.ok(!job.steps.some((step) => step.name === "Generate caller project"));
    const build = job.steps.find((step) => step.id === "build");
    assert.equal(build.uses, "./.deherm-action");
    assert.match(build.with["build-server"], /inputs\.mode == 'local'/);
    assert.equal(build.env.GITHUB_TOKEN, "${{ github.token }}");
    const headerStage = job.steps.find((step) => step.name === "Stage pinned Hermes headers for source-workspace dogfood");
    assert.match(headerStage.if, /github\.repository == 'ts-defold\/deherm'/);
    assert.match(headerStage.run, /scripts\/stage-hermes-public-headers\.mjs/);
    const archive = job.steps.find((step) => step.id === "archive");
    assert.match(archive.run, /tar -czf/);
    assert.equal(archive.env.BUNDLE_PATH, "${{ steps.build.outputs.bundle-path }}");
    assert.ok(
      job.steps.some(
        (step) =>
          step.uses === "actions/upload-artifact@v6" && step.with.path === "${{ steps.archive.outputs.archive-path }}",
      ),
    );
  }
});

test("War Battles dogfood invokes the public workflow at its own commit", () => {
  assert.equal(smoke.jobs["war-battles"].uses, "./.github/workflows/deherm-build.yml");
  assert.equal(smoke.jobs["war-battles"].with["action-ref"], "${{ github.sha }}");
  assert.equal(smoke.jobs["war-battles"].with.project, "examples/war-battles-online/defold");
  assert.equal(smoke.jobs["war-battles"].with.entry, "main/player.script.ts");
  assert.ok(smoke.on.push.paths.includes("action.yml"));
  assert.ok(smoke.on.push.paths.includes("packages/cli/src/ci-bundle.mjs"));
});

test("workflow archive preserves a runnable bundle's executable bit", { skip: process.platform === "win32" }, () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "deherm-workflow-archive-"));
  try {
    const bundle = path.join(temporary, "Action Smoke.app");
    const executable = path.join(bundle, "Contents/MacOS/ActionSmoke");
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const githubOutput = path.join(temporary, "output");
    const archiveStep = workflow.jobs.apple.steps.find((step) => step.id === "archive");
    const result = spawnSync("bash", ["-e", "-c", archiveStep.run], {
      encoding: "utf8",
      env: {
        ...process.env,
        BUNDLE_PATH: bundle,
        DEHERM_TARGET: "arm64-osx",
        RUNNER_TEMP: temporary,
        GITHUB_OUTPUT: githubOutput,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const archive = path.join(temporary, "deherm-arm64-osx.tar.gz");
    const extracted = path.join(temporary, "extracted");
    fs.mkdirSync(extracted);
    const unpack = spawnSync("tar", ["-xzf", archive, "-C", extracted], { encoding: "utf8" });
    assert.equal(unpack.status, 0, unpack.stderr);
    assert.ok(fs.statSync(path.join(extracted, "Action Smoke.app/Contents/MacOS/ActionSmoke")).mode & 0o111);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("the default matrix follows the caller project's generated Defold target matrix", () => {
  const result = plan();
  assert.equal(result.status, 0, result.stderr);
  const actual = [...result.values.nonapple, ...result.values.apple].map((row) => row.target).sort();
  const ledger = JSON.parse(fs.readFileSync(path.join(root, "packages/toolchains/defold-bundle-targets.json"), "utf8"));
  const expected = ledger.targets
    .filter((row) => row.kind === "bundle" && !(row.group === "web" && row.architecture === "wasm_pthread"))
    .map((row) => row.target)
    .sort();
  assert.deepEqual(actual, expected);
  assert.ok(result.values.apple.every((row) => ["ios", "osx"].includes(row.group)));
  assert.ok(result.values.nonapple.every((row) => !["ios", "osx"].includes(row.group)));
});

test("a different consumer Defold revision changes the matrix without a new Action package", () => {
  const result = plan({
    consumerTargets: [
      { target: "x86_64-linux", group: "linux", kind: "bundle" },
      { target: "future-web", group: "web", kind: "bundle" },
      { target: "arm64-ios", group: "ios", kind: "bundle" },
    ],
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.values.nonapple, [
    { target: "x86_64-linux", group: "linux" },
    { target: "future-web", group: "web" },
  ]);
  assert.deepEqual(result.values.apple, [{ target: "arm64-ios", group: "ios" }]);
});

test("a selected target is routed once, and unsupported targets fail closed", () => {
  const one = plan({ targets: '["wasm-web"]' });
  assert.equal(one.status, 0, one.stderr);
  assert.deepEqual(one.values.nonapple, [{ target: "wasm-web", group: "web" }]);
  assert.deepEqual(one.values.apple, []);
  for (const targets of ['["not-a-target"]', '["wasm-web","wasm-web"]', "{}"]) {
    assert.notEqual(plan({ targets }).status, 0, targets);
  }
  const blocked = plan({ targets: '["wasm_pthread-web"]' });
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /web-pthread-browser-host-unproven/);
});

test("mode and build-server contracts cannot silently route local work to a remote server", () => {
  assert.equal(plan({ mode: "local" }).status, 0);
  assert.equal(plan({ mode: "external", server: "https://extender.example.test" }).status, 0);
  assert.notEqual(plan({ mode: "external" }).status, 0);
  assert.notEqual(plan({ mode: "external", server: "http://extender.example.test" }).status, 0);
  assert.notEqual(plan({ mode: "local", server: "https://extender.example.test" }).status, 0);
  assert.notEqual(plan({ mode: "defold", server: "https://extender.example.test" }).status, 0);
  assert.notEqual(plan({ mode: "unknown" }).status, 0);
});
