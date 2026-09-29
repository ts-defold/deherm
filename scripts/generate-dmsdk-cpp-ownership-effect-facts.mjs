#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  DMSDK_CPP_SOURCE_SEMANTIC_ADMISSION,
  DMSDK_CPP_TARGET_AVAILABILITY,
  deriveDmSdkCppOwnershipEffectFacts,
  validateDmSdkCppOwnershipEffectReport,
} from "../packages/compiler/src/dmsdk-cpp-ownership-effect-frontend.mjs";
import {
  defoldSourceQuoteRoots,
  deriveDefoldSourceIncludeAliases,
  materializeDefoldSourceIncludeAliases,
} from "../packages/compiler/src/defold-source-include-aliases.mjs";
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

async function includeRoots(engineRoot) {
  // Keep lookup deterministic and faithful to Defold's exported include
  // layout. Source-local quoted includes are resolved by Clang from the
  // translation unit itself; adding every leaf directory here can shadow
  // system headers (for example dmsdk/dlib/math.h over <math.h>).
  const roots = new Set([engineRoot]);
  roots.add(path.join(engineRoot, "dlib", "src"));
  const sdkIncludeRoots = [];
  const lock = await readFile(path.join(root, "upstream.lock"), "utf8");
  const revision = lock.match(/^DEFOLD_REV=(.+)$/mu)?.[1]?.trim();
  if (revision) {
    const sdkRoot = path.join(root, "upstream", "extender", "server", "app", "sdk", revision, "defoldsdk");
    for (const relative of ["sdk/include", "include", "ext/include"]) {
      const includeRoot = path.join(sdkRoot, relative);
      roots.add(includeRoot);
      sdkIncludeRoots.push(includeRoot);
    }
  }
  return { roots: [...roots].sort(compareCodeUnits), sdkIncludeRoots: sdkIncludeRoots.sort(compareCodeUnits) };
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

function clangArguments(file, roots, vfsOverlay = null, astFilter = null) {
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
    ...(astFilter ? ["-Xclang", `-ast-dump-filter=${astFilter}`] : []),
    ...(vfsOverlay ? ["-ivfsoverlay", vfsOverlay] : []),
    ...roots.map((directory) => `-I${directory}`),
    file,
  ];
}

function clangArgumentsWithQuoteRoots(file, roots, quoteRoots, vfsOverlay = null, astFilter = null) {
  const arguments_ = clangArguments(file, roots, vfsOverlay, astFilter);
  const sourceIndex = arguments_.lastIndexOf(file);
  arguments_.splice(sourceIndex, 0, ...quoteRoots.flatMap((directory) => ["-iquote", directory]));
  return arguments_;
}

function parseJsonSequence(value) {
  const rows = [];
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') {
      quoted = true;
      continue;
    }
    if (character === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        rows.push(JSON.parse(value.slice(start, index + 1)));
        start = -1;
      }
    }
  }
  if (quoted || depth !== 0 || start !== -1) throw new Error("filtered Clang AST JSON sequence is incomplete");
  return rows;
}

