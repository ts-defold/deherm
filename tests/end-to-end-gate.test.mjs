import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import YAML from "yaml";

import {
  assertProjectDefoldRevision,
  buildLedger,
  buildServerForDefoldRef,
  main as runEndToEndGate,
  publishedNativeArtifactState,
  readLedger,
  scaffoldArguments,
  selectDefoldRevision,
  shouldRetryHostedExtenderFailure,
  stageNames,
} from "../scripts/check-end-to-end.mjs";
import {
  checkPublishedNativeArtifactReadiness,
  parseArguments as parseNativeReadinessArguments,
} from "../scripts/check-published-native-artifacts.mjs";
import { planPolicyWorkflow } from "../scripts/plan-policy-workflow.mjs";

test("rolling consumer revision is resolved once and exact revisions never consult the channel", async () => {
  const revision = "a".repeat(40);
  const calls = [];
  const resolve = async (channel) => {
    calls.push(channel);
    return { revision };
  };
  assert.equal(await selectDefoldRevision({ channel: "stable" }, resolve), revision);
  assert.equal(await selectDefoldRevision({ revision }, resolve), revision);
  assert.deepEqual(calls, ["stable"]);
  await assert.rejects(selectDefoldRevision({ revision: "latest" }, resolve), /exact Defold revision/u);
  await assert.rejects(selectDefoldRevision({ revision: "" }, resolve), /exact Defold revision/u);
  await assert.rejects(selectDefoldRevision({ channel: "" }, resolve), /channel requires/u);
  await assert.rejects(selectDefoldRevision({ revision, channel: "stable" }, resolve), /not both/u);
});

test("planned alpha reaches the consumer lock, readiness, and dispatched workflow arguments", async (t) => {
  const baseline = "a".repeat(40);
  const stable = "b".repeat(40);
  const alpha = "c".repeat(40);
  assert.notEqual(baseline, stable);
  assert.notEqual(stable, alpha);
  assert.notEqual(baseline, alpha);
  const calls = [];
  const resolve = async (channel) => {
    calls.push(channel);
    return { revision: channel === "alpha" ? alpha : stable };
  };

  assert.equal(await selectDefoldRevision({ channel: "stable" }, resolve), stable);
  assert.equal(await selectDefoldRevision({ channel: "alpha" }, resolve), alpha);
  const plan = planPolicyWorkflow({
    event: "workflow_dispatch",
    requestedRevision: alpha,
    requestedChannel: "",
    refreshOnly: false,
    callbackRevision: "",
    channelPlan: {
      observations: [
        { channel: "stable", sha1: stable, version: "1.14.0" },
        { channel: "alpha", sha1: alpha, version: null },
      ],
      indexedRevisions: [baseline],
      derive: [],
    },
  });
  assert.deepEqual(plan.endToEndCandidates, [{ channel: "alpha", sha1: alpha }]);
  assert.equal(await selectDefoldRevision({ revision: plan.endToEndCandidates[0].sha1 }, resolve), alpha);
  assert.deepEqual(calls, ["stable", "alpha"]);
  assert.deepEqual(scaffoldArguments({ project: "build/alpha", defoldRevision: alpha }).slice(-2), [
    "--defold-sdk",
    alpha,
  ]);

  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "deherm-planned-alpha-lock-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  await writeFile(path.join(projectRoot, "deherm.lock"), `${JSON.stringify({ defoldRevision: alpha })}\n`);
  assert.equal(await assertProjectDefoldRevision(projectRoot, alpha), alpha);

  const readinessCalls = [];
  const readiness = await checkPublishedNativeArtifactReadiness(alpha, {
    index: { marker: "injected published locator" },
    resolvePublishedPolicy: async (revision, { index }) => {
      readinessCalls.push({ revision, index });
      return {
        artifacts: {
          artifacts: {
            "native-artifacts": {
              indexedBy: "bundleTarget",
              assets: { "x86_64-linux": "archive" },
              releases: { "x86_64-linux": { tag: "alpha-test", fingerprint: "d".repeat(64) } },
            },
          },
        },
      };
    },
  });
  assert.deepEqual(readiness, { revision: alpha, status: "ready" });
  assert.deepEqual(readinessCalls, [{ revision: alpha, index: { marker: "injected published locator" } }]);

  const workflow = YAML.parse(await readFile(new URL("../.github/workflows/policy.yml", import.meta.url), "utf8"));
  const dispatchStep = workflow.jobs["dispatch-end-to-end"].steps.find(({ name }) =>
    name?.startsWith("Dispatch each ready exact revision"),
  );
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "deherm-alpha-dispatch-"));
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const readyDirectory = path.join(temporaryDirectory, "ready-end-to-end-revisions");
  const binDirectory = path.join(temporaryDirectory, "bin");
  await mkdir(readyDirectory);
  await mkdir(binDirectory);
  await writeFile(path.join(readyDirectory, "ready-end-to-end.json"), `${JSON.stringify(plan.endToEndCandidates)}\n`);
  const capturePath = path.join(temporaryDirectory, "gh-arguments.txt");
  const fakeGh = path.join(binDirectory, "gh");
  await writeFile(fakeGh, '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$GH_CAPTURE"\n');
  await chmod(fakeGh, 0o755);
  const run = dispatchStep.run
    .replaceAll("${{ github.repository }}", "ts-defold/deherm")
    .replaceAll("${{ github.ref_name }}", "main");
  const dispatched = spawnSync("bash", ["-euo", "pipefail", "-c", run], {
    encoding: "utf8",
    env: {
      ...process.env,
      GH_CAPTURE: capturePath,
      GH_TOKEN: "fixture-token",
      RUNNER_TEMP: temporaryDirectory,
      PATH: `${binDirectory}${path.delimiter}${process.env.PATH}`,
    },
  });
  assert.equal(dispatched.status, 0, dispatched.stderr);
  assert.deepEqual((await readFile(capturePath, "utf8")).trim().split("\n"), [
    "workflow",
    "run",
    "end-to-end.yml",
    "--repo",
    "ts-defold/deherm",
    "--ref",
    "main",
    "-f",
    `defold-sdk=${alpha}`,
    "-f",
    "defold-channel=alpha",
  ]);
});

