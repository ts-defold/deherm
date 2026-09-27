import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { extractAstcProbeSemantics } from "../scripts/generate-dmsdk-astc-probe-bindings.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  reportPath = join(root, "packages/bindings/generated/defold-dmsdk-astc-probe-bindings.json"),
  sdk = join(root, "upstream/extender/server/app/sdk/7f0f554f41f9dce1e0ddff99bf08200657d1ee05/defoldsdk"),
  cxx = process.env.CXX || "clang++",
  cc = process.env.CC || "clang";
const run = (c, a) => execFileSync(c, a, { cwd: root, encoding: "utf8", stdio: "pipe" });
const includes = [
  `-I${join(root, "defold/defold_hermes/include")}`,
  "-isystem",
  join(sdk, "sdk/include"),
  "-isystem",
  join(sdk, "include"),
  "-isystem",
  join(root, "upstream/defold/engine/dlib/src"),
];
test("astc-probe generation is deterministic, census-complete, and evidence-bound", async () => {
  const out = await mkdtemp(join(tmpdir(), "deherm-astc-"));
  try {
    run(process.execPath, ["scripts/generate-dmsdk-astc-probe-bindings.mjs", "--out-root", out]);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    assert.deepEqual(report.coverage, {
      baselineRuntimePending: 1361,
      discovered: 2,
      structurallyEligible: 2,
      emitted: 2,
      policyBlocked: 0,
      hostBehaviorVerified: 2,
      remainingWithoutGeneratedAdapters: 1320,
    });
    assert.equal(report.fallbackAudit.count, 0);
    for (const f of [...report.artifacts, "packages/bindings/generated/defold-dmsdk-astc-probe-bindings.json"])
      assert.equal(await readFile(join(out, f), "utf8"), await readFile(join(root, f), "utf8"));
    assert.deepEqual(
      report.declarations.map(({ mode, patternDecision }) => ({ mode, patternDecision })),
      [
        { mode: "block-size", patternDecision: "span.fixed-three-u32-probe" },
        { mode: "dimensions", patternDecision: "span.fixed-three-u32-probe" },
      ],
    );
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});
test("astc-probe semantics come from implementation dataflow plus ABI, not names or documentation prose", async () => {
  const [ir, shapes, sourceFacts] = await Promise.all([
    readFile(join(root, "packages/bindings/generated/defold-sdk-ir.json"), "utf8").then(JSON.parse),
    readFile(join(root, "packages/bindings/generated/defold-dmsdk-abi-shapes.json"), "utf8").then(JSON.parse),
    readFile(join(root, "packages/bindings/generated/defold-dmsdk-source-semantic-facts.json"), "utf8").then(
      JSON.parse,
    ),
  ]);
  const policyText = await readFile(join(root, "packages/bindings/overrides/dmsdk-astc-probe-bindings.json"), "utf8");
  const policy = JSON.parse(policyText);
  assert.doesNotMatch(
    policyText,
    /documentationContract|description|symbolPrefix|candidateSelector|image\.h|"entries"/u,
  );
  const declarations = ir.declarations.filter(({ name }) => /GetAstc(?:BlockSize|Dimensions)$/u.test(name));
  const factsById = new Map(sourceFacts.declarations.map((entry) => [entry.declarationId, entry]));
  assert.equal(declarations.length, 2);
  for (const declaration of declarations) {
    const candidate = shapes.rows.find(({ id }) => id === declaration.id);
    const facts = factsById.get(declaration.id);
    assert.ok(extractAstcProbeSemantics(declaration, candidate, policy.recipe, facts), declaration.id);
    assert.ok(
      extractAstcProbeSemantics(
        {
          ...declaration,
          description: "",
          returnDescription: "",
          parameters: declaration.parameters.map((parameter) => ({ ...parameter, description: "" })),
        },
        candidate,
        policy.recipe,
        facts,
      ),
    );
    assert.ok(extractAstcProbeSemantics({ ...declaration, name: "dmImage::Probe" }, candidate, policy.recipe, facts));
    assert.equal(extractAstcProbeSemantics(declaration, candidate, policy.recipe, { definitions: [] }), null);
  }
});
test("astc C ABI and bounded runtime compile, link to pinned parser source, behave, and allocate nothing warmed", async () => {
  const out = await mkdtemp(join(tmpdir(), "deherm-astc-host-"));
  try {
    const cobj = join(out, "c.o");
    run(cc, [
      "-std=c11",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-pedantic",
      `-I${join(root, "defold/defold_hermes/include")}`,
      "-c",
      "native/dmsdk_astc_probe_c_header_test.c",
      "-o",
      cobj,
    ]);
    const common = [
      "-std=c++17",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-pedantic",
      '-DDLIB_LOG_DOMAIN="deherm"',
      "-ffunction-sections",
      ...includes,
      "defold/defold_hermes/src/generated_dmsdk_astc_probe_image.cpp",
      "upstream/defold/engine/dlib/src/dlib/image.cpp",
      "-Wl,-dead_strip",
    ];
    const cabi = join(out, "cabi");
    run(cxx, [...common, cobj, "-o", cabi]);
    run(cabi, []);
    const host = join(out, "host");
    run(cxx, [
      ...common,
      "defold/defold_hermes/src/generated_dmsdk_astc_probe_runtime.cpp",
      "native/dmsdk_astc_probe_host_test.cpp",
      "-o",
      host,
    ]);
    run(host, []);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});
test("astc generated C++ has no heap ownership primitive", async () => {
  const r = JSON.parse(await readFile(reportPath, "utf8"));
  for (const f of r.artifacts.filter((x) => x.endsWith(".cpp")))
    assert.doesNotMatch(await readFile(join(root, f), "utf8"), /\b(?:new|delete|malloc|calloc|realloc|free)\b/);
});
