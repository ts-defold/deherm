#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { extractCppImplementationFacts } from "../packages/compiler/src/cpp-semantic-facts.mjs";
import {
  astcProbePattern,
  base64SpanPattern,
  fixedDigestPattern,
  xteaSpanPattern,
} from "../packages/compiler/src/dmsdk-pattern-catalog.mjs";
import { DMSDK_UNIVERSAL_FALLBACK_PATTERN, selectDmSdkPattern } from "../packages/compiler/src/dmsdk-pattern-selector.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaults = Object.freeze({
  ir: "packages/bindings/generated/defold-sdk-ir.json",
  shapes: "packages/bindings/generated/defold-dmsdk-abi-shapes.json",
  output: "packages/bindings/generated/defold-dmsdk-source-semantic-facts.json",
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseArguments(argv) {
  const options = { ...defaults, outRoot: root, check: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") options.check = true;
    else if (argument === "--out-root") options.outRoot = path.resolve(argv[++index]);
    else if (argument === "--ir") options.ir = argv[++index];
    else if (argument === "--shapes") options.shapes = argv[++index];
    else if (argument === "--output") options.output = argv[++index];
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

const boundedSpanPatterns = Object.freeze([
  fixedDigestPattern(),
  base64SpanPattern(),
  astcProbePattern(),
  xteaSpanPattern(),
  DMSDK_UNIVERSAL_FALLBACK_PATTERN,
]);

function isBoundedSpanCandidate(row) {
  const decision = selectDmSdkPattern({
    id: row.id,
    kind: row.kind,
    result: row.result,
    parameters: row.parameters,
    families: row.families,
    semanticTokens: [],
  }, boundedSpanPatterns);
  return decision.trace.some(({ blockers }) =>
    blockers.length > 0 && blockers.every((blocker) => blocker.startsWith("semantic-token-missing:")),
  );
}

async function filesBelow(directory) {
  const result = [];
  async function visit(current) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => compareCodeUnits(left.name, right.name))) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) result.push(absolute);
    }
  }
  await visit(directory);
  return result;
}

function tokenPattern(names) {
  const escaped = [...names]
    .sort((left, right) => right.length - left.length || compareCodeUnits(left, right))
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
  return new RegExp(`\\b(?:${escaped.join("|")})\\s*\\(`, "u");
}

async function discoverSources(engineRoot, names) {
  const pattern = tokenPattern(names);
  const extensions = new Set([".c", ".cc", ".cpp", ".cxx", ".mm"]);
  const files = await filesBelow(engineRoot);
  const matches = [];
  for (const file of files) {
    if (!extensions.has(path.extname(file)) || /(?:^|\/)test(?:s)?\//u.test(file)) continue;
    const source = await readFile(file, "utf8");
    if (pattern.test(source)) matches.push({ file, source });
  }
  return matches;
}

async function includeRoots(engineRoot) {
  // These are Defold's actual public/internal include roots for the bounded
  // dlib implementations. Do not infer them by walking the checkout: doing so
  // makes the AST depend on unrelated files that happen to be present and
  // prevents a declared-input clean room from reproducing the same facts.
  const roots = new Set([
    engineRoot,
    path.join(engineRoot, "dlib", "src"),
  ]);
  const lock = await readFile(path.join(root, "upstream.lock"), "utf8");
  const revision = lock.match(/^DEFOLD_REV=(.+)$/mu)?.[1]?.trim();
  if (revision) {
    const sdkRoot = path.join(root, "upstream", "extender", "server", "app", "sdk", revision, "defoldsdk");
    for (const relative of ["sdk/include", "include", "ext/include"]) roots.add(path.join(sdkRoot, relative));
  }
  roots.add(path.join(engineRoot, "dlib", "src", "mbedtls", "tf-psa-crypto", "include"));
  roots.add(path.join(engineRoot, "dlib", "src", "mbedtls", "tf-psa-crypto", "drivers", "builtin", "include"));
  return [...roots].sort(compareCodeUnits);
}

function normalizeDiagnostics(diagnostics, repositoryRoot) {
  return diagnostics.replaceAll(repositoryRoot, "<repository>");
}

function clangAst(file, roots, repositoryRoot) {
  const args = [
    "-x", "c++", "-std=c++17", "-fsyntax-only", "-Wno-everything", "-ferror-limit=0",
    "-Xclang", "-ast-dump=json",
    ...roots.map((directory) => `-I${directory}`),
    file,
  ];
  return new Promise((resolve, reject) => {
    execFile("clang++", args, { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!stdout.trim()) {
        reject(new Error(`clang produced no AST for ${path.relative(root, file)}: ${stderr.trim().split("\n").at(-1) ?? error}`));
        return;
      }
      try {
        resolve({ ast: JSON.parse(stdout), diagnostics: normalizeDiagnostics(stderr, repositoryRoot), complete: !error });
      } catch (parseError) {
        reject(new Error(`clang produced invalid AST JSON for ${path.relative(root, file)}: ${parseError.message}`));
      }
    });
  });
}

