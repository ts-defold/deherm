import { createHash } from "node:crypto";

import { extractCppOwnershipEffectFacts, validateCppOwnershipEffectFact } from "./cpp-ownership-effect-facts.mjs";

export const DMSDK_CPP_OWNERSHIP_EFFECT_FRONTEND_KIND = "deherm.dmsdk-cpp-ownership-effect-frontend";
export const DMSDK_CPP_OWNERSHIP_EFFECT_REPORT_KIND = "deherm.dmsdk-cpp-ownership-effect-facts";

const CALLABLE_KINDS = new Set(["FunctionDecl", "CXXMethodDecl", "CXXConstructorDecl", "CXXDestructorDecl"]);
const compareCodeUnits = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function exactKeys(value, expected, label) {
  assert(object(value), `${label} must be an object`);
  const actual = Object.keys(value).sort(compareCodeUnits);
  const wanted = [...expected].sort(compareCodeUnits);
  assert(
    JSON.stringify(actual) === JSON.stringify(wanted),
    `${label} has unsupported schema keys: ${actual.join(", ")}`,
  );
}

function normalizedPath(value) {
  return String(value ?? "").replaceAll("\\", "/");
}

function canonicalEvidencePath(value, fallback) {
  const normalized = normalizedPath(value);
  const stableFallback = normalizedPath(fallback);
  if (!normalized || sameFile(normalized, stableFallback)) return stableFallback;
  const aliasMarker = "/.deherm/cache/dmsdk-semantic-includes/";
  const aliasIndex = normalized.lastIndexOf(aliasMarker);
  if (aliasIndex >= 0) {
    const relative = normalized.slice(aliasIndex + aliasMarker.length).split("/").slice(1).join("/");
    return `<source-alias-overlay>/${relative}`;
  }
  for (const marker of ["/upstream/", "/packages/"]) {
    const index = normalized.lastIndexOf(marker);
    if (index >= 0) return normalized.slice(index + 1);
  }
  return normalized;
}

function astLocation(node, sourcePath) {
  const loc = node?.loc ?? {};
  const file = loc.file ?? loc.includedFrom?.file ?? sourcePath;
  return {
    file: canonicalEvidencePath(file, sourcePath),
    line: Number(loc.line ?? 0),
    column: Number(loc.col ?? 0),
  };
}

