import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  buildLedger,
  buildServerForDefoldRef,
  readLedger,
  stageNames
} from "../scripts/check-end-to-end.mjs";

// The property that makes the gate worth having: it cannot silently omit a
// target. Every check in this file is about that, not about whether any
// particular target builds - that is what running the gate is for.

test("every declared bundle target is either exercised or declined by name", async () => {
  const { rows, problems } = await readLedger();
  assert.deepEqual(problems, []);
  for (const row of rows) {
    assert.ok(["exercise", "declined"].includes(row.disposition), `${row.target}: ${row.disposition}`);
    if (row.disposition === "declined") {
      assert.ok(row.reason && row.reason.length > 20,
        `${row.target} is not exercised and says only "${row.reason}"; a decline must name a reason`);
    }
  }
  assert.ok(rows.some((row) => row.disposition === "exercise"), "the gate exercises nothing at all");
});

test("a bundle target Defold adds is a failure, not a missing row", () => {
  const { rows, problems } = buildLedger({
    bundleTargets: { targets: [{ target: "riscv64-linux", group: "linux", architecture: "riscv64" }] },
    artifacts: { targets: {}, statuses: {} },
    releaseTags: { families: {} }
  });
  assert.deepEqual(rows, []);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /riscv64-linux/);
});

test("an artifact the bundle-target list does not declare is a failure", () => {
  const { problems } = buildLedger({
    bundleTargets: { targets: [] },
    artifacts: { targets: { "ppc-aix": { status: "vendored" } }, statuses: {} },
    releaseTags: { families: {} }
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
    releaseTags
  });
  assert.deepEqual(vague.rows, []);
  assert.match(vague.problems[0], /machine-readable blocker/);

  const named = buildLedger({
    bundleTargets,
    artifacts: {
      targets: {
        "wasm_pthread-web": { status: "blocked", blocker: { code: "no-runner", reason: "nothing in CI runs a pthread browser host" } }
      },
      statuses: {}
    },
    releaseTags
  });
  assert.deepEqual(named.problems, []);
  assert.equal(named.rows[0].disposition, "declined");
  assert.match(named.rows[0].reason, /no-runner: nothing in CI runs a pthread browser host/);
});

test("the declared stages are the ones the gate can run", async () => {
  const module = await import("../scripts/check-end-to-end.mjs");
  assert.ok(stageNames.includes("bob"), "the gate must build the game, or it is not end to end");
  assert.ok(stageNames.includes("policy"), "the gate must resolve a published policy");
  assert.ok(module.defaultBuildServer.startsWith("https://"),
    "the gate must default to a real build server, not this repository's localhost Extender");
});

test("the implicit hosted Extender follows the pinned Defold channel", async () => {
  const module = await import("../scripts/check-end-to-end.mjs");
  const lock = await readFile(new URL("../upstream.lock", import.meta.url), "utf8");
  const ref = /^DEFOLD_REF=(.+)$/mu.exec(lock)?.[1];
  assert.equal(module.defaultBuildServer, buildServerForDefoldRef(ref));
  assert.equal(buildServerForDefoldRef("stable"), "https://build.defold.com");
  for (const channel of ["dev", "alpha", "beta"]) {
    assert.equal(buildServerForDefoldRef(channel), "https://build-stage.defold.com");
  }
});

test("the Bob matrix prints and preserves the target's Extender failure log", async () => {
  const workflow = await readFile(new URL("../.github/workflows/end-to-end.yml", import.meta.url), "utf8");
  assert.match(workflow, /Print Extender failure log/u);
  assert.match(workflow, /cat "\$log"/u);
  assert.match(workflow, /bob-extender-log-\$\{\{ matrix\.target \}\}/u);
  assert.match(workflow, /build\/end-to-end\/project\/build\/\$\{\{ matrix\.target \}\}\/log\.txt/u);
});

test("the Bob matrix consumes the package's pinned Hermes public headers", async () => {
  const workflow = await readFile(new URL("../.github/workflows/end-to-end.yml", import.meta.url), "utf8");
  assert.match(workflow, /extension-headers:/u);
  assert.match(workflow, /bootstrap-upstreams\.sh hermes/u);
  assert.match(workflow, /stage-hermes-public-headers\.mjs/u);
  assert.match(workflow, /name: pinned-hermes-public-headers/u);
  assert.match(workflow, /needs: \[local, extension-headers\]/u);
  assert.match(workflow, /path: defold\/defold_hermes\/include/u);
});

test("Bob consumes the generated project's target artifact instead of rebuilding a host-native package", async () => {
  const wrapper = await readFile(new URL("../scripts/bob.sh", import.meta.url), "utf8");
  assert.match(wrapper, /check-project-native-artifact\.mjs" "\$project_root" "\$bundle_target"/u);
  assert.match(wrapper, /--platform "\$bob_platform"/u);
  assert.match(wrapper, /resolve-defold-platform\.mjs/u);
  assert.doesNotMatch(wrapper, /package:defold/u);
});

test("Bob rejects macOS's executable Java stub before selecting a real JDK", async () => {
  const wrapper = await readFile(new URL("../scripts/bob.sh", import.meta.url), "utf8");
  assert.match(wrapper, /"\$candidate" -version >\/dev\/null 2>&1/u);
  assert.match(wrapper, /\/opt\/homebrew\/opt\/openjdk@25\/bin\/java/u);
});
