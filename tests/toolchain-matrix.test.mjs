import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { deriveBundleTargets, derivePlatformPairs } from "../scripts/generate-defold-bundle-targets.mjs";
import { hostCompilerKey, inspectHostCompilers, hostCompilerReport, requireHostCompilers, requireHostTool } from "../packages/cli/src/host-compilers.mjs";
import { resolveDefoldSurface } from "../packages/cli/src/defold-surface.mjs";
import { assertProjectNativeArtifact, ensureProjectNativeArtifact, nativeArtifactReport } from "../packages/cli/src/toolchains.mjs";
import { buildArtifactReferences } from "../packages/generator/src/policy/generate-api-policy.mjs";
import { dehermPluginManifest, transformCompilerIdentity, transformProject } from "../packages/cli/src/transform-compiler.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const knownTargetStatuses = new Set(["vendored", "vendored-source", "required-missing", "blocked", "retired-upstream"]);

const policyManifest = await readJson("packages/bindings/generated/defold-api-policy.json");
const policyToolchain = (await resolveDefoldSurface(policyManifest.defoldRevision, { packageRoot: repositoryRoot })).toolchain;
const artifactDocument = {
  schemaVersion: 1,
  kind: "deherm.policy.artifacts",
  defoldRevision: policyManifest.defoldRevision,
  artifacts: await buildArtifactReferences()
};

async function writeProjectLock(root) {
  await writeFile(path.join(root, "deherm.lock"), `${JSON.stringify({
    defoldRevision: policyManifest.defoldRevision,
    toolchain: policyToolchain,
    artifacts: artifactDocument
  }, null, 2)}\n`);
}

async function readJson(relative) {
  return JSON.parse(await readFile(path.join(repositoryRoot, relative), "utf8"));
}

test("the bundle target list is derived from the pinned Defold sources, not hand-listed", async () => {
  const generated = await readJson("packages/toolchains/defold-bundle-targets.json");
  const derived = await deriveBundleTargets();
  assert.deepEqual(derived, generated, "run node scripts/generate-defold-bundle-targets.mjs");

  // The structural rule: `<arch>-<group>` keys are selectable bundle targets and
  // bare keys are shared group contexts. Asserting both directions keeps a
  // future Defold release from quietly reclassifying one as the other.
  for (const entry of generated.targets) assert.match(entry.target, /-/);
  for (const group of generated.groups) assert.equal(group.includes("-"), false);
  assert.ok(generated.targets.some((entry) => entry.group === "android"), "Android must be derived, not omitted");
  assert.ok(generated.targets.some((entry) => entry.group === "ios"), "iOS must be derived, not omitted");
});

test("Bob and Extender platform identities are derived from Defold Platform.java", async () => {
  const generated = await readJson("packages/toolchains/defold-platform-pairs.json");
  assert.deepEqual(generated, await derivePlatformPairs());
  assert.deepEqual(policyToolchain.targetMatrix.platformPairs, generated.platforms);
  assert.ok(policyToolchain.targetMatrix.targets.some(({ target, kind }) => target === "x86-osx" && kind === "retired"));
});

