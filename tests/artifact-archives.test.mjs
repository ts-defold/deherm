// The published asset is now one `.tar.gz` per matrix row, and the release tag
// is a fingerprint of the inputs that determine its bytes. That claim only
// holds if packaging the same build outputs twice produces the same FILE - so
// it is asserted here against the real `toolchains/hermes/package-archive.sh`
// rather than inferred from the flags it passes.
//
// Nothing here builds Hermes. The packager's contract is "these files in, that
// archive out", and small stand-in files exercise it exactly as multi-megabyte
// ones would: tar and gzip do not record what a file is, only its name, mode,
// size, ownership and timestamp - which is the whole list of things that would
// have made the output vary.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { extractReleaseArchive } from "../packages/cli/src/release-assets.mjs";
import {
  artifactFamilyNames,
  expectedAssetNames,
  familyRelease,
  publishedAssets,
  repositoryRoot,
  tagDigestLength,
  targetDebugLibraryName
} from "../scripts/lib/artifact-releases.mjs";

const execFileAsync = promisify(execFile);
const packager = path.join(repositoryRoot, "toolchains/hermes/package-archive.sh");

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function scratch(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "deherm-archive-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function pack(output, files) {
  await execFileAsync("bash", [packager, output, ...files]);
  return readFile(output);
}

test("packaging the same inputs twice produces a byte-identical archive", async (t) => {
  const directory = await scratch(t);
  const inputs = path.join(directory, "in");
  await mkdir(inputs, { recursive: true });

  const release = path.join(inputs, "libhermes.a");
  const debug = path.join(inputs, "libhermes.debug.a");
  await writeFile(release, "release archive contents");
  await writeFile(debug, "debugger-enabled archive contents");
  // The executable bit is the thing a flat release asset loses; an archive is
  // supposed to carry it, so pack a file that has one.
  await chmod(release, 0o755);

  const first = await pack(path.join(directory, "first.tar.gz"), [release, debug]);

  // Everything tar would otherwise stamp into the output, moved: the build
  // happened at a different time, in a different directory, in a different
  // order. None of it may reach the bytes.
  const later = new Date("2031-04-05T06:07:08Z");
  await utimes(release, later, later);
  await utimes(debug, later, later);
  const elsewhere = path.join(directory, "elsewhere");
  await mkdir(elsewhere, { recursive: true });
  const movedRelease = path.join(elsewhere, "libhermes.a");
  const movedDebug = path.join(elsewhere, "libhermes.debug.a");
  await writeFile(movedRelease, await readFile(release));
  await writeFile(movedDebug, await readFile(debug));
  await chmod(movedRelease, 0o755);

  const second = await pack(path.join(directory, "second.tar.gz"), [movedDebug, movedRelease]);

  assert.equal(
    digest(second),
    digest(first),
    "repackaging identical build outputs must produce identical bytes, or the pinned tag can never hold"
  );
});

test("different contents produce a different archive, so the comparison above is not vacuous", async (t) => {
  const directory = await scratch(t);
  const one = path.join(directory, "libhermes.a");
  await writeFile(one, "release archive contents");
  const first = await pack(path.join(directory, "first.tar.gz"), [one]);
  await writeFile(one, "release archive contents, rebuilt");
  const second = await pack(path.join(directory, "second.tar.gz"), [one]);
  assert.notEqual(digest(second), digest(first));
});

test("an archive round-trips through the download side, flat and still executable", async (t) => {
  const directory = await scratch(t);
  const release = path.join(directory, "libhermes.a");
  const debug = path.join(directory, "libhermes.debug.a");
  await writeFile(release, "release archive contents");
  await writeFile(debug, "debugger-enabled archive contents");
  await chmod(release, 0o755);

  const archive = path.join(directory, "hermes-arm64-osx.tar.gz");
  await pack(archive, [release, debug]);

  const unpacked = path.join(directory, "unpacked");
  await extractReleaseArchive({ archive, destination: unpacked });

  // Flat by basename: the archive is the unit, so the builder's directory
  // layout must not appear inside it - `install` looks for the library beside
  // the row's own directory and nowhere deeper.
  assert.equal(await readFile(path.join(unpacked, "libhermes.a"), "utf8"), "release archive contents");
  assert.equal(await readFile(path.join(unpacked, "libhermes.debug.a"), "utf8"), "debugger-enabled archive contents");
  // The reason the host compilers travel in an archive at all: a bare release
  // asset loses this, and a compiler that cannot be executed is not installed,
  // merely present.
  assert.equal((await stat(path.join(unpacked, "libhermes.a"))).mode & 0o111, 0o111);
});