function sameFile(actual, expected) {
  const left = normalizedPath(actual);
  const right = normalizedPath(expected);
  return left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`);
}

function qualifiedName(scope, name) {
  return [...scope, name].filter(Boolean).join("::");
}

function canonicalCallableIdentity(row, sourcePath, header = false) {
  const location = header ? { line: row.location.line } : { line: row.location.line, column: row.location.column };
  return sha256(
    JSON.stringify({
      schemaVersion: 1,
      kind: row.kind,
      name: row.name,
      mangledName: row.mangledName,
      type: row.type,
      parameterCount: row.parameterCount,
      sourcePath: normalizedPath(sourcePath),
      location,
    }),
  );
}

function parameterCount(node) {
  return (node?.inner ?? []).filter(({ kind }) => kind === "ParmVarDecl").length;
}

function collectCallables(ast, sourcePath) {
  const rows = [];
  function visit(node, scope = []) {
    if (!node || typeof node !== "object") return;
    const nextScope =
      node.kind === "NamespaceDecl" || node.kind === "CXXRecordDecl" ? [...scope, node.name].filter(Boolean) : scope;
    if (CALLABLE_KINDS.has(node.kind) && node.name && node.id) {
      rows.push({
        id: node.id,
        name: qualifiedName(scope, node.name),
        mangledName: node.mangledName ?? null,
        type: node.type?.qualType ?? "",
        kind: node.kind,
        parameterCount: parameterCount(node),
        hasBody: (node.inner ?? []).some(({ kind }) => kind === "CompoundStmt"),
        location: astLocation(node, sourcePath),
      });
    }
    for (const child of node.inner ?? []) visit(child, nextScope);
  }
  visit(ast);
  return rows;
}

function candidateRows(callables, declaration, sourcePath, includedHeaders = []) {
  const matching = callables.filter(
    (row) => row.name === declaration.name && row.parameterCount === (declaration.parameters ?? []).length,
  );
  const forcedHeader = includedHeaders.filter((header) => sameFile(header, declaration.header));
  const headerDeclarations = matching.filter(
    (row) =>
      row.location.line === declaration.line &&
      (sameFile(row.location.file, declaration.header) || forcedHeader.length === 1),
  );
  const definitions = matching.filter((row) => row.hasBody);
  const declaredSymbols = new Set(
    [declaration.mangledName, ...Object.values(declaration.mangledNames ?? {})].filter(Boolean),
  );
  const symbolDefinitions = definitions.filter(
    (row) => row.mangledName && declaredSymbols.has(row.mangledName),
  );
  return { matching, headerDeclarations, definitions, symbolDefinitions };
}

function canonicalSourceDeclarationIdentity(declaration) {
  return sha256(
    JSON.stringify({
      schemaVersion: 1,
      id: declaration.id,
      name: declaration.name,
      header: normalizedPath(declaration.header),
      line: declaration.line,
      mangledName: declaration.mangledName ?? null,
      mangledNames: Object.entries(declaration.mangledNames ?? {}).sort(([left], [right]) =>
        compareCodeUnits(left, right),
      ),
      type: declaration.type ?? "",
    }),
  );
}

function unknownRow(declaration, sourcePath, diagnostics) {
  return {
    declarationId: declaration.id,
    name: declaration.name,
    header: declaration.header,
    line: declaration.line,
    state: "unknown",
    ast: null,
    fact: null,
    diagnostics: [...new Set(diagnostics)].sort(compareCodeUnits),
    sourcePath,
  };
}

/**
 * Bind source-identity declarations to a complete Clang AST, then run the
 * package-owned effect extractor against the exact AST declaration identity.
 * A missing/ambiguous identity never becomes a positive fact: it is emitted as
 * an explicit unknown row for the policy layer to route to universal fallback.
 */
export function deriveDmSdkCppOwnershipEffectFacts({
  ast,
  declarations,
  sourcePath,
  sourceText = "",
  translationUnitText = "",
  externalCalleeRules = {},
  includedHeaders = [],
}) {
  assert(ast && typeof ast === "object", "ownership/effect frontend requires a complete Clang AST");
  assert(typeof sourcePath === "string" && sourcePath.length > 0, "ownership/effect frontend requires sourcePath");
  assert(Array.isArray(declarations), "ownership/effect frontend declarations must be an array");
  const callables = collectCallables(ast, sourcePath);
  const functions = [];
  for (const declaration of [...declarations].sort((left, right) => compareCodeUnits(left.id, right.id))) {
    const { matching, headerDeclarations, definitions, symbolDefinitions } = candidateRows(
      callables,
      declaration,
      sourcePath,
      includedHeaders,
    );
    if (headerDeclarations.length > 1) {
      functions.push(
        unknownRow(
          declaration,
          sourcePath,
          ["header-declaration-ambiguous"],
        ),
      );
      continue;
    }
    const joinedDefinitions = headerDeclarations.length === 1 ? definitions : symbolDefinitions;
    if (joinedDefinitions.length !== 1) {
      functions.push(
        unknownRow(
          declaration,
          sourcePath,
          joinedDefinitions.length === 0
            ? [headerDeclarations.length === 0 ? "implementation-symbol-not-found" : "implementation-not-found"]
            : ["implementation-ambiguous"],
        ),
      );
      continue;
    }
    const definition = joinedDefinitions[0];
    const extracted = extractCppOwnershipEffectFacts(ast, [definition.id], { externalCalleeRules });
    const fact = extracted.functions[0];
    validateCppOwnershipEffectFact(fact);
    functions.push({
      declarationId: declaration.id,
      name: declaration.name,
      header: declaration.header,
      line: declaration.line,
      state: "observed",
      sourcePath,
      ast: {
        join: headerDeclarations.length === 1 ? "header-location" : "mangled-symbol",
        headerDeclarationId:
          headerDeclarations.length === 1
            ? canonicalCallableIdentity(headerDeclarations[0], declaration.header, true)
            : canonicalSourceDeclarationIdentity(declaration),
        definitionId: canonicalCallableIdentity(definition, sourcePath),
        definitionFile: definition.location.file,
        definitionLine: definition.location.line,
      },
      fact: { ...fact, declarationId: declaration.id },
      diagnostics: [],
    });
    // `matching` is intentionally evaluated above. It protects this frontend
    // from silently accepting an unrelated same-spelled overload when the
    // source IR changes its parameter count.
    assert(matching.length >= headerDeclarations.length, `${declaration.id}: callable identity index is inconsistent`);
  }
  const artifact = {
    schemaVersion: 1,
    kind: DMSDK_CPP_OWNERSHIP_EFFECT_FRONTEND_KIND,
    sourcePath,
    sourceSha256: sha256(sourceText),
    translationUnitSha256: sha256(translationUnitText),
    functions: functions.sort((left, right) => compareCodeUnits(left.declarationId, right.declarationId)),
  };
  validateDmSdkCppOwnershipEffectFrontend(artifact);
  return artifact;
}

export function validateDmSdkCppOwnershipEffectFrontend(artifact) {
  exactKeys(
    artifact,
    ["schemaVersion", "kind", "sourcePath", "sourceSha256", "translationUnitSha256", "functions"],
    "dmSDK C++ ownership/effect frontend artifact",
  );
  assert(
    artifact.schemaVersion === 1 && artifact.kind === DMSDK_CPP_OWNERSHIP_EFFECT_FRONTEND_KIND,
    "invalid frontend artifact identity",
  );
  assert(typeof artifact.sourcePath === "string" && artifact.sourcePath.length > 0, "frontend source path is invalid");
  for (const hash of [artifact.sourceSha256, artifact.translationUnitSha256]) {
    assert(/^[a-f0-9]{64}$/u.test(hash), "frontend source hash is invalid");
  }
  assert(Array.isArray(artifact.functions), "frontend functions are invalid");
  let previous = "";
  for (const row of artifact.functions) {
    exactKeys(
      row,
      ["declarationId", "name", "header", "line", "state", "sourcePath", "ast", "fact", "diagnostics"],
      "frontend function",
    );
    assert(
      typeof row.declarationId === "string" && row.declarationId > previous,
      "frontend functions are not canonical",
    );
    previous = row.declarationId;
    assert(["observed", "unknown"].includes(row.state), `${row.declarationId}: invalid frontend state`);
    assert(
      Array.isArray(row.diagnostics) && row.diagnostics.every((diagnostic) => typeof diagnostic === "string"),
      `${row.declarationId}: invalid frontend diagnostics`,
    );
    if (row.state === "observed") {
      assert(
        object(row.ast) && row.ast.headerDeclarationId && row.ast.definitionId,
        `${row.declarationId}: observed AST identity is missing`,
      );
      validateCppOwnershipEffectFact(row.fact);
      assert(
        row.fact.declarationId === row.declarationId,
        `${row.declarationId}: fact identity differs from source identity`,
      );
    } else {
      assert(
        row.fact === null && row.ast === null && row.diagnostics.length > 0,
        `${row.declarationId}: unknown row must fail closed`,
      );
    }
  }
  return artifact;
}

export function validateDmSdkCppOwnershipEffectReport(report) {
  exactKeys(
    report,
    [
      "schemaVersion",
      "kind",
      "defoldRevision",
      "extraction",
      "admission",
      "targetProfiles",
      "inputs",
      "sources",
      "coverage",
      "functions",
    ],
    "dmSDK C++ ownership/effect report",
  );
  assert(
    report.schemaVersion === 2 && report.kind === DMSDK_CPP_OWNERSHIP_EFFECT_REPORT_KIND,
    "invalid ownership/effect report identity",
  );
  assert(
    report.admission === "audit-only-single-profile",
    "ownership/effect report must remain audit-only until target profiles join",
  );
  assert(
    Array.isArray(report.targetProfiles) && report.targetProfiles.length > 0,
    "ownership/effect target profile evidence is missing",
  );
  exactKeys(
    report.inputs,
    ["ir", "shapes", "policy", "scratchPolicy", "sourceCount", "includeRoots", "includeAliases", "clang"],
    "ownership/effect report inputs",
  );
  for (const hash of [report.inputs.ir, report.inputs.shapes, report.inputs.policy, report.inputs.scratchPolicy])
    assert(/^[a-f0-9]{64}$/u.test(hash), "ownership/effect input hash is invalid");
  assert(Array.isArray(report.inputs.includeAliases), "ownership/effect include aliases are invalid");
  let previousAlias = "";
  for (const alias of report.inputs.includeAliases) {
    exactKeys(alias, ["include", "source", "sourceSha256"], "ownership/effect include alias");
    assert(alias.include > previousAlias, "ownership/effect include aliases are not canonical");
    previousAlias = alias.include;
    assert(/^[a-f0-9]{64}$/u.test(alias.sourceSha256), "ownership/effect include alias hash is invalid");
  }
  assert(Array.isArray(report.sources), "ownership/effect report sources are invalid");
  for (const source of report.sources) {
    exactKeys(
      source,
      ["path", "sourceSha256", "translationUnitSha256", "astState", "blockers"],
      "ownership/effect source",
    );
    assert(/^[a-f0-9]{64}$/u.test(source.sourceSha256), "ownership/effect source hash is invalid");
    assert(
      /^[a-f0-9]{64}$/u.test(source.translationUnitSha256),
      "ownership/effect translation-unit hash is invalid",
    );
    assert(
      ["complete", "rejected-with-diagnostics"].includes(source.astState),
      "ownership/effect source state is invalid",
    );
    assert(
      Array.isArray(source.blockers) &&
        source.blockers.every((blocker) => typeof blocker === "string" && blocker.length > 0),
      "ownership/effect source blockers are invalid",
    );
    assert(
      source.astState === "complete" ? source.blockers.length === 0 : source.blockers.length > 0,
      "ownership/effect source state and blockers disagree",
    );
  }
  exactKeys(report.coverage, ["requested", "observed", "unknown", "envelopes"], "ownership/effect coverage");
  assert(report.coverage.requested === report.functions.length, "ownership/effect report coverage differs");
  assert(
    report.coverage.observed + report.coverage.unknown === report.coverage.requested,
    "ownership/effect report coverage is not exhaustive",
  );
  let previous = "";
  for (const row of report.functions) {
    exactKeys(
      row,
      ["declarationId", "name", "header", "line", "envelopes", "state", "fact", "observations", "diagnostics"],
      "ownership/effect function",
    );
    assert(
      typeof row.declarationId === "string" && row.declarationId > previous,
      "ownership/effect functions are not canonical",
    );
    previous = row.declarationId;
    assert(Array.isArray(row.envelopes) && row.envelopes.length > 0, `${row.declarationId}: envelopes are missing`);
    assert(row.state === "observed" || row.state === "unknown", `${row.declarationId}: invalid ownership/effect state`);
    if (row.state === "observed") validateCppOwnershipEffectFact(row.fact);
    else
      assert(row.fact === null && row.diagnostics.length > 0, `${row.declarationId}: unknown row is not fail-closed`);
    for (const observation of row.observations) {
      exactKeys(
        observation,
        ["sourcePath", "sourceSha256", "translationUnitSha256", "ast"],
        `${row.declarationId}: observation`,
      );
      assert(
        /^[a-f0-9]{64}$/u.test(observation.sourceSha256) && /^[a-f0-9]{64}$/u.test(observation.translationUnitSha256),
        `${row.declarationId}: observation hashes are invalid`,
      );
    }
  }
  return report;
}
