import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  bundleArguments,
  parseBundleOutput,
  resolveInstalledCli,
  resolveProject,
  validatedBuildServer,
} from "../github-action/run.mjs";

const actionScript = fileURLToPath(new URL("../github-action/run.mjs", import.meta.url));

test("Action mode validation keeps Defold default server implicit", () => {
  assert.equal(validatedBuildServer("defold", ""), null);
  assert.throws(() => validatedBuildServer("defold", "https://build.defold.com"), /must be empty/);
  assert.throws(() => validatedBuildServer("unexpected", ""), /mode must be/);
  assert.throws(() => validatedBuildServer("local", ""), /required/);
  assert.equal(validatedBuildServer("local", "http://127.0.0.1:9010"), "http://127.0.0.1:9010");
  assert.equal(validatedBuildServer("local", "http://[::1]:9000"), "http://[::1]:9000");
  assert.throws(() => validatedBuildServer("local", "https://extender.example.org"), /loopback/);
  assert.equal(validatedBuildServer("external", "https://extender.example.org"), "https://extender.example.org");
  assert.throws(() => validatedBuildServer("external", "http://extender.example.org"), /allow-insecure-http/);
  assert.equal(validatedBuildServer("external", "http://extender.example.org", true), "http://extender.example.org");
});

test("Action rejects credentials and URL components that could leak source or secrets", () => {
  for (const url of [
    "ftp://extender.example.org",
    "https://user:password@extender.example.org",
    "https://extender.example.org/private",
    "https://extender.example.org/?token=secret",
    "https://extender.example.org/#fragment",
  ]) {
    assert.throws(() => validatedBuildServer("external", url), /origin/);
  }
});

test("Action translates one build target without a shell or hidden server override", () => {
  const base = {
    project: "/checkout/game",
    target: "x86_64-linux",
    variant: "release",
    applicationMode: "static",
    entry: "src/main.script.ts",
    mode: "defold",
    buildServer: "",
    allowInsecureHttp: false,
  };
  assert.deepEqual(bundleArguments(base), [
    "bundle",
    "--project",
    "/checkout/game",
    "--target",
    "x86_64-linux",
    "--variant",
    "release",
    "--application-mode",
    "static",
    "--json",
    "--entry",
    "src/main.script.ts",
  ]);
  assert.deepEqual(bundleArguments({ ...base, mode: "local", buildServer: "http://localhost:9010" }).slice(-2), [
    "--build-server",
    "http://localhost:9010",
  ]);
  assert.throws(() => bundleArguments({ ...base, target: "linux; echo bad" }), /target/);
  assert.throws(() => bundleArguments({ ...base, variant: "test" }), /variant/);
  assert.throws(() => bundleArguments({ ...base, applicationMode: "jsi" }), /application-mode/);
});

test("Action runs the installed CLI and emits only a completed bundle path", () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "deherm-action-"));
  const output = mkdtempSync(path.join(os.tmpdir(), "deherm-bundle-"));
  try {
    const project = path.join(workspace, "game");
    const bin = path.join(workspace, "node_modules", "@ts-defold", "deherm", "bin");
    mkdirSync(project, { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(project, "game.project"), "[project]\ntitle = Test\n");
    writeFileSync(
      path.join(bin, "deherm.mjs"),
      `
      import fs from "node:fs";
      const args = process.argv.slice(2);
      fs.writeFileSync(${JSON.stringify(path.join(workspace, "arguments.json"))}, JSON.stringify(args));
      process.stdout.write(JSON.stringify({ bundleOutput: ${JSON.stringify(output)} }) + "\\n");
    `,
    );
    const githubOutput = path.join(workspace, "github-output");
    const result = spawnSync(process.execPath, [actionScript], {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_WORKSPACE: workspace,
        GITHUB_OUTPUT: githubOutput,
        DEHERM_ACTION_PROJECT: "game",
        DEHERM_ACTION_TARGET: "x86_64-linux",
        DEHERM_ACTION_VARIANT: "release",
        DEHERM_ACTION_ENTRY: "",
        DEHERM_ACTION_MODE: "defold",
        DEHERM_ACTION_BUILD_SERVER: "",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(githubOutput, "utf8"), `bundle-path=${realpathSync(output)}\n`);
    const args = JSON.parse(readFileSync(path.join(workspace, "arguments.json"), "utf8"));
    assert.ok(args.includes("--json"));
    assert.deepEqual(args.slice(args.indexOf("--application-mode"), args.indexOf("--application-mode") + 2), [
      "--application-mode",
      "dynamic",
    ]);
    assert.ok(!args.includes("--build-server"));
    assert.equal(resolveProject(workspace, "game"), project);
    assert.equal(resolveInstalledCli(project, workspace), path.join(bin, "deherm.mjs"));
    assert.equal(parseBundleOutput(JSON.stringify({ bundleOutput: output })), realpathSync(output));
    assert.throws(() => resolveProject(workspace, "../outside"), /inside/);
    assert.throws(
      () => parseBundleOutput(JSON.stringify({ bundleOutput: path.join(workspace, "missing") })),
      /does not exist/,
    );
    assert.throws(
      () => parseBundleOutput(JSON.stringify({ bundleOutput: path.join(project, "game.project") })),
      /directory/,
    );
    assert.throws(() => parseBundleOutput(JSON.stringify({ bundleOutput: `${output}\ninjected=value` })), /line break/);
    if (process.platform !== "win32") {
      const outside = mkdtempSync(path.join(os.tmpdir(), "deherm-action-outside-"));
      try {
        symlinkSync(outside, path.join(workspace, "linked-game"));
        writeFileSync(path.join(outside, "game.project"), "[project]\n");
        assert.throws(() => resolveProject(workspace, "linked-game"), /must not resolve outside/);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(output, { recursive: true, force: true });
  }
});
