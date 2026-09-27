#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  deriveDmSdkCppOwnershipEffectFacts,
  validateDmSdkCppOwnershipEffectReport,
} from "../packages/compiler/src/dmsdk-cpp-ownership-effect-frontend.mjs";
import { discoverSources } from "./generate-dmsdk-source-semantic-facts.mjs";
import { borrowedHandlePattern } from "../packages/compiler/src/dmsdk-pattern-catalog.mjs";
import {
  DMSDK_UNIVERSAL_FALLBACK_PATTERN,
  selectDmSdkPattern,
} from "../packages/compiler/src/dmsdk-pattern-selector.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaults = Object.freeze({
  ir: "packages/bindings/generated/defold-sdk-ir.json",
  shapes: "packages/bindings/generated/defold-dmsdk-abi-shapes.json",
  policy: "packages/bindings/overrides/dmsdk-borrowed-handle-bindings.json",
  scratchPolicy: "packages/bindings/overrides/dmsdk-scratch-scalar-out-bindings.json",
  output: "packages/bindings/generated/defold-dmsdk-cpp-ownership-effect-facts.json",
});
const compareCodeUnits = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

function parseArguments(argv) {
  const options = { outRoot: root, check: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") options.check = true;
    else if (argument === "--out-root") options.outRoot = path.resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

async function includeRoots(engineRoot, sourceFiles) {
  // Keep lookup deterministic but bounded. Passing every directory in the
  // checkout changes include precedence and can make Clang instantiate large,
  // unrelated template forests. Each translation unit gets its own source
  // directory and ancestors, plus the stable SDK roots below.
  const roots = new Set([engineRoot]);
  roots.add(path.join(engineRoot, "dlib", "src"));
  for (const file of sourceFiles) {
    let directory = path.dirname(file);
    while (directory.startsWith(engineRoot) && directory !== path.dirname(engineRoot)) {
      roots.add(directory);
      if (directory === engineRoot) break;
      directory = path.dirname(directory);
    }
  }
  const lock = await readFile(path.join(root, "upstream.lock"), "utf8");
  const revision = lock.match(/^DEFOLD_REV=(.+)$/mu)?.[1]?.trim();
  if (revision) {
    const sdkRoot = path.join(root, "upstream", "extender", "server", "app", "sdk", revision, "defoldsdk");
    for (const relative of ["sdk/include", "include", "ext/include"]) roots.add(path.join(sdkRoot, relative));
  }
  return [...roots].sort(compareCodeUnits);
}

async function filesBelow(directory) {
  const result = [];
  async function visit(current) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => compareCodeUnits(left.name, right.name))) {
      if (entry.isDirectory() && !/(?:^|\/)(?:test|tests|build|\.git)(?:\/|$)/u.test(entry.name))
        await visit(path.join(current, entry.name));
      else if (entry.isFile()) result.push(path.join(current, entry.name));
    }
  }
  await visit(directory);
  return result.sort(compareCodeUnits);
}

async function discoverHeaderSources(engineRoot, names) {
  const escaped = [...names]
    .sort((left, right) => right.length - left.length || compareCodeUnits(left, right))
    .map(escapeRegExp);
  const pattern = new RegExp(`\\b(?:${escaped.join("|")})\\s*\\(`, "u");
  const extensions = new Set([".h", ".hh", ".hpp", ".hxx", ".inl"]);
  const matches = [];
  for (const file of await filesBelow(engineRoot)) {
    if (!extensions.has(path.extname(file).toLowerCase())) continue;
    const source = await readFile(file, "utf8");
    if (pattern.test(source)) matches.push({ file, source });
  }
  return matches;
}

function clangArguments(file, roots) {
  const extension = path.extname(file).toLowerCase();
  const language = extension === ".mm" ? "objective-c++" : extension === ".c" ? "c" : "c++";
  return [
    "-x",
    language,
    `-std=${language === "c" ? "c11" : "c++17"}`,
    "-fsyntax-only",
    "-Wno-everything",
    "-ferror-limit=0",
    "-Xclang",
    "-ast-dump=json",
    ...roots.map((directory) => `-I${directory}`),
    file,
  ];
}