test("published native readiness requires an explicit exact revision", () => {
  assert.throws(() => parseNativeReadinessArguments(["--github-output", "out"]), /40-character SHA/u);
  assert.throws(
    () => parseNativeReadinessArguments(["--defold-sdk", "stable", "--github-output", "out"]),
    /40-character SHA/u,
  );
  assert.deepEqual(parseNativeReadinessArguments(["--github-output", "out", "--defold-sdk", "a".repeat(40)]), {
    revision: "a".repeat(40),
    githubOutput: "out",
  });
});

test("an incomplete exact-revision CLI option cannot fall back to the ledger revision", async () => {
  await assert.rejects(runEndToEndGate(["--defold-sdk"]), /--defold-sdk requires a value/u);
  await assert.rejects(runEndToEndGate(["--defold-sdk", "--stage", "generate"]), /--defold-sdk requires a value/u);
});

test("consumer matrix shares the selected channel SHA and uses project-locked build inputs", async () => {
  const workflowSource = await readFile(new URL("../.github/workflows/end-to-end.yml", import.meta.url), "utf8");
  const workflow = YAML.parse(workflowSource);
  const gate = await readFile(new URL("../scripts/check-end-to-end.mjs", import.meta.url), "utf8");
  const dispatchInputs = workflow.on.workflow_dispatch.inputs;
  assert.equal(dispatchInputs["defold-sdk"].type, "string");
  const planStep = workflow.jobs.local.steps.find((step) => step.id === "plan");
  assert.match(planStep.env.EXACT_REVISION, /inputs\.defold-sdk/u);
  assert.match(planStep.env.CHANNEL, /inputs\.defold-channel/u);
  assert.match(
    planStep.run,
    /if \[ -n "\$EXACT_REVISION" \][\s\S]*--defold-sdk "\$EXACT_REVISION"[\s\S]*else[\s\S]*--channel "\$CHANNEL"/u,
  );
  assert.match(workflowSource, /--defold-sdk "\$\{\{ needs\.local\.outputs\.revision \}\}"/u);
  assert.match(
    workflow.concurrency.group,
    /format\('full-\{0\}-\{1\}-\{2\}', inputs\.defold-sdk \|\| '', inputs\.defold-channel \|\| 'stable', inputs\.build-server \|\| 'default'\)/u,
    "distinct exact SHA, channel, and Extender requests must not cancel each other",
  );
  assert.doesNotMatch(workflowSource, /bootstrap-bob\.sh/u);
  assert.match(
    workflowSource,
    /endsWith\(matrix\.target, '-ios'\).*endsWith\(matrix\.target, '-osx'\).*'macos-15-intel'/u,
  );
  assert.doesNotMatch(gate, /manage-native-artifacts\.mjs|await run\(path.join\(root, "scripts", "bob.sh"\)/u);
  assert.match(gate, /await node\(\s*"bin\/deherm.mjs",\s*\[\s*"bundle"/u);
  assert.match(gate, /assertProjectNativeArtifact\(projectRoot, row.target/u);
});

test("generated project lock must identify the selected consumer revision", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "deherm-exact-revision-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const alpha = "c".repeat(40);
  await writeFile(path.join(directory, "deherm.lock"), `${JSON.stringify({ defoldRevision: alpha })}\n`);
  assert.equal(await assertProjectDefoldRevision(directory, alpha), alpha);
  await assert.rejects(assertProjectDefoldRevision(directory, "b".repeat(40)), /expected/u);
});

test("published native mapping distinguishes a pending build from a malformed release", () => {
  assert.equal(
    publishedNativeArtifactState({
      indexedBy: "bundleTarget",
      assets: {},
      availability: { status: "pending-compatible-build" },
    }),
    "pending-compatible-build",
  );
  assert.equal(
    publishedNativeArtifactState({
      indexedBy: "bundleTarget",
      assets: { "x86_64-linux": "libhermes-x86_64-linux.tar.gz" },
      releases: { "x86_64-linux": { tag: "libs-test", fingerprint: "a".repeat(64) } },
    }),
    "ready",
  );
  assert.throws(() => publishedNativeArtifactState({ indexedBy: "bundleTarget", assets: {} }), /no usable/u);
  assert.throws(
    () => publishedNativeArtifactState({ indexedBy: "bundleTarget", assets: { "x86_64-linux": "archive" } }),
    /no usable/u,
  );
});

test("policy consumers, readiness, and end-to-end dispatch carry each exact planned revision", async () => {
  const source = await readFile(new URL("../.github/workflows/policy.yml", import.meta.url), "utf8");
  const workflow = YAML.parse(source);
  const plan = workflow.jobs.plan;
  const consumer = workflow.jobs["consumer-smoke"];
  const planStep = plan.steps.find(({ id }) => id === "plan");
  const generation = consumer.steps.find(({ name }) => name?.startsWith("Pack once and generate every distinct"));
  const readiness = consumer.steps.find(({ name }) => name?.startsWith("Check exact-revision native readiness"));
  const dispatch = workflow.jobs["dispatch-end-to-end"];
  const dispatchStep = dispatch.steps.find(({ name }) => name?.startsWith("Dispatch each ready exact revision"));

  assert.match(plan.outputs.consumer_revisions, /steps\.plan\.outputs\.consumer_revisions/u);
  assert.match(planStep.run, /plan-policy-workflow\.mjs[\s\S]*--channel-plan "\$channel_plan"/u);
  assert.match(planStep.run, /consumerRevisions\)\)[\s\S]*endToEndCandidates/u);
  assert.equal(generation.if, "needs.plan.outputs.consumer_revisions != '[]'");
  assert.equal(generation.env.CONSUMER_REVISIONS, "${{ needs.plan.outputs.consumer_revisions }}");
  assert.match(generation.run, /row\.sha1/u);
  assert.match(generation.run, /revision_args\+=\(--defold-sdk "\$sha"\)/u);
  assert.match(generation.run, /prove-npm-consumer\.mjs --pack-only "\$\{revision_args\[@\]\}"/u);
  assert.match(
    generation.run,
    /prove-npm-consumer\.mjs --candidate "\$candidate" --generate-only "\$\{revision_args\[@\]\}"/u,
  );
  assert.doesNotMatch(generation.run, /upstream\.lock|--channel|--defold-sdk ["']?(stable|alpha|beta)/u);

  assert.equal(readiness.if, "needs.plan.outputs.end_to_end_candidates != '[]'");
  assert.equal(readiness.env.E2E_CANDIDATES, "${{ needs.plan.outputs.end_to_end_candidates }}");
  assert.match(readiness.run, /row\.channel\}\\t\$\{row\.sha1\}/u);
  assert.match(readiness.run, /check-published-native-artifacts\.mjs --defold-sdk "\$sha" --github-output "\$status"/u);
  assert.match(readiness.run, /ready-end-to-end\.tsv[\s\S]*\{channel, sha1\}/u);
  assert.doesNotMatch(readiness.run, /upstream\.lock|--defold-sdk ["']?(stable|alpha|beta)/u);

  assert.deepEqual(dispatch.needs, ["plan", "consumer-smoke"]);
  assert.match(dispatch.if, /needs\.consumer-smoke\.result == 'success'/u);
  assert.match(dispatch.if, /needs\.plan\.outputs\.end_to_end_candidates != '\[\]'/u);
  assert.match(dispatchStep.run, /row\.sha1\}\\t\$\{row\.channel\}/u);
  assert.match(
    dispatchStep.run,
    /gh workflow run end-to-end\.yml[\s\S]*-f defold-sdk="\$sha" -f defold-channel="\$channel"/u,
  );
  assert.match(dispatchStep.run, /case "\$channel" in stable\|beta\|alpha/u);
});

// The property that makes the gate worth having: it cannot silently omit a
// target. Every check in this file is about that, not about whether any
// particular target builds - that is what running the gate is for.

test("every declared bundle target is either exercised or declined by name", async () => {
  const { rows, problems } = await readLedger();
  assert.deepEqual(problems, []);
  for (const row of rows) {
    assert.ok(["exercise", "declined"].includes(row.disposition), `${row.target}: ${row.disposition}`);
    if (row.disposition === "declined") {
      assert.ok(
        row.reason && row.reason.length > 20,
        `${row.target} is not exercised and says only "${row.reason}"; a decline must name a reason`,
      );
    }
  }
  assert.ok(
    rows.some((row) => row.disposition === "exercise"),
    "the gate exercises nothing at all",
  );
});

test("the scaffold is pinned to the policy revision instead of racing Defold latest", async () => {
  const { defoldRevision } = await readLedger();
  assert.deepEqual(scaffoldArguments({ project: "build/example", defoldRevision }), [
    "create",
    "build/example",
    "--name",
    "deherm end to end",
    "--defold-sdk",
    defoldRevision,
  ]);
  assert.throws(
    () => scaffoldArguments({ project: "build/example", defoldRevision: "stable" }),
    /requires the exact policy Defold revision/u,
  );
});

test("the exact workflow input plans before the default channel and carries its SHA into downstream jobs", async () => {
  const workflowSource = await readFile(new URL("../.github/workflows/end-to-end.yml", import.meta.url), "utf8");
  const workflow = YAML.parse(workflowSource);
  const alpha = "c".repeat(40);
  const exact = await selectDefoldRevision({ revision: alpha }, async () => {
    throw new Error("an exact workflow input must not resolve the default stable channel");
  });
  assert.equal(exact, alpha);

  const local = workflow.jobs.local;
  const planStep = local.steps.find((step) => step.id === "plan");
  assert.match(planStep.run, /--defold-sdk "\$EXACT_REVISION"/u);
  assert.match(planStep.run, /revision=\$\{plan\.defoldRevision\}/u);
  assert.match(workflowSource, /--defold-sdk "\$\{\{ steps\.plan\.outputs\.revision \}\}"/u);
  assert.match(workflowSource, /--defold-sdk "\$\{\{ needs\.local\.outputs\.revision \}\}"/u);
});

test("the cheap consumer proof runs on every main push without a maintained path allowlist", async () => {
  const workflow = await readFile(new URL("../.github/workflows/end-to-end.yml", import.meta.url), "utf8");
  const push = /^  push:\s*\n([\s\S]*?)(?=^  [a-z_]+:|^permissions:)/mu.exec(workflow)?.[1];
  assert.ok(push, "the end-to-end workflow must run on push");
  assert.match(push, /^    branches: \[main\]$/mu);
  assert.doesNotMatch(push, /^    paths(?:-ignore)?:/mu);
  assert.match(workflow, /if: github\.event_name != 'push'/u, "the expensive matrix stays off the push lane");
});

test("a bundle target Defold adds is a failure, not a missing row", () => {
  const { rows, problems } = buildLedger({
    bundleTargets: { targets: [{ target: "riscv64-linux", group: "linux", architecture: "riscv64" }] },
    artifacts: { targets: {}, statuses: {} },
    releaseTags: { families: {} },
  });
  assert.deepEqual(rows, []);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /riscv64-linux/);
});

test("an artifact the bundle-target list does not declare is a failure", () => {
  const { problems } = buildLedger({
    bundleTargets: { targets: [] },
    artifacts: { targets: { "ppc-aix": { status: "vendored" } }, statuses: {} },
    releaseTags: { families: {} },
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /ppc-aix/);
});

test("a blocked target must carry a machine-readable blocker to be declined", () => {
  const bundleTargets = { targets: [{ target: "wasm_pthread-web", group: "web", architecture: "wasm_pthread" }] };
  const releaseTags = { families: {} };

  const vague = buildLedger({
    bundleTargets,
    artifacts: { targets: { "wasm_pthread-web": { status: "blocked" } }, statuses: {} },
    releaseTags,
  });
  assert.deepEqual(vague.rows, []);
  assert.match(vague.problems[0], /machine-readable blocker/);

  const named = buildLedger({
    bundleTargets,
    artifacts: {
      targets: {
        "wasm_pthread-web": {
          status: "blocked",
          blocker: { code: "no-runner", reason: "nothing in CI runs a pthread browser host" },
        },
      },
      statuses: {},
    },
    releaseTags,
  });
  assert.deepEqual(named.problems, []);
  assert.equal(named.rows[0].disposition, "declined");
  assert.match(named.rows[0].reason, /no-runner: nothing in CI runs a pthread browser host/);
});

test("the declared stages are the ones the gate can run", async () => {
  const module = await import("../scripts/check-end-to-end.mjs");
  assert.ok(stageNames.includes("bob"), "the gate must build the game, or it is not end to end");
  assert.ok(stageNames.includes("policy"), "the gate must resolve a published policy");
  assert.ok(
    module.defaultBuildServer.startsWith("https://"),
    "the gate must default to a real build server, not this repository's localhost Extender",
  );
});

test("the implicit hosted Extender follows the pinned Defold channel", async () => {
  const module = await import("../scripts/check-end-to-end.mjs");
  const lock = await readFile(new URL("../upstream.lock", import.meta.url), "utf8");
  const ref = /^DEFOLD_REF=(.+)$/mu.exec(lock)?.[1];
  assert.equal(module.defaultBuildServer, buildServerForDefoldRef(ref));
  assert.equal(buildServerForDefoldRef("stable"), "https://build.defold.com");
  assert.equal(buildServerForDefoldRef("dev"), "https://build.defold.com");
  for (const channel of ["alpha", "beta"]) {
    assert.equal(buildServerForDefoldRef(channel), "https://build-stage.defold.com");
  }
});

test("hosted Extender defaults mirror the pinned Defold Editor channel rule", async () => {
  const source = await readFile(
    new URL("../upstream/defold/editor/src/clj/editor/connection_properties.clj", import.meta.url),
    "utf8",
  );
  assert.match(source, /:build-server-url "https:\/\/build\.defold\.com"/u);
  for (const channel of ["alpha", "beta"]) {
    assert.match(source, new RegExp(`"${channel}" "https://build-stage\\.defold\\.com"`, "u"));
  }
  assert.doesNotMatch(source, /"dev" "https:\/\/build-stage\.defold\.com"/u);
});

test("hosted Bob retries only fresh observed Extender worker transport failures, at most twice", () => {
  const refusal =
    "Job id: new Failed to communicate with Extender service.org.apache.http.conn.HttpHostConnectException: Connection refused";
  const baseline = { buildServer: "https://build-stage.defold.com", priorLog: "", currentLog: refusal };
  assert.equal(shouldRetryHostedExtenderFailure({ ...baseline, attempt: 1 }), true);
  assert.equal(shouldRetryHostedExtenderFailure({ ...baseline, attempt: 2 }), true);
  assert.equal(shouldRetryHostedExtenderFailure({ ...baseline, attempt: 3 }), false);
  assert.equal(
    shouldRetryHostedExtenderFailure({ ...baseline, buildServer: "http://localhost:9010", attempt: 1 }),
    false,
  );
  assert.equal(shouldRetryHostedExtenderFailure({ ...baseline, priorLog: refusal, attempt: 1 }), false);
  const noRoute =
    "Job id: new Failed to communicate with Extender service.java.net.NoRouteToHostException: No route to host";
  assert.equal(shouldRetryHostedExtenderFailure({ ...baseline, currentLog: noRoute, attempt: 1 }), true);
  assert.equal(shouldRetryHostedExtenderFailure({ ...baseline, currentLog: noRoute, attempt: 3 }), false);
  assert.equal(
    shouldRetryHostedExtenderFailure({ ...baseline, currentLog: noRoute, priorLog: noRoute, attempt: 1 }),
    false,
  );
  assert.equal(
    shouldRetryHostedExtenderFailure({ ...baseline, currentLog: "error: undefined symbol in libhermes.a", attempt: 1 }),
    false,
  );
});

test("the Bob matrix prints and preserves the target's Extender failure log", async () => {
  const workflow = await readFile(new URL("../.github/workflows/end-to-end.yml", import.meta.url), "utf8");
  assert.match(workflow, /Print Extender failure log/u);
  assert.match(workflow, /cat "\$log"/u);
  assert.match(workflow, /bob-extender-log-\$\{\{ matrix\.target \}\}/u);
  assert.match(workflow, /build\/end-to-end\/project\/build\/\$\{\{ matrix\.target \}\}\/log\.txt/u);
});

test("both consumer jobs authenticate GitHub release metadata reads", async () => {
  const workflow = await readFile(new URL("../.github/workflows/end-to-end.yml", import.meta.url), "utf8");
  const local = workflow.slice(workflow.indexOf("  local:"), workflow.indexOf("  extension-headers:"));
  const bob = workflow.slice(workflow.indexOf("  bob:"));
  const jobToken = /^    env:\n      GH_TOKEN: \$\{\{ github\.token \}\}/mu;
  assert.match(local, jobToken);
  assert.match(bob, jobToken);
});

test("the Bob matrix consumes the package's pinned Hermes public headers", async () => {
  const source = await readFile(new URL("../.github/workflows/end-to-end.yml", import.meta.url), "utf8");
  const workflow = YAML.parse(source);
  const job = workflow.jobs["extension-headers"];
  const setupNode = job.steps.find((step) => step.uses?.startsWith("actions/setup-node@"));
  assert.equal(setupNode.with.cache, "pnpm");
  const commands = job.steps.map((step) => step.run ?? "").join("\n");
  assert.match(commands, /pnpm install --frozen-lockfile --ignore-scripts/u);
  assert.match(commands, /bootstrap-upstreams\.sh hermes/u);
  assert.match(commands, /stage-hermes-public-headers\.mjs/u);
  assert.equal(
    job.steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"))?.with.name,
    "pinned-hermes-public-headers",
  );
  assert.deepEqual(workflow.jobs.bob.needs, ["local", "extension-headers"]);
  assert.match(workflow.jobs["extension-headers"].steps.at(-1).with.path, /defold\/defold_hermes\/include/u);
});

test("pushes run the available cheap consumer half while artifact-dispatched runs require every artifact", async () => {
  const workflow = await readFile(new URL("../.github/workflows/end-to-end.yml", import.meta.url), "utf8");
  const parsedWorkflow = YAML.parse(workflow);
  const nativeWorkflow = await readFile(new URL("../.github/workflows/native-artifacts.yml", import.meta.url), "utf8");
  const parsedNativeWorkflow = YAML.parse(nativeWorkflow);
  const policyWorkflow = await readFile(new URL("../.github/workflows/policy.yml", import.meta.url), "utf8");
  const local = workflow.slice(workflow.indexOf("  local:"), workflow.indexOf("  extension-headers:"));
  assert.match(
    local,
    /if \[ "\$\{\{ github\.event_name \}\}" != push \]; then[\s\S]*stages\+=\(--stage target-archives\)/u,
  );
  assert.match(local, /--stage policy[\s\S]*--stage scaffold[\s\S]*--stage generate/u);
  assert.match(
    local,
    /\[ "\$\{\{ steps\.published-host-tools\.outputs\.available \}\}" = true \][\s\S]*stages\+=\(--stage host-tools\)/u,
  );
  assert.match(local, /for \(const family of \["hermes-host", "dehermc"\]\)/u);
  assert.match(local, /tags\[family\]\.assets\["linux-x64"\]/u);
  assert.match(local, /ordered artifact dispatch will exercise it/u);
  assert.match(local, /DEHERM_PACKAGE_SMOKE_DOWNLOAD_DEHERMC=1/u);
  assert.match(local, /Packed clean consumer downloads the published compiler/u);
  assert.match(
    parsedWorkflow.concurrency.group,
    /format\('full-\{0\}-\{1\}-\{2\}', inputs\.defold-sdk \|\| '', inputs\.defold-channel \|\| 'stable', inputs\.build-server \|\| 'default'\)/u,
  );
  assert.match(workflow, /extension-headers:[\s\S]*if: github\.event_name != 'push'/u);
  assert.match(workflow, /bob:[\s\S]*if: github\.event_name != 'push'/u);
  const bob = workflow.slice(workflow.indexOf("  bob:"));
  assert.match(bob, /--stage policy --stage scaffold --stage generate --stage target-archives --stage bob/u);
  const refresh = parsedNativeWorkflow.jobs.summary.steps.find(
    ({ name }) => name === "Refresh policy artifact mappings after publication",
  );
  assert.match(
    refresh.run,
    /args=\(workflow run policy\.yml[\s\S]*-f artifact_refresh_only=true\)[\s\S]*gh "\$\{args\[@\]\}"/u,
  );
  assert.equal(refresh.if, "always()");
  const consumerSmoke = policyWorkflow.slice(policyWorkflow.indexOf("  consumer-smoke:"));
  assert.match(
    consumerSmoke,
    /Wait for Pages and resolve the public content-addressed store[\s\S]*check-published-policy\.mjs/u,
  );
  assert.match(
    consumerSmoke,
    /Run full end-to-end after public policy resolution[\s\S]*needs: \[plan, consumer-smoke\][\s\S]*gh workflow run end-to-end\.yml/u,
  );
});

test("Bob consumes the generated project's target artifact instead of rebuilding a host-native package", async () => {
  const wrapper = await readFile(new URL("../scripts/bob.sh", import.meta.url), "utf8");
  assert.match(wrapper, /check-project-native-artifact\.mjs" "\$project_root" "\$bundle_target" "\$variant"/u);
  assert.match(wrapper, /--platform "\$bob_platform"/u);
  assert.match(wrapper, /resolve-defold-platform\.mjs/u);
  assert.match(wrapper, /resolve-defold-platform\.mjs" "\$platform_input" "\$project_root"/u);
  assert.doesNotMatch(wrapper, /package:defold/u);
});

test("Bob rejects macOS's executable Java stub before selecting a real JDK", async () => {
  const wrapper = await readFile(new URL("../scripts/bob.sh", import.meta.url), "utf8");
  assert.match(wrapper, /"\$candidate" -version >\/dev\/null 2>&1/u);
  assert.match(wrapper, /\/opt\/homebrew\/opt\/openjdk@25\/bin\/java/u);
});
