import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testDirectory, "..");
const reportPath = join(repositoryRoot, "packages/bindings/generated/defold-dmsdk-abi-shapes.json");

function run(args) {
  return execFileSync(process.execPath, args, { cwd: repositoryRoot, encoding: "utf8", stdio: "pipe" });
}

test("the dmSDK ABI-shape census is deterministic", async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "deherm-dmsdk-abi-shapes-"));
  try {
    const output = join(outputDirectory, "report.json");
    run(["scripts/generate-dmsdk-abi-shapes.mjs", "--output", output]);
    assert.equal(await readFile(output, "utf8"), await readFile(reportPath, "utf8"));
    run(["scripts/generate-dmsdk-abi-shapes.mjs", "--output", output, "--check"]);
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

test("all 1,361 runtime-pending declarations have one reproducible ABI shape and tranche", async () => {
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.deepEqual(report.coverage, {
    runtimePending: 1361,
    shaped: 1361,
    uniqueShapes: 880,
    tranches: 15,
    unshaped: 0,
  });
  assert.equal(new Set(report.rows.map(({ id }) => id)).size, 1361);
  assert.equal(Object.values(report.primaryFamilySummary).reduce((sum, count) => sum + count, 0), 1361);
  assert.equal(Object.values(report.trancheSummary).reduce((sum, count) => sum + count, 0), 1361);
  assert.equal(Object.values(report.shapeSummary).reduce((sum, count) => sum + count, 0), 1361);
  assert.equal(report.trancheSummary["implemented-scalar-frontier"], 31);
  assert.equal(report.trancheSummary["next-enum-value-direct"], 10);
  assert.deepEqual(report.policy.nextFamilies, ["next-enum-value-direct", "next-named-scalar-direct"]);
  assert.equal(report.policy.classificationOnly, true);
  for (const row of report.rows) {
    assert.ok(row.shape);
    assert.ok(row.tranche);
    assert.ok(row.blockers.length > 0);
    assert.ok(row.blockers.includes("native-symbol-linkage-unverified"));
  }
});

test("the next enum-value family is derived from resolved SDK types rather than symbol allowlists", async () => {
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const rows = report.rows.filter(({ tranche }) => tranche === "next-enum-value-direct");
  assert.equal(rows.length, 10);
  const buffer = rows.find(({ symbol }) => symbol === "dmBuffer::GetSizeForValueType");
  assert.equal(buffer.shape, "scalar:u32(value:enum:dmBuffer::ValueType)");
  assert.ok(buffer.blockers.includes("enum-width-domain-validation-policy"));
  assert.ok(rows.some(({ symbol }) => symbol === "dmGraphics::InstallAdapter"));
  assert.ok(rows.some(({ symbol }) => symbol === "dmLogSetLevel"));
  assert.ok(rows.every(({ parameters, result }) => [result, ...parameters].every(({ role }) =>
    role === "void" || role.startsWith("scalar:") || role.startsWith("enum:"))));
});

test("every source fingerprint is pinned and complete", async () => {
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.match(report.sourceHashes.ir, /^[a-f0-9]{64}$/);
  assert.match(report.sourceHashes.classification, /^[a-f0-9]{64}$/);
  const headers = new Set(report.rows.map(({ header }) => header));
  assert.equal(Object.keys(report.sourceHashes.headers).length, headers.size);
  for (const [header, digest] of Object.entries(report.sourceHashes.headers)) {
    assert.ok(headers.has(header));
    assert.match(digest, /^[a-f0-9]{64}$/);
  }
});
