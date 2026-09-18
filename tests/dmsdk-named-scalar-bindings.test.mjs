import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reportPath = join(repositoryRoot, "bindings/generated/defold-dmsdk-named-scalar-bindings.json");
const compiler = process.env.CXX || "clang++";
const cCompiler = process.env.CC || "clang";
function run(command, args) { return execFileSync(command, args, { cwd: repositoryRoot, encoding: "utf8", stdio: "pipe" }); }
function sha256(content) { return createHash("sha256").update(content).digest("hex"); }

async function expectProvenanceFailure(label, mutate, expected) {
  const directory = await mkdtemp(join(tmpdir(), "deherm-dmsdk-named-scalar-provenance-"));
  try {
    let irContent = await readFile(join(repositoryRoot, "bindings/generated/defold-sdk-ir.json"), "utf8");
    let shapesContent = await readFile(join(repositoryRoot, "bindings/generated/defold-dmsdk-abi-shapes.json"), "utf8");
    ({ irContent, shapesContent } = await mutate({ irContent, shapesContent }));
    const irPath = join(directory, "ir.json");
    const shapesPath = join(directory, "shapes.json");
    await writeFile(irPath, irContent);
    await writeFile(shapesPath, shapesContent);
    assert.throws(() => run(process.execPath, ["scripts/generate-dmsdk-named-scalar-bindings.mjs", "--ir", irPath, "--shapes", shapesPath, "--out-root", join(directory, "out")]), expected, label);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test("named-scalar policy artifacts are deterministic and completely census-derived", async () => {
  const output = await mkdtemp(join(tmpdir(), "deherm-dmsdk-named-scalar-"));
  try {
    run(process.execPath, ["scripts/generate-dmsdk-named-scalar-bindings.mjs", "--out-root", output]);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    assert.deepEqual(report.coverage, { reviewed: 21, generated: 0, policyBlocked: 21, signatureCompileCovered: 21, linked: 0, behaviorCovered: 0, warmedDispatchIterations: 100000, warmedDispatchObservedCppAllocations: 0 });
    assert.equal(new Set(report.declarations.map(({ id }) => id)).size, 21);
    assert.equal(new Set(report.declarations.map(({ policy }) => policy.id)).size, 3);
    for (const artifact of [...report.artifacts, "bindings/generated/defold-dmsdk-named-scalar-bindings.json"])
      assert.equal(await readFile(join(output, artifact), "utf8"), await readFile(join(repositoryRoot, artifact), "utf8"), artifact);
  } finally { await rm(output, { recursive: true, force: true }); }
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
  await context.test("named-scalar census drift", () => expectProvenanceFailure("census drift", async ({ irContent, shapesContent }) => {
    const shapes = JSON.parse(shapesContent);
    const index = shapes.rows.findIndex(({ tranche }) => tranche === "next-named-scalar-direct");
    shapes.rows.splice(index, 1);
    shapes.trancheSummary["next-named-scalar-direct"] = 20;
    return { irContent, shapesContent: `${JSON.stringify(shapes, null, 2)}\n` };
  }, /must declare exactly 21/));
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

test("all named-scalar signatures compile, while links and behavior stay explicitly unclaimed", async () => {
  const output = await mkdtemp(join(tmpdir(), "deherm-dmsdk-named-scalar-audit-"));
  try {
    const sdkInclude = join(repositoryRoot, "upstream/extender/server/app/sdk/7f0f554f41f9dce1e0ddff99bf08200657d1ee05/defoldsdk/sdk/include");
    run(compiler, ["-std=c++17", "-Wall", "-Wextra", "-Werror", "-pedantic", "-DDLIB_LOG_DOMAIN=\"deherm\"", "-isystem", sdkInclude, "-isystem", join(repositoryRoot, "upstream/defold/engine/dlib/src"), "-isystem", join(repositoryRoot, "upstream/defold/engine/gameobject/src"), "-isystem", join(repositoryRoot, "upstream/defold/engine/sound/src"), "-c", "native/dmsdk_named_scalar_blocker_audit.cpp", "-o", join(output, "audit.o")]);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    for (const entry of report.declarations) {
      assert.equal(entry.stages.compiled.status, "signature-compiled-not-linked");
      assert.equal(entry.stages.linked.status, "not-claimed-policy-blocked");
      assert.equal(entry.stages.conformant.status, "not-claimed-policy-blocked");
    }
  } finally { await rm(output, { recursive: true, force: true }); }
});

test("empty-default C ABI links and its bounded rejection path allocates nothing", async () => {
  const output = await mkdtemp(join(tmpdir(), "deherm-dmsdk-named-scalar-runtime-"));
  try {
    const cObject = join(output, "header.o");
    const executable = join(output, "runtime-test");
    run(cCompiler, ["-std=c11", "-Wall", "-Wextra", "-Werror", "-pedantic", `-I${join(repositoryRoot, "defold/defold_hermes/include")}`, "-c", "native/dmsdk_named_scalar_c_header_test.c", "-o", cObject]);
    run(compiler, ["-std=c++17", "-Wall", "-Wextra", "-Werror", "-pedantic", `-I${join(repositoryRoot, "defold/defold_hermes/include")}`, "defold/defold_hermes/src/generated_dmsdk_named_scalar_runtime.cpp", "native/dmsdk_named_scalar_runtime_test.cpp", cObject, "-o", executable]);
    assert.equal(run(executable, []).trim(), "dmsdk-named-scalar-runtime:ok");
  } finally { await rm(output, { recursive: true, force: true }); }
});