async function clangAst(file, roots, headers = []) {
  try {
    const arguments_ = clangArguments(file, roots);
    const sourceIndex = arguments_.lastIndexOf(file);
    arguments_.splice(sourceIndex, 0, ...headers.flatMap((header) => ["-include", header]));
    const result = await execFileAsync("clang++", arguments_, {
      cwd: root,
      encoding: "utf8",
      // A translation unit that expands beyond this bound is not a usable
      // clean-room AST input. Treat it as unknown instead of allowing a
      // pathological include/template expansion to exhaust Node's string
      // representation.
      maxBuffer: 128 * 1024 * 1024,
    });
    return { ast: JSON.parse(result.stdout), diagnostics: result.stderr, complete: true };
  } catch (error) {
    return { ast: null, diagnostics: String(error.stderr ?? error.message ?? "clang failed"), complete: false };
  }
}

function structuralCandidates(ir, shapes, policy, scratchPolicy) {
  const declarations = new Map(ir.declarations.map((declaration) => [declaration.id, declaration]));
  const structural = borrowedHandlePattern(policy.selection);
  const scratch = scratchPolicy.selection;
  const isScratch = (shape) => {
    const result = scratch.resultRolePrefixes.some((prefix) => shape.result.role.startsWith(prefix));
    const parameters = shape.parameters.every((parameter) =>
      parameter.direction === "value"
        ? scratch.valueRolePrefixes.some((prefix) => parameter.role.startsWith(prefix))
        : scratch.pointerDirections.includes(parameter.direction) &&
          scratch.pointerRolePrefixes.some((prefix) => parameter.role.startsWith(prefix)),
    );
    const writable = shape.parameters.some(
      (parameter) =>
        ["out", "inout"].includes(parameter.direction) &&
        scratch.pointerRolePrefixes.some((prefix) => parameter.role.startsWith(prefix)),
    );
    const rejected = scratch.rejectedFamilies.every((family) => !shape.families.includes(family));
    return result && parameters && writable && rejected;
  };
  const envelopes = new Map();
  for (const shape of shapes.rows) {
    const selection = selectDmSdkPattern(
      {
        id: shape.id,
        kind: shape.kind,
        result: shape.result,
        parameters: shape.parameters,
        families: shape.families,
        semanticTokens: ["borrowed-handle-consumer", "provider-validated-handle", "synchronous-noescape"],
      },
      [structural, DMSDK_UNIVERSAL_FALLBACK_PATTERN],
    );
    if (!selection.fallback) envelopes.set(shape.id, [...(envelopes.get(shape.id) ?? []), "borrowed-handle"]);
    if (isScratch(shape)) envelopes.set(shape.id, [...(envelopes.get(shape.id) ?? []), "scratch-scalar-out"]);
  }
  return [...envelopes.entries()]
    .map(([id, envelopeNames]) => {
      const shape = shapes.rows.find((row) => row.id === id);
      const declaration = declarations.get(id);
      if (!declaration) throw new Error(`${id}: structural candidate is absent from SDK IR`);
      return { ...declaration, envelopes: envelopeNames.sort(compareCodeUnits) };
    })
    .sort((left, right) => compareCodeUnits(left.id, right.id));
}

