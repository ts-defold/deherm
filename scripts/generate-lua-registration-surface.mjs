#!/usr/bin/env node

// Verify a Lua-shaped script API against the C code that actually registers it.
//
// `.script_api` files and reference documentation are declarations. The ground
// truth is the Lua C API registration and how each C function body uses the Lua
// stack. This generator derives the REGISTERED surface of a target - the pinned
// Defold engine tree, a native extension root, or a Bob dependency archive -
// straight from its C/C++ sources, then diffs it against the DECLARED surface.
//
// Everything is structural. There is no per-route and no per-module list: a C
// construct the parser cannot decide is recorded as a blocker with its reason,
// never assumed away.

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { unzipSync } from "fflate";
import { parse as parseYaml } from "yaml";

import { assertReviewedRevision } from "./lib/reviewed-revision.mjs";
import {
  analyzeFunctionBody,
  buildProject,
  collectBodyDerivedHelpers,
  collectSdkStackHelpers,
  collectUserTypes,
  compareText,
  documentedNameOf,
  interpretRegistrations
} from "./lib/lua-c-registration.mjs";
import { deriveConstantValues } from "./lib/defold-constant-values.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const defaultPolicy = "packages/bindings/overrides/lua-registration-surface-targets.json";
const defaultOutput = "packages/bindings/generated/defold-lua-registration-surface.json";
const gateOutput = "packages/bindings/generated/defold-lua-registration-gate.json";
const textDecoder = new TextDecoder();

const SOURCE_EXTENSIONS = /\.(?:c|cc|cpp|cxx|m|mm)$/i;
const HEADER_EXTENSIONS = /\.(?:h|hh|hpp|hxx|inl)$/i;

function fail(message) {
  throw new Error(`lua registration surface: ${message}`);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function inputPath(path) {
  return isAbsolute(path) ? path : join(repositoryRoot, path);
}

function parseArgs(argv) {
  const options = { check: false, outRoot: repositoryRoot, policy: defaultPolicy, only: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") options.check = true;
    else if (argument === "--out-root") options.outRoot = resolve(argv[++index]);
    else if (argument === "--policy") options.policy = argv[++index];
    else if (argument === "--only") options.only = argv[++index];
    else fail(`unknown argument '${argument}'`);
  }
  return options;
}

// ---------------------------------------------------------------------------
// Input collection. A target's sources come from a directory tree or straight
// out of a Bob dependency archive; the archive is never unpacked to disk.

async function walkDirectory(root) {
  const files = [];
  async function visit(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "build") continue;
        await visit(full);
        continue;
      }
      files.push(full);
    }
  }
  await visit(root);
  return files;
}

function excluded(relativePath, target) {
  for (const segment of target.excludePathSegments ?? []) if (relativePath.includes(segment)) return true;
  for (const pattern of target.excludeVariants ?? []) if (relativePath.includes(pattern.path)) return true;
  return false;
}

async function collectDirectoryTarget(target) {
  const root = inputPath(target.root);
  const all = await walkDirectory(root);
  const sources = [];
  const headers = [];
  const declarations = [];
  for (const file of all) {
    const relativePath = relative(root, file).split(/[\\/]/).join("/");
    if (excluded(relativePath, target)) continue;
    if (SOURCE_EXTENSIONS.test(relativePath)) {
      sources.push({ path: relativePath, text: await readFile(file, "utf8") });
    } else if (HEADER_EXTENSIONS.test(relativePath)) {
      headers.push({ path: relativePath, text: await readFile(file, "utf8") });
    } else if (relativePath.endsWith(".script_api")) {
      declarations.push({ path: relativePath, text: await readFile(file, "utf8") });
    }
  }
  return { sources, headers, declarations, listing: all.length };
}

async function collectArchiveTarget(target) {
  // Defold dependencies are ZIPs. Read `.script_api` and the C/C++ sources
  // directly out of the archive: keep the whole entry listing, decompress only
  // what the verifier reads.
  const bytes = await readFile(inputPath(target.archive));
  const listing = [];
  const entries = unzipSync(new Uint8Array(bytes), {
    filter(file) {
      if (file.name.endsWith("/")) return false;
      listing.push(file.name);
      return SOURCE_EXTENSIONS.test(file.name) || HEADER_EXTENSIONS.test(file.name) ||
        file.name.endsWith(".script_api") || posix.basename(file.name) === "ext.manifest";
    }
  });
  const prefix = target.archiveRoot ?? "";
  const sources = [];
  const headers = [];
  const declarations = [];
  for (const name of Object.keys(entries).sort(compareText)) {
    if (prefix && !name.startsWith(prefix)) continue;
    const relativePath = prefix ? name.slice(prefix.length).replace(/^\//, "") : name;
    if (excluded(relativePath, target)) continue;
    const text = textDecoder.decode(entries[name]);
    if (SOURCE_EXTENSIONS.test(relativePath)) sources.push({ path: relativePath, text });
    else if (HEADER_EXTENSIONS.test(relativePath)) headers.push({ path: relativePath, text });
    else if (relativePath.endsWith(".script_api")) declarations.push({ path: relativePath, text });
  }
  return { sources, headers, declarations, listing: listing.length, archiveSha256: sha256(bytes) };
}

// ---------------------------------------------------------------------------
// Declared surface loaders.

function declaredFromScriptIr(value) {
  assert(Array.isArray(value.functions), "script API IR has no functions");
  const rows = [];
  for (const entry of value.functions) {
    rows.push({
      name: entry.rawName,
      module: entry.modulePath.join("."),
      member: entry.member,
      source: `${entry.source}:${entry.line}`,
      parameters: entry.parameters.map((parameter) => ({
        name: parameter.rawName,
        optional: Boolean(parameter.optional),
        type: parameter.rawType ?? null
      })),
      returns: entry.returns?.length ?? 0
    });
  }
  return rows;
}

function normalizeDeclaredType(value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    const members = value.map((item) => normalizeDeclaredType(item)).filter(Boolean);
    return members.length ? members.join("|") : null;
  }
  if (typeof value === "string") return value;
  return null;
}

