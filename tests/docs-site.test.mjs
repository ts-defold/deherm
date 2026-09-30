import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { buildDocsSite } from "../scripts/build-docs-site.mjs";
import { buildPolicySite } from "../scripts/build-policy-site.mjs";

test("docs lead with truthful new- and existing-project quick starts", async () => {
  const output = await mkdtemp(path.join(tmpdir(), "deherm-docs-site-"));
  const result = await buildDocsSite({ output });
  const page = await readFile(path.join(output, "index.html"), "utf8");
  const metrics = JSON.parse(await readFile(path.join(output, "metrics.json"), "utf8"));

  assert.match(page, /pnpm dlx @ts-defold\/deherm create my-game --name/u);
  assert.match(page, /pnpm add -D @ts-defold\/deherm/u);
  assert.match(page, /pnpm exec deherm generate/u);
  assert.match(page, /pnpm exec deherm dev/u);
  assert.doesNotMatch(page, /deherm init/u);
  assert.match(page, /Press <code>p<\/code> to build and launch native Defold/u);
  assert.match(page, /press <code>w<\/code> for HTML5/u);
  assert.match(page, /generated as \/src\/player\.script/u);
  assert.match(page, /src\/player\.script\.ts/u);
  assert.match(page, /Build, launch, inspect, reload/u);
  assert.match(page, /Your game, alive in the editor/u);
  assert.match(page, /\.cpuprofile/u);
  assert.match(page, /\.heapsnapshot/u);
  assert.match(page, /Measured in Release/u);
  assert.match(page, /HTML5 \/ wasm-web release/u);
  assert.doesNotMatch(page, /All five host-tool bundles|Checked-out native archives|CI footprint/u);
  assert.equal(result.metrics.packageVersion, "0.1.0");
  assert.equal(metrics.release.build.variant, "release");
  assert.equal(metrics.release.browserWasmWeb.embedsHermes, false);
  assert.equal(metrics.transport.build.cmakeBuildType, "Release");
  assert.equal(metrics.transport.build.profiling, false);
  assert.ok(metrics.sourceInputs.every((input) => input.bytes > 0 && /^[0-9a-f]{64}$/u.test(input.sha256)));
});

test("docs ship the exact TUI and VS Code evidence images", async () => {
  const output = await mkdtemp(path.join(tmpdir(), "deherm-docs-assets-"));
  await buildDocsSite({ output });
  assert.ok((await stat(path.join(output, "assets/deherm-tui.png"))).size > 10000);
  assert.ok((await stat(path.join(output, "assets/vscode-live-values.png"))).size > 100000);
  assert.ok((await stat(path.join(output, "assets/deherm-og.png"))).size > 10000);
});

test("release evidence distinguishes product size, overhead, and browser runtime", async () => {
  const output = await mkdtemp(path.join(tmpdir(), "deherm-docs-release-"));
  await buildDocsSite({ output });
  const metrics = JSON.parse(await readFile(path.join(output, "metrics.json"), "utf8"));
  assert.ok(metrics.release.nativeArm64Macos.packageLogicalBytes > metrics.release.nativeArm64Macos.engineBytes);
  assert.ok(metrics.release.nativeArm64Macos.engineOverheadBytes > 0);
  assert.ok(metrics.release.nativeArm64Macos.applicationBytecodeBytes > 0);
  assert.ok(metrics.release.browserWasmWeb.packageLogicalBytes > 0);
  assert.ok(metrics.release.browserWasmWeb.engineShellOverheadBytes > 0);
  assert.ok(metrics.transport.results.directCAbi.bestNanoseconds > 0);
  assert.ok(metrics.transport.results.typedNativeMedianNanoseconds > 0);
  assert.ok(metrics.transport.results.luaBridgeOwnedMedianNanoseconds > 0);
});

test("the policy landing page links to docs without changing immutable policy paths", async () => {
  const output = await mkdtemp(path.join(tmpdir(), "deherm-policy-with-docs-"));
  await buildPolicySite({ output });
  const page = await readFile(path.join(output, "index.html"), "utf8");
  assert.match(page, /href="docs\/"/u);
  assert.match(page, /0\.1 preview/u);
  assert.match(page, /v1\/policy\/&lt;root-hash&gt;/u);
});

test("policy CI mounts docs into the accumulated branch-served Pages tree", async () => {
  const workflow = await readFile(path.resolve(".github/workflows/policy.yml"), "utf8");
  const policyBuild = workflow.indexOf('node scripts/build-policy-site.mjs "${args[@]}"');
  const docsBuild = workflow.indexOf("node scripts/build-docs-site.mjs --out build/policy-site/docs");
  const accumulatedPublish = workflow.indexOf("cp -R build/policy-site/. /tmp/site/");
  const pagesBuild = workflow.indexOf('gh api -X POST "repos/${GITHUB_REPOSITORY}/pages/builds" --silent');
  assert.ok(policyBuild >= 0);
  assert.ok(policyBuild < docsBuild);
  assert.ok(docsBuild < accumulatedPublish);
  assert.ok(accumulatedPublish < pagesBuild);
  assert.doesNotMatch(workflow, /actions\/deploy-pages/u);
});