function mergeRows(candidates, observations) {
  return candidates.map((declaration) => {
    const rows = observations.flatMap((artifact) =>
      artifact.functions
        .filter((row) => row.declarationId === declaration.id)
        .map((row) => ({
          ...row,
          sourceSha256: artifact.sourceSha256,
          translationUnitSha256: artifact.translationUnitSha256,
        })),
    );
    const observed = rows.filter((row) => row.state === "observed");
    const semantic = (fact) =>
      JSON.stringify({
        ownershipEffect: fact.ownershipEffect,
        escape: fact.escape,
        completion: fact.completion,
        resultProvenance: fact.resultProvenance,
        parameters: fact.parameters,
      });
    const distinct = [...new Set(observed.map((row) => semantic(row.fact)))];
    if (distinct.length === 1) {
      const row = observed[0];
      return {
        declarationId: declaration.id,
        name: declaration.name,
        header: declaration.header,
        line: declaration.line,
        envelopes: declaration.envelopes,
        state: "observed",
        fact: row.fact,
        observations: observed
          .map(({ sourcePath, ast, sourceSha256, translationUnitSha256 }) => ({
            sourcePath,
            sourceSha256,
            translationUnitSha256,
            ast,
          }))
          .sort((left, right) => compareCodeUnits(left.sourcePath, right.sourcePath)),
        diagnostics: [],
      };
    }
    return {
      declarationId: declaration.id,
      name: declaration.name,
      header: declaration.header,
      line: declaration.line,
      envelopes: declaration.envelopes,
      state: "unknown",
      fact: null,
      observations: rows
        .map(({ sourcePath, ast, sourceSha256, translationUnitSha256 }) => ({
          sourcePath,
          sourceSha256,
          translationUnitSha256,
          ast,
        }))
        .sort((left, right) => compareCodeUnits(left.sourcePath, right.sourcePath)),
      diagnostics: [
        ...new Set(
          distinct.length > 1 ? ["conflicting-source-definitions"] : rows.flatMap(({ diagnostics }) => diagnostics),
        ),
      ].sort(compareCodeUnits),
    };
  });
}

