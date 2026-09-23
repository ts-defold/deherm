import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

test("generated constant routes execute through the Lua adapter", () => {
  execFileSync("cmake", ["--build", "build/native", "--target", "defold-hermes-script-constant-lua-adapter-test", "--parallel"], { stdio: "pipe" });
  const output = execFileSync("build/native/defold-hermes-script-constant-lua-adapter-test", [], { encoding: "utf8" });
  assert.match(output, /script-constant-lua-adapter:constants:exact-lookup-stack-arity-profile-json-null:ok/);
});
