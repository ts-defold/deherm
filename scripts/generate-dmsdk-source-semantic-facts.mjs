#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { extractCppImplementationFacts } from "../packages/compiler/src/cpp-semantic-facts.mjs";
import { isDmSdkBoundedSpanSourceFactCandidate } from "../packages/compiler/src/dmsdk-bounded-span-plan.mjs";

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

function isBoundedSpanCandidate(row) {
  return isDmSdkBoundedSpanSourceFactCandidate(row);
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

const allSourceExtensions = Object.freeze([".c", ".cc", ".cpp", ".cxx", ".mm"]);
const portableSourceExtensions = Object.freeze([".c", ".cc", ".cpp", ".cxx"]);

export async function discoverSources(engineRoot, names, options = {}) {
  const pattern = tokenPattern(names);
  const extensions = new Set(options.extensions ?? allSourceExtensions);
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
  const roots = new Set([engineRoot, path.join(engineRoot, "dlib", "src")]);
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

export function clangInvocation(file, roots) {
  const extension = path.extname(file).toLowerCase();
  const language = extension === ".mm" ? "objective-c++" : extension === ".c" ? "c" : "c++";
  const standard = language === "c" ? "c11" : "c++17";
  return [
    "-x",
    language,
    `-std=${standard}`,
    "-fsyntax-only",
    "-Wno-everything",
    "-ferror-limit=0",
    "-Xclang",
    "-ast-dump=json",
    ...roots.map((directory) => `-I${directory}`),
    file,
  ];
}

// A recovery AST is useful for diagnostics, but it is not semantic evidence.
// Clang deliberately emits a partial tree after many parse/type errors. Admitting
// that tree would let unrelated or ill-typed syntax manufacture positive facts.
// This function therefore returns an AST only for an error-free translation unit.
export function clangAst(file, roots, repositoryRoot) {
  const args = clangInvocation(file, roots);
  return new Promise((resolve, reject) => {
    execFile(
      "clang++",
      args,
      { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const diagnostics = normalizeDiagnostics(stderr, repositoryRoot);
        if (error) {
          resolve({ ast: null, diagnostics, complete: false });
          return;
        }
        if (!stdout.trim()) {
          reject(
            new Error(
              `clang produced no AST for ${path.relative(repositoryRoot, file)}: ${stderr.trim().split("\n").at(-1) ?? "no diagnostics"}`,
            ),
          );
          return;
        }
        try {
          resolve({ ast: JSON.parse(stdout), diagnostics, complete: true });
        } catch (parseError) {
          reject(
            new Error(
              `clang produced invalid AST JSON for ${path.relative(repositoryRoot, file)}: ${parseError.message}`,
            ),
          );
        }
      },
    );
  });
}

async function writeOutput(file, contents, check) {
  if (check) {
    let current = null;
    try {
      current = await readFile(file, "utf8");
    } catch {}
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
  // These facts describe the canonical portable implementation shape. Target
  // replacements (for example crypt_apple.mm) remain available to target-aware
  // analyses and the build matrix, but must not make this policy artifact
  // depend on the derivation host's SDK headers.
  const sources = await discoverSources(engineRoot, names, { extensions: portableSourceExtensions });
  const roots = await includeRoots(engineRoot);
  const requestedNames = new Set(candidates.map(({ declaration }) => declaration.name));
  const parsed = [];
  const rejectedSources = [];
  for (const { file, source } of sources) {
    const relative = path.relative(repositoryRoot, file).replaceAll(path.sep, "/");
    const result = await clangAst(file, roots, repositoryRoot);
    if (!result.complete) {
      rejectedSources.push({
        path: relative,
        sha256: sha256(source),
        astState: "rejected-with-diagnostics",
        diagnosticsPresent: result.diagnostics.length > 0,
      });
      continue;
    }
    const definitions = result.complete ? extractCppImplementationFacts(result.ast, requestedNames, relative) : [];
    if (definitions.length) {
      parsed.push({
        path: relative,
        sha256: sha256(source),
        astState: "complete",
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
  const entries = candidates
    .map(({ declaration, row }) => {
      const definitions = definitionsByName.get(declaration.name) ?? [];
      return {
        declarationId: declaration.id,
        name: declaration.name,
        shape: row.shape,
        state: definitions.length ? "observed" : "implementation-not-found",
        definitions,
      };
    })
    .sort((left, right) => compareCodeUnits(left.declarationId, right.declarationId));
  const report = {
    schemaVersion: 1,
    defoldRevision: ir.defoldRevision,
    extraction: "clang-json-ast/portable-compact-dataflow-v3",
    scope: "structurally eligible bounded-span declarations",
    sources: parsed
      .map(({ definitions: _definitions, ...source }) => source)
      .sort((left, right) => compareCodeUnits(left.path, right.path)),
    rejectedSources: rejectedSources.sort((left, right) => compareCodeUnits(left.path, right.path)),
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
  process.stdout.write(
    `${options.check ? "Verified" : "Generated"} ${report.coverage.observed}/${report.coverage.requested} bounded-span source semantic facts.\n`,
  );
}
