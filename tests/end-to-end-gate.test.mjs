import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  buildLedger,
  buildServerForDefoldRef,
  publishedNativeArtifactState,
  readLedger,
  scaffoldArguments,
  selectDefoldRevision,
  shouldRetryHostedExtenderFailure,
  stageNames,
} from "../scripts/check-end-to-end.mjs";

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
  await assert.rejects(selectDefoldRevision({ revision, channel: "stable" }, resolve), /not both/u);
});

test("consumer matrix shares the selected channel SHA and uses project-locked build inputs", async () => {
  const workflow = await readFile(new URL("../.github/workflows/end-to-end.yml", import.meta.url), "utf8");
  const gate = await readFile(new URL("../scripts/check-end-to-end.mjs", import.meta.url), "utf8");
  assert.match(workflow, /--channel "\$\{\{ inputs.defold-channel \|\| 'stable' \}\}"/u);
  assert.match(workflow, /--defold-sdk "\$\{\{ needs.local.outputs.revision \}\}"/u);
  assert.doesNotMatch(workflow, /bootstrap-bob\.sh/u);
  assert.match(workflow, /endsWith\(matrix.target, '-ios'\).*endsWith\(matrix.target, '-osx'\).*'macos-15'/u);
  assert.doesNotMatch(gate, /manage-native-artifacts\.mjs|await run\(path.join\(root, "scripts", "bob.sh"\)/u);
  assert.match(gate, /await node\(\s*"bin\/deherm.mjs",\s*\[\s*"bundle"/u);
  assert.match(gate, /assertProjectNativeArtifact\(projectRoot, row.target/u);
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

test("policy publication gates full end-to-end dispatch on a compatible published native mapping", async () => {
  const workflow = await readFile(new URL("../.github/workflows/policy.yml", import.meta.url), "utf8");
  const dispatch = workflow.slice(workflow.indexOf("  dispatch-end-to-end:"));
  assert.match(dispatch, /needs: consumer-smoke/u);
  assert.match(dispatch, /check-published-native-artifacts\.mjs --github-output/u);
  assert.match(dispatch, /if: steps\.artifacts\.outputs\.ready == 'true'/u);
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
  const jobToken = /runs-on: ubuntu-24\.04\n\s+env:\n\s+GH_TOKEN: \$\{\{ github\.token \}\}/u;
  assert.match(local, jobToken);
  assert.match(bob, jobToken);
});

test("the Bob matrix consumes the package's pinned Hermes public headers", async () => {
  const workflow = await readFile(new URL("../.github/workflows/end-to-end.yml", import.meta.url), "utf8");
  const headers = workflow.slice(workflow.indexOf("  extension-headers:"), workflow.indexOf("  bob:"));
  assert.match(headers, /actions\/setup-node@v7[\s\S]*cache: 'pnpm'/u);
  assert.match(
    headers,
    /pnpm\/action-setup@v6[\s\S]*actions\/setup-node@v7[\s\S]*pnpm install --frozen-lockfile --ignore-scripts[\s\S]*bootstrap-upstreams\.sh hermes[\s\S]*stage-hermes-public-headers\.mjs/u,
  );
  assert.match(headers, /name: pinned-hermes-public-headers/u);
  assert.match(workflow, /needs: \[local, extension-headers\]/u);
  assert.match(workflow, /path: defold\/defold_hermes\/include/u);
});

test("pushes run the available cheap consumer half while artifact-dispatched runs require every artifact", async () => {
  const workflow = await readFile(new URL("../.github/workflows/end-to-end.yml", import.meta.url), "utf8");
  const nativeWorkflow = await readFile(new URL("../.github/workflows/native-artifacts.yml", import.meta.url), "utf8");
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
    workflow,
    /group: end-to-end-\$\{\{ github\.ref \}\}-\$\{\{ github\.event_name == 'push' && 'push' \|\| 'full' \}\}/u,
  );
  assert.match(workflow, /extension-headers:[\s\S]*if: github\.event_name != 'push'/u);
  assert.match(workflow, /bob:[\s\S]*if: github\.event_name != 'push'/u);
  const bob = workflow.slice(workflow.indexOf("  bob:"));
  assert.match(bob, /--stage policy --stage scaffold --stage generate --stage target-archives --stage bob/u);
  const dispatch = nativeWorkflow.slice(nativeWorkflow.indexOf("Verify every fingerprinted row is published"));
  assert.match(
    dispatch,
    /Refresh policy artifact mappings after publication[\s\S]*gh workflow run policy\.yml[\s\S]*artifact_refresh_only=true/u,
  );
  assert.doesNotMatch(dispatch, /if: needs\.plan\.outputs\.build_any == 'true'/u);
  const consumerSmoke = policyWorkflow.slice(policyWorkflow.indexOf("  consumer-smoke:"));
  assert.match(
    consumerSmoke,
    /Wait for Pages and resolve the public content-addressed store[\s\S]*check-published-policy\.mjs/u,
  );
  assert.match(
    consumerSmoke,
    /Run full end-to-end after public policy resolution[\s\S]*needs: consumer-smoke[\s\S]*gh workflow run end-to-end\.yml/u,
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