function declaredFromScriptApi(declarations, diagnostics) {
  const rows = [];
  for (const file of declarations) {
    let parsed;
    try {
      parsed = parseYaml(file.text);
    } catch (error) {
      diagnostics.push({ code: "script-api-parse-error", path: file.path, detail: error.message });
      continue;
    }
    if (!Array.isArray(parsed)) {
      diagnostics.push({ code: "script-api-not-a-sequence", path: file.path, detail: "expected a top-level YAML sequence" });
      continue;
    }
    for (const module of parsed) {
      if (!module || typeof module !== "object" || typeof module.name !== "string") continue;
      for (const member of module.members ?? []) {
        if (!member || typeof member !== "object" || typeof member.name !== "string") continue;
        const declaredType = normalizeDeclaredType(member.type);
        const hasCallShape = Array.isArray(member.parameters) || Array.isArray(member.returns);
        if (declaredType !== "function" && !hasCallShape) continue;
        const parameters = (member.parameters ?? []).map((parameter) => {
          const raw = typeof parameter?.name === "string" ? parameter.name : "";
          // defold-astar writes optionality as a trailing `[optional]` marker on
          // the parameter NAME rather than as `optional: true`. Decode it, and
          // keep the non-standard spelling visible in the report.
          const marker = /^(.*?)\[([^\]]*)\]$/.exec(raw);
          const declaredOptional = parameter?.optional === true;
          return {
            name: marker ? marker[1] : raw,
            optional: declaredOptional || (marker ? marker[2] === "optional" : false),
            optionalitySpelling: marker
              ? (marker[2] === "optional" ? "trailing-optional-marker" : `unrecognized-name-marker:${marker[2]}`)
              : declaredOptional ? "optional-key" : "required",
            type: normalizeDeclaredType(parameter?.type)
          };
        });
        rows.push({
          name: `${module.name}.${member.name}`,
          module: module.name,
          member: member.name,
          source: file.path,
          declaredType,
          missingFunctionType: declaredType !== "function" && hasCallShape,
          parameters,
          returns: (member.returns ?? []).length
        });
      }
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Type agreement. The derived vocabulary comes from the accessors; the declared
// vocabulary comes from the declaration. A declared spelling the comparison has
// no rule for is reported undecided, never silently passed.

const DECLARED_TYPE_ALIASES = Object.freeze({
  integer: "number",
  float: "number",
  double: "number",
  bool: "boolean",
  quaternion: "quat",
  quat: "quat",
  vector: "userdata",
  constant: "number",
  hash: "hash",
  url: "url",
  buffer: "buffer",
  buffer_data: "buffer",
  buffer_stream: "userdata",
  node: "userdata",
  table: "table",
  string: "string",
  number: "number",
  boolean: "boolean",
  "function": "function",
  func: "function",
  nil: "nil",
  any: null,
  userdata: "userdata",
  matrix4: "matrix4",
  vector3: "vector3",
  vector4: "vector4"
});

const DERIVED_TYPE_VOCABULARY = new Set([
  "number", "string", "boolean", "table", "function", "userdata", "nil", "thread",
  "hash", "url", "buffer", "vector3", "vector4", "quat", "matrix4"
]);

function splitDeclaredType(raw) {
  if (!raw) return null;
  return String(raw).split("|").map((part) => part.trim().toLowerCase().replace(/\[\]$/, "")).filter(Boolean);
}

function mapAtom(token) {
  // A documented `T[]` is a Lua sequence, which reaches C as a table.
  if (/\[\]$/.test(token)) return "table";
  if (Object.hasOwn(DECLARED_TYPE_ALIASES, token)) return DECLARED_TYPE_ALIASES[token];
  if (/^fun\(/.test(token)) return "function";
  if (/^table[<(]/.test(token)) return "table";
  return undefined;
}

function compareParameterType(declaredRaw, derivedTypes) {
  const declaredAtoms = splitDeclaredType(declaredRaw);
  if (!declaredAtoms) return { verdict: "undecided", reason: "no-declared-type" };
  const derivedAtoms = derivedTypes.map((type) => type.toLowerCase()).filter((type) => type !== "nil");
  if (!derivedAtoms.length) return { verdict: "undecided", reason: "no-derived-type" };
  const declaredSet = new Set(declaredAtoms.filter((type) => type !== "nil"));
  const derivedSet = new Set(derivedAtoms);
  if (!declaredSet.size) return { verdict: "undecided", reason: "declared-type-is-nil-only" };
  // A user type is named where it is registered, so an engine handle spelling
  // such as `b2Body` compares directly against the documented spelling before
  // any primitive mapping is attempted.
  if (declaredSet.size === derivedSet.size && [...derivedSet].every((type) => declaredSet.has(type))) {
    return { verdict: "agree", reason: null };
  }
  const declaredMapped = [...declaredSet].map((token) => ({ token, mapped: mapAtom(token) }));
  const derivedMapped = [...derivedSet].map((token) => ({ token, mapped: mapAtom(token) ?? token }));
  const unconstrained = declaredMapped.find((item) => item.mapped === null);
  if (unconstrained) return { verdict: "undecided", reason: "declared-type-is-unconstrained" };
  const unmappedDeclared = declaredMapped.filter((item) => item.mapped === undefined).map((item) => item.token).sort(compareText);
  const unmappedDerived = derivedMapped
    .filter((item) => !DERIVED_TYPE_VOCABULARY.has(item.mapped)).map((item) => item.token).sort(compareText);
  if (unmappedDeclared.length) return { verdict: "undecided", reason: `unmapped-declared-type:${unmappedDeclared[0]}` };
  if (unmappedDerived.length) return { verdict: "undecided", reason: `unmapped-derived-type:${unmappedDerived[0]}` };
  const declaredPrimitives = new Set(declaredMapped.map((item) => item.mapped));
  const derivedPrimitives = [...new Set(derivedMapped.map((item) => item.mapped))];
  const overlap = derivedPrimitives.filter((type) => declaredPrimitives.has(type));
  const render = (values) => [...values].sort(compareText).join("|");
  if (overlap.length === derivedPrimitives.length && declaredPrimitives.size === derivedPrimitives.length) {
    return { verdict: "agree", reason: null };
  }
  if (overlap.length) {
    return { verdict: "agree-partially", reason: `declared=${render(declaredPrimitives)} derived=${render(derivedPrimitives)}` };
  }
  return { verdict: "disagree", reason: `declared=${render(declaredPrimitives)} derived=${render(derivedPrimitives)}` };
}

// ---------------------------------------------------------------------------
// Target analysis.

function registeredRoutes(interpretation, project, helpers, blockers) {
  const routes = [];
  const constants = [];
  const commentedOut = [];
  for (const [module, record] of interpretation.modules) {
    for (const entry of record.functions) {
      const fullName = module ? `${module}.${entry.name}` : entry.name;
      const symbol = entry.cFunction.replace(/^[\w]+::/, "").trim();
      const all = project.functionsByName.get(symbol) ?? [];
      // A file-static C function is visible only in its own translation unit,
      // so the registration's own file wins before its directory does.
      const sameFile = all.filter((item) => item.path === entry.path);
      const directory = entry.path.slice(0, entry.path.lastIndexOf("/") + 1);
      const sameDirectory = all.filter((item) => item.path.startsWith(directory));
      const definitions = sameFile.length === 1 ? sameFile : sameDirectory.length === 1 ? sameDirectory : all;
      const route = {
        name: fullName,
        module,
        member: entry.name,
        cFunction: entry.cFunction,
        registration: { path: entry.path, line: entry.line, array: entry.array, guard: entry.guard ?? null }
      };
      if (definitions.length !== 1) {
        blockers.push({
          code: definitions.length ? "ambiguous-c-function" : "unresolved-c-function",
          route: fullName,
          path: entry.path,
          line: entry.line,
          detail: definitions.length
            ? `'${symbol}' has ${definitions.length} definitions: ${definitions.map((item) => `${item.path}:${item.line}`).join(", ")}`
            : `'${symbol}' has no visible definition, so its arity and argument types cannot be derived`
        });
        route.body = null;
        routes.push(route);
        continue;
      }
      // The `@name` annotation the implementation carries is an independent
      // claim about the same C symbol, so a mismatch with the registered
      // spelling means the documented name is not callable.
      const documented = documentedNameOf(definitions[0]);
      route.documentedName = documented
        ? { name: documented.name, line: documented.line, matchesRegistration: documented.name === fullName }
        : null;
      const analysis = analyzeFunctionBody(definitions[0], helpers, project);
      route.body = analysis;
      for (const item of analysis.undecided) {
        blockers.push({ code: item.code, route: fullName, path: analysis.path, line: analysis.line, detail: item.detail });
      }
      if (!analysis.results.decided) {
        blockers.push({
          code: "undecided-result-arity",
          route: fullName,
          path: analysis.path,
          line: analysis.line,
          detail: analysis.results.reason
        });
      }
      for (const parameter of analysis.parameters) {
        if (parameter.evidence !== "no-stack-access") continue;
        blockers.push({
          code: "argument-slot-without-stack-access",
          route: fullName,
          path: analysis.path,
          line: analysis.line,
          detail: `argument ${parameter.index} is inside the derived arity but no recognised stack accessor reads it`
        });
      }
      routes.push(route);
    }
    for (const entry of record.constants) {
      constants.push({ name: module ? `${module}.${entry.name}` : entry.name, module, member: entry.name, valueKind: entry.valueKind, expression: entry.expression, path: entry.path, line: entry.line });
    }
    for (const entry of record.commentedOut ?? []) {
      commentedOut.push({ name: module ? `${module}.${entry.name}` : entry.name, module, member: entry.name, cFunction: entry.cFunction, array: entry.array, path: entry.path, line: entry.line, evidence: entry.evidence });
    }
  }
  routes.sort((left, right) => compareText(left.name, right.name));
  constants.sort((left, right) => compareText(left.name, right.name));
  commentedOut.sort((left, right) => compareText(left.name, right.name));
  return { routes, constants, commentedOut };
}

// Codes for a body construct that leaves an argument position unread. Any of
// them means the derived argument window is a lower bound rather than a bound,
// so an arity or a missing-slot verdict read off it would be an artefact of the
// parse rather than a disagreement between the two descriptions.
const INDEX_UNDECIDABLE = new Set(["dynamic-stack-index", "relative-stack-index", "unresolved-helper-overload"]);

// A slot whose documented optionality and whose C body disagree. Naming the
// defect is the point: the two directions are not the same kind of problem, and
// only one of them makes a generated signature unsound.
function classifyOptionality(declaredParameter, derivedParameter) {
  if (declaredParameter.optional && !derivedParameter.optional) {
    // A requirement read off an accessor inside a branch holds only on that
    // branch, so it does not prove the engine refuses the omission. Refuse to
    // classify rather than correct a signature on conditional evidence.
    if (!derivedParameter.requirementUnconditional) {
      return {
        classification: "branch-dependent-requirement",
        defect: "undecided",
        severity: "undecided",
        correction: "none"
      };
    }
    // The documentation permits a call the engine refuses. A binding that
    // follows the declaration emits an optional parameter whose omission raises
    // a Lua error at runtime, so the declaration is what must give way.
    return {
      classification: "documentation-permits-refused-call",
      defect: "declaration",
      severity: "blocking",
      correction: "require-slot"
    };
  }
  if (derivedParameter.evidence === "defaulted") {
    // The C body defaults the slot with `luaL_opt*`. The engine advertises a
    // default the declaration withholds, so the declaration is narrower than the
    // implementation and widening it is safe.
    return {
      classification: "documentation-withholds-default",
      defect: "declaration",
      severity: "advisory",
      correction: "relax-slot"
    };
  }
  // The slot is read with a non-raising accessor or behind an explicit presence
  // guard: omitting the argument is not refused, it is silently substituted with
  // the accessor's zero value. The documented requirement is the narrower and
  // safer contract and following it emits no call the engine rejects, so this is
  // engine laxity to report rather than a signature to change.
  return {
    classification: derivedParameter.evidence === "presence-guarded"
      ? "engine-guards-omission"
      : "engine-tolerates-omission",
    defect: "neither",
    severity: "advisory",
    correction: "none"
  };
}

function diffRoute(registered, declared) {
  const analysis = registered.body;
  const parameters = [];
  let disagreements = 0;
  let undecided = 0;
  const declaredCount = declared.parameters.length;
  // A body the parser could not fully read cannot bound the argument window.
  const indexUndecidable = Boolean(analysis?.undecided.some((item) => INDEX_UNDECIDABLE.has(item.code)));
  const slots = Math.max(declaredCount, analysis ? analysis.arity.max : 0);
  for (let index = 0; index < slots; index += 1) {
    const declaredParameter = declared.parameters[index] ?? null;
    const derivedParameter = analysis ? analysis.parameters[index] ?? null : null;
    if (!declaredParameter) {
      parameters.push({ index: index + 1, declared: null, derived: derivedParameter, verdict: "registered-only" });
      disagreements += 1;
      continue;
    }
    if (!derivedParameter) {
      // Saying "documented but never read" needs the body to have been read to
      // the end of its argument window; an undecidable index means it was not.
      const decidable = analysis && !indexUndecidable;
      parameters.push({
        index: index + 1,
        declared: declaredParameter,
        derived: null,
        verdict: decidable ? "declared-only" : "undecided",
        reason: analysis ? (decidable ? null : "undecided-stack-index") : "no-body-analysis"
      });
      if (decidable) disagreements += 1; else undecided += 1;
      continue;
    }
    const type = compareParameterType(declaredParameter.type, derivedParameter.types);
    const optionalityVerdict = derivedParameter.optional === null
      ? { verdict: "undecided", reason: "no-stack-access" }
      : derivedParameter.optional === declaredParameter.optional
        ? { verdict: "agree", reason: null }
        : (() => {
          const classified = classifyOptionality(declaredParameter, derivedParameter);
          return {
            // A conditional requirement is not a disagreement: the parse could
            // not decide whether the engine refuses the omission.
            verdict: classified.severity === "undecided" ? "undecided" : "disagree",
            reason: `declared ${declaredParameter.optional ? "optional" : "required"}, derived ${derivedParameter.optional ? "optional" : "required"} from ${derivedParameter.evidence} accessor ${derivedParameter.accessors.join(",") || "<none>"}`,
            ...classified
          };
        })();
    const verdict = type.verdict === "disagree" || optionalityVerdict.verdict === "disagree"
      ? "disagree"
      : type.verdict === "undecided" || optionalityVerdict.verdict === "undecided"
        ? "undecided"
        : type.verdict;
    if (verdict === "disagree") disagreements += 1;
    if (verdict === "undecided") undecided += 1;
    parameters.push({
      index: index + 1,
      declared: { name: declaredParameter.name, optional: declaredParameter.optional, type: declaredParameter.type, optionalitySpelling: declaredParameter.optionalitySpelling ?? null },
      derived: { optional: derivedParameter.optional, types: derivedParameter.types, accessors: derivedParameter.accessors, evidence: derivedParameter.evidence },
      type: type,
      optionality: optionalityVerdict,
      verdict
    });
  }
  const declaredMinimum = declared.parameters.filter((parameter) => !parameter.optional).length;
  const arityVerdict = () => {
    // A slot the parser could not place leaves the derived window open at the
    // top, so neither bound can be compared with the declaration.
    if (indexUndecidable) return { verdict: "undecided", reason: "undecided-stack-index" };
    if (analysis.arity.max !== declaredCount) return { verdict: "disagree", reason: null };
    if (analysis.arity.min === declaredMinimum) return { verdict: "agree", reason: null };
    // The C body branches on the argument count, so its `luaL_check*` calls do
    // not settle the minimum. Report undecided, not agreement.
    return analysis.arity.branchDependent
      ? { verdict: "undecided", reason: "branch-dependent-minimum" }
      : { verdict: "disagree", reason: null };
  };
  const arity = analysis
    ? { derived: analysis.arity, declaredMinimum, declaredMaximum: declaredCount, ...arityVerdict() }
    : { derived: null, declaredMinimum, declaredMaximum: declaredCount, verdict: "undecided", reason: "no-body-analysis" };
  const results = analysis
    ? {
      derived: analysis.results.decided ? { min: analysis.results.min, max: analysis.results.max } : null,
      declared: declared.returns,
      verdict: !analysis.results.decided
        ? "undecided"
        : analysis.results.min === declared.returns && analysis.results.max === declared.returns ? "agree" : "disagree"
    }
    : { derived: null, declared: declared.returns, verdict: "undecided" };
  const verdict = !analysis
    ? "undecided"
    : disagreements || arity.verdict === "disagree" || results.verdict === "disagree"
      ? "disagree"
      : undecided || arity.verdict === "undecided" || results.verdict === "undecided"
        ? "partially-undecided"
        : "agree";
  return { parameters, arity, results, verdict, disagreements, undecided };
}

async function analyzeTarget(target, policy) {
  const collected = target.kind === "dependency-archive"
    ? await collectArchiveTarget(target)
    : await collectDirectoryTarget(target);

  const provenance = {
    root: target.root ?? null,
    archive: target.archive ?? null,
    archiveSha256: collected.archiveSha256 ?? null,
    archiveEntries: target.kind === "dependency-archive" ? collected.listing : null,
    declaredSurface: target.declared.kind === "script-ir" ? target.declared.path : collected.declarations.map((item) => item.path),
    sourceSha256: sha256(JSON.stringify(collected.sources.map((item) => [item.path, sha256(item.text)]))),
    variantExclusions: (target.excludeVariants ?? []).map((item) => ({ path: item.path, reason: item.reason }))
  };

  if (collected.sources.length === 0) {
    // Fail closed. A target that ships a declaration but no implementation
    // cannot be verified at all, and saying nothing would read as agreement.
    const declarationDiagnostics = [];
    const declaredRows = target.declared.kind === "script-api"
      ? declaredFromScriptApi(collected.declarations, declarationDiagnostics)
      : [];
    return {
      id: target.id,
      kind: target.kind,
      status: "unverifiable",
      inputs: provenance,
      summary: {
        sourceFiles: 0,
        headerFiles: collected.headers.length,
        declaredRoutes: declaredRows.length,
        registeredRoutes: null,
        verified: false
      },
      blockerHistogram: { "no-native-source-in-target": 1 },
      namespaces: {},
      registrationEntryPoints: [],
      stackBalancedCallees: [],
      routes: [],
      declaredButUnregistered: [],
      registeredButUndeclared: [],
      registeredConstants: [],
      commentedOutRegistrations: [],
      unverifiedDeclarations: declaredRows.map((row) => ({ name: row.name, source: row.source, missingFunctionType: row.missingFunctionType ?? false })),
      blockers: [{
        code: "no-native-source-in-target",
        route: null,
        path: target.root ?? target.archive ?? target.id,
        line: 0,
        detail: `${collected.declarations.length} .script_api declaration file(s) but no C/C++ implementation, so the registered surface cannot be derived and the declaration cannot be verified`
      }],
      diagnostics: declarationDiagnostics,
      policyNotes: target.notes ?? null
    };
  }

  const headerScope = target.sdkHeaderMatch ? new RegExp(target.sdkHeaderMatch) : null;
  const sdkHeaders = [];
  for (const header of collected.headers) {
    if (headerScope && !headerScope.test(header.path)) continue;
    sdkHeaders.push(header);
  }
  const externalHeaders = [];
  for (const path of target.externalSdkHeaderRoots ?? []) {
    for (const file of await walkDirectory(inputPath(path))) {
      if (!HEADER_EXTENSIONS.test(file)) continue;
      const relativePath = relative(inputPath(path), file).split(/[\\/]/).join("/");
      if (headerScope && !headerScope.test(relativePath)) continue;
      externalHeaders.push({ path: `${path}/${relativePath}`, text: await readFile(file, "utf8") });
    }
  }
  const declaredHelpers = collectSdkStackHelpers([...sdkHeaders, ...externalHeaders]);

  const project = buildProject(collected.sources);
  const userTypes = collectUserTypes(project);
  // Helpers declared in the SDK give the portable vocabulary; helpers defined in
  // the target's own sources are typed by reading their bodies, so a private
  // wrapper such as Box2D's CheckBody resolves to the user type it checks.
  const helpers = collectBodyDerivedHelpers(project, declaredHelpers, userTypes);
  const interpretation = interpretRegistrations(project);
  const blockers = [...interpretation.blockers.map((item) => ({ ...item, route: null }))];
  for (const file of project.files) for (const item of file.blockers) blockers.push({ ...item, route: null });
  const { routes, constants, commentedOut } = registeredRoutes(interpretation, project, helpers, blockers);
  const constantValues = deriveConstantValues([...collected.sources, ...collected.headers], constants);
  for (const constant of constants) {
    const value = constantValues.get(constant.name);
    if (value) Object.assign(constant, value);
  }

  const diagnostics = [];
  let declared;
  if (target.declared.kind === "script-ir") {
    const text = await readFile(inputPath(target.declared.path), "utf8");
    declared = declaredFromScriptIr(JSON.parse(text));
    diagnostics.push({ code: "declared-input", path: target.declared.path, detail: sha256(text) });
  } else if (target.declared.kind === "script-api") {
    assert(collected.declarations.length > 0, `${target.id}: no .script_api declarations were found`);
    declared = declaredFromScriptApi(collected.declarations, diagnostics);
  } else {
    fail(`${target.id}: unknown declared surface kind '${target.declared.kind}'`);
  }

  // Restrict the comparison to the namespaces the declaration knows about, and
  // report every other registered namespace separately. Both totals are
  // reported: hiding the vendored Lua runtime would be an allowlist.
  const declaredModules = new Set(declared.map((row) => row.module));
  const declaredByName = new Map(declared.map((row) => [row.name, row]));
  assert(declaredByName.size === declared.length, `${target.id}: declared surface contains duplicate names`);
  const registeredByName = new Map();
  for (const route of routes) {
    if (registeredByName.has(route.name)) {
      blockers.push({
        code: "duplicate-registration",
        route: route.name,
        path: route.registration.path,
        line: route.registration.line,
        detail: "the same fully-qualified name is registered more than once"
      });
      continue;
    }
    registeredByName.set(route.name, route);
  }

  const comparisons = [];
  const registeredButUndeclared = [];
  for (const route of routes) {
    const declaration = declaredByName.get(route.name);
    if (!declaration) {
      registeredButUndeclared.push({
        name: route.name,
        module: route.module,
        inDeclaredModule: declaredModules.has(route.module),
        cFunction: route.cFunction,
        registration: route.registration,
        // The `@name` the implementation carries. When it differs from the
        // registered spelling, this row is the callable half of a documented
        // name that is not.
        documentedName: route.documentedName ?? null,
        derivedArity: route.body?.arity ?? null
      });
      continue;
    }
    comparisons.push({
      name: route.name,
      module: route.module,
      cFunction: route.cFunction,
      registration: route.registration,
      documentedName: route.documentedName ?? null,
      declaration: { source: declaration.source, parameters: declaration.parameters.length, returns: declaration.returns, missingFunctionType: declaration.missingFunctionType ?? false },
      ...diffRoute(route, declaration)
    });
  }
  comparisons.sort((left, right) => compareText(left.name, right.name));
  registeredButUndeclared.sort((left, right) => compareText(left.name, right.name));

  const commentedByName = new Map(commentedOut.map((item) => [item.name, item]));
  const declaredButUnregistered = declared
    .filter((row) => !registeredByName.has(row.name))
    .map((row) => ({
      name: row.name,
      module: row.module,
      source: row.source,
      moduleIsRegistered: [...registeredByName.keys()].some((name) => name.startsWith(`${row.module}.`)),
      // A commented-out registration entry is positive evidence of absence.
      commentedOutRegistration: commentedByName.get(row.name) ?? null
    }))
    .sort((left, right) => compareText(left.name, right.name));

  for (const row of declaredButUnregistered) {
    if (row.commentedOutRegistration) continue;
    if (!row.moduleIsRegistered) {
      blockers.push({
        code: "declared-module-never-registered",
        route: row.name,
        path: row.source,
        line: 0,
        detail: `no registration array in this target registers any member of '${row.module}'`
      });
    }
  }

  blockers.sort((left, right) =>
    compareText(left.code, right.code) || compareText(left.route ?? "", right.route ?? "") ||
    compareText(left.path ?? "", right.path ?? "") || (left.line ?? 0) - (right.line ?? 0) ||
    compareText(left.detail ?? "", right.detail ?? ""));

  const inDeclaredModules = (route) => declaredModules.has(route.module);
  const summary = {
    sourceFiles: collected.sources.length,
    headerFiles: collected.headers.length,
    sdkStackHelpers: declaredHelpers.size,
    bodyDerivedStackHelpers: helpers.values().filter((item) => item.origin === "body").length,
    namedUserTypes: userTypes.size,
    registrationEntryPoints: interpretation.entryPoints.length,
    registeredNamespaces: interpretation.modules.size,
    registeredRoutes: routes.length,
    registeredRoutesInDeclaredNamespaces: routes.filter(inDeclaredModules).length,
    registeredConstants: constants.length,
    commentedOutRegistrations: commentedOut.length,
    declaredRoutes: declared.length,
    registeredAndDeclared: comparisons.length,
    agreeing: comparisons.filter((item) => item.verdict === "agree").length,
    partiallyUndecided: comparisons.filter((item) => item.verdict === "partially-undecided").length,
    disagreeing: comparisons.filter((item) => item.verdict === "disagree").length,
    undecided: comparisons.filter((item) => item.verdict === "undecided").length,
    declaredButUnregistered: declaredButUnregistered.length,
    registeredButUndeclared: registeredButUndeclared.length,
    registeredButUndeclaredInDeclaredNamespaces: registeredButUndeclared.filter((item) => item.inDeclaredModule).length,
    parameterSlotsCompared: comparisons.reduce((count, item) => count + item.parameters.length, 0),
    parameterSlotsDisagreeing: comparisons.reduce((count, item) =>
      count + item.parameters.filter((parameter) => parameter.verdict === "disagree" || parameter.verdict === "registered-only" || parameter.verdict === "declared-only").length, 0),
    parameterSlotsUndecided: comparisons.reduce((count, item) =>
      count + item.parameters.filter((parameter) => parameter.verdict === "undecided").length, 0),
    blockers: blockers.length,
    blockedRoutes: new Set(blockers.map((item) => item.route).filter(Boolean)).size
  };

  const blockerHistogram = {};
  for (const blocker of blockers) blockerHistogram[blocker.code] = (blockerHistogram[blocker.code] ?? 0) + 1;

  const namespaces = {};
  for (const [module, record] of [...interpretation.modules.entries()].sort(([left], [right]) => compareText(left, right))) {
    namespaces[module || "<globals>"] = {
      declared: declaredModules.has(module),
      registeredRoutes: record.functions.length,
      registeredConstants: record.constants.length,
      commentedOutRegistrations: (record.commentedOut ?? []).length,
      declaredRoutes: declared.filter((row) => row.module === module).length
    };
  }
  for (const module of [...declaredModules].sort(compareText)) {
    const key = module || "<globals>";
    if (namespaces[key]) continue;
    namespaces[key] = {
      declared: true,
      registeredRoutes: 0,
      registeredConstants: 0,
      commentedOutRegistrations: 0,
      declaredRoutes: declared.filter((row) => row.module === module).length
    };
  }

  return {
    id: target.id,
    kind: target.kind,
    status: "verified",
    inputs: provenance,
    summary,
    blockerHistogram,
    namespaces,
    registrationEntryPoints: interpretation.entryPoints,
    stackBalancedCallees: interpretation.balancedCallees,
    routes: comparisons,
    declaredButUnregistered,
    registeredButUndeclared,
    registeredConstants: constants,
    commentedOutRegistrations: commentedOut,
    blockers,
    diagnostics: diagnostics.sort((left, right) => compareText(left.code, right.code) || compareText(left.path, right.path)),
    policyNotes: target.notes ?? null
  };
}

// ---------------------------------------------------------------------------
// The gate. The report above is a description of two descriptions; this is the
// small, machine-readable subset a downstream generator may act on.
//
// Only findings backed by POSITIVE evidence in C source are gated. "The parser
// found no registration" is absence of evidence and has innocent explanations -
// a Lua-side module such as luasocket, a `go.property` declaration token, a
// build variant this target excludes - so it stays in the report and never
// reaches the gate. What does reach it is evidence that says what the source
// *does*: a registration array that registers the same C function under another
// name, a registration entry commented out, a C body that refuses a missing
// argument the declaration calls optional.
//
// Findings must hold in every engine target. The two Box2D builds are mutually
// exclusive link-time variants, so a route present in one and absent in the
// other is a variant fact, not a defect, and must not gate anything.
function buildGate(targets, engineTargetIds) {
  const perTarget = engineTargetIds.map((id) => {
    const target = targets[id];
    const unregistered = new Map(target.declaredButUnregistered.map((row) => [row.name, row]));
    const findings = new Map();
    const record = (route, finding) => {
      const existing = findings.get(route);
      if (!existing) findings.set(route, finding);
    };

    // A documented name whose implementation is registered under a different
    // spelling. Both halves are read out of the same translation unit: the
    // `@name` annotation above the C function, and the registration array entry
    // that names it.
    for (const row of target.registeredButUndeclared) {
      const documented = row.documentedName;
      if (!documented || documented.name === row.name) continue;
      if (!unregistered.has(documented.name)) continue;
      record(documented.name, {
        route: documented.name,
        kind: "registered-under-a-different-name",
        action: "use-registered-name",
        callableAs: row.name,
        parameter: null,
        reason: `documented as '${documented.name}' but '${row.cFunction}' is registered as '${row.name}'`,
        evidence: {
          target: id,
          documentedAt: `${row.registration.path}:${documented.line}`,
          registeredAt: `${row.registration.path}:${row.registration.line}`,
          registrationArray: row.registration.array
        }
      });
    }

    // A registration entry that exists in the source but is commented out.
    for (const row of target.declaredButUnregistered) {
      const commented = row.commentedOutRegistration;
      if (!commented) continue;
      record(row.name, {
        route: row.name,
        kind: "registration-commented-out",
        action: "mark-source-unavailable",
        callableAs: null,
        parameter: null,
        reason: `the registration entry for '${row.name}' is present but commented out`,
        evidence: {
          target: id,
          documentedAt: row.source,
          registeredAt: `${commented.path}:${commented.line}`,
          registrationArray: commented.array
        }
      });
    }

    // A slot the declaration calls optional whose C body refuses its omission on
    // every path. Following the declaration would emit an optional parameter
    // whose absence raises a Lua error.
    for (const route of target.routes) {
      for (const parameter of route.parameters ?? []) {
        if (parameter.optionality?.correction !== "require-slot") continue;
        record(`${route.name}#${parameter.index}`, {
          route: route.name,
          kind: "documented-optional-slot-required-by-c",
          action: "require-parameter",
          callableAs: null,
          parameter: { index: parameter.index, name: parameter.declared?.name ?? null },
          reason: parameter.optionality.reason,
          evidence: {
            target: id,
            documentedAt: route.declaration.source,
            registeredAt: `${route.registration.path}:${route.registration.line}`,
            accessors: parameter.derived?.accessors ?? []
          }
        });
      }
    }
    return findings;
  });

  // Intersect: a finding gates only where every engine target reaches it.
  const [first, ...rest] = perTarget;
  const findings = [];
  for (const [key, finding] of first ?? new Map()) {
    const agreeing = rest.every((other) => other.get(key)?.kind === finding.kind);
    if (!agreeing) continue;
    findings.push({ ...finding, evidence: [finding.evidence, ...rest.map((other) => other.get(key).evidence)] });
  }
  findings.sort((left, right) =>
    compareText(left.route, right.route) ||
    (left.parameter?.index ?? 0) - (right.parameter?.index ?? 0) ||
    compareText(left.kind, right.kind));

  const countBy = (selector) => {
    const counts = {};
    for (const finding of findings) counts[selector(finding)] = (counts[selector(finding)] ?? 0) + 1;
    return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => compareText(left, right)));
  };
  return {
    findings,
    counts: {
      findings: findings.length,
      routesRemapped: new Set(findings.filter((item) => item.action === "use-registered-name").map((item) => item.route)).size,
      routesSourceUnavailable: new Set(findings.filter((item) => item.action === "mark-source-unavailable").map((item) => item.route)).size,
      parametersCorrected: findings.filter((item) => item.action === "require-parameter").length,
      byKind: countBy((item) => item.kind),
      byAction: countBy((item) => item.action)
    }
  };
}

async function generate(options) {
  const policyText = await readFile(inputPath(options.policy), "utf8");
  const policy = JSON.parse(policyText);
  assert(policy.schemaVersion === 1, "unsupported policy schema");
  assert(Array.isArray(policy.targets) && policy.targets.length, "policy declares no targets");
  // The revision this report speaks for is the one `upstream.lock` pins, because
  // that is the checkout whose C sources are about to be parsed. It used to be
  // whatever the reviewed target policy said, which was never compared against
  // anything: a reviewed file could name one revision while the parse read
  // another, and nothing downstream could tell.
  const lock = await readFile(join(repositoryRoot, "upstream.lock"), "utf8");
  const defoldRevision = lock.match(/^DEFOLD_REV=([0-9a-f]{40})$/m)?.[1];
  assert(defoldRevision, "upstream.lock does not pin an exact Defold revision");
  assertReviewedRevision({
    input: options.policy,
    reviewed: policy.defoldRevision,
    derived: defoldRevision,
    detail: "the reviewed registration-surface targets and their source roots"
  });

  const targets = {};
  for (const target of policy.targets) {
    if (options.only && target.id !== options.only) continue;
    targets[target.id] = await analyzeTarget(target, policy);
  }
  assert(Object.keys(targets).length, `no target matched${options.only ? ` '${options.only}'` : ""}`);

  const totals = {};
  for (const [id, target] of Object.entries(targets)) totals[id] = target.summary;

  const report = {
    schemaVersion: 1,
    generator: "scripts/generate-lua-registration-surface.mjs",
    defoldRevision,
    contract: {
      groundTruth: "The Lua C API registration arrays and the C function bodies that read the Lua stack.",
      declaredSurface: "The `.script_api` declaration, or the pinned script API IR for the engine.",
      failClosed: "A C construct the parser cannot decide is recorded in `blockers` with its reason and never counted as agreement."
    },
    inputEvidence: { policy: options.policy, policySha256: sha256(policyText) },
    totals,
    targets
  };
  const surface = `${JSON.stringify(report, null, 2)}\n`;

  // Constant values are additive realization evidence. They must not churn
  // the route-registration gate (and every downstream route-evidence digest)
  // when the registered route surface itself is unchanged.
  const gateSourceReport = structuredClone(report);
  for (const target of Object.values(gateSourceReport.targets)) {
    for (const constant of target.registeredConstants ?? []) {
      delete constant.value;
      delete constant.source;
    }
  }

  // The gate only speaks for the engine, whose targets are the mutually
  // exclusive build variants of one tree. An extension target is a separate
  // product with its own emission decision, and an unverifiable target has no
  // evidence to gate with.
  const engineTargetIds = Object.entries(targets)
    .filter(([, target]) => target.kind === "engine-tree" && target.status === "verified")
    .map(([id]) => id)
    .sort(compareText);
  const gated = engineTargetIds.length ? buildGate(targets, engineTargetIds) : { findings: [], counts: null };
  const gate = {
    schemaVersion: 1,
    generator: "scripts/generate-lua-registration-surface.mjs",
    defoldRevision,
    scope: "The subset of the registered-vs-declared findings that a downstream generator may act on: each one is backed by positive evidence in C source and holds in every mutually exclusive engine build variant. Absence of a registration is reported in the surface report and never gated.",
    actions: {
      "use-registered-name": "The engine source registers this function under a different name. Emit the documented TypeScript surface and dispatch it through the registered source name.",
      "mark-source-unavailable": "Positive source evidence says this route is not registered in every selected engine variant. Keep the API and machinery emitted, but mark the affected profile unavailable.",
      "require-parameter": "The documented parameter is optional but the C body refuses its omission on every path. A generated signature must mark it required, or block the route."
    },
    sourceReport: defaultOutput,
    sourceReportSha256: sha256(`${JSON.stringify(gateSourceReport, null, 2)}\n`),
    engineTargets: engineTargetIds,
    counts: gated.counts,
    findings: gated.findings
  };
  return { surface, gate: `${JSON.stringify(gate, null, 2)}\n` };
}

const options = parseArgs(process.argv.slice(2));
const generated = await generate(options);
const outputs = [[defaultOutput, generated.surface], [gateOutput, generated.gate]];
for (const [relativePath, text] of outputs) {
  const destination = join(options.outRoot, relativePath);
  if (options.check) {
    const current = await readFile(destination, "utf8");
    assert(current === text, `${relativePath} is stale; regenerate it`);
    continue;
  }
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, text);
}
