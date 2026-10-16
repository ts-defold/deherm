#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nativeSource = "native/component_runtime_hermes_e2e.cpp";
const nativeIncludes = [
  "defold/defold_hermes/include",
  "upstream/defold/engine/dlib/src",
  "upstream/defold/engine/lua/src",
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", ...options });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.error?.message ?? result.status}):\n${result.stderr || result.stdout}`,
    );
  }
}

export async function compileNativeComponentFixture({
  source = path.join(root, nativeSource),
  compiler = process.env.CXX || "c++",
} = {}) {
  for (const include of nativeIncludes) {
    await access(path.join(root, include)).catch(() => {
      throw new Error(`Native preflight requires ${include}; bootstrap pinned Defold sources first`);
    });
  }
  await access(source);
  run(compiler, ["-std=c++17", "-fsyntax-only", ...nativeIncludes.map((include) => `-I${include}`), source]);
}

export async function runReleasePreflight({ native = false, execute = run } = {}) {
  if (native) {
    await compileNativeComponentFixture();
    console.log(`release-preflight: native component ABI syntax passed (${nativeSource})`);
    return;
  }
  const stages = [
    ["workspace release metadata", ["scripts/check-release-readiness.mjs"]],
    [
      "package-owned generated component capability",
      ["scripts/generate-component-proxy-runtime-capability.mjs", "--check"],
    ],
    ["npm package revision boundary", ["scripts/check-package-revision-boundary.mjs", "--quiet"]],
  ];
  for (const [name, args] of stages) {
    try {
      execute(process.execPath, args);
    } catch (error) {
      throw new Error(`Release preflight failed at ${name}: ${error.message}`, { cause: error });
    }
    console.log(`release-preflight: ${name} passed`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arguments_ = process.argv.slice(2);
  if (arguments_.some((argument) => argument !== "--native")) {
    throw new Error(`Unknown release preflight argument: ${arguments_.find((argument) => argument !== "--native")}`);
  }
  await runReleasePreflight({ native: arguments_.includes("--native") });
}
