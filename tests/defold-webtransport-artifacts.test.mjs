import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { unzipSync, zipSync } from "fflate";

import {
  auditNativeArtifactDirectory,
  assembleNativeArtifacts,
  fingerprintNativeArtifacts,
  nativeArtifactRelease,
  packageNativeArtifact,
  planNativeArtifactBuilds,
  readNativeArtifactRows,
  repositoryRoot,
  stageNativeArtifactOverlay,
  verifyNativeArtifact
} from "../scripts/lib/defold-webtransport-artifacts.mjs";
import { describeDefoldWebtransportPackage } from "../scripts/package-defold-webtransport.mjs";

async function scratch(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "defold-webtransport-artifacts-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function syntheticLibraries(root, row, salt = row.target) {
  await mkdir(root, { recursive: true });
  for (const filename of row.files) await writeFile(path.join(root, filename), `synthetic ${salt} ${filename}\n`);
}

test("ext.manifest is the authority for every native artifact row and bundled library", async () => {
  const rows = await readNativeArtifactRows();
  assert.deepEqual(rows.map((row) => row.target), [
    "arm64-android", "arm64-ios", "arm64-linux", "arm64-osx", "arm64_sim-ios",
    "armv7-android", "x86_64-android", "x86_64-linux", "x86_64-osx", "x86_64-win32"
  ]);
  for (const row of rows) {
    assert.equal(row.files.length, 11);
    assert.ok(row.files.some((name) => name.includes("everest")));
    assert.ok(row.files.some((name) => name.includes("p256m")));
    assert.ok(!row.files.some((name) => name.includes("ws2_32") || name.includes("bcrypt")));
  }
  assert.deepEqual([...new Set(rows.map((row) => row.lane))].sort(), ["android", "apple", "linux", "windows"]);
});

test("planner schedules only missing immutable target assets", async () => {
  const rows = await readNativeArtifactRows();
  const present = rows.slice(0, 3).map((row) => row.asset);
  const plan = await planNativeArtifactBuilds(present);
  assert.equal(plan.rows.length, 10);
  assert.equal(plan.missing.length, 7);
  assert.ok(plan.missing.every((row) => !present.includes(row.asset)));
  assert.equal(plan.complete, false);
  assert.equal((await planNativeArtifactBuilds(rows.map((row) => row.asset))).complete, true);
});