test("the packager refuses an input that does not exist rather than shipping a short archive", async (t) => {
  const directory = await scratch(t);
  const present = path.join(directory, "libhermes.a");
  await writeFile(present, "release archive contents");
  await assert.rejects(
    pack(path.join(directory, "out.tar.gz"), [present, path.join(directory, "libhermes.debug.a")]),
    (error) => {
      assert.match(error.stderr ?? "", /libhermes\.debug\.a does not exist/);
      return true;
    }
  );
});

test("every family publishes one archive per matrix row, named for that row", async () => {
  for (const name of artifactFamilyNames) {
    const rows = await publishedAssets(name);
    assert.ok(rows.length > 0, `${name} publishes nothing`);
    for (const row of rows) {
      const key = row.host ?? row.target;
      assert.ok(key, `${name} row names neither a host nor a bundle target`);
      assert.match(row.asset, /\.tar\.gz$/, `${name} must publish archives, not loose files`);
      assert.ok(row.asset.endsWith(`-${key}.tar.gz`), `${row.asset} is not named for ${key}`);
      // An archive that names no contents is an archive the download side
      // cannot look inside, which is how the old flat names got parsed back out
      // of a string in the first place.
      assert.ok(row.files.length > 0, `${row.asset} declares no contents`);
    }
    const names = await expectedAssetNames(name);
    assert.equal(new Set(names).size, names.length, `${name} expects the same asset twice`);
  }
});

test("a target archive carries the release library and its debugger-enabled sibling", async () => {
  const rows = await publishedAssets("native-artifacts");
  const manifest = JSON.parse(
    await readFile(path.join(repositoryRoot, "packages/toolchains/native-artifacts.json"), "utf8")
  );
  for (const row of rows) {
    const artifact = manifest.targets[row.target];
    const debug = targetDebugLibraryName(row.target, artifact);
    assert.equal(row.files.length, 2, `${row.target} must ship both variants in one asset`);
    assert.ok(row.files.includes(debug), `${row.target} ships no ${debug}`);
    // The debugger variant is the same library name with `.debug` before the
    // extension, never a different extension: Extender force-loads by suffix.
    assert.ok(debug.endsWith(path.extname(row.files[0])), `${debug} changed the library's extension`);
  }
});

test("the tag is a readable prefix of the full fingerprint, which is kept", async () => {
  for (const name of artifactFamilyNames) {
    const release = await familyRelease(name);
    assert.match(release.fingerprint, /^[a-f0-9]{64}$/, "provenance is still asserted over the whole digest");
    assert.ok(
      release.tag.endsWith(release.fingerprint.slice(0, tagDigestLength)),
      `${release.tag} is not derived from ${release.fingerprint}`
    );
    // The point of the truncation: 81-character tags could not be compared by
    // eye or quoted in a bug report.
    assert.ok(release.tag.length < 40, `${release.tag} is still too long to read`);
    // A title that restates the tag is not a title.
    assert.notEqual(release.title, release.tag);
    assert.ok(release.notes.includes(release.fingerprint), "the release notes must record the full digest");
  }
});

test("package-archive.sh is an input to every family, because it decides the published bytes", async () => {
  const { artifactFamilies } = await import("../scripts/lib/artifact-releases.mjs");
  for (const name of artifactFamilyNames) {
    assert.ok(
      artifactFamilies[name].files.includes("toolchains/hermes/package-archive.sh"),
      `${name} publishes archives this script writes but does not hash it`
    );
  }
});

test("the Windows archiver protects MSVC's /OUT option from Git Bash path rewriting", async (t) => {
  const directory = await scratch(t);
  const build = path.join(directory, "build");
  const tools = path.join(directory, "bin");
  const capture = path.join(directory, "argv.txt");
  await mkdir(path.join(build, "lib"), { recursive: true });
  await mkdir(path.join(build, "jsi"), { recursive: true });
  await mkdir(tools, { recursive: true });
  await writeFile(path.join(build, "lib", "hermesvm_a.lib"), "hermes");
  await writeFile(path.join(build, "jsi", "jsi.lib"), "jsi");

  const cygpath = path.join(tools, "cygpath");
  const archiver = path.join(tools, "mock-lib");
  await writeFile(cygpath, "#!/usr/bin/env bash\nprintf 'C:\\\\native\\\\hermes.lib\\n'\n");
  await writeFile(
    archiver,
    "#!/usr/bin/env bash\nprintf '%s\\n' \"$MSYS2_ARG_CONV_EXCL\" \"$@\" > \"$CAPTURE\"\n"
  );
  await chmod(cygpath, 0o755);
  await chmod(archiver, 0o755);

  await execFileAsync("bash", [
    path.join(repositoryRoot, "toolchains/hermes/package-msvc.sh"),
    build,
    path.join(directory, "hermes.lib")
  ], {
    env: {
      ...process.env,
      CAPTURE: capture,
      LIB_TOOL: archiver,
      PATH: `${tools}:${process.env.PATH}`
    }
  });

  const args = (await readFile(capture, "utf8")).trimEnd().split("\n");
  assert.equal(args[0], "/OUT:");
  assert.equal(args[1], "/OUT:C:\\native\\hermes.lib");
  assert.deepEqual(args.slice(2), [
    path.join(build, "lib", "hermesvm_a.lib"),
    path.join(build, "jsi", "jsi.lib")
  ]);
});

