import { createHash } from "node:crypto";

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freeze(child);
  return value;
}

function unwrap(node) {
  let current = node;
  const transparent = new Set([
    "CStyleCastExpr",
    "ConstantExpr",
    "ExprWithCleanups",
    "ImplicitCastExpr",
    "MaterializeTemporaryExpr",
    "ParenExpr",
    "StaticCastExpr",
  ]);
  while (transparent.has(current?.kind) && current.inner?.length === 1) [current] = current.inner;
  return current;
}

function declarationReference(node, parameters) {
  const current = unwrap(node);
  if (!current) return { kind: "unresolved" };
  if (current.kind === "IntegerLiteral") {
    const value = Number(current.value);
    return Number.isSafeInteger(value) ? { kind: "integer", value } : { kind: "integer", value: current.value };
  }
  if (current.kind === "CXXBoolLiteralExpr") return { kind: "boolean", value: Boolean(current.value) };
  if (current.kind === "CharacterLiteral") return { kind: "character", value: Number(current.value) };
  if (current.kind === "StringLiteral") return { kind: "string", value: current.value ?? "" };
  if (current.kind === "GNUNullExpr" || current.kind === "CXXNullPtrLiteralExpr") return { kind: "null" };
  if (current.kind === "DeclRefExpr") {
    const referenced = current.referencedDecl ?? {};
    if (referenced.kind === "ParmVarDecl" && parameters.has(referenced.id)) {
      const parameter = parameters.get(referenced.id);
      return { kind: "parameter", index: parameter.index, name: parameter.name };
    }
    if (referenced.kind === "EnumConstantDecl") return { kind: "enum-constant", name: referenced.name };
    if (referenced.kind === "FunctionDecl") return { kind: "function", name: referenced.name };
    if (referenced.kind === "VarDecl") return { kind: "variable", name: referenced.name };
    return { kind: "declaration", declarationKind: referenced.kind ?? "unknown", name: referenced.name ?? "" };
  }
  if (current.kind === "UnaryOperator" && current.inner?.length === 1) {
    return { kind: "unary", operator: current.opcode ?? "", operand: declarationReference(current.inner[0], parameters) };
  }
  if (current.kind === "MemberExpr") {
    return {
      kind: "member",
      name: current.name ?? "",
      base: current.inner?.length ? declarationReference(current.inner[0], parameters) : null,
    };
  }
  if (current.kind === "ArraySubscriptExpr" && current.inner?.length === 2) {
    return {
      kind: "subscript",
      base: declarationReference(current.inner[0], parameters),
      index: declarationReference(current.inner[1], parameters),
    };
  }
  if (current.kind === "BinaryOperator" && current.inner?.length === 2) {
    return {
      kind: "binary",
      operator: current.opcode ?? "",
      left: declarationReference(current.inner[0], parameters),
      right: declarationReference(current.inner[1], parameters),
    };
  }
  if (current.kind === "UnaryExprOrTypeTraitExpr") {
    return { kind: current.name === "sizeof" ? "sizeof" : "type-trait", type: current.argType?.qualType ?? null };
  }
  return { kind: "expression", expressionKind: current.kind ?? "unknown" };
}

function calleeName(node) {
  const current = unwrap(node);
  if (!current) return null;
  if (current.kind === "DeclRefExpr" && current.referencedDecl?.kind === "FunctionDecl") {
    return current.referencedDecl.name ?? null;
  }
  if (current.kind === "MemberExpr") return current.name ?? null;
  if (current.kind === "UnresolvedLookupExpr") return current.name ?? null;
  for (const child of current.inner ?? []) {
    const name = calleeName(child);
    if (name) return name;
  }
  return null;
}

function callFacts(body, parameters) {
  const calls = [];
  function visit(node) {
    if (node.kind === "CallExpr" || node.kind === "CXXMemberCallExpr" || node.kind === "RecoveryExpr") {
      const [callee, ...arguments_] = node.inner ?? [];
      const name = calleeName(callee);
      if (name) calls.push({ callee: name, arguments: arguments_.map((argument) => declarationReference(argument, parameters)) });
    }
    for (const child of node.inner ?? []) visit(child);
  }
  visit(body);
  return calls;
}

