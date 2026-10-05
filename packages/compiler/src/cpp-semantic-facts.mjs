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
    return {
      kind: "unary",
      operator: current.opcode ?? "",
      operand: declarationReference(current.inner[0], parameters),
    };
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
  if (current.kind === "CallExpr" || current.kind === "CXXMemberCallExpr") {
    const [callee, ...arguments_] = current.inner ?? [];
    const identity = calleeIdentity(callee);
    return {
      kind: "call",
      callee: identity?.name ?? "",
      ...(identity?.rawDeclarationId ? { _calleeDeclarationId: identity.rawDeclarationId } : {}),
      ...(identity?.type ? { calleeType: identity.type } : {}),
      arguments: arguments_.map((argument) => declarationReference(argument, parameters)),
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

function calleeIdentity(node) {
  const current = unwrap(node);
  if (!current) return null;
  if (current.kind === "DeclRefExpr" && current.referencedDecl?.kind === "FunctionDecl") {
    return {
      name: current.referencedDecl.name ?? null,
      rawDeclarationId: current.referencedDecl.id ?? null,
      type: current.referencedDecl.type?.qualType ?? current.type?.qualType ?? null,
    };
  }
  if (current.kind === "MemberExpr") {
    return {
      name: current.name ?? null,
      rawDeclarationId: current.referencedMemberDecl ?? null,
      type: current.type?.qualType ?? null,
    };
  }
  for (const child of current.inner ?? []) {
    const identity = calleeIdentity(child);
    if (identity?.name) return identity;
  }
  const name = calleeName(current);
  return name ? { name, rawDeclarationId: null, type: current.type?.qualType ?? null } : null;
}

function controlChildren(node, parameters, conditions, visit) {
  if (node.kind !== "IfStmt" || !node.inner?.length) return false;
  const [condition, thenBranch, elseBranch] = node.inner;
  visit(condition, conditions);
  const expression = declarationReference(condition, parameters);
  if (thenBranch) visit(thenBranch, [...conditions, { expression, branch: true }]);
  if (elseBranch) visit(elseBranch, [...conditions, { expression, branch: false }]);
  return true;
}

function isHostAssertionCall(name) {
  return ["__assert_fail", "__assert_rtn", "__builtin_expect"].includes(name);
}

function callFacts(body, parameters) {
  const calls = [];
  function visit(node, conditions = []) {
    if (node.kind === "CallExpr" || node.kind === "CXXMemberCallExpr" || node.kind === "RecoveryExpr") {
      const [callee, ...arguments_] = node.inner ?? [];
      const identity = calleeIdentity(callee);
      if (identity?.name && !isHostAssertionCall(identity.name))
        calls.push({
          callee: identity.name,
          ...(identity.rawDeclarationId ? { _calleeDeclarationId: identity.rawDeclarationId } : {}),
          ...(identity.type ? { calleeType: identity.type } : {}),
          arguments: arguments_.map((argument) => declarationReference(argument, parameters)),
          conditions,
        });
    }
    if (controlChildren(node, parameters, conditions, visit)) return;
    for (const child of node.inner ?? []) visit(child, conditions);
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
          ["char", 1],
          ["signed char", 1],
          ["unsigned char", 1],
          ["int8_t", 1],
          ["uint8_t", 1],
          ["int16_t", 2],
          ["uint16_t", 2],
          ["int32_t", 4],
          ["uint32_t", 4],
          ["int64_t", 8],
          ["uint64_t", 8],
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

function localVariables(body, parameters) {
  const variables = [];
  function visit(node, conditions = []) {
    if (node.kind === "VarDecl") {
      variables.push({
        name: node.name ?? "",
        type: node.type?.qualType ?? "",
        initializer: node.inner?.length
          ? declarationReference(node.inner.at(-1), parameters)
          : { kind: "uninitialized" },
        conditions,
      });
    }
    if (controlChildren(node, parameters, conditions, visit)) return;
    for (const child of node.inner ?? []) visit(child, conditions);
  }
  visit(body);
  return variables;
}

function operationFacts(body, parameters) {
  const operations = [];
  const returns = [];
  function visit(node, conditions = []) {
    if ((node.kind === "BinaryOperator" || node.kind === "CompoundAssignOperator") && node.inner?.length === 2) {
      operations.push({
        operator: node.opcode ?? "",
        left: declarationReference(node.inner[0], parameters),
        right: declarationReference(node.inner[1], parameters),
        conditions,
      });
    } else if (node.kind === "ReturnStmt") {
      returns.push({
        ...(node.inner?.length ? declarationReference(node.inner[0], parameters) : { kind: "void" }),
        conditions,
      });
    }
    if (controlChildren(node, parameters, conditions, visit)) return;
    for (const child of node.inner ?? []) visit(child, conditions);
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
          _declarationId: node.id ?? null,
          type: node.type?.qualType ?? "",
          parameterCount: parameterNodes.length,
          source,
          line: node.loc?.line ?? node.range?.begin?.line ?? null,
          calls: callFacts(body, parameters),
          fixedArrays: localFixedArrays(body),
          variables: localVariables(body, parameters),
          operations: operation.operations,
          returns: operation.returns,
        });
      }
    }
    for (const child of node.inner ?? []) visit(child, nextScope);
  }

  visit(ast);
  const stableIdentity = (definition) =>
    `${definition.name}|${definition.type}|${definition.source}|${definition.line ?? 0}`;
  const definitionsByRawId = new Map(
    allDefinitions.flatMap((definition) =>
      definition._declarationId ? [[definition._declarationId, definition]] : [],
    ),
  );
  for (const definition of allDefinitions) definition.identity = stableIdentity(definition);
  function normalizeCallIdentity(value) {
    const target = definitionsByRawId.get(value._calleeDeclarationId);
    if (target) value.calleeIdentity = target.identity;
    else {
      // The external declaration's spelled type belongs to the host headers and
      // compiler, not to Defold's implementation semantics. For example,
      // Darwin and glibc disagree about restrict/noexcept spelling and the
      // underlying C type of uint64_t. The callee name is the portable identity
      // we can prove from the pinned translation unit; argument dataflow remains
      // available separately.
      value.calleeIdentity = `external:${value.callee}`;
      delete value.calleeType;
    }
    delete value._calleeDeclarationId;
  }
  function normalizeExpressionIdentities(value) {
    if (!value || typeof value !== "object") return;
    if (value.kind === "call") normalizeCallIdentity(value);
    for (const child of Object.values(value)) {
      if (Array.isArray(child)) child.forEach(normalizeExpressionIdentities);
      else normalizeExpressionIdentities(child);
    }
  }
  for (const definition of allDefinitions) {
    for (const call of definition.calls) normalizeCallIdentity(call);
    normalizeExpressionIdentities(definition.variables);
    normalizeExpressionIdentities(definition.operations);
    normalizeExpressionIdentities(definition.returns);
    normalizeExpressionIdentities(definition.calls);
    delete definition._declarationId;
  }
  const definitionsByLeaf = new Map();
  for (const definition of allDefinitions) {
    const leaf = definition.name.split("::").at(-1);
    const entries = definitionsByLeaf.get(leaf) ?? [];
    entries.push(definition);
    definitionsByLeaf.set(leaf, entries);
  }
  function reachableFrom(root) {
    const namespace = root.name.split("::").slice(0, -1).join("::");
    const visited = new Set([root.identity]);
    const queue = [...root.calls];
    const reachable = [];
    const definitionsByIdentity = new Map(allDefinitions.map((definition) => [definition.identity, definition]));
    while (queue.length) {
      const call = queue.shift();
      const matches = definitionsByLeaf.get(call.callee) ?? [];
      const sameNamespace = matches.filter(({ name }) => name.split("::").slice(0, -1).join("::") === namespace);
      const selected =
        definitionsByIdentity.get(call.calleeIdentity) ??
        (sameNamespace.length === 1 ? sameNamespace[0] : matches.length === 1 ? matches[0] : null);
      if (!selected || visited.has(selected.identity)) continue;
      visited.add(selected.identity);
      reachable.push(selected);
      queue.push(...selected.calls);
    }
    return reachable.sort(
      (left, right) => compareCodeUnits(left.name, right.name) || (left.line ?? 0) - (right.line ?? 0),
    );
  }
  const definitions = allDefinitions
    .filter(({ name }) => requested.has(name))
    .map((definition) => ({ ...definition, reachableDefinitions: reachableFrom(definition) }));
  definitions.sort(
    (left, right) =>
      compareCodeUnits(left.name, right.name) ||
      compareCodeUnits(left.source, right.source) ||
      (left.line ?? 0) - (right.line ?? 0),
  );
  return freeze(definitions);
}

