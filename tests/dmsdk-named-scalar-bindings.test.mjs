import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { build, orderedBlockingReasons } from "../scripts/generate-dmsdk-named-scalar-bindings.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reportPath = join(repositoryRoot, "packages/bindings/generated/defold-dmsdk-named-scalar-bindings.json");
const compiler = process.env.CXX || "clang++";
const cCompiler = process.env.CC || "clang";
function run(command, args) { return execFileSync(command, args, { cwd: repositoryRoot, encoding: "utf8", stdio: "pipe" }); }
function sha256(content) { return createHash("sha256").update(content).digest("hex"); }

test("named-scalar blocker reporting preserves symbol and structural causes", () => {
  assert.deepEqual(orderedBlockingReasons({
    symbolBlocker: "native-symbol-absent",
    resultBlocker: "unsupported-result-shape",
    parameterBlockers: [undefined, "unsupported-parameter-shape", "unsupported-result-shape"]
  }), ["native-symbol-absent", "unsupported-result-shape", "unsupported-parameter-shape"]);
});

async function expectProvenanceFailure(label, mutate, expected) {
  const directory = await mkdtemp(join(tmpdir(), "deherm-dmsdk-named-scalar-provenance-"));
  try {
    let irContent = await readFile(join(repositoryRoot, "packages/bindings/generated/defold-sdk-ir.json"), "utf8");
    let shapesContent = await readFile(join(repositoryRoot, "packages/bindings/generated/defold-dmsdk-abi-shapes.json"), "utf8");
    ({ irContent, shapesContent } = await mutate({ irContent, shapesContent }));
    const irPath = join(directory, "ir.json");
    const shapesPath = join(directory, "shapes.json");
    await writeFile(irPath, irContent);
    await writeFile(shapesPath, shapesContent);
    assert.throws(() => run(process.execPath, ["scripts/generate-dmsdk-named-scalar-bindings.mjs", "--ir", irPath, "--shapes", shapesPath, "--out-root", join(directory, "out")]), expected, label);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test("named-scalar ABI artifacts are deterministic and completely census-derived", async () => {
  const output = await mkdtemp(join(tmpdir(), "deherm-dmsdk-named-scalar-"));
  try {
    run(process.execPath, ["scripts/generate-dmsdk-named-scalar-bindings.mjs", "--out-root", output]);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    assert.deepEqual(report.coverage, { reviewed: 21, generated: 20, policyBlocked: 1, signatureCompileCovered: 20, linked: 20, behaviorCovered: 20, exactCallCovered: 20, typescriptCallable: 0, warmedDispatchIterations: 100000, warmedDispatchObservedCppAllocations: 0 });
    assert.equal(new Set(report.declarations.map(({ id }) => id)).size, 21);
    const emitted = report.declarations.filter((declaration) => declaration.emitted);
    assert.equal(new Set(emitted.map(({ bindingId }) => bindingId)).size, 20);
    assert.equal(new Set(emitted.map(({ recipe }) => recipe.exactVectorSha256)).size, 20);
    assert.equal(emitted.length, 20);
    assert.deepEqual(report.universalFallback, { preserved: true, catalog: "packages/bindings/generated/defold-dmsdk-universal-bindings.json", mutation: "none" });
    for (const artifact of [...report.artifacts, "packages/bindings/generated/defold-dmsdk-named-scalar-bindings.json"])
      assert.equal(await readFile(join(output, artifact), "utf8"), await readFile(join(repositoryRoot, artifact), "utf8"), artifact);
  } finally { await rm(output, { recursive: true, force: true }); }
});

test("named-scalar reports the actual normalized symbol-evidence input path and hash", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deherm-dmsdk-named-scalar-symbol-path-"));
  try {
    const source = await readFile(join(repositoryRoot,
      "packages/bindings/generated/defold-dmsdk-symbol-evidence.json"), "utf8");
    const alternate = join(directory, "alternate-symbol-evidence.json");
    const output = join(directory, "out");
    await writeFile(alternate, source);
    run(process.execPath, [
      "scripts/generate-dmsdk-named-scalar-bindings.mjs",
      "--symbol-evidence", alternate,
      "--out-root", output,
    ]);
    const report = JSON.parse(await readFile(join(output,
      "packages/bindings/generated/defold-dmsdk-named-scalar-bindings.json"), "utf8"));
    assert.equal(report.sourceHashes.symbolEvidence, sha256(source));
    for (const declaration of report.declarations) {
      assert.equal(declaration.symbolEvidence.path, alternate);
      assert.equal(declaration.symbolEvidence.sha256, sha256(source));
      if (declaration.emitted) assert.equal(declaration.stages.linked.evidence, alternate);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("named-scalar generation rejects drifted IR and ABI-shape provenance", async (context) => {
  await context.test("revision mismatch", () => expectProvenanceFailure("revision mismatch", async ({ irContent, shapesContent }) => {
    const ir = JSON.parse(irContent);
    ir.defoldRevision = "different-revision";
    irContent = `${JSON.stringify(ir, null, 2)}\n`;
    const shapes = JSON.parse(shapesContent);
    shapes.sourceHashes.ir = sha256(irContent);
    return { irContent, shapesContent: `${JSON.stringify(shapes, null, 2)}\n` };
  }, /Defold revisions differ/));
  await context.test("exact IR hash mismatch", () => expectProvenanceFailure("IR hash mismatch", async ({ irContent, shapesContent }) => ({ irContent: `${irContent}\n`, shapesContent }), /IR hash does not match/));
  await context.test("duplicate IR declaration ID", () => expectProvenanceFailure("duplicate IR ID", async ({ irContent, shapesContent }) => {
    const ir = JSON.parse(irContent);
    ir.declarations.push({ ...ir.declarations[0] });
    irContent = `${JSON.stringify(ir, null, 2)}\n`;
    const shapes = JSON.parse(shapesContent);
    shapes.sourceHashes.ir = sha256(irContent);
    return { irContent, shapesContent: `${JSON.stringify(shapes, null, 2)}\n` };
  }, /IR contains duplicate declaration id/));
  await context.test("duplicate ABI-shape declaration ID", () => expectProvenanceFailure("duplicate shape ID", async ({ irContent, shapesContent }) => {
    const shapes = JSON.parse(shapesContent);
    shapes.rows.push({ ...shapes.rows[0] });
    return { irContent, shapesContent: `${JSON.stringify(shapes, null, 2)}\n` };
  }, /ABI-shape report contains duplicate declaration id/));
});

test("named-scalar source census changes do not require package policy count edits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deherm-dmsdk-named-scalar-census-"));
  try {
    const irPath = join(repositoryRoot, "packages/bindings/generated/defold-sdk-ir.json");
    const shapes = JSON.parse(await readFile(join(repositoryRoot,
      "packages/bindings/generated/defold-dmsdk-abi-shapes.json"), "utf8"));
    const index = shapes.rows.findIndex(({ tranche }) => tranche === "next-named-scalar-direct");
    assert.notEqual(index, -1);
    shapes.rows.splice(index, 1);
    shapes.trancheSummary["next-named-scalar-direct"] -= 1;
    const shapesPath = join(directory, "shapes.json");
    await writeFile(shapesPath, `${JSON.stringify(shapes, null, 2)}\n`);
    const { report } = await build({ irPath, shapesPath });
    assert.equal(report.coverage.reviewed, 20);
    assert.equal(report.coverage.generated + report.coverage.policyBlocked, 20);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("empty JSI and TypeScript artifacts make no module, install, or callable claim", async () => {
  const jsiHeader = await readFile(join(repositoryRoot, "defold/defold_hermes/include/defold_hermes/generated_dmsdk_named_scalar_jsi.hpp"), "utf8");
  const jsiSource = await readFile(join(repositoryRoot, "defold/defold_hermes/src/generated_dmsdk_named_scalar_jsi.cpp"), "utf8");
  const typescript = await readFile(join(repositoryRoot, "packages/sdk/src/generated/dmsdk/named-scalar.ts"), "utf8");
  for (const content of [jsiHeader, jsiSource, typescript]) {
    assert.doesNotMatch(content, /installDmSdkNamedScalarModule|DmSdkNamedScalar|\.call\(/);
  }
  assert.match(typescript, /export \{\};/);
});

test("a header declaration absent from every pinned Defold archive fails closed", async () => {
  const [report, runtime, symbolEvidence, profileHeader, nullProfile] = await Promise.all([
    readFile(reportPath, "utf8").then(JSON.parse),
    readFile(join(repositoryRoot, "defold/defold_hermes/src/generated_dmsdk_named_scalar_runtime.cpp"), "utf8"),
    readFile(join(repositoryRoot, "packages/bindings/generated/defold-dmsdk-symbol-evidence.json"), "utf8").then(JSON.parse),
    readFile(join(repositoryRoot, "upstream/defold/engine/dlib/src/dmsdk/dlib/profile.h"), "utf8"),
    readFile(join(repositoryRoot, "upstream/defold/engine/dlib/src/dlib/profile/profile_null.cpp"), "utf8")
  ]);
  const declaration = report.declarations.find(({ symbol }) => symbol === "ProfilePropertyAddBool");
  const evidence = symbolEvidence.declarations[declaration.id];
  assert.match(profileHeader, /void ProfilePropertyAdd##stype\(ProfileIdx idx, type v\);/u);
  assert.doesNotMatch(nullProfile, /void ProfilePropertyAddBool\(/u);
  assert.deepEqual({ linkage: evidence.linkage, availability: evidence.availability, linkedIn: evidence.linkedIn }, { linkage: "absent", availability: "unlinked", linkedIn: {} });
  assert.deepEqual(declaration.symbolEvidence, { path: "packages/bindings/generated/defold-dmsdk-symbol-evidence.json", sha256: sha256(await readFile(join(repositoryRoot, "packages/bindings/generated/defold-dmsdk-symbol-evidence.json"), "utf8")), linkage: "absent", availability: "unlinked", linkedIn: {} });
  assert.equal(declaration.emitted, false);
  assert.equal(declaration.blocker, "native-symbol-absent");
  assert.equal(declaration.issue, "https://github.com/ts-defold/deherm/issues/117");
  assert.doesNotMatch(runtime, /ProfilePropertyAddBool/u);
});

test("all 20 engine-linked production wrappers and exact-call twins run without warmed dispatch allocation", async () => {
  const output = await mkdtemp(join(tmpdir(), "deherm-dmsdk-named-scalar-runtime-"));
  try {
    const cObject = join(output, "header.o");
    const executable = join(output, "runtime-test");
    run(cCompiler, ["-std=c11", "-Wall", "-Wextra", "-Werror", "-pedantic", `-I${join(repositoryRoot, "defold/defold_hermes/include")}`, "-c", "native/dmsdk_named_scalar_c_header_test.c", "-o", cObject]);
    const sdk = join(repositoryRoot, "upstream/extender/server/app/sdk/7f0f554f41f9dce1e0ddff99bf08200657d1ee05/defoldsdk");
    run(compiler, ["-std=c++17", "-Wall", "-Wextra", "-Werror", "-pedantic", "-DDLIB_LOG_DOMAIN=\"deherm\"", `-I${join(repositoryRoot, "defold/defold_hermes/include")}`, "-isystem", join(sdk, "sdk/include"), "-isystem", join(sdk, "include"), "defold/defold_hermes/src/generated_dmsdk_named_scalar_runtime.cpp", "tests/fixtures/generated_dmsdk_named_scalar_exact_verification.cpp", "native/dmsdk_named_scalar_runtime_test.cpp", cObject, "-o", executable]);
    assert.equal(run(executable, []).trim(), "dmsdk-named-scalar-runtime:ok");
  } finally { await rm(output, { recursive: true, force: true }); }
});