export async function generateDmSdkCppOwnershipEffectFacts({ root: outputRoot = root, check = false } = {}) {
  const [irText, shapesText, policyText, scratchPolicyText] = await Promise.all([
    readFile(path.resolve(outputRoot, defaults.ir), "utf8"),
    readFile(path.resolve(outputRoot, defaults.shapes), "utf8"),
    readFile(path.resolve(outputRoot, defaults.policy), "utf8"),
    readFile(path.resolve(outputRoot, defaults.scratchPolicy), "utf8"),
  ]);
  const ir = JSON.parse(irText);
  const shapes = JSON.parse(shapesText);
  const policy = JSON.parse(policyText);
  const scratchPolicy = JSON.parse(scratchPolicyText);
  const candidates = structuralCandidates(ir, shapes, policy, scratchPolicy);
  const names = new Set(candidates.map(({ name }) => name.split("::").at(-1)));
  const engineRoot = path.resolve(outputRoot, "upstream/defold/engine");
  const sourceMatches = [
    ...(await discoverSources(engineRoot, names)),
    ...(await discoverHeaderSources(engineRoot, names)),
  ]
    .filter((entry, index, values) => values.findIndex((other) => other.file === entry.file) === index)
    .sort((left, right) => compareCodeUnits(left.file, right.file));
  const roots = await includeRoots(
    engineRoot,
    sourceMatches.map(({ file }) => file),
  );
  const observations = [];
  const sourceRecords = [];
  for (const { file, source } of sourceMatches) {
    const relative = path.relative(outputRoot, file).replaceAll(path.sep, "/");
    const headers = candidates
      .filter(({ name }) => new RegExp(`\\b${escapeRegExp(name.split("::").at(-1))}\\s*\\(`, "u").test(source))
      .map(({ header }) => path.resolve(outputRoot, header));
    const forcedHeaders = [...new Set(headers)].sort(compareCodeUnits).filter((header) => header !== file);
    const result = await clangAst(file, roots, forcedHeaders);
    if (!result.complete) {
      sourceRecords.push({
        path: relative,
        sourceSha256: sha256(source),
        astState: "rejected-with-diagnostics",
      });
      continue;
    }
    const relevant = candidates.filter((declaration) => names.has(declaration.name.split("::").at(-1)));
    const profileArguments = clangArguments(file, roots);
    const profileSourceIndex = profileArguments.lastIndexOf(file);
    profileArguments.splice(profileSourceIndex, 0, ...forcedHeaders.flatMap((header) => ["-include", header]));
    const canonicalArguments = profileArguments.map((argument) => {
      if (argument.startsWith(`-I${outputRoot}`)) {
        return `-I${path.relative(outputRoot, argument.slice(2)).replaceAll(path.sep, "/")}`;
      }
      if (argument.startsWith(outputRoot)) return path.relative(outputRoot, argument).replaceAll(path.sep, "/");
      return argument;
    });
    const translationUnitText = `${canonicalArguments.join("\0")}\0${source}`;
    const artifact = deriveDmSdkCppOwnershipEffectFacts({
      ast: result.ast,
      declarations: relevant,
      sourcePath: relative,
      sourceText: source,
      translationUnitText,
      includedHeaders: forcedHeaders.map((header) => path.relative(outputRoot, header).replaceAll(path.sep, "/")),
    });
    sourceRecords.push({
      path: relative,
      sourceSha256: artifact.sourceSha256,
      translationUnitSha256: artifact.translationUnitSha256,
      astState: "complete",
    });
    observations.push(artifact);
  }
  const lock = await readFile(path.resolve(outputRoot, "upstream.lock"), "utf8");
  const revision = lock.match(/^DEFOLD_REV=(.+)$/mu)?.[1]?.trim() ?? "unknown";
  const functions = mergeRows(candidates, observations);
  const envelopeCoverage = Object.fromEntries(
    ["borrowed-handle", "scratch-scalar-out"].map((envelope) => {
      const rows = functions.filter(({ envelopes }) => envelopes.includes(envelope));
      return [
        envelope,
        {
          requested: rows.length,
          observed: rows.filter(({ state }) => state === "observed").length,
          unknown: rows.filter(({ state }) => state === "unknown").length,
        },
      ];
    }),
  );
  const report = {
    schemaVersion: 1,
    kind: "deherm.dmsdk-cpp-ownership-effect-facts",
    defoldRevision: revision,
    extraction: "clang-json-ast/cpp-ownership-effect-v1",
    admission: "audit-only-single-profile",
    targetProfiles: [{ id: "host-clang-c++17", defines: [], compiler: "clang++" }],
    inputs: {
      ir: sha256(irText),
      shapes: sha256(shapesText),
      policy: sha256(policyText),
      scratchPolicy: sha256(scratchPolicyText),
      sourceCount: sourceMatches.length,
      includeRoots: roots.map((entry) => path.relative(outputRoot, entry).replaceAll(path.sep, "/")),
      clang: {
        executable: "clang++",
        language: "c++17",
        ast: "json",
        diagnostics: "ephemeral-not-policy-input",
      },
    },
    sources: sourceRecords.sort((left, right) => compareCodeUnits(left.path, right.path)),
    coverage: {
      requested: functions.length,
      observed: functions.filter(({ state }) => state === "observed").length,
      unknown: functions.filter(({ state }) => state === "unknown").length,
      envelopes: envelopeCoverage,
    },
    functions,
  };
  validateDmSdkCppOwnershipEffectReport(report);
  report.coverage.observed = report.functions.filter(({ state }) => state === "observed").length;
  report.coverage.unknown = report.functions.filter(({ state }) => state === "unknown").length;
  const content = `${JSON.stringify(report, null, 2)}\n`;
  const destination = path.resolve(outputRoot, defaults.output);
  if (check) {
    if ((await readFile(destination, "utf8")) !== content) throw new Error(`${defaults.output} is stale`);
  } else {
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content);
  }
  process.stdout.write(
    `${check ? "Verified" : "Generated"} C++ ownership/effect facts: ${report.coverage.observed}/${report.coverage.requested} observed, ${report.coverage.unknown} unknown.\n`,
  );
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseArguments(process.argv.slice(2));
  generateDmSdkCppOwnershipEffectFacts({ root: options.outRoot, check: options.check }).catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}