test("the Windows cross toolchain uses Defold's MSVC and SDK headers", async () => {
  const source = await readFile(
    path.join(repositoryRoot, "toolchains/hermes/windows-msvc.cmake"),
    "utf8"
  );

  // A target triple alone is insufficient: clang otherwise reaches the host's
  // Linux C++ headers, and Hermes' first `<atomic>` probe fails. These are the
  // environment-owned roots in Defold's Extender win32 `systemIncludes`.
  for (const suffix of [
    "$ENV{WINDOWS_MSVC_DIR}/include",
    "$ENV{WINDOWS_MSVC_DIR}/atlmfc/include",
    "$ENV{WINDOWS_SDK_DIR}/Include/$ENV{WINDOWS_SDK_VERSION}/ucrt",
    "$ENV{WINDOWS_SDK_DIR}/Include/$ENV{WINDOWS_SDK_VERSION}/winrt",
    "$ENV{WINDOWS_SDK_DIR}/Include/$ENV{WINDOWS_SDK_VERSION}/um",
    "$ENV{WINDOWS_SDK_DIR}/Include/$ENV{WINDOWS_SDK_VERSION}/shared"
  ]) {
    assert.match(source, new RegExp(suffix.replace(/[{}$]/g, "\\$&")));
  }
  assert.match(source, /-nostdinc\+\+/);
  assert.match(source, /if\(NOT IS_DIRECTORY "\$\{include_root\}"\)/);
  assert.match(source, /set\(CMAKE_ASM_COMPILER_TARGET x86_64-pc-win32-msvc\)/);
  assert.match(source, /set\(CMAKE_ASM_FLAGS_INIT "-target x86_64-pc-win32-msvc -m64"\)/);
});

test("the POSIX packager merges explicit static runtime dependencies", async (t) => {
  const candidates = ["llvm-ar", "/opt/homebrew/opt/llvm/bin/llvm-ar", "/usr/local/opt/llvm/bin/llvm-ar", "ar"];
  let arTool = null;
  for (const candidate of candidates) {
    try {
      const { stdout, stderr } = await execFileAsync(candidate, ["--version"]);
      if (/GNU|LLVM/u.test(`${stdout}${stderr}`)) { arTool = candidate; break; }
    } catch {
      // BSD ar has no MRI mode; try the next deterministic archiver.
    }
  }
  if (!arTool) return t.skip("no GNU/LLVM ar with MRI support on this host");
  const directory = await scratch(t);
  const build = path.join(directory, "build");
  const objects = path.join(directory, "objects");
  const dependency = path.join(directory, "libicuuc.a");
  const output = path.join(directory, "libhermes.a");
  await mkdir(path.join(build, "lib"), { recursive: true });
  await mkdir(path.join(build, "jsi"), { recursive: true });
  await mkdir(objects, { recursive: true });
  const vm = path.join(objects, "vm.o");
  const jsi = path.join(objects, "jsi.o");
  const icu = path.join(objects, "icu.o");
  await Promise.all([
    writeFile(vm, "vm"),
    writeFile(jsi, "jsi"),
    writeFile(icu, "icu")
  ]);
  await execFileAsync(arTool, ["rcs", path.join(build, "lib", "libhermesvm_a.a"), vm]);
  await execFileAsync(arTool, ["rcs", path.join(build, "jsi", "libjsi.a"), jsi]);
  await execFileAsync(arTool, ["rcs", dependency, icu]);
  await execFileAsync("bash", [
    path.join(repositoryRoot, "toolchains/hermes/package-posix.sh"),
    build,
    output,
    dependency
  ], { env: { ...process.env, AR: arTool } });
  const { stdout } = await execFileAsync(arTool, ["t", output]);
  assert.deepEqual(new Set(stdout.trim().split(/\r?\n/u)), new Set(["vm.o", "jsi.o", "icu.o"]));
});
