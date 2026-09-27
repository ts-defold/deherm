import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { extractFixedDigestSemantics } from "../scripts/generate-dmsdk-fixed-digest-bindings.mjs";
import {
  analyzeFixedDigestRecipe,
  createDmSdkFallbackAudit,
} from "../packages/compiler/src/dmsdk-bounded-span-recipes.mjs";
import { buildDmSdkBoundedSpanPlan } from "../packages/compiler/src/dmsdk-bounded-span-plan.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reportPath = join(repositoryRoot, "packages/bindings/generated/defold-dmsdk-fixed-digest-bindings.json");
const sdkRoot = join(
  repositoryRoot,
  "upstream/extender/server/app/sdk/7f0f554f41f9dce1e0ddff99bf08200657d1ee05/defoldsdk",
);
const compiler = process.env.CXX || "clang++";
const cCompiler = process.env.CC || "clang";
function run(command, args) {
  return execFileSync(command, args, { cwd: repositoryRoot, encoding: "utf8", stdio: "pipe" });
}
function includeArgs() {
  return [
    `-I${join(repositoryRoot, "defold/defold_hermes/include")}`,
    "-isystem",
    join(sdkRoot, "sdk/include"),
    "-isystem",
    join(sdkRoot, "include"),
  ];
}

test("fixed-digest generator is deterministic and provenance-bound to the IR census", async () => {
  const output = await mkdtemp(join(tmpdir(), "deherm-dmsdk-fixed-digest-"));
  try {
    run(process.execPath, ["scripts/generate-dmsdk-fixed-digest-bindings.mjs", "--out-root", output]);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    assert.deepEqual(report.coverage, {
      baselineRuntimePending: 1361,
      structurallyEligible: 4,
      discovered: 4,
      emitted: 4,
      policyBlocked: 0,
      hostBehaviorVerified: 4,
      remainingWithoutGeneratedAdapters: 1324,
    });
    assert.deepEqual(report.fallbackAudit, {
      retainedImplementation: "@deherm/compiler/dmsdk-universal-materializer",
      count: 0,
      entries: [],
    });
    for (const artifact of [...report.artifacts, "packages/bindings/generated/defold-dmsdk-fixed-digest-bindings.json"])
      assert.equal(
        await readFile(join(output, artifact), "utf8"),
        await readFile(join(repositoryRoot, artifact), "utf8"),
        artifact,
      );
    run(process.execPath, ["scripts/generate-dmsdk-fixed-digest-bindings.mjs", "--out-root", output, "--check"]);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test("fixed-digest generation fails closed when ABI-shape provenance no longer names the supplied IR", async () => {
  const output = await mkdtemp(join(tmpdir(), "deherm-dmsdk-fixed-digest-provenance-"));
  try {
    const irPath = join(output, "ir.json");
    await writeFile(
      irPath,
      `${await readFile(join(repositoryRoot, "packages/bindings/generated/defold-sdk-ir.json"), "utf8")}\n`,
    );
    assert.throws(
      () =>
        run(process.execPath, [
          "scripts/generate-dmsdk-fixed-digest-bindings.mjs",
          "--ir",
          irPath,
          "--out-root",
          join(output, "out"),
        ]),
      /IR hash does not match ABI-shape census provenance/,
    );
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test("a fixed-digest shape without recoverable implementation extent retains the universal path", async () => {
  const output = await mkdtemp(join(tmpdir(), "deherm-dmsdk-fixed-digest-fallback-"));
  try {
    const ir = JSON.parse(
      await readFile(join(repositoryRoot, "packages/bindings/generated/defold-sdk-ir.json"), "utf8"),
    );
    const shapes = JSON.parse(
      await readFile(join(repositoryRoot, "packages/bindings/generated/defold-dmsdk-abi-shapes.json"), "utf8"),
    );
    const sourceFacts = JSON.parse(
      await readFile(join(repositoryRoot, "packages/bindings/generated/defold-dmsdk-source-semantic-facts.json"), "utf8"),
    );
    const declaration = ir.declarations.find(({ name }) => name === "dmCrypt::HashSha256");
    const implementation = sourceFacts.declarations.find(({ declarationId }) => declarationId === declaration.id);
    implementation.definitions = [];
    implementation.state = "implementation-not-found";
    const irText = `${JSON.stringify(ir, null, 2)}\n`;
    shapes.sourceHashes.ir = createHash("sha256").update(irText).digest("hex");
    const shapesText = `${JSON.stringify(shapes, null, 2)}\n`;
    sourceFacts.sourceHashes.ir = createHash("sha256").update(irText).digest("hex");
    sourceFacts.sourceHashes.shapes = createHash("sha256").update(shapesText).digest("hex");
    const irPath = join(output, "ir.json");
    const shapesPath = join(output, "shapes.json");
    const sourceFactsPath = join(output, "source-facts.json");
    const planPath = join(output, "bounded-span-plan.json");
    const policyTexts = Object.fromEntries(await Promise.all([
      ["fixedDigest", "dmsdk-fixed-digest-bindings.json"],
      ["base64", "dmsdk-base64-span-bindings.json"],
      ["astc", "dmsdk-astc-probe-bindings.json"],
      ["xtea", "dmsdk-xtea-span-bindings.json"],
      ["hashSpan", "dmsdk-hash-span-bindings.json"],
    ].map(async ([key, name]) => [key, await readFile(join(repositoryRoot, "packages/bindings/overrides", name), "utf8")])));
    const sourceFactsText = `${JSON.stringify(sourceFacts, null, 2)}\n`;
    await writeFile(irPath, irText);
    await writeFile(shapesPath, shapesText);
    await writeFile(sourceFactsPath, sourceFactsText);
    const plan = buildDmSdkBoundedSpanPlan({
      ir,
      shapes,
      sourceFacts,
      policies: Object.fromEntries(Object.entries(policyTexts).map(([key, text]) => [key, JSON.parse(text)])),
      texts: { ir: irText, shapes: shapesText, sourceFacts: sourceFactsText, ...policyTexts },
    });
    await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`);

    run(process.execPath, [
      "scripts/generate-dmsdk-fixed-digest-bindings.mjs",
      "--ir",
      irPath,
      "--shapes",
      shapesPath,
      "--source-facts",
      sourceFactsPath,
      "--plan",
      planPath,
      "--out-root",
      join(output, "out"),
    ]);
    const report = JSON.parse(
      await readFile(join(output, "out/packages/bindings/generated/defold-dmsdk-fixed-digest-bindings.json"), "utf8"),
    );
    assert.equal(report.coverage.emitted, 3);
    assert.equal(report.coverage.policyBlocked, 1);
    assert.equal(report.fallbackAudit.count, 1);
    assert.equal(report.fallbackAudit.entries[0].state, "universal-fallback");
    assert.equal(
      report.fallbackAudit.entries[0].observedShape,
      shapes.rows.find(({ id }) => id === declaration.id).shape,
    );
    assert.deepEqual(report.fallbackAudit.entries[0].missingWiring, ["implementation-fixed-output-extent"]);
    assert.equal(report.fallbackAudit.entries[0].recommendation.preserveFallbackUntilSpecialized, true);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test("fixed-digest semantics come from implementation AST dataflow and survive declaration renaming", async () => {
  const [ir, shapes, sourceFacts, policyText] = await Promise.all([
    readFile(join(repositoryRoot, "packages/bindings/generated/defold-sdk-ir.json"), "utf8").then(JSON.parse),
    readFile(join(repositoryRoot, "packages/bindings/generated/defold-dmsdk-abi-shapes.json"), "utf8").then(JSON.parse),
    readFile(join(repositoryRoot, "packages/bindings/generated/defold-dmsdk-source-semantic-facts.json"), "utf8").then(JSON.parse),
    readFile(join(repositoryRoot, "packages/bindings/overrides/dmsdk-fixed-digest-bindings.json"), "utf8"),
  ]);
  const policy = JSON.parse(policyText);
  const declaration = ir.declarations.find(({ name }) => name === "dmCrypt::HashSha256");
  const candidate = shapes.rows.find(({ id }) => id === declaration.id);
  const implementation = sourceFacts.declarations.find(({ declarationId }) => declarationId === declaration.id);
  const semantics = extractFixedDigestSemantics(declaration, candidate, policy.recipe, implementation);
  assert.equal(semantics.digestBytes, 32);
  assert.equal(semantics.algorithm, "MBEDTLS_MD_SHA256");
  assert.deepEqual(semantics.semanticTokens, ["fixed-output-byte-count", "synchronous-noescape"]);
  assert.equal(semantics.evidence.semanticSource, "revision-implementation-ast+abi-shape");
  assert.equal(
    extractFixedDigestSemantics(
      {
        ...declaration,
        description: "",
        returnDescription: "",
        parameters: declaration.parameters.map((parameter) => ({ ...parameter, description: "" })),
      },
      candidate,
      policy.recipe,
      implementation,
    )?.digestBytes,
    32,
  );
  const renamed = analyzeFixedDigestRecipe(
    { ...declaration, name: "dmCrypt::HashFuture" },
    candidate,
    policy.recipe,
    implementation,
  );
  assert.equal(renamed.semantics.digestBytes, 32);
  const unknown = analyzeFixedDigestRecipe(declaration, candidate, policy.recipe, { definitions: [] });
  assert.equal(unknown.semantics, null);
  assert.deepEqual(unknown.missingFacts, ["implementation-fixed-output-extent"]);
  const audit = createDmSdkFallbackAudit({
    candidate,
    family: "fixed-digest",
    patternId: "span.fixed-output-digest",
    emitter: "scripts/generate-dmsdk-fixed-digest-bindings.mjs",
    missingFacts: unknown.missingFacts,
  });
  assert.equal(audit.retainedImplementation, "@deherm/compiler/dmsdk-universal-materializer");
  assert.equal(audit.observedShape, candidate.shape);
  assert.deepEqual(audit.recommendation.requiredFacts, ["implementation-fixed-output-extent"]);
  assert.doesNotMatch(policyText, /documentationContract|description|dmCrypt|crypt\.h|HashSha|HashMd5|"entries"/u);
});

test("fixed-digest C ABI compiles, links, hashes known input, rejects invalid bounds, and allocates nothing warmed", async (context) => {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    context.skip(
      `pinned packaged-library runtime harness requires arm64-macos, got ${process.arch}-${process.platform}`,
    );
    return;
  }
  const output = await mkdtemp(join(tmpdir(), "deherm-dmsdk-fixed-digest-host-"));
  try {
    const cObject = join(output, "header.o");
    run(cCompiler, [
      "-std=c11",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-pedantic",
      `-I${join(repositoryRoot, "defold/defold_hermes/include")}`,
      "-c",
      "native/dmsdk_fixed_digest_c_header_test.c",
      "-o",
      cObject,
    ]);
    const libraryArgs = [
      join(sdkRoot, "lib/arm64-macos/libdlib.a"),
      "-framework",
      "Security",
      "-framework",
      "CoreFoundation",
      "-framework",
      "Foundation",
    ];
    const cExecutable = join(output, "c-abi");
    run(compiler, [
      "-std=c++17",
      ...includeArgs(),
      "defold/defold_hermes/src/generated_dmsdk_fixed_digest_crypt.cpp",
      cObject,
      ...libraryArgs,
      "-o",
      cExecutable,
    ]);
    run(cExecutable, []);
    const executable = join(output, "host");
    run(compiler, [
      "-std=c++17",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-pedantic",
      ...includeArgs(),
      "defold/defold_hermes/src/generated_dmsdk_fixed_digest_crypt.cpp",
      "defold/defold_hermes/src/generated_dmsdk_fixed_digest_runtime.cpp",
      "native/dmsdk_fixed_digest_host_test.cpp",
      ...libraryArgs,
      "-o",
      executable,
    ]);
    run(executable, []);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test("fixed-digest generated C++ has no heap ownership primitive", async () => {
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  for (const artifact of report.artifacts.filter((path) => path.endsWith(".cpp")))
    assert.doesNotMatch(
      await readFile(join(repositoryRoot, artifact), "utf8"),
      /\b(?:new|delete|malloc|calloc|realloc|free)\b/,
      artifact,
    );
});