async function runClangAst(file, roots, quoteRoots, vfsOverlay, headers, astFilter = null) {
  const arguments_ = clangArgumentsWithQuoteRoots(file, roots, quoteRoots, vfsOverlay, astFilter);
  const sourceIndex = arguments_.lastIndexOf(file);
  arguments_.splice(sourceIndex, 0, ...headers.flatMap((header) => ["-include", header]));
  return execFileAsync("clang++", arguments_, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
}

async function clangAst(file, roots, quoteRoots, vfsOverlay = null, headers = [], declarations = []) {
  try {
    const result = await runClangAst(file, roots, quoteRoots, vfsOverlay, headers);
    return { ast: JSON.parse(result.stdout), diagnostics: result.stderr, complete: true, profile: "full" };
  } catch (error) {
    const diagnostics = String(error.stderr ?? error.message ?? "clang failed");
    const capacityFailure =
      error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ||
      /maxBuffer|stdout maxBuffer|ENOBUFS|too large|Invalid string length/iu.test(
        `${error.message ?? ""}\n${diagnostics}`,
      );
    const toolFailure = !/(?:^|\n)[^\n]*error:/u.test(diagnostics);
    if (declarations.length > 0 && (capacityFailure || toolFailure)) {
      try {
        const filters = [
          ...new Set(
            declarations.map(({ name }) => {
              const parts = name.split("::");
              return parts.length > 1 ? parts.slice(0, -1).join("::") : name;
            }),
          ),
        ].sort(compareCodeUnits);
        const nodes = [];
        const diagnosticRows = [];
        for (const filter of filters) {
          const result = await runClangAst(file, roots, quoteRoots, vfsOverlay, headers, filter);
          nodes.push(...parseJsonSequence(result.stdout));
          diagnosticRows.push(result.stderr);
        }
        return {
          ast: { kind: "TranslationUnitDecl", inner: nodes },
          diagnostics: diagnosticRows.join("\n"),
          complete: true,
          profile: "qualified-namespace-filter",
        };
      } catch (filteredError) {
        return {
          ast: null,
          diagnostics: String(filteredError.stderr ?? filteredError.message ?? "filtered clang failed"),
          complete: false,
          profile: "qualified-namespace-filter",
        };
      }
    }
    return { ast: null, diagnostics, complete: false, profile: "full" };
  }
}

function translationUnitBlockers(result) {
  if (result.complete) return [];
  const missing = [...String(result.diagnostics).matchAll(/fatal error: ['<]([^'">]+)['>] file not found/gu)].map(
    (match) => `missing-include:${match[1]}`,
  );
  if (missing.length > 0) return [...new Set(missing)].sort(compareCodeUnits);
  if (/invalid or unsupported -std value|unsupported option|unknown target triple/iu.test(result.diagnostics)) {
    return ["unsupported-compiler-profile"];
  }
  if (/too large|exceeded|maxBuffer|ENOBUFS/iu.test(result.diagnostics)) return ["ast-output-capacity-exceeded"];
  if (/(?:^|\n)[^\n]*error:/u.test(result.diagnostics)) return ["translation-unit-compile-error"];
  return ["translation-unit-tool-failure"];
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
      const declaration = declarations.get(id);
      if (!declaration) throw new Error(`${id}: structural candidate is absent from SDK IR`);
      return { ...declaration, envelopes: envelopeNames.sort(compareCodeUnits) };
    })
    .sort((left, right) => compareCodeUnits(left.id, right.id));
}

function sourceCandidates(candidates, source) {
  return candidates.filter(({ name }) =>
    new RegExp(`\\b${escapeRegExp(name.split("::").at(-1))}\\s*\\(`, "u").test(source),
  );
}

function rejectedArtifact({ declarations, sourcePath, sourceText, translationUnitText }) {
  return {
    schemaVersion: 1,
    kind: "deherm.dmsdk-cpp-ownership-effect-frontend",
    sourcePath,
    sourceSha256: sha256(sourceText),
    translationUnitSha256: sha256(translationUnitText),
    functions: declarations.map((declaration) => ({
      declarationId: declaration.id,
      name: declaration.name,
      header: declaration.header,
      line: declaration.line,
      state: "unknown",
      sourcePath,
      ast: null,
      fact: null,
      diagnostics: ["translation-unit-rejected"],
    })),
  };
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
  const discoveredMatches = [
    ...(await discoverSources(engineRoot, names)),
    ...(await discoverHeaderSources(engineRoot, names)),
  ]
    .filter((entry, index, values) => values.findIndex((other) => other.file === entry.file) === index)
    .sort((left, right) => compareCodeUnits(left.file, right.file));
  const sourceMatches = discoveredMatches
    .map((entry) => ({ ...entry, relevant: sourceCandidates(candidates, entry.source) }))
    .filter(({ relevant }) => relevant.length > 0);
  const { roots, sdkIncludeRoots } = await includeRoots(engineRoot);
  const includeAliases = await deriveDefoldSourceIncludeAliases({
    repositoryRoot: outputRoot,
    engineRoot,
    sdkIncludeRoots,
    sources: sourceMatches.map(({ file, source }) => ({
      path: path.relative(outputRoot, file).replaceAll(path.sep, "/"),
      text: source,
    })),
  });
  const aliasOverlay = await materializeDefoldSourceIncludeAliases({
    repositoryRoot: outputRoot,
    aliases: includeAliases,
  });
  roots.unshift(aliasOverlay.directory);
  const observations = [];
  const sourceRecords = [];
  for (const { file, source, relevant } of sourceMatches) {
    const relative = path.relative(outputRoot, file).replaceAll(path.sep, "/");
    const quoteRoots = defoldSourceQuoteRoots(file, engineRoot);
    const profileArguments = clangArgumentsWithQuoteRoots(file, roots, quoteRoots, aliasOverlay.vfsOverlay);
    const canonicalArguments = profileArguments.map((argument) => {
      if (argument === `-I${aliasOverlay.directory}`) return "-I<source-alias-overlay>";
      if (argument === aliasOverlay.vfsOverlay) return "<source-vfs-overlay>";
      if (argument.startsWith(`-I${outputRoot}`)) {
        return `-I${path.relative(outputRoot, argument.slice(2)).replaceAll(path.sep, "/")}`;
      }
      if (argument.startsWith(outputRoot)) return path.relative(outputRoot, argument).replaceAll(path.sep, "/");
      return argument;
    });
    const result = await clangAst(file, roots, quoteRoots, aliasOverlay.vfsOverlay, [], relevant);
    const translationUnitText = `${canonicalArguments.join("\0")}\0ast-profile=${result.profile}\0${source}`;
    const artifact = result.complete
      ? deriveDmSdkCppOwnershipEffectFacts({
          ast: result.ast,
          declarations: relevant,
          sourcePath: relative,
          sourceText: source,
          translationUnitText,
          includedHeaders: [],
        })
      : rejectedArtifact({
          declarations: relevant,
          sourcePath: relative,
          sourceText: source,
          translationUnitText,
        });
    sourceRecords.push({
      path: relative,
      sourceSha256: artifact.sourceSha256,
      translationUnitSha256: artifact.translationUnitSha256,
      astState: result.complete ? "complete" : "rejected-with-diagnostics",
      astProfile: result.profile,
      blockers: translationUnitBlockers(result),
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
    schemaVersion: 4,
    kind: "deherm.dmsdk-cpp-ownership-effect-facts",
    defoldRevision: revision,
    extraction: "clang-json-ast/cpp-ownership-effect-v3",
    semanticAdmission: DMSDK_CPP_SOURCE_SEMANTIC_ADMISSION,
    extractionProfiles: [{ id: "host-clang-c++17", defines: [], compiler: "clang++" }],
    targetAvailability: DMSDK_CPP_TARGET_AVAILABILITY,
    inputs: {
      ir: sha256(irText),
      shapes: sha256(shapesText),
      policy: sha256(policyText),
      scratchPolicy: sha256(scratchPolicyText),
      sourceCount: sourceMatches.length,
      includeRoots: roots.map((entry) =>
        entry === aliasOverlay.directory
          ? "<source-alias-overlay>"
          : path.relative(outputRoot, entry).replaceAll(path.sep, "/"),
      ),
      includeAliases,
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