test("a copied browser-host source artifact satisfies the project artifact gate", async () => {
  const project = await mkdtemp(path.join(tmpdir(), "deherm-web-artifact."));
  try {
    await writeProjectLock(project);
    const relative = "defold_hermes/lib/web/library_defold_hermes.js";
    await mkdir(path.join(project, path.dirname(relative)), { recursive: true });
    await copyFile(path.join(repositoryRoot, "defold", relative), path.join(project, relative));
    const result = await assertProjectNativeArtifact(project, "wasm-web");
    assert.equal(path.relative(project, result.file), relative);
    await writeFile(path.join(project, relative), "tampered");
    await assert.rejects(assertProjectNativeArtifact(project, "wasm-web"), /source checksum mismatch/);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("every Defold bundle target carries an explicit status and never silence", async () => {
  const generated = await readJson("packages/toolchains/defold-bundle-targets.json");
  const manifest = await readJson("packages/toolchains/native-artifacts.json");
  assert.deepEqual(
    Object.keys(manifest.targets).sort(),
    generated.targets.map(({ target }) => target).sort(),
    "the artifact manifest and the derived platform list must enumerate exactly the same targets"
  );
  for (const [target, artifact] of Object.entries(manifest.targets)) {
    assert.ok(knownTargetStatuses.has(artifact.status), `${target} has unknown status ${artifact.status}`);
    if (artifact.status === "required-missing") {
      assert.ok(artifact.builder, `${target} is required-missing without naming a builder`);
      assert.ok(artifact.library, `${target} is required-missing without naming its library`);
    }
    // A target that cannot be built must say why in machine-readable form.
    // Silence is the failure mode this matrix exists to remove.
    if (artifact.status === "blocked" || artifact.status === "retired-upstream") {
      assert.ok(artifact.blocker?.code, `${target} is ${artifact.status} without a blocker code`);
      assert.ok(artifact.blocker?.reason?.length > 40, `${target} blocker reason is not specific enough`);
      assert.ok(Array.isArray(artifact.blocker.requires), `${target} blocker must list what it requires`);
    }
  }
});

test("the host tool matrix covers every supported host with a pinned record per tool", async () => {
  const manifest = await readJson("packages/toolchains/host-compilers.json");
  assert.deepEqual(Object.keys(manifest.hosts).sort(), ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64"]);
  // Three tools run on the user's machine, not two. dehermc is tracked the
  // same way as the Hermes compilers because it has the same property: it runs
  // on the host, it is indexed by the host, and without it shipped the user's
  // machine compiles it - which is exactly the requirement the product contract
  // says déherm does not impose.
  assert.deepEqual(Object.keys(manifest.tools).sort(), ["dehermc", "hermesc", "shermes"]);
  for (const [key, record] of Object.entries(manifest.hosts)) {
    assert.equal(`${record.host.platform}-${record.host.architecture}`, key);
    assert.deepEqual(Object.keys(record.tools).sort(), ["dehermc", "hermesc", "shermes"], `${key} must ship all three host tools`);
    for (const [tool, toolRecord] of Object.entries(record.tools)) {
      assert.ok(toolRecord.file, `${key} ${tool} names no file`);
      if (toolRecord.status === "vendored") {
        assert.match(toolRecord.sha256 ?? "", /^[a-f0-9]{64}$/, `${key} ${tool} carries no pinned digest`);
      } else {
        assert.ok(toolRecord.builder || toolRecord.blocker?.code, `${key} ${tool} is ${toolRecord.status} without a builder or a blocker`);
      }
    }
    assert.equal(record.package, undefined, `${key} must not route binaries through npm`);
  }
});

test("a host with no available build fails closed with an actionable diagnostic", async () => {
  const unknown = await inspectHostCompilers("sunos-sparc");
  assert.equal(unknown.ok, false);
  assert.match(unknown.detail, /declares no hermesc\/shermes\/dehermc build for sunos-sparc/);

  const report = await hostCompilerReport();
  assert.equal(report.currentHost, hostCompilerKey());
  assert.equal(report.hosts.filter((host) => host.current).length, 1);

  const current = report.hosts.find((host) => host.current);
  // Every tool is answered for by name, whether or not it resolved. A host
  // report that omitted a tool would be silence about the one thing the user
  // needs to know.
  assert.deepEqual(Object.keys(current.tools).sort(), ["dehermc", "hermesc", "shermes"]);
  for (const tool of Object.values(current.tools)) {
    assert.ok(tool.detail.length > 0, `${tool.tool} reported no detail`);
    if (!tool.ok) {
      await assert.rejects(requireHostTool(tool.tool), (error) => {
        assert.match(error.message, new RegExp(`déherm cannot run ${tool.tool} on this host`));
        return true;
      });
    }
  }
  if (current.ok) {
    assert.ok(current.binaries.hermesc.sha256);
    assert.ok(current.binaries.shermes.sha256);
    assert.ok(current.binaries["dehermc"].sha256);
    await requireHostCompilers();
  } else {
    // Failing closed means the error names the host and how to fix it, never a
    // silent fallback to whatever compiler happens to be on PATH.
    await assert.rejects(requireHostCompilers(), (error) => {
      assert.match(error.message, /déherm cannot compile on this host/);
      assert.ok(
        error.message.includes(hostCompilerKey()) || error.message.includes("DEHERM_TOOL_CACHE"),
        `diagnostic must name the host or release cache: ${error.message}`
      );
      return true;
    });
  }
});

test("the transform compiler is driven by digest, or fails closed naming itself", async (t) => {
  // The manifest is not optional and not a formality. ttsc pairs registrations
  // with linked manifest entries by build order, so this one entry is what
  // activates the single plugin dehermc links; without it the host answers
  // with the project unchanged and exit 0, which is indistinguishable from a
  // project that declares no transforms.
  const manifest = JSON.parse(dehermPluginManifest({ resourceSymbols: "./symbols.json" }));
  assert.equal(manifest.length, 1);
  assert.equal(manifest[0].stage, "transform");
  assert.deepEqual(manifest[0].config, { resourceSymbols: "./symbols.json" });

  const resolved = await transformCompilerIdentity().then((identity) => identity, () => null);
  if (!resolved) {
    // The published binary is not in this checkout, which is the normal state
    // until CI has run. What must hold unconditionally is that the seam refuses
    // rather than falling back to building Go on the user's machine.
    await assert.rejects(transformProject({ tsconfig: "tests/fixtures/hash-literal/tsconfig.json" }), (error) => {
      assert.match(error.message, /déherm cannot run dehermc on this host/);
      return true;
    });
    t.diagnostic("dehermc is not staged in this checkout; exercised the fail-closed path only");
    return;
  }

  assert.match(resolved.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(resolved.transforms, ["defold-hash-literal", "resource-name", "defold-api-usage"]);
  assert.equal(resolved.host, hostCompilerKey());

  const envelope = await transformProject({
    tsconfig: path.join(repositoryRoot, "tests/fixtures/hash-literal/tsconfig.json")
  });
  const entry = Object.entries(envelope.typescript).find(([file]) => file.endsWith("hash-literal/entry.ts"));
  assert.ok(entry, "the transform envelope must carry the fixture entry point");
  // dmHashBufferNoReverse64("up"). If the transforms had not run, this would
  // still read `hashLiteral("#up")` and the compile would have succeeded.
  assert.match(entry[1], /export const up: DefoldHash<"up"> = 0x80356add32e752e9n;/);
});


test("the artifact report says what this package can bundle, per target", async () => {
  const project = await mkdtemp(path.join(tmpdir(), "deherm-artifact-report."));
  await writeProjectLock(project);
  await mkdir(path.join(project, "defold_hermes/lib/web"), { recursive: true });
  await copyFile(
    path.join(repositoryRoot, "defold/defold_hermes/lib/web/library_defold_hermes.js"),
    path.join(project, "defold_hermes/lib/web/library_defold_hermes.js")
  );
  const report = await nativeArtifactReport(project);
  const generated = await readJson("packages/toolchains/defold-bundle-targets.json");
  assert.equal(report.targets.length, generated.targets.filter(({ kind }) => kind === "bundle").length);
  for (const row of report.targets) {
    assert.ok(row.detail.length > 0, `${row.target} reported no detail`);
  }
  const macos = report.targets.find((row) => row.target === "arm64-osx");
  assert.equal(macos.status, "published");
  assert.equal(report.targets.some((row) => row.target === "x86-osx"), false);
  await rm(project, { recursive: true, force: true });
});

test("a target release already in the content-addressed cache installs without network", async () => {
  const project = await mkdtemp(path.join(tmpdir(), "deherm-target-cache."));
  try {
    await writeProjectLock(project);
    const family = artifactDocument.artifacts["native-artifacts"];
    const cacheHome = path.join(project, "user-cache");
    const cached = path.join(cacheHome, "artifacts", family.tag, "arm64-osx");
    await mkdir(cached, { recursive: true });
    const hashes = {};
    for (const member of family.contents["arm64-osx"]) {
      const bytes = Buffer.from(`fixture:${member}`);
      await writeFile(path.join(cached, member), bytes);
      hashes[member] = createHash("sha256").update(bytes).digest("hex");
    }
    await writeFile(path.join(cached, ".deherm-target-cache.json"), `${JSON.stringify({
      schemaVersion: 1,
      kind: "deherm.target-artifact-cache",
      target: "arm64-osx",
      tag: family.tag,
      fingerprint: family.fingerprint,
      asset: family.assets["arm64-osx"],
      assetSha256: "a".repeat(64),
      members: family.contents["arm64-osx"],
      hashes
    }, null, 2)}\n`);
    const installed = await ensureProjectNativeArtifact(project, "arm64-macos", {
      env: { DEHERM_CACHE_HOME: cacheHome },
      offline: true
    });
    assert.equal(installed.target, "arm64-osx");
    const verified = await assertProjectNativeArtifact(project, "arm64-macos", { fetch: false });
    assert.match(await readFile(verified.file, "utf8"), /^fixture:/u);
    const installedConfig = path.join(project, "defold_hermes/include/libhermesvm-config.h");
    assert.equal(await readFile(installedConfig, "utf8"), "fixture:libhermesvm-config.h");
    await writeFile(installedConfig, "wrong target config");
    await assert.rejects(
      assertProjectNativeArtifact(project, "arm64-macos", { fetch: false }),
      /missing or does not match its receipt/u
    );
    await ensureProjectNativeArtifact(project, "arm64-macos", {
      env: { DEHERM_CACHE_HOME: cacheHome },
      offline: true
    });
    await writeFile(path.join(cached, family.contents["arm64-osx"][0]), "corrupt cache");
    await assert.rejects(
      ensureProjectNativeArtifact(project, "arm64-macos", {
        env: { DEHERM_CACHE_HOME: cacheHome },
        offline: true
      }),
      /no valid cache receipt/u
    );
    await writeFile(verified.file, "corrupt");
    await assert.rejects(
      assertProjectNativeArtifact(project, "arm64-macos", { fetch: false }),
      /missing or does not match its receipt: defold_hermes\/lib\/arm64-osx\/libhermes\.a/u
    );
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("deherm doctor reports the matrix and rejects a target Defold does not declare", () => {
  const result = spawnSync(process.execPath, [
    path.join(repositoryRoot, "bin", "deherm.mjs"),
    "doctor",
    "--target", "arm64-osx,not-a-platform",
    "--json"
  ], { cwd: repositoryRoot, encoding: "utf8" });
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  assert.deepEqual(report.bundleTargets.unknownTargets, ["not-a-platform"]);
  assert.ok(report.failures.some((failure) => failure.includes("not-a-platform")));
  assert.ok(report.hostCompilers.hosts.length >= 5);
  assert.equal(result.status, 1);
});

test("the declared matrix verifies and the complete matrix names every gap", () => {
  const declared = spawnSync(process.execPath, [path.join(repositoryRoot, "scripts", "manage-native-artifacts.mjs"), "verify"], {
    cwd: repositoryRoot,
    encoding: "utf8"
  });
  assert.equal(declared.status, 0, declared.stderr);

  const complete = spawnSync(process.execPath, [path.join(repositoryRoot, "scripts", "manage-native-artifacts.mjs"), "verify", "--complete"], {
    cwd: repositoryRoot,
    encoding: "utf8"
  });
  if (complete.status !== 0) {
    // The point of --complete is that it names every gap at once; reporting
    // only the first would make filling the matrix a serial guessing game.
    const manifest = JSON.parse(spawnSync(process.execPath, [path.join(repositoryRoot, "scripts", "manage-native-artifacts.mjs"), "report"], {
      cwd: repositoryRoot,
      encoding: "utf8"
    }).stdout);
    for (const row of manifest.targets) {
      if (row.status === "required-missing" || row.status === "blocked") {
        assert.ok(complete.stderr.includes(row.target), `--complete did not name ${row.target}`);
      }
    }
  }
});

test("targeted artifact verification does not require unrelated bundle targets", () => {
  const result = spawnSync(process.execPath, [
    path.join(repositoryRoot, "scripts", "manage-native-artifacts.mjs"),
    "verify",
    "--target", "wasm-web"
  ], { cwd: repositoryRoot, encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /ok wasm-web: vendored-source/u);
  assert.doesNotMatch(result.stdout, /arm64-osx/u);
});

test("a targeted artifact pull rejects a target that has no published row before downloading", () => {
  const result = spawnSync(
    process.execPath,
    [path.join(repositoryRoot, "scripts", "manage-native-artifacts.mjs"), "pull", "--target", "not-a-defold-target"],
    { cwd: repositoryRoot, encoding: "utf8" }
  );
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /No native artifact is published for not-a-defold-target/u);
});
