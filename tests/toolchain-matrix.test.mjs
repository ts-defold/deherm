import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { deriveBundleTargets } from "../scripts/generate-defold-bundle-targets.mjs";
import { hostCompilerKey, inspectHostCompilers, hostCompilerReport, requireHostCompilers } from "../packages/cli/src/host-compilers.mjs";
import { nativeArtifactReport } from "../packages/cli/src/toolchains.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const knownTargetStatuses = new Set(["vendored", "vendored-source", "required-missing", "blocked", "retired-upstream"]);

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

test("the host compiler matrix covers every supported host with a pinned record", async () => {
  const manifest = await readJson("packages/toolchains/host-compilers.json");
  assert.deepEqual(Object.keys(manifest.hosts).sort(), ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64"]);
  for (const [key, record] of Object.entries(manifest.hosts)) {
    assert.equal(`${record.host.platform}-${record.host.architecture}`, key);
    assert.ok(record.package.startsWith("@ts-defold/deherm-compilers-"), `${key} declares no publishable package`);
    assert.deepEqual(Object.keys(record.files).sort(), ["hermesc", "shermes"], `${key} must ship both compilers`);
    if (record.status === "vendored") {
      for (const tool of Object.keys(record.files)) {
        assert.match(record.binaries?.[tool]?.sha256 ?? "", /^[a-f0-9]{64}$/, `${key} ${tool} carries no pinned digest`);
      }
    } else {
      assert.ok(record.builder || record.blocker?.code, `${key} is ${record.status} without a builder or a blocker`);
    }
    const declared = JSON.parse(await readFile(path.join(repositoryRoot, record.directory, "package.json"), "utf8"));
    assert.equal(declared.name, record.package);
    assert.deepEqual(declared.os, [record.host.platform]);
    assert.deepEqual(declared.cpu, [record.host.architecture]);
  }
});

test("a host with no available build fails closed with an actionable diagnostic", async () => {
  const unknown = await inspectHostCompilers("sunos-sparc");
  assert.equal(unknown.ok, false);
  assert.match(unknown.detail, /declares no hermesc\/shermes build for sunos-sparc/);

  const report = await hostCompilerReport();
  assert.equal(report.currentHost, hostCompilerKey());
  assert.equal(report.hosts.filter((host) => host.current).length, 1);

  const current = report.hosts.find((host) => host.current);
  if (current.ok) {
    assert.ok(current.binaries.hermesc.sha256);
    assert.ok(current.binaries.shermes.sha256);
    await requireHostCompilers();
  } else {
    // Failing closed means the error names the host and how to fix it, never a
    // silent fallback to whatever compiler happens to be on PATH.
    await assert.rejects(requireHostCompilers(), (error) => {
      assert.match(error.message, /déherm cannot compile on this host/);
      assert.ok(
        error.message.includes(hostCompilerKey()) || error.message.includes("@ts-defold/deherm-compilers-"),
        `diagnostic must name the host or its package: ${error.message}`
      );
      return true;
    });
  }
});

test("the artifact report says what this package can bundle, per target", async () => {
  const report = await nativeArtifactReport();
  const generated = await readJson("packages/toolchains/defold-bundle-targets.json");
  assert.equal(report.targets.length, generated.targets.length);
  for (const row of report.targets) {
    assert.ok(knownTargetStatuses.has(row.status), `${row.target} reported unknown status ${row.status}`);
    assert.ok(row.detail.length > 0, `${row.target} reported no detail`);
  }
  const macos = report.targets.find((row) => row.target === "arm64-osx");
  assert.equal(macos.status, "vendored");
  const retired = report.targets.find((row) => row.target === "x86-osx");
  assert.equal(retired.ok, false);
  assert.match(retired.detail, /upstream-platform-retired/);
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
