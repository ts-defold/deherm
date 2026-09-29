const OWNERSHIP_EFFECTS = new Set(["none", "acquire", "retain", "release", "finalize", "transfer", "unknown"]);
const ESCAPES = new Set(["noescape", "retained", "returned", "deferred", "unknown"]);
const COMPLETIONS = new Set(["synchronous", "deferred", "unknown"]);
const RESULT_PROVENANCE = new Set(["plain-value", "borrowed-resource", "owned-resource", "lease-token", "unknown"]);
const MEMORY_EFFECTS = new Set([
  "exact-one-read",
  "exact-one-write",
  "exact-one-readwrite",
  "span",
  "persistent-rebind",
  "atomic",
  "unknown",
]);
const WRITE_PREDICATES = new Set(["never", "always", "conditional", "unknown"]);
const CALLABLE_DECLARATIONS = new Set(["FunctionDecl", "CXXMethodDecl", "CXXConstructorDecl", "CXXDestructorDecl"]);
const CALL_EXPRESSIONS = new Set(["CallExpr", "CXXMemberCallExpr", "CXXOperatorCallExpr"]);

export const CPP_OWNERSHIP_EFFECT_FACTS_KIND = "deherm.cpp-ownership-effect-facts";

const compareCodeUnits = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freeze(child);
  return value;
}

