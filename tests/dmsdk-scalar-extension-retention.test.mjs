import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const engine = `${root}defold/build/arm64-osx/dmengine`;
const log = `${root}defold/build/arm64-osx/log.txt`;
const artifactsExist = existsSync(engine) && existsSync(log);
if (process.env.DEHERM_REQUIRE_ENGINE_ARTIFACTS === "1" && !artifactsExist) {
  throw new Error("Required local Extender engine artifacts are missing; run npm run bob:local:bundle first");
}
const ledger = JSON.parse(
  readFileSync(`${root}bindings/generated/defold-dmsdk-scalar-thunks.json`, "utf8")
);

test(
  "local arm64 Extender artifact retains every emitted dmSDK scalar thunk",
  { skip: !artifactsExist },
  () => {
    const symbols = execFileSync("nm", ["-C", engine], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024
    });
    const buildLog = readFileSync(log, "utf8");
    const emitted = ledger.declarations.filter((declaration) => declaration.emitted);

    assert.equal(emitted.length, ledger.coverage.extensionFinalBinaryRetained);
    for (const declaration of emitted) {
      assert.match(symbols, new RegExp(`_${declaration.wrapper}(?:\\n|$)`));
    }

    assert.match(symbols, /_deherm_dmsdk_scalar_dispatch(?:\n|$)/);
    assert.match(symbols, /defold_hermes::installDmSdkScalarModule\(/);
    assert.match(buildLog, /-mmacosx-version-min=11\.5/);
    assert.match(buildLog, /generated_dmsdk_scalar_runtime\.cpp/);
    assert.match(buildLog, /generated_dmsdk_scalar_jsi\.cpp/);
    assert.doesNotMatch(buildLog, /No available targets are compatible/);
  }
);