async function writeOutput(file, contents, check) {
  if (check) {
    let current = null;
    try { current = await readFile(file, "utf8"); } catch {}
    if (current !== contents) throw new Error(`${path.relative(root, file)} is stale`);
    return;
  }
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents);
}

export async function buildDmSdkSourceSemanticFacts(options = {}) {
  const repositoryRoot = options.root ?? root;
  const irPath = path.resolve(repositoryRoot, options.ir ?? defaults.ir);
  const shapesPath = path.resolve(repositoryRoot, options.shapes ?? defaults.shapes);
  const [irContent, shapesContent] = await Promise.all([readFile(irPath, "utf8"), readFile(shapesPath, "utf8")]);
  const ir = JSON.parse(irContent);
  const shapes = JSON.parse(shapesContent);
  if (ir.defoldRevision !== shapes.defoldRevision) throw new Error("dmSDK source-fact inputs have different revisions");
  const declarations = new Map(ir.declarations.map((declaration) => [declaration.id, declaration]));
  const candidates = shapes.rows.filter(isBoundedSpanCandidate).map((row) => {
    const declaration = declarations.get(row.id);
    if (!declaration) throw new Error(`${row.id}: source-fact candidate is absent from SDK IR`);
    return { declaration, row };
  });
  const names = new Set(candidates.map(({ declaration }) => declaration.name.split("::").at(-1)));
  const engineRoot = path.join(repositoryRoot, "upstream", "defold", "engine");
  const sources = await discoverSources(engineRoot, names);
  const roots = await includeRoots(engineRoot);
  const requestedNames = new Set(candidates.map(({ declaration }) => declaration.name));
  const parsed = [];
  for (const { file, source } of sources) {
    const relative = path.relative(repositoryRoot, file).replaceAll(path.sep, "/");
    const result = await clangAst(file, roots, repositoryRoot);
    const definitions = extractCppImplementationFacts(result.ast, requestedNames, relative);
    if (definitions.length) {
      parsed.push({
        path: relative,
        sha256: sha256(source),
        astState: result.complete ? "complete" : "partial-with-diagnostics",
        diagnosticsSha256: sha256(result.diagnostics),
        definitions,
      });
    }
  }
  const definitionsByName = new Map();
  for (const source of parsed) {
    for (const definition of source.definitions) {
      const entries = definitionsByName.get(definition.name) ?? [];
      entries.push(definition);
      definitionsByName.set(definition.name, entries);
    }
  }
  const entries = candidates.map(({ declaration, row }) => {
    const definitions = definitionsByName.get(declaration.name) ?? [];
    return {
      declarationId: declaration.id,
      name: declaration.name,
      shape: row.shape,
      state: definitions.length ? "observed" : "implementation-not-found",
      definitions,
    };
  }).sort((left, right) => compareCodeUnits(left.declarationId, right.declarationId));
  const report = {
    schemaVersion: 1,
    defoldRevision: ir.defoldRevision,
    extraction: "clang-json-ast/compact-dataflow-v1",
    scope: "structurally eligible bounded-span declarations",
    sources: parsed.map(({ definitions: _definitions, ...source }) => source).sort((left, right) => compareCodeUnits(left.path, right.path)),
    sourceHashes: { ir: sha256(irContent), shapes: sha256(shapesContent) },
    coverage: {
      requested: entries.length,
      observed: entries.filter(({ state }) => state === "observed").length,
      missing: entries.filter(({ state }) => state !== "observed").length,
    },
    declarations: entries,
  };
  const contents = `${JSON.stringify(report, null, 2)}\n`;
  const output = path.resolve(options.outRoot ?? repositoryRoot, options.output ?? defaults.output);
  await writeOutput(output, contents, options.check ?? false);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseArguments(process.argv.slice(2));
  const report = await buildDmSdkSourceSemanticFacts(options);
  process.stdout.write(`${options.check ? "Verified" : "Generated"} ${report.coverage.observed}/${report.coverage.requested} bounded-span source semantic facts.\n`);
}