function exactKeys(value, expected, label) {
  if (!object(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort(compareCodeUnits);
  const wanted = [...expected].sort(compareCodeUnits);
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} has unsupported schema keys: ${actual.join(", ")}`);
  }
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

function referencedParameter(node, parameters) {
  const current = unwrap(node);
  if (!current) return null;
  if (current.kind === "DeclRefExpr" && current.referencedDecl?.kind === "ParmVarDecl") {
    return parameters.get(current.referencedDecl.id)?.index ?? null;
  }
  return null;
}

function parameterReferences(node, parameters, output = new Set()) {
  const index = referencedParameter(node, parameters);
  if (index !== null) output.add(index);
  for (const child of node?.inner ?? []) parameterReferences(child, parameters, output);
  return output;
}

function directCallee(node) {
  const current = unwrap(node);
  if (!current) return null;
  if (current.kind === "DeclRefExpr" && CALLABLE_DECLARATIONS.has(current.referencedDecl?.kind)) {
    return {
      declarationId: current.referencedDecl.id ?? null,
      name: current.referencedDecl.name ?? "",
    };
  }
  if (current.kind === "MemberExpr") {
    return {
      declarationId: current.referencedMemberDecl ?? null,
      name: current.name ?? "",
    };
  }
  for (const child of current.inner ?? []) {
    const identity = directCallee(child);
    if (identity) return identity;
  }
  return null;
}

function mergeEnum(values, neutral, unknown = "unknown") {
  const material = [...new Set(values.filter((value) => value !== neutral))];
  if (material.length === 0) return neutral;
  if (material.length === 1) return material[0];
  return unknown;
}

function mergeOwnership(values) {
  return mergeEnum(values, "none");
}

function mergeEscape(values) {
  return mergeEnum(values, "noescape");
}

function mergeCompletion(values) {
  return mergeEnum(values, "synchronous");
}

function mergeResult(values) {
  const unique = [...new Set(values)];
  return unique.length === 0 ? "plain-value" : unique.length === 1 ? unique[0] : "unknown";
}

function mergeMemory(values) {
  const unique = [...new Set(values)];
  if (unique.length === 0) return null;
  if (unique.includes("unknown")) return "unknown";
  if (unique.includes("persistent-rebind"))
    return unique.every((value) => value === "persistent-rebind" || value === "exact-one-write")
      ? "persistent-rebind"
      : "unknown";
  if (unique.includes("atomic")) return unique.every((value) => value === "atomic") ? "atomic" : "unknown";
  if (unique.includes("span")) return "span";
  const reads = unique.includes("exact-one-read") || unique.includes("exact-one-readwrite");
  const writes = unique.includes("exact-one-write") || unique.includes("exact-one-readwrite");
  return reads && writes ? "exact-one-readwrite" : writes ? "exact-one-write" : "exact-one-read";
}

function isPointer(type) {
  return /\*/u.test(type ?? "");
}

function pointerDepth(type) {
  return [...String(type ?? "")].filter((character) => character === "*").length;
}

function emptyParameter(index, type, desugaredType = type) {
  return {
    index,
    type,
    desugaredType,
    pointer: isPointer(type) || isPointer(desugaredType),
    ownership: [],
    escape: [],
    completion: [],
    memory: [],
    writes: [],
  };
}

function addParameterFact(
  parameter,
  { ownership = "none", escape = "noescape", completion = "synchronous", memory = null, writePredicate = null } = {},
) {
  parameter.ownership.push(ownership);
  parameter.escape.push(escape);
  parameter.completion.push(completion);
  if (memory) parameter.memory.push(memory);
  if (writePredicate) parameter.writes.push(writePredicate);
}

function writePredicate(values) {
  if (values.includes("unknown")) return "unknown";
  if (values.includes("always")) return "always";
  if (values.includes("conditional")) return "conditional";
  return "never";
}

function standardExternalRule(identity) {
  const name = identity?.name ?? "";
  if (name === "free" || name === "operator delete" || name === "operator delete[]") {
    return {
      ownershipEffect: "finalize",
      escape: "noescape",
      completion: "synchronous",
      arguments: { 0: { ownershipEffect: "finalize" } },
    };
  }
  if (
    [
      "atomic_fetch_add",
      "atomic_fetch_sub",
      "__atomic_fetch_add",
      "__atomic_fetch_sub",
      "__sync_fetch_and_add",
      "__sync_fetch_and_sub",
      "fetch_add",
      "fetch_sub",
    ].includes(name)
  ) {
    return {
      ownershipEffect: "none",
      escape: "noescape",
      completion: "synchronous",
      arguments: { 0: { memoryEffect: "atomic", writePredicate: "always" } },
    };
  }
  return null;
}

function validateRule(rule, label) {
  if (!object(rule)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(rule)) {
    if (!["ownershipEffect", "escape", "completion", "resultProvenance", "arguments"].includes(key)) {
      throw new Error(`${label} has unsupported key ${key}`);
    }
  }
  if (rule.ownershipEffect !== undefined && !OWNERSHIP_EFFECTS.has(rule.ownershipEffect))
    throw new Error(`${label} has invalid ownership effect`);
  if (rule.escape !== undefined && !ESCAPES.has(rule.escape)) throw new Error(`${label} has invalid escape`);
  if (rule.completion !== undefined && !COMPLETIONS.has(rule.completion))
    throw new Error(`${label} has invalid completion`);
  if (rule.resultProvenance !== undefined && !RESULT_PROVENANCE.has(rule.resultProvenance))
    throw new Error(`${label} has invalid result provenance`);
  for (const [index, argument] of Object.entries(rule.arguments ?? {})) {
    if (!/^\d+$/u.test(index) || !object(argument)) throw new Error(`${label} has invalid argument rule`);
    for (const key of Object.keys(argument)) {
      if (!["ownershipEffect", "escape", "completion", "memoryEffect", "writePredicate"].includes(key)) {
        throw new Error(`${label} argument ${index} has unsupported key ${key}`);
      }
    }
    if (argument.ownershipEffect !== undefined && !OWNERSHIP_EFFECTS.has(argument.ownershipEffect))
      throw new Error(`${label} argument ${index} has invalid ownership effect`);
    if (argument.escape !== undefined && !ESCAPES.has(argument.escape))
      throw new Error(`${label} argument ${index} has invalid escape`);
    if (argument.completion !== undefined && !COMPLETIONS.has(argument.completion))
      throw new Error(`${label} argument ${index} has invalid completion`);
    if (argument.memoryEffect !== undefined && !MEMORY_EFFECTS.has(argument.memoryEffect))
      throw new Error(`${label} argument ${index} has invalid memory effect`);
    if (argument.writePredicate !== undefined && !WRITE_PREDICATES.has(argument.writePredicate))
      throw new Error(`${label} argument ${index} has invalid write predicate`);
  }
}

function definitionIndex(ast) {
  const definitions = new Map();
  function visit(node) {
    if (CALLABLE_DECLARATIONS.has(node?.kind) && node.id) {
      const body = (node.inner ?? []).find(({ kind }) => kind === "CompoundStmt");
      if (body) definitions.set(node.id, node);
    }
    for (const child of node?.inner ?? []) visit(child);
  }
  visit(ast);
  return definitions;
}

function returnType(functionType) {
  const type = String(functionType ?? "");
  const split = type.indexOf(" (");
  return split === -1 ? type : type.slice(0, split);
}

function literalLike(node) {
  const current = unwrap(node);
  return new Set([
    "CXXBoolLiteralExpr",
    "CharacterLiteral",
    "FloatingLiteral",
    "IntegerLiteral",
    "StringLiteral",
    "CXXNullPtrLiteralExpr",
    "GNUNullExpr",
  ]).has(current?.kind);
}

/**
 * Extract ownership, escape, completion, result-provenance, and pointer-memory
 * facts from Clang JSON AST bodies. Requested callables are selected by Clang
 * declaration identity, so no public spelling/header/tranche/count is an
 * inference input. External semantic rules are keyed by declaration identity;
 * the only spelling rules built in are revision-neutral C/C++ memory/atomic
 * primitives. Unknown indirect/external behavior fails closed.
 */
export function extractCppOwnershipEffectFacts(ast, requestedDeclarationIds, options = {}) {
  const definitions = definitionIndex(ast);
  const requested = [...new Set(requestedDeclarationIds)].sort(compareCodeUnits);
  const externalRules = new Map(Object.entries(options.externalCalleeRules ?? {}));
  for (const [id, rule] of externalRules) validateRule(rule, `external callee rule ${id}`);
  const cache = new Map();

  function analyze(declarationId, active = new Set()) {
    if (cache.has(declarationId)) return cache.get(declarationId);
    const definition = definitions.get(declarationId);
    if (!definition) return null;
    const parameterNodes = (definition.inner ?? []).filter(({ kind }) => kind === "ParmVarDecl");
    const parameters = new Map(parameterNodes.map((parameter, index) => [parameter.id, { index, node: parameter }]));
    const parameterFacts = parameterNodes.map((parameter, index) =>
      emptyParameter(
        index,
        parameter.type?.qualType ?? "",
        parameter.type?.desugaredQualType ?? parameter.type?.qualType ?? "",
      ),
    );
    const ownership = [];
    const escapes = [];
    const completions = [];
    const results = [];
    const diagnostics = [];
    const body = (definition.inner ?? []).find(({ kind }) => kind === "CompoundStmt");
    const nextActive = new Set(active).add(declarationId);

    function markUnknown(indices, code) {
      diagnostics.push(code);
      ownership.push("unknown");
      escapes.push("unknown");
      completions.push("unknown");
      for (const index of indices) {
        if (!parameterFacts[index]?.pointer) continue;
        addParameterFact(parameterFacts[index], {
          ownership: "unknown",
          escape: "unknown",
          completion: "unknown",
          memory: "unknown",
          writePredicate: "unknown",
        });
      }
    }

    function callArgumentMemory(effect, argument) {
      if (!effect || !argument) return effect;
      const current = unwrap(argument);
      const offset =
        current?.kind === "ArraySubscriptExpr" ||
        ((current?.kind === "BinaryOperator" || current?.kind === "CompoundAssignOperator") &&
          ["+", "-", "+=", "-="].includes(current.opcode));
      return offset && effect.startsWith("exact-one-") ? "span" : effect;
    }

    function applyRule(rule, arguments_, conditional) {
      ownership.push(rule.ownershipEffect ?? "none");
      escapes.push(rule.escape ?? "noescape");
      completions.push(rule.completion ?? "synchronous");
      for (const [argumentIndex, effect] of Object.entries(rule.arguments ?? {})) {
        const argument = arguments_[Number(argumentIndex)];
        for (const parameterIndex of parameterReferences(argument, parameters)) {
          addParameterFact(parameterFacts[parameterIndex], {
            ownership: effect.ownershipEffect ?? "none",
            escape: effect.escape ?? "noescape",
            completion: effect.completion ?? "synchronous",
            memory: callArgumentMemory(effect.memoryEffect ?? null, argument),
            writePredicate:
              effect.writePredicate === "always" && conditional ? "conditional" : (effect.writePredicate ?? null),
          });
        }
      }
      return rule.resultProvenance ?? null;
    }

    function applyInternal(summary, arguments_, conditional) {
      ownership.push(summary.ownershipEffect);
      escapes.push(summary.escape);
      completions.push(summary.completion);
      for (const effect of summary.parameters) {
        const argument = arguments_[effect.index];
        for (const parameterIndex of parameterReferences(argument, parameters)) {
          addParameterFact(parameterFacts[parameterIndex], {
            ownership: effect.ownershipEffect,
            escape: effect.escape,
            completion: effect.completion,
            memory: callArgumentMemory(effect.memoryEffect, argument),
            writePredicate: effect.writePredicate === "always" && conditional ? "conditional" : effect.writePredicate,
          });
        }
      }
      return summary.resultProvenance;
    }

    function analyzeCall(node, conditional) {
      const [callee, ...arguments_] = node.inner ?? [];
      const identity = directCallee(callee);
      const referenced = [...new Set(arguments_.flatMap((argument) => [...parameterReferences(argument, parameters)]))];
      let rule = identity?.declarationId ? externalRules.get(identity.declarationId) : null;
      rule ??= standardExternalRule(identity);
      if (rule) return applyRule(rule, arguments_, conditional);
      if (identity?.declarationId && definitions.has(identity.declarationId)) {
        if (nextActive.has(identity.declarationId)) {
          markUnknown(referenced, "recursive-callee-effect");
          return "unknown";
        }
        const summary = analyze(identity.declarationId, nextActive);
        return applyInternal(summary, arguments_, conditional);
      }
      if (referenced.some((index) => parameterFacts[index]?.pointer)) {
        markUnknown(referenced, identity ? "unresolved-callee-effect" : "indirect-callee-effect");
      }
      return "unknown";
    }

    function inspectExpression(node, conditional = false, context = "read") {
      const current = unwrap(node);
      if (!current) return null;
      if (CALL_EXPRESSIONS.has(current.kind)) {
        return analyzeCall(current, conditional);
      }
      if (current.kind === "CXXNewExpr") {
        ownership.push("acquire");
        return "owned-resource";
      }
      if (current.kind === "CXXDeleteExpr") {
        const indices = [...parameterReferences(current, parameters)];
        ownership.push("finalize");
        for (const index of indices) addParameterFact(parameterFacts[index], { ownership: "finalize" });
        return "plain-value";
      }
      if (current.kind === "AtomicExpr") {
        const indices = [...parameterReferences(current, parameters)];
        for (const index of indices)
          addParameterFact(parameterFacts[index], {
            memory: "atomic",
            writePredicate: conditional ? "conditional" : "always",
          });
        return "plain-value";
      }
      if (current.kind === "ArraySubscriptExpr") {
        for (const index of parameterReferences(current.inner?.[0], parameters)) {
          addParameterFact(parameterFacts[index], {
            memory: "span",
            writePredicate:
              context === "write" || context === "readwrite" ? (conditional ? "conditional" : "always") : null,
          });
        }
        for (const child of current.inner ?? []) inspectExpression(child, conditional, "read");
        return null;
      }
      if (current.kind === "UnaryOperator") {
        const operand = current.inner?.[0];
        if (current.opcode === "++" || current.opcode === "--") {
          inspectExpression(operand, conditional, "readwrite");
          return null;
        }
        if (current.opcode === "*") {
          const effect =
            context === "write"
              ? "exact-one-write"
              : context === "readwrite"
                ? "exact-one-readwrite"
                : "exact-one-read";
          for (const index of parameterReferences(operand, parameters)) {
            addParameterFact(parameterFacts[index], {
              memory: effect,
              writePredicate: effect === "exact-one-read" ? null : conditional ? "conditional" : "always",
            });
          }
          return null;
        }
      }
      if (
        (current.kind === "BinaryOperator" || current.kind === "CompoundAssignOperator") &&
        current.inner?.length === 2
      ) {
        const [left, right] = current.inner;
        const operator = current.opcode ?? "";
        if (["=", "+=", "-=", "*=", "/=", "|=", "&=", "^="].includes(operator)) {
          const leftContext = operator === "=" ? "write" : "readwrite";
          const leftUnwrapped = unwrap(left);
          if (operator === "=" && leftUnwrapped?.kind === "UnaryOperator" && leftUnwrapped.opcode === "*") {
            for (const index of parameterReferences(leftUnwrapped.inner?.[0], parameters)) {
              if (
                pointerDepth(parameterFacts[index].desugaredType) >= 2 &&
                (unwrap(right)?.kind === "CXXNewExpr" || isPointer(unwrap(right)?.type?.qualType))
              ) {
                addParameterFact(parameterFacts[index], {
                  memory: "persistent-rebind",
                  writePredicate: conditional ? "conditional" : "always",
                });
              }
            }
          }
          inspectExpression(left, conditional, leftContext);
          inspectExpression(right, conditional, "read");
          return null;
        }
        if (["+", "-"].includes(operator)) {
          for (const index of parameterReferences(current, parameters)) {
            if (parameterFacts[index]?.pointer) addParameterFact(parameterFacts[index], { memory: "span" });
          }
        }
      }
      for (const child of current.inner ?? []) inspectExpression(child, conditional, context);
      return null;
    }

    function visit(node, conditional = false) {
      if (!node) return;
      if (["ForStmt", "WhileStmt", "DoStmt", "CXXForRangeStmt"].includes(node.kind)) {
        const referenced = [...parameterReferences(node, parameters)].filter((index) => parameterFacts[index]?.pointer);
        if (referenced.length) diagnostics.push("repeated-pointer-effect");
        for (const index of referenced) {
          addParameterFact(parameterFacts[index], { memory: "unknown", writePredicate: "unknown" });
        }
        for (const child of node.inner ?? []) visit(child, true);
        return;
      }
      if (node.kind === "IfStmt") {
        const [condition, thenBranch, elseBranch] = node.inner ?? [];
        inspectExpression(condition, conditional, "read");
        visit(thenBranch, true);
        visit(elseBranch, true);
        return;
      }
      if (node.kind === "ReturnStmt") {
        const expression = node.inner?.[0];
        if (!expression) {
          results.push("plain-value");
          return;
        }
        const directParameter = referencedParameter(expression, parameters);
        if (directParameter !== null && parameterFacts[directParameter]?.pointer) {
          results.push("borrowed-resource");
          escapes.push("returned");
          addParameterFact(parameterFacts[directParameter], { escape: "returned" });
          return;
        }
        const provenance = inspectExpression(expression, conditional, "read");
        if (provenance) results.push(provenance);
        else if (literalLike(expression) || !isPointer(returnType(definition.type?.qualType)))
          results.push("plain-value");
        else results.push("unknown");
        return;
      }
      if (
        (node.kind === "BinaryOperator" || node.kind === "CompoundAssignOperator") &&
        node.opcode === "=" &&
        node.inner?.length === 2
      ) {
        const [left, right] = node.inner;
        const rightParameters = [...parameterReferences(right, parameters)].filter(
          (index) => parameterFacts[index]?.pointer,
        );
        const leftParameter = referencedParameter(left, parameters);
        // A pointer referenced inside a scalar load (for example `dst = src[i]`)
        // does not itself escape. Only storing a pointer-valued expression can
        // retain pointer identity beyond the call.
        if (rightParameters.length && leftParameter === null && isPointer(unwrap(right)?.type?.qualType)) {
          escapes.push("retained");
          for (const index of rightParameters)
            addParameterFact(parameterFacts[index], { ownership: "retain", escape: "retained" });
          ownership.push("retain");
        }
      }
      if (node.kind === "CXXDeleteExpr") {
        inspectExpression(node, conditional);
        return;
      }
      if (CALL_EXPRESSIONS.has(node.kind) || node.kind === "CXXNewExpr" || node.kind === "AtomicExpr") {
        inspectExpression(node, conditional);
        return;
      }
      if (
        node.kind === "UnaryOperator" ||
        node.kind === "BinaryOperator" ||
        node.kind === "CompoundAssignOperator" ||
        node.kind === "ArraySubscriptExpr"
      ) {
        inspectExpression(node, conditional);
        return;
      }
      for (const child of node.inner ?? []) visit(child, conditional);
    }

    visit(body);
    const hasReturn = results.length > 0;
    const fact = freeze({
      schemaVersion: 1,
      declarationId,
      ownershipEffect: mergeOwnership(ownership),
      escape: mergeEscape(escapes),
      completion: mergeCompletion(completions),
      resultProvenance: hasReturn ? mergeResult(results) : "plain-value",
      parameters: parameterFacts.map((parameter) => ({
        index: parameter.index,
        pointer: parameter.pointer,
        ownershipEffect: mergeOwnership(parameter.ownership),
        escape: mergeEscape(parameter.escape),
        completion: mergeCompletion(parameter.completion),
        memoryEffect: parameter.pointer ? (mergeMemory(parameter.memory) ?? "unknown") : "unknown",
        writePredicate: parameter.pointer ? writePredicate(parameter.writes) : "never",
      })),
      diagnostics: [...new Set(diagnostics)].sort(compareCodeUnits),
    });
    validateCppOwnershipEffectFact(fact);
    cache.set(declarationId, fact);
    return fact;
  }

  const functions = requested.map((id) => {
    const fact = analyze(id);
    if (!fact) throw new Error(`Requested Clang function declaration ${id} has no body`);
    return fact;
  });
  const artifact = { schemaVersion: 1, kind: CPP_OWNERSHIP_EFFECT_FACTS_KIND, functions };
  validateCppOwnershipEffectArtifact(artifact);
  return freeze(artifact);
}

export function validateCppOwnershipEffectArtifact(artifact) {
  exactKeys(artifact, ["schemaVersion", "kind", "functions"], "C++ ownership/effect artifact");
  if (artifact.schemaVersion !== 1 || artifact.kind !== CPP_OWNERSHIP_EFFECT_FACTS_KIND) {
    throw new Error("C++ ownership/effect artifact identity is invalid");
  }
  if (!Array.isArray(artifact.functions)) throw new Error("C++ ownership/effect artifact functions are invalid");
  artifact.functions.forEach(validateCppOwnershipEffectFact);
  const ids = artifact.functions.map(({ declarationId }) => declarationId);
  if (new Set(ids).size !== ids.length) throw new Error("C++ ownership/effect artifact has duplicate declaration ids");
  const sorted = [...ids].sort(compareCodeUnits);
  if (JSON.stringify(ids) !== JSON.stringify(sorted)) {
    throw new Error("C++ ownership/effect artifact declarations are not in canonical order");
  }
  return artifact;
}

export function validateCppOwnershipEffectFact(fact) {
  exactKeys(
    fact,
    [
      "schemaVersion",
      "declarationId",
      "ownershipEffect",
      "escape",
      "completion",
      "resultProvenance",
      "parameters",
      "diagnostics",
    ],
    "C++ ownership/effect fact",
  );
  if (fact.schemaVersion !== 1 || typeof fact.declarationId !== "string" || fact.declarationId.length === 0) {
    throw new Error("C++ ownership/effect fact identity is invalid");
  }
  if (!OWNERSHIP_EFFECTS.has(fact.ownershipEffect))
    throw new Error("C++ ownership/effect fact has invalid ownership effect");
  if (!ESCAPES.has(fact.escape)) throw new Error("C++ ownership/effect fact has invalid escape");
  if (!COMPLETIONS.has(fact.completion)) throw new Error("C++ ownership/effect fact has invalid completion");
  if (!RESULT_PROVENANCE.has(fact.resultProvenance))
    throw new Error("C++ ownership/effect fact has invalid result provenance");
  if (!Array.isArray(fact.parameters) || !Array.isArray(fact.diagnostics))
    throw new Error("C++ ownership/effect fact collections are invalid");
  fact.parameters.forEach((parameter, index) => {
    exactKeys(
      parameter,
      ["index", "pointer", "ownershipEffect", "escape", "completion", "memoryEffect", "writePredicate"],
      `C++ ownership/effect parameter ${index}`,
    );
    if (parameter.index !== index || typeof parameter.pointer !== "boolean")
      throw new Error(`C++ ownership/effect parameter ${index} identity is invalid`);
    if (!OWNERSHIP_EFFECTS.has(parameter.ownershipEffect))
      throw new Error(`C++ ownership/effect parameter ${index} ownership is invalid`);
    if (!ESCAPES.has(parameter.escape)) throw new Error(`C++ ownership/effect parameter ${index} escape is invalid`);
    if (!COMPLETIONS.has(parameter.completion))
      throw new Error(`C++ ownership/effect parameter ${index} completion is invalid`);
    if (!MEMORY_EFFECTS.has(parameter.memoryEffect))
      throw new Error(`C++ ownership/effect parameter ${index} memory effect is invalid`);
    if (!WRITE_PREDICATES.has(parameter.writePredicate))
      throw new Error(`C++ ownership/effect parameter ${index} write predicate is invalid`);
  });
  if (fact.diagnostics.some((diagnostic) => typeof diagnostic !== "string"))
    throw new Error("C++ ownership/effect diagnostics are invalid");
  const canonicalDiagnostics = [...new Set(fact.diagnostics)].sort(compareCodeUnits);
  if (JSON.stringify(fact.diagnostics) !== JSON.stringify(canonicalDiagnostics)) {
    throw new Error("C++ ownership/effect diagnostics are not canonical");
  }
  return fact;
}
