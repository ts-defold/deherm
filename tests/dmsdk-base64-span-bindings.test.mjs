import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { extractBase64SpanSemantics } from "../scripts/generate-dmsdk-base64-span-bindings.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reportPath = join(repositoryRoot, "packages/bindings/generated/defold-dmsdk-base64-span-bindings.json");
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

test("base64-span generator is deterministic, census-derived, and policy complete", async () => {
  const output = await mkdtemp(join(tmpdir(), "deherm-dmsdk-base64-span-"));
  try {
    run(process.execPath, ["scripts/generate-dmsdk-base64-span-bindings.mjs", "--out-root", output]);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    assert.deepEqual(report.coverage, {
      baselineRuntimePending: 1361,
      discovered: 2,
      structurallyEligible: 2,
      emitted: 2,
      policyBlocked: 0,
      hostBehaviorVerified: 2,
      remainingWithoutGeneratedAdapters: 1322,
    });
    assert.equal(report.fallbackAudit.count, 0);
    assert.deepEqual(
      report.declarations.map(({ mode, patternDecision }) => ({ mode, patternDecision })),
      [
        { mode: "decode", patternDecision: "span.bounded-byte-transform" },
        { mode: "encode", patternDecision: "span.bounded-byte-transform" },
      ],
    );
    for (const artifact of [...report.artifacts, "packages/bindings/generated/defold-dmsdk-base64-span-bindings.json"])
      assert.equal(
        await readFile(join(output, artifact), "utf8"),
        await readFile(join(repositoryRoot, artifact), "utf8"),
        artifact,
      );
    run(process.execPath, ["scripts/generate-dmsdk-base64-span-bindings.mjs", "--out-root", output, "--check"]);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test("base64-span generator rejects mixed provenance", async () => {
  const output = await mkdtemp(join(tmpdir(), "deherm-dmsdk-base64-span-drift-"));
  try {
    const irPath = join(output, "ir.json");
    await writeFile(
      irPath,
      `${await readFile(join(repositoryRoot, "packages/bindings/generated/defold-sdk-ir.json"), "utf8")}\n`,
    );
    assert.throws(
      () =>
        run(process.execPath, [
          "scripts/generate-dmsdk-base64-span-bindings.mjs",
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

test("base64-span semantics come from ABI plus codec identifier grammar, not documentation prose", async () => {
  const [ir, shapes] = await Promise.all([
    readFile(join(repositoryRoot, "packages/bindings/generated/defold-sdk-ir.json"), "utf8").then(JSON.parse),
    readFile(join(repositoryRoot, "packages/bindings/generated/defold-dmsdk-abi-shapes.json"), "utf8").then(JSON.parse),
  ]);
  const policyText = await readFile(
    join(repositoryRoot, "packages/bindings/overrides/dmsdk-base64-span-bindings.json"),
    "utf8",
  );
  const policy = JSON.parse(policyText);
  assert.doesNotMatch(
    policyText,
    /documentationContract|description|symbolPrefix|candidateSelector|crypt\.h|"entries"/u,
  );
  const declarations = ir.declarations.filter(({ name }) => /Base64(?:Encode|Decode)$/u.test(name));
  assert.equal(declarations.length, 2);
  for (const declaration of declarations) {
    const candidate = shapes.rows.find(({ id }) => id === declaration.id);
    const semantics = extractBase64SpanSemantics(declaration, candidate, policy.recipe);
    assert.ok(semantics, declaration.id);
    assert.equal(semantics.mode, declaration.name.endsWith("Encode") ? "encode" : "decode");
    assert.ok(
      extractBase64SpanSemantics(
        {
          ...declaration,
          description: "",
          returnDescription: "",
          parameters: declaration.parameters.map((parameter) => ({ ...parameter, description: "" })),
        },
        candidate,
        policy.recipe,
      ),
    );
    assert.equal(
      extractBase64SpanSemantics({ ...declaration, name: "dmCrypt::Transform" }, candidate, policy.recipe),
      null,
    );
  }
});

test("base64 C ABI links, rejects unsafe input, and observes zero warmed C++ operator new calls", async (context) => {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    context.skip(
      `pinned packaged-library runtime harness requires arm64-macos, got ${process.arch}-${process.platform}`,
    );
    return;
  }
  const output = await mkdtemp(join(tmpdir(), "deherm-dmsdk-base64-span-host-"));
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
      "native/dmsdk_base64_span_c_header_test.c",
      "-o",
      cObject,
    ]);
    const libraries = [
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
      "defold/defold_hermes/src/generated_dmsdk_base64_span_crypt.cpp",
      cObject,
      ...libraries,
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
      "defold/defold_hermes/src/generated_dmsdk_base64_span_crypt.cpp",
      "defold/defold_hermes/src/generated_dmsdk_base64_span_runtime.cpp",
      "native/dmsdk_base64_span_host_test.cpp",
      ...libraries,
      "-o",
      executable,
    ]);
    run(executable, []);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test("base64 generated C++ has no heap ownership primitive", async () => {
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  for (const artifact of report.artifacts.filter((path) => path.endsWith(".cpp")))
    assert.doesNotMatch(
      await readFile(join(repositoryRoot, artifact), "utf8"),
      /\b(?:new|delete|malloc|calloc|realloc|free)\b/,
      artifact,
    );
});