test("content fingerprint rotates when a pinned native build input changes", async (t) => {
  const root = await scratch(t);
  const paths = [
    "native/webtransport-cpp",
    "extensions/defold-webtransport/defold_webtransport/ext.manifest",
    "extensions/defold-webtransport/defold_webtransport/include",
    "packages/toolchains/defold-bundle-targets.json",
    "scripts/lib/defold-webtransport-artifacts.mjs",
    "scripts/manage-defold-webtransport-artifacts.mjs",
    ".github/workflows/defold-webtransport-native-artifacts.yml"
  ];
  for (const relative of paths) {
    const source = path.join(repositoryRoot, relative);
    const destination = path.join(root, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(source, destination, { recursive: true });
  }
  const first = await fingerprintNativeArtifacts({ root });
  const cmake = path.join(root, "native/webtransport-cpp/CMakeLists.txt");
  const cmakeSource = await readFile(cmake, "utf8");
  await writeFile(cmake, cmakeSource.replace(/\n/gu, "\r\n"));
  assert.equal(await fingerprintNativeArtifacts({ root }), first,
    "Git line-ending materialization must not change a content-addressed release identity");
  await writeFile(cmake, `${cmakeSource}\n# fingerprint fixture mutation\n`);
  const second = await fingerprintNativeArtifacts({ root });
  assert.match(first, /^[0-9a-f]{64}$/u);
  assert.notEqual(second, first);

  const helper = path.join(root, "native/webtransport-cpp/cmake/apply_patch.cmake");
  await writeFile(helper, `${await readFile(helper, "utf8")}\n# cmake helper fingerprint mutation\n`);
  assert.notEqual(await fingerprintNativeArtifacts({ root }), second,
    "CMake helper changes must rotate the immutable native release");
});

test("pinned dependency patches are idempotent but still fail closed on foreign source state", async (t) => {
  const root = await scratch(t);
  const patch = path.join(root, "change.patch");
  const helper = path.join(repositoryRoot, "native/webtransport-cpp/cmake/apply_patch.cmake");
  await writeFile(path.join(root, "value.txt"), "before\n");
  await writeFile(patch, [
    "diff --git a/value.txt b/value.txt",
    "--- a/value.txt",
    "+++ b/value.txt",
    "@@ -1 +1 @@",
    "-before",
    "+after",
    ""
  ].join("\n"));
  const apply = () => execFileSync("cmake", [
    "-DDEHERM_GIT=git",
    `-DDEHERM_PATCH=${patch}`,
    "-P", helper
  ], { cwd: root, encoding: "utf8", stdio: "pipe" });

  apply();
  assert.equal(await readFile(path.join(root, "value.txt"), "utf8"), "after\n");
  apply();
  assert.equal(await readFile(path.join(root, "value.txt"), "utf8"), "after\n");

  await writeFile(path.join(root, "value.txt"), "foreign\n");
  assert.throws(apply, /neither applicable nor already applied/u);
});

test("every pinned dependency patch is structurally valid before FetchContent runs", async () => {
  const patchRoot = path.join(repositoryRoot, "native/webtransport-cpp/patches");
  const patches = (await readdir(patchRoot)).filter((name) => name.endsWith(".patch")).sort();
  assert.ok(patches.length > 0);
  for (const name of patches) {
    const output = execFileSync("git", ["apply", "--numstat", path.join(patchRoot, name)], {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: "pipe"
    });
    assert.match(output, /\S/u, `${name} must contain at least one structurally valid diff`);
  }
});

test("artifact identity ignores unrelated Defold revision metadata but rotates for consumed SDK settings", async (t) => {
  const root = await scratch(t);
  const paths = [
    "native/webtransport-cpp",
    "extensions/defold-webtransport/defold_webtransport/ext.manifest",
    "extensions/defold-webtransport/defold_webtransport/include",
    "packages/toolchains/defold-bundle-targets.json",
    "scripts/lib/defold-webtransport-artifacts.mjs",
    "scripts/manage-defold-webtransport-artifacts.mjs",
    ".github/workflows/defold-webtransport-native-artifacts.yml"
  ];
  for (const relative of paths) {
    const source = path.join(repositoryRoot, relative);
    const destination = path.join(root, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(source, destination, { recursive: true });
  }
  const targetFile = path.join(root, "packages/toolchains/defold-bundle-targets.json");
  const original = JSON.parse(await readFile(targetFile, "utf8"));
  const first = await fingerprintNativeArtifacts({ root });
  original.defoldRevision = "0".repeat(40);
  original.sourceSha256 = "f".repeat(64);
  await writeFile(targetFile, `${JSON.stringify(original, null, 2)}\n`);
  assert.equal(await fingerprintNativeArtifacts({ root }), first);
  original.sdk.macosxVersionMin = "11.0";
  await writeFile(targetFile, `${JSON.stringify(original, null, 2)}\n`);
  assert.notEqual(await fingerprintNativeArtifacts({ root }), first);
});

test("per-target archives are deterministic, fingerprinted, and exact-member", async (t) => {
  const directory = await scratch(t);
  const row = (await readNativeArtifactRows()).find(({ target }) => target === "arm64-osx");
  const firstInput = path.join(directory, "first-input");
  const secondInput = path.join(directory, "second-input", "nested");
  await syntheticLibraries(firstInput, row, "same");
  await syntheticLibraries(secondInput, row, "same");
  const first = await packageNativeArtifact({ target: row.target, inputRoot: firstInput, outputRoot: path.join(directory, "first") });
  const second = await packageNativeArtifact({ target: row.target, inputRoot: path.dirname(secondInput), outputRoot: path.join(directory, "second") });
  assert.deepEqual(await readFile(first.archivePath), await readFile(second.archivePath));
  const verified = await verifyNativeArtifact({ target: row.target, archivePath: first.archivePath });
  assert.equal(verified.metadata.fingerprint, (await nativeArtifactRelease()).fingerprint);
  assert.deepEqual(Object.keys(verified.archive).sort(), [
    "artifact.json",
    ...row.files.map((name) => `lib/${row.target}/${name}`)
  ].sort());
});

test("artifact packaging fails closed on a missing or duplicate library", async (t) => {
  const directory = await scratch(t);
  const row = (await readNativeArtifactRows())[0];
  const input = path.join(directory, "input");
  await syntheticLibraries(input, row);
  await rm(path.join(input, row.files[0]));
  await assert.rejects(
    packageNativeArtifact({ target: row.target, inputRoot: input, outputRoot: path.join(directory, "out") }),
    /requires exactly one/u
  );
  await writeFile(path.join(input, row.files[0]), "one\n");
  await mkdir(path.join(input, "duplicate"));
  await writeFile(path.join(input, "duplicate", row.files[0]), "two\n");
  await assert.rejects(
    packageNativeArtifact({ target: row.target, inputRoot: input, outputRoot: path.join(directory, "out") }),
    /found 2/u
  );
});

test("artifact verification rejects bytes that do not match the immutable inventory", async (t) => {
  const directory = await scratch(t);
  const row = (await readNativeArtifactRows())[0];
  const input = path.join(directory, "input");
  await syntheticLibraries(input, row);
  const result = await packageNativeArtifact({ target: row.target, inputRoot: input, outputRoot: path.join(directory, "out") });
  const members = unzipSync(await readFile(result.archivePath));
  members[`lib/${row.target}/${row.files[0]}`] = new TextEncoder().encode("tampered\n");
  const tampered = path.join(directory, "tampered.zip");
  await writeFile(tampered, zipSync(members));
  await assert.rejects(verifyNativeArtifact({ target: row.target, archivePath: tampered }), /digest or byte count/u);
});

test("a corrupt same-name immutable release asset fails with operational recovery guidance", async (t) => {
  const directory = await scratch(t);
  const row = (await readNativeArtifactRows())[0];
  const input = path.join(directory, "input");
  const assets = path.join(directory, "assets");
  await syntheticLibraries(input, row);
  const result = await packageNativeArtifact({ target: row.target, inputRoot: input, outputRoot: assets });
  const members = unzipSync(await readFile(result.archivePath));
  members[`lib/${row.target}/${row.files[0]}`] = new TextEncoder().encode("corrupt immutable bytes\n");
  await writeFile(result.archivePath, zipSync(members));
  await assert.rejects(
    auditNativeArtifactDirectory({ archiveRoot: assets, partial: true }),
    /content-addressed asset is immutable.*quarantine\/delete.*rotate/u
  );
});

test("synthetic complete archives assemble a package-valid release tree", async (t) => {
  const directory = await scratch(t);
  const assets = path.join(directory, "assets");
  for (const row of await readNativeArtifactRows()) {
    const input = path.join(directory, "inputs", row.target);
    await syntheticLibraries(input, row);
    await packageNativeArtifact({ target: row.target, inputRoot: input, outputRoot: assets });
  }
  const outputRoot = path.join(directory, "assembled");
  const assembled = await assembleNativeArtifacts({ archiveRoot: assets, outputRoot });
  assert.equal(assembled.artifacts.length, 10);
  const description = await describeDefoldWebtransportPackage({ sourceRoot: outputRoot });
  assert.match(description.assetName, /^defold-webtransport-.+\.zip$/u);
  assert.ok(description.members.some((member) => member.endsWith("/lib/x86_64-win32/defold_webtransport_core.lib")));
});

test("release assembly fails closed when one native target asset is absent", async (t) => {
  const directory = await scratch(t);
  const rows = await readNativeArtifactRows();
  const assets = path.join(directory, "assets");
  for (const row of rows.slice(1)) {
    const input = path.join(directory, "inputs", row.target);
    await syntheticLibraries(input, row);
    await packageNativeArtifact({ target: row.target, inputRoot: input, outputRoot: assets });
  }
  await assert.rejects(
    assembleNativeArtifacts({ archiveRoot: assets, outputRoot: path.join(directory, "assembled") }),
    new RegExp(rows[0].asset.replaceAll(".", "\\."), "u")
  );
});

test("one verified target archive can be staged for a target-local Bob build", async (t) => {
  const directory = await scratch(t);
  const row = (await readNativeArtifactRows()).find(({ target }) => target === "arm64-osx");
  const input = path.join(directory, "input");
  await syntheticLibraries(input, row);
  const packaged = await packageNativeArtifact({ target: row.target, inputRoot: input, outputRoot: path.join(directory, "assets") });
  const staged = await stageNativeArtifactOverlay({ target: row.target, archivePath: packaged.archivePath, outputRoot: path.join(directory, "overlay") });
  assert.equal(staged.artifacts.length, 1);
  assert.deepEqual(
    await readFile(path.join(staged.outputRoot, "lib", row.target, row.files[0])),
    await readFile(path.join(input, row.files[0]))
  );
});

test("the real source package command remains fail-closed without assembled native artifacts", async () => {
  await assert.rejects(
    describeDefoldWebtransportPackage(),
    /declared .* library is absent from the release/u
  );
});

test("CI publishes content-addressed rows immutably and release assembly consumes all of them", async () => {
  const nativeWorkflow = await readFile(path.join(repositoryRoot, ".github/workflows/defold-webtransport-native-artifacts.yml"), "utf8");
  const releaseWorkflow = await readFile(path.join(repositoryRoot, ".github/workflows/defold-webtransport-release.yml"), "utf8");
  const uploadHelper = await readFile(path.join(repositoryRoot, "scripts/ci/upload-release-asset.sh"), "utf8");
  assert.match(nativeWorkflow, /manage-defold-webtransport-artifacts\.mjs release-metadata/u);
  assert.match(nativeWorkflow, /Validate native artifact graph and dependency patches[\s\S]*node --test tests\/defold-webtransport-artifacts\.test\.mjs/u,
    "the plan job must reject malformed dependency patches before allocating matrix runners");
  assert.match(nativeWorkflow, /deherm_webtransport_cpp_test/u);
  assert.match(nativeWorkflow, /ctest --test-dir/u);
  assert.match(nativeWorkflow, /upload-release-asset\.sh/u);
  assert.match(nativeWorkflow, /RELEASE_TARGET: \$\{\{ github\.sha \}\}/u);
  assert.match(uploadHelper, /--target "\$release_target"/u);
  assert.match(nativeWorkflow, /androidNdkVersion/u);
  assert.match(nativeWorkflow, /No sdkmanager NDK mapping for pinned Defold NDK/u);
  assert.match(nativeWorkflow, /cmdline-tools\/latest\/bin\/sdkmanager/u);
  assert.doesNotMatch(nativeWorkflow, /android-actions\/setup-android/u);
  assert.doesNotMatch(nativeWorkflow, /ndk;25\.2\.9519653/u);
  assert.doesNotMatch(nativeWorkflow, /--clobber/u);
  assert.match(nativeWorkflow, /permissions:\n  contents: read/u);
  assert.match(nativeWorkflow, /publish:[\s\S]*permissions:\n      contents: write/u);
  assert.equal((nativeWorkflow.match(/actions\/checkout@v7/gu) ?? []).length, (nativeWorkflow.match(/persist-credentials: false/gu) ?? []).length);
  assert.match(releaseWorkflow, /needs: native-artifacts/u);
  assert.match(releaseWorkflow, /gh release download "\$NATIVE_TAG"/u);
  assert.match(releaseWorkflow, /manage-defold-webtransport-artifacts\.mjs assemble/u);
  assert.match(releaseWorkflow, /--source build\/defold-webtransport-release-source/u);
  assert.match(releaseWorkflow, /pnpm test:native-webtransport-jsi/u);
  assert.match(releaseWorkflow, /pnpm test:static-native-module-exact/u);
  assert.match(releaseWorkflow, /pnpm test:static-webtransport-facade-exact/u);

  const cmake = await readFile(path.join(repositoryRoot, "native/webtransport-cpp/CMakeLists.txt"), "utf8");
  assert.match(cmake, /LINK_GROUP:RESCAN,picohttp-core,picoquic-core,picoquic-log/u,
    "GNU static linking must rescan the mutually dependent picoquic archives");
  const picotlsPatch = await readFile(path.join(repositoryRoot,
    "native/webtransport-cpp/patches/picotls-dtrace-probe-output.patch"), "utf8");
  assert.match(picotlsPatch, /FIND_PACKAGE\(PkgConfig QUIET\)/u);
  assert.match(picotlsPatch, /IF \(PkgConfig_FOUND\)[\s\S]*PKG_CHECK_MODULES/u,
    "optional Brotli discovery must not make pkg-config a Windows build prerequisite");
  assert.match(picotlsPatch, /IF \(WIN32\)[\s\S]*INCLUDE_DIRECTORIES\(picotlsvs\/picotls\)/u);
  assert.match(picotlsPatch, /LIST\(APPEND CORE_FILES picotlsvs\/picotls\/wintimeofday\.c\)/u,
    "Picotls' CMake build must consume its own Windows compatibility implementation");
  assert.match(picotlsPatch, /ptls_log_getsni_t result/u);
  assert.match(picotlsPatch, /buf->align_bits = 0/u,
    "Picotls' public header must remain valid when consumed by MSVC C++");
  assert.match(cmake, /target_compile_definitions\(deherm_webtransport_cpp PRIVATE NOMINMAX WIN32_LEAN_AND_MEAN\)/u,
    "the Windows SDK min/max macros must not rewrite bounded C++ calls");
  assert.match(cmake, /if\(CMAKE_CONFIGURATION_TYPES\)[\s\S]*CMAKE_CFG_INTDIR[\s\S]*MBEDTLS_LIBRARY/u,
    "multi-config generators must link Mbed TLS archives from their configuration directory");
});
