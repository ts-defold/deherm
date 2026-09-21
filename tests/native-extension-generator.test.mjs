import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ingestNativeExtensionHeader, renderNativeExtensionBindings } from "../packages/compiler/src/native-extension-generator.mjs";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const fixture = path.join(root, "tests/fixtures/native-extension/sample_extension.h");

test("arbitrary extension headers deterministically produce ABI IR, TypeScript, C glue, and explicit blockers", async () => {
  const first = ingestNativeExtensionHeader({ header: fixture, moduleName: "sample" });
  const second = ingestNativeExtensionHeader({ header: fixture, moduleName: "sample" });
  assert.deepEqual(first, second);
  assert.deepEqual(first.routes.map(({ symbol, disposition }) => [symbol, disposition]), [
    ["sample_accumulate", "generated-c-abi"], ["sample_apply", "generated-c-abi"],
    ["sample_label", "generated-c-abi"], ["sample_translate", "cataloged-needs-layout"],
    ["sample_variadic", "cataloged-needs-layout"],
  ]);
  assert.equal(first.routes.filter(({ symbol }) => symbol === "sample_label").length, 1, "repeated compatible declarations deduplicate");
  assert.deepEqual(first.routes.find(({ symbol }) => symbol === "sample_variadic").blockers, ["variadic:requires-typed-nonvariadic-facade"]);
  assert.equal(new Set(first.routes.map(({ numericId }) => numericId)).size, first.routes.length);
  assert.ok(first.routes.every(({ id, numericId, stableId, signatureSha256 }) =>
    id === numericId && Number.isSafeInteger(numericId) && numericId >= 0 &&
    stableId.endsWith(`:${signatureSha256}`) && /^native-extension:sample:[A-Za-z_][A-Za-z0-9_]*:[0-9a-f]{64}$/.test(stableId) &&
    /^[0-9a-f]{64}$/.test(signatureSha256)));
  assert.deepEqual(first.enums[0].values, [{ name: "SAMPLE_MODE_ADD", value: 0 }, { name: "SAMPLE_MODE_MULTIPLY", value: 1 }]);
  const generated = renderNativeExtensionBindings(first);
  assert.equal(generated.generatedRouteCount, 3);
  assert.equal(generated.blockedRouteCount, 2);
  assert.equal(generated.verification.vectorCount, generated.generatedRouteCount);
  assert.deepEqual(
    generated.verification.vectors.map(({ stableId, numericId, symbol }) => ({ stableId, numericId, symbol })),
    first.routes.filter(({ disposition }) => disposition === "generated-c-abi")
      .map(({ stableId, numericId, symbol }) => ({ stableId, numericId, symbol }))
  );
  assert.match(generated.verificationSource, /deherm_ext_sample_exact_dispatch/);
  assert.match(generated.verificationDriver, /native-extension exact-call driver/);
  assert.match(generated.verificationDriver, /return deherm_exact_fail\("dispatch"/);
  assert.doesNotMatch(generated.verificationDriver, /ownership-effects|deherm_exact_effects/);
  assert.doesNotMatch(generated.verificationDriver, /return (?:[1-9][0-9]{2,}|256);/);
  for (const digest of Object.values(generated.verification.artifacts)) assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(generated.verification.artifacts.productionSourceSha256, createHash("sha256").update(generated.source).digest("hex"));
  assert.equal(generated.verification.artifacts.verificationSourceSha256, createHash("sha256").update(generated.verificationSource).digest("hex"));
  assert.equal(generated.verification.artifacts.verificationDriverSha256, createHash("sha256").update(generated.verificationDriver).digest("hex"));
  assert.match(generated.typescript, /accumulate\(value:number,delta:number\):number/);
  assert.match(generated.typescript, /blocked: parameter-0:record:SamplePoint/);
  assert.match(generated.source, /deherm_ext_sample_dispatch/);
  assert.ok(generated.verification.vectors.every(({
    compileTimeResolution,
    declaredOwnership,
    declaredOwnershipEffectMask,
  }) =>
    compileTimeResolution.callingConvention === "extern-c" && compileTimeResolution.signatureSha256 &&
    compileTimeResolution.callExpression && Array.isArray(compileTimeResolution.parameterCppTypes) &&
    declaredOwnership.result && Number.isSafeInteger(declaredOwnershipEffectMask)));
  assert.equal(
    generated.verification.vectors.find(({ symbol }) => symbol === "sample_label").declaredOwnership.result.effect,
    "returned-identity-unowned",
  );

  const output = await mkdtemp(path.join(tmpdir(), "deherm-native-extension-"));
  try {
    const shiftedHeader = path.join(output, "sample_extension.h");
    await writeFile(shiftedHeader, `\n\n${await readFile(fixture, "utf8")}`);
    const shifted = ingestNativeExtensionHeader({ header: shiftedHeader, moduleName: "sample" });
    assert.deepEqual(
      shifted.routes.map(({ symbol, numericId, stableId, signatureSha256 }) => ({ symbol, numericId, stableId, signatureSha256 })),
      first.routes.map(({ symbol, numericId, stableId, signatureSha256 }) => ({ symbol, numericId, stableId, signatureSha256 })),
      "content-derived identities must not change when declaration line numbers move"
    );

    const glue = path.join(output, "glue.cpp"), implementation = path.join(output, "implementation.cpp"), harness = path.join(output, "harness.cpp"), executable = path.join(output, "test");
    const exactGlue = path.join(output, "glue.verify.cpp"), exactDriver = path.join(output, "glue.verify.driver.cpp"), exactExecutable = path.join(output, "test-exact");
    await writeFile(glue, generated.source);
    await writeFile(implementation, `#include <sample_extension.h>\nextern "C" uint32_t sample_accumulate(uint32_t value,int32_t delta){return value+delta;}\nextern "C" double sample_apply(double value,SampleMode mode){return mode==SAMPLE_MODE_MULTIPLY?value*2:value+2;}\nextern "C" const char* sample_label(SampleMode mode){return mode==SAMPLE_MODE_ADD?"add":"multiply";}\nextern "C" SamplePoint sample_translate(SamplePoint point,float x,float y){return {point.x+x,point.y+y};}\n`);
    const ids = Object.fromEntries(first.routes.map(({ symbol, numericId }) => [symbol, numericId]));
    await writeFile(harness, `#include <defold_hermes/generated_dmsdk_universal.h>\n#include <stdint.h>\n#include <string.h>\nextern "C" DehermDmSdkUniversalStatus deherm_ext_sample_dispatch(uint32_t,const DehermDmSdkUniversalValue*,uint32_t,DehermDmSdkUniversalValue*);\nint main(){DehermDmSdkUniversalValue a[2]={{7,0,DEHERM_DMSDK_UNIVERSAL_U64,0},{static_cast<uint64_t>(static_cast<int64_t>(-2)),0,DEHERM_DMSDK_UNIVERSAL_I64,0}},r={};if(deherm_ext_sample_dispatch(UINT32_C(${ids.sample_accumulate}),a,2,&r)!=DEHERM_DMSDK_UNIVERSAL_OK||r.payload!=5)return 1;double d=3.5;memcpy(&a[0].payload,&d,8);a[0].tag=DEHERM_DMSDK_UNIVERSAL_F64;a[1]={1,0,DEHERM_DMSDK_UNIVERSAL_I64,0};if(deherm_ext_sample_dispatch(UINT32_C(${ids.sample_apply}),a,2,&r)!=DEHERM_DMSDK_UNIVERSAL_OK)return 2;memcpy(&d,&r.payload,8);if(d!=7)return 3;if(deherm_ext_sample_dispatch(UINT32_C(${ids.sample_translate}),a,2,&r)!=DEHERM_DMSDK_UNIVERSAL_UNKNOWN_ID)return 4;return 0;}\n`);
    await writeFile(exactGlue, generated.verificationSource);
    await writeFile(exactDriver, generated.verificationDriver);
    execFileSync(process.env.CXX ?? "clang++", ["-std=c++17", "-Wall", "-Wextra", "-Werror", "-pedantic", `-I${path.join(root, "defold/defold_hermes/include")}`, `-I${path.dirname(fixture)}`, glue, implementation, harness, "-o", executable], { cwd: root, stdio: "pipe" });
    execFileSync(executable, [], { stdio: "pipe" });
    execFileSync(process.env.CXX ?? "clang++", ["-std=c++17", "-Wall", "-Wextra", "-Werror", "-pedantic", `-I${path.join(root, "defold/defold_hermes/include")}`, `-I${path.dirname(fixture)}`, exactGlue, exactDriver, "-o", exactExecutable], { cwd: root, stdio: "pipe" });
    execFileSync(exactExecutable, [], { stdio: "pipe" });

    const baseRoute = first.routes.find(({ symbol }) => symbol === "sample_accumulate");
    const manyRoutes = Array.from({ length: 157 }, (_, index) => {
      const digest = createHash("sha256").update(`many-route-${index}`).digest("hex");
      return {
        ...structuredClone(baseRoute),
        id: index,
        numericId: index,
        stableId: `native-extension:sample:sample_many_${index}:${digest}`,
        signatureSha256: digest,
        symbol: `sample_many_${index}`,
        line: 1000 + index,
      };
    });
    const many = renderNativeExtensionBindings({ ...structuredClone(first), routes: manyRoutes });
    const lastFake = many.verification.vectors.at(-1).fakeCallee;
    const lastDefinition = `extern "C" uint32_t ${lastFake}(uint32_t arg0,int32_t arg1){`;
    const failingDriver = many.verificationDriver.replace(lastDefinition, `${lastDefinition}deherm_exact_failure=157;`);
    assert.notEqual(failingDriver, many.verificationDriver, "the large-suite regression must inject a failure in vector 156");
    const manyGlue = path.join(output, "many.verify.cpp");
    const manyDriver = path.join(output, "many.verify.driver.cpp");
    const manyExecutable = path.join(output, "many-exact");
    await writeFile(manyGlue, many.verificationSource);
    await writeFile(manyDriver, failingDriver);
    execFileSync(process.env.CXX ?? "clang++", ["-std=c++17", "-w", `-I${path.join(root, "defold/defold_hermes/include")}`, `-I${path.dirname(fixture)}`, manyGlue, manyDriver, "-o", manyExecutable], { cwd: root, stdio: "pipe" });
    const failed = spawnSync(manyExecutable, [], { encoding: "utf8" });
    assert.equal(failed.status, 1, `a failure in vector 156 must remain a nonzero process status\n${failed.stderr}`);
    assert.match(failed.stderr, /stage=arguments vector=156/);
  } finally { await rm(output, { recursive: true, force: true }); }
});

test("automatic header ingestion keeps exact C names and excludes transitive declarations", async (t) => {
  const output = await mkdtemp(path.join(tmpdir(), "deherm-native-extension-unfiltered-"));
  t.after(() => rm(output, { recursive: true, force: true }));
  await writeFile(path.join(output, "shared.inc"), "double SharedHelper(double value);\n");
  const header = path.join(output, "xmath.h");
  await writeFile(header, "#include <shared.inc>\ndouble XMathDot(double left, double right);\n");

  const ir = ingestNativeExtensionHeader({
    header,
    moduleName: "xmath",
    symbolPrefix: null,
    include: [output]
  });
  assert.equal(ir.symbolPrefix, null);
  assert.deepEqual(ir.routes.map(({ symbol, memberName }) => [symbol, memberName]), [["XMathDot", "XMathDot"]]);
  const generated = renderNativeExtensionBindings(ir);
  assert.match(generated.typescript, /XMathDot\(left:number,right:number\):number/);
  assert.doesNotMatch(generated.typescript, /SharedHelper/);
  assert.match(generated.source, /XMathDot\(/);
});

test("CLI exposes header-to-IR generation and reports layout blockers", async () => {
  const output = await mkdtemp(path.join(tmpdir(), "deherm-native-extension-cli-"));
  try {
    const result = spawnSync(process.execPath, ["bin/deherm.mjs", "generate-extension-api", "--header", fixture, "--module", "sample", "--output", output, "--json"], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 2, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.deepEqual({ generated: report.generatedRouteCount, blocked: report.blockedRouteCount }, { generated: 3, blocked: 2 });
    assert.match(report.verificationManifestSha256, /^[0-9a-f]{64}$/);
    assert.equal(JSON.parse(await readFile(path.join(output, "extension.ir.json"), "utf8")).routes.length, 5);
    assert.match(await readFile(path.join(output, "sample_glue.cpp"), "utf8"), /deherm_ext_sample_dispatch/);
    assert.match(await readFile(path.join(output, "sample_glue.verify.cpp"), "utf8"), /deherm_ext_sample_exact_dispatch/);
    assert.match(await readFile(path.join(output, "sample_glue.verify.driver.cpp"), "utf8"), /int main\(\)/);
    assert.equal(
      JSON.parse(await readFile(path.join(output, "sample_glue.verify.json"), "utf8")).manifestSha256,
      report.verificationManifestSha256,
    );
  } finally { await rm(output, { recursive: true, force: true }); }
});