function localFixedArrays(body) {
  const arrays = [];
  function visit(node) {
    if (node.kind === "VarDecl") {
      const type = node.type?.qualType ?? "";
      const match = type.match(/\[(\d+)\]$/u);
      if (match) {
        const elementType = type.slice(0, type.lastIndexOf("[")).trim();
        const widths = new Map([
          ["char", 1], ["signed char", 1], ["unsigned char", 1], ["int8_t", 1], ["uint8_t", 1],
          ["int16_t", 2], ["uint16_t", 2], ["int32_t", 4], ["uint32_t", 4], ["int64_t", 8], ["uint64_t", 8],
        ]);
        const extent = Number(match[1]);
        arrays.push({
          name: node.name ?? "",
          type,
          elementType,
          extent,
          ...(widths.has(elementType) ? { byteExtent: widths.get(elementType) * extent } : {}),
        });
      }
    }
    for (const child of node.inner ?? []) visit(child);
  }
  visit(body);
  return arrays;
}

function operationFacts(body, parameters) {
  const operations = [];
  const returns = [];
  function visit(node) {
    if (node.kind === "BinaryOperator" && node.inner?.length === 2) {
      operations.push({
        operator: node.opcode ?? "",
        left: declarationReference(node.inner[0], parameters),
        right: declarationReference(node.inner[1], parameters),
      });
    } else if (node.kind === "ReturnStmt") {
      returns.push(node.inner?.length ? declarationReference(node.inner[0], parameters) : { kind: "void" });
    }
    for (const child of node.inner ?? []) visit(child);
  }
  visit(body);
  return { operations, returns };
}

/**
 * Project a Clang JSON AST into compact, revision-carrying implementation facts.
 * The output intentionally keeps dataflow relationships (parameter forwarding,
 * constants and callees) rather than source text or a compiler-specific AST.
 */
export function extractCppImplementationFacts(ast, requestedNames, source) {
  const requested = new Set(requestedNames);
  const allDefinitions = [];

  function visit(node, scope = []) {
    const nextScope = node.kind === "NamespaceDecl" && node.name ? [...scope, node.name] : scope;
    if (node.kind === "FunctionDecl" && node.name) {
      const qualifiedName = [...nextScope, node.name].join("::");
      const body = (node.inner ?? []).find(({ kind }) => kind === "CompoundStmt");
      if (body) {
        const parameterNodes = (node.inner ?? []).filter(({ kind }) => kind === "ParmVarDecl");
        const parameters = new Map(
          parameterNodes.map((parameter, index) => [parameter.id, { index, name: parameter.name ?? `arg${index}` }]),
        );
        const operation = operationFacts(body, parameters);
        allDefinitions.push({
          name: qualifiedName,
          type: node.type?.qualType ?? "",
          source,
          line: node.loc?.line ?? node.range?.begin?.line ?? null,
          calls: callFacts(body, parameters),
          fixedArrays: localFixedArrays(body),
          operations: operation.operations,
          returns: operation.returns,
        });
      }
    }
    for (const child of node.inner ?? []) visit(child, nextScope);
  }

  visit(ast);
  const definitionsByLeaf = new Map();
  for (const definition of allDefinitions) {
    const leaf = definition.name.split("::").at(-1);
    const entries = definitionsByLeaf.get(leaf) ?? [];
    entries.push(definition);
    definitionsByLeaf.set(leaf, entries);
  }
  function reachableFrom(root) {
    const namespace = root.name.split("::").slice(0, -1).join("::");
    const visited = new Set([root.name]);
    const queue = [...root.calls];
    const reachable = [];
    while (queue.length) {
      const call = queue.shift();
      const matches = definitionsByLeaf.get(call.callee) ?? [];
      const sameNamespace = matches.filter(({ name }) => name.split("::").slice(0, -1).join("::") === namespace);
      const selected = sameNamespace.length === 1 ? sameNamespace[0] : matches.length === 1 ? matches[0] : null;
      if (!selected || visited.has(selected.name)) continue;
      visited.add(selected.name);
      reachable.push(selected);
      queue.push(...selected.calls);
    }
    return reachable.sort((left, right) => compareCodeUnits(left.name, right.name) || (left.line ?? 0) - (right.line ?? 0));
  }
  const definitions = allDefinitions
    .filter(({ name }) => requested.has(name))
    .map((definition) => ({ ...definition, reachableDefinitions: reachableFrom(definition) }));
  definitions.sort((left, right) =>
    compareCodeUnits(left.name, right.name) || compareCodeUnits(left.source, right.source) || (left.line ?? 0) - (right.line ?? 0),
  );
  return freeze(definitions);
}