function forwardedSuffix(call, parameterCount) {
  const arguments_ = call.arguments ?? [];
  for (let start = 0; start <= arguments_.length - parameterCount; start += 1) {
    if (
      arguments_
        .slice(start, start + parameterCount)
        .every((argument, index) => argument.kind === "parameter" && argument.index === index)
    ) {
      return { start, before: arguments_.slice(0, start), after: arguments_.slice(start + parameterCount) };
    }
  }
  return null;
}

function callTarget(definition, call) {
  const reachable = definition.reachableDefinitions ?? [];
  return (
    reachable.find(({ identity }) => identity && identity === call.calleeIdentity) ??
    (() => {
      const matches = reachable.filter(({ name }) => name.split("::").at(-1) === call.callee);
      return matches.length === 1 ? matches[0] : null;
    })()
  );
}

function helperConsumesForwardedOutputAndExtent(helper, outputIndex, extentIndex) {
  if (!helper) return false;
  return (helper.calls ?? []).some(({ arguments: arguments_ = [] }) => {
    const referenced = new Set(
      arguments_.flatMap((argument) => (argument.kind === "parameter" ? [argument.index] : [])),
    );
    return referenced.has(outputIndex) && referenced.has(extentIndex);
  });
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
      const helper = callTarget(definition, call);
      const outputIndex = forwarding.start + parameterCount - 1;
      const extentIndex = forwarding.start + parameterCount;
      if (!helperConsumesForwardedOutputAndExtent(helper, outputIndex, extentIndex)) continue;
      const bytes = Number(forwarding.after[0].value);
      if (!Number.isSafeInteger(bytes) || bytes <= 0) continue;
      observations.push({
        bytes,
        source: definition.source,
        line: definition.line,
        callee: call.callee,
        calleeIdentity: call.calleeIdentity ?? null,
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
  return createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
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