function forwardedSuffix(call, parameterCount) {
  const arguments_ = call.arguments ?? [];
  for (let start = 0; start <= arguments_.length - parameterCount; start += 1) {
    if (
      arguments_.slice(start, start + parameterCount).every(
        (argument, index) => argument.kind === "parameter" && argument.index === index,
      )
    ) {
      return { start, before: arguments_.slice(0, start), after: arguments_.slice(start + parameterCount) };
    }
  }
  return null;
}

/**
 * Resolve a fixed byte extent from implementation dataflow. A qualifying body
 * forwards every public parameter, in order, to a helper and supplies exactly
 * one additional positive integer after them. Multiple agreeing definitions
 * corroborate one fact; disagreement is reported rather than guessed through.
 */
export function inferForwardedFixedOutputExtent(definitions, parameterCount) {
  const observations = [];
  for (const definition of definitions ?? []) {
    for (const call of definition.calls ?? []) {
      const forwarding = forwardedSuffix(call, parameterCount);
      if (!forwarding || forwarding.after.length !== 1 || forwarding.after[0].kind !== "integer") continue;
      const bytes = Number(forwarding.after[0].value);
      if (!Number.isSafeInteger(bytes) || bytes <= 0) continue;
      observations.push({
        bytes,
        source: definition.source,
        line: definition.line,
        callee: call.callee,
        leadingArguments: forwarding.before,
      });
    }
  }
  const values = [...new Set(observations.map(({ bytes }) => bytes))].sort((left, right) => left - right);
  if (values.length !== 1) {
    return freeze({
      state: values.length === 0 ? "absent" : "contradictory",
      values,
      observations,
    });
  }
  return freeze({ state: "resolved", bytes: values[0], observations });
}

export function sourceFactDigest(value) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

/**
 * Authenticate one generated semantic-fact artifact against the exact IR and
 * ABI-shape census it was derived from, then provide deterministic lookup by
 * declaration id. Emitters call this instead of independently reimplementing
 * the policy/source provenance boundary.
 */
export function indexCppSemanticFactArtifact(artifact, { revision, irText, shapesText }) {
  if (artifact?.schemaVersion !== 1) throw new Error("Unsupported C++ semantic-fact schema");
  if (artifact.defoldRevision !== revision) {
    throw new Error("Defold revisions differ between C++ semantic facts and dmSDK IR");
  }
  if (artifact.sourceHashes?.ir !== sourceFactDigest(irText)) {
    throw new Error("IR hash does not match C++ semantic-fact provenance");
  }
  if (artifact.sourceHashes?.shapes !== sourceFactDigest(shapesText)) {
    throw new Error("ABI-shape hash does not match C++ semantic-fact provenance");
  }
  const declarations = artifact.declarations ?? [];
  const ids = declarations.map(({ declarationId }) => declarationId);
  if (ids.some((id) => typeof id !== "string" || id.length === 0) || new Set(ids).size !== ids.length) {
    throw new Error("C++ semantic facts contain missing or duplicate declaration ids");
  }
  return new Map(declarations.map((entry) => [entry.declarationId, entry]));
}
