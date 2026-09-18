#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { hexBindingId, stableBindingId } from "./lib/binding-identity.mjs";

const root = new URL("../", import.meta.url);
const irUrl = new URL("packages/bindings/generated/defold-script-api-ir.json", root);
const scalarDispatchUrl = new URL("packages/bindings/generated/defold-script-scalar-dispatch.json", root);
const patternsUrl = new URL("packages/bindings/generated/defold-script-binding-patterns.json", root);
const definitionUrls = [
  new URL("packages/bindings/overrides/script-defold-value-bindings.json", root),
  new URL("packages/bindings/overrides/script-defold-handle-bindings.json", root),
  new URL("packages/bindings/overrides/script-go-current-instance-bindings.json", root),
  new URL("packages/bindings/overrides/script-msg-structured-bindings.json", root),
  new URL("packages/bindings/overrides/script-factory-structured-bindings.json", root),
  new URL("packages/bindings/overrides/script-gui-structured-bindings.json", root)
];
const reportUrl = new URL("packages/bindings/generated/defold-script-value-bindings.json", root);
const headerUrl = new URL("defold/defold_hermes/include/defold_hermes/generated_script_value_bindings.hpp", root);
const sourceUrl = new URL("defold/defold_hermes/src/generated_script_value_bindings.cpp", root);
const targetSupportUrl = new URL("packages/sdk/src/generated/script/value-target-support.ts", root);

const CODECS = new Set([
  "Nil", "Boolean", "Number", "String", "Hash", "Url", "Vector3", "Vector4",
  "Quaternion", "Matrix4", "Table", "Node", "AddressArray"
]);
const codecForType = new Map([
  ["number", "Number"],
  ["string", "String"],
  ["hash", "Hash"],
  ["url", "Url"],
  ["vector3", "Vector3"],
  ["vector4", "Vector4"],
  ["quaternion", "Quaternion"],
  ["matrix4", "Matrix4"],
  ["nil", "Nil"],
  ["boolean", "Boolean"],
  ["table<any, any>", "Table"],
  ["table<string|hash, any>", "Table"],
  ["node", "Node"],
  ["(string|hash|url)[]", "AddressArray"]
]);

function pascal(value) {
  return value.split(/[^A-Za-z0-9]+/).filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1)).join("");
}

function split(value, delimiter = "|") {
  const result = [];
  let start = 0;
  let angle = 0;
  let round = 0;
  let square = 0;
  const source = String(value);
  for (let index = 0; index < source.length; ++index) {
    const char = source[index];
    if (char === "<") ++angle;
    else if (char === ">") --angle;
    else if (char === "(") ++round;
    else if (char === ")") --round;
    else if (char === "[") ++square;
    else if (char === "]") --square;
    else if (char === delimiter && angle === 0 && round === 0 && square === 0) {
      const item = source.slice(start, index).trim();
      if (item) result.push(item);
      start = index + 1;
    }
  }
  const tail = source.slice(start).trim();
  if (tail) result.push(tail);
  return result;
}

function parameterTypes(signature) {
  const match = signature.match(/^fun\((.*)\):/);
  if (!match) throw new Error(`Unsupported overload signature ${signature}`);
  if (!match[1].trim()) return [];
  return split(match[1], ",").map((parameter) => parameter.slice(parameter.indexOf(":") + 1).trim());
}

function cartesian(parts) {
  return parts.reduce((rows, alternatives) => rows.flatMap((row) => alternatives.map((item) => [...row, item])), [[]]);
}

function deriveCallShapes(fn, codecOverrides = new Map()) {
  const genericConstraints = new Map(fn.generics.map((generic) => {
    const separator = generic.indexOf(":");
    return [generic.slice(0, separator).trim(), split(generic.slice(separator + 1))];
  }));
  const primary = fn.parameters.map(({ rawType }) => rawType);
  let requiredCount = fn.parameters.length;
  while (requiredCount > 0 && fn.parameters[requiredCount - 1].optional) requiredCount -= 1;
  const primarySignatures = [];
  for (let count = requiredCount; count <= primary.length; ++count) primarySignatures.push(primary.slice(0, count));
  const signatures = [...primarySignatures, ...fn.overloads.map(parameterTypes)];
  const shapes = signatures.flatMap((parameters) => cartesian(parameters.map((rawType) => {
    const types = genericConstraints.get(rawType) ?? split(rawType);
    return types.map((type) => {
      const codec = codecOverrides.get(type) ?? codecForType.get(type);
      if (!codec) throw new Error(`${fn.id}: unsupported value type ${type}`);
      return codec;
    });
  })));
  const unique = new Map(shapes.map((shape) => [JSON.stringify(shape), shape]));
  return [...unique.values()];
}

function luaRegistration(source, member) {
  const literal = source.match(new RegExp(`\\{\\s*"${member}"\\s*,\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*\\}`));
  if (literal) return { symbol: literal[1], anchor: literal[0] };
  const macro = source.match(new RegExp(`REGGETSET\\(\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*,\\s*${member.slice(4)}\\s*\\)`));
  if (macro) return { symbol: `LuaSet${macro[1]}`, anchor: macro[0] };
  return null;
}

function expandDefinitionBindings(definition, functions, patterns, source) {
  const expanded = [...(definition.bindings ?? [])];
  for (const family of definition.families ?? []) {
    const selector = family?.selector;
    if (family?.id === "gui-node-setters") {
      if (!selector ||
        !equal(selector.modulePath, ["gui"]) || selector.memberPrefix !== "set_" ||
        selector.firstParameterType !== "node" || selector.resultCount !== 0 ||
        !equal(selector.excludedIds, ["script:gui.set_text"]) ||
        selector.expectedRouteCount !== 39 || !selector.typeCodecs ||
        family.operation?.template !== "gui-node-setter") {
        throw new Error("gui-node-setters family metadata is not the reviewed finite selector");
      }
      const codecOverrides = new Map(Object.entries(selector.typeCodecs));
      if ([...codecOverrides.values()].some((codec) => !CODECS.has(codec))) {
        throw new Error("gui-node-setters family contains an unsupported codec mapping");
      }
      const selected = [...functions.values()].filter((fn) =>
        fn.source === definition.irSource && equal(fn.modulePath, selector.modulePath) &&
        !selector.excludedIds.includes(fn.id) &&
        fn.member.startsWith(selector.memberPrefix) &&
        fn.parameters[0]?.rawType === selector.firstParameterType &&
        fn.returns.length === selector.resultCount &&
        fn.parameters.every(({ rawType }) => split(rawType).every((type) => codecOverrides.has(type))));
      if (selected.length !== selector.expectedRouteCount) {
        throw new Error(`gui-node-setters selected ${selected.length} routes; reviewed count is ${selector.expectedRouteCount}`);
      }
      for (const fn of selected) {
        const registration = luaRegistration(source, fn.member);
        if (!registration) throw new Error(`${fn.id}: no pinned Gui_methods registration was found`);
        const callShapes = deriveCallShapes(fn, codecOverrides);
        expanded.push({
          id: fn.id,
          sourceSymbol: registration.symbol,
          sourceOperation: registration.anchor,
          operation: family.operation,
          callShapes,
          implementedCallShapes: callShapes,
          resultCodec: "None",
          generatedFamily: family.id,
          familyTypeCodecs: Object.fromEntries(codecOverrides)
        });
      }
      continue;
    }
    if (family?.id === "vmath-fixed-pod") {
      const allowedTypes = ["number", "vector3", "vector4", "quaternion"];
      const excludedIds = [
        "script:vmath.length", "script:vmath.normalize", "script:vmath.quat",
        "script:vmath.quat_rotation_z", "script:vmath.vector3"
      ];
      if (!selector || !equal(selector.modulePath, ["vmath"]) ||
          selector.loweringFamily !== "defold-value" ||
          !equal(selector.allowedTypes, allowedTypes) || !equal(selector.excludedIds, excludedIds) ||
          selector.expectedRouteCount !== 11 || !Array.isArray(selector.terminalOperations) ||
          selector.terminalOperations.length !== 11 || family.operation?.template !== "vmath-fixed-pod" ||
          !equal(family.operation.parameters, {
            rejectNaNDefoldInputs: true,
            numberNarrowing: "lua-number-to-float32",
            normalization: "none"
          })) {
        throw new Error("vmath-fixed-pod family metadata is not the reviewed finite selector");
      }
      const allowed = new Set(allowedTypes);
      const selected = [...functions.values()].filter((fn) => {
        const pattern = patterns.get(fn.id);
        return fn.source === definition.irSource && equal(fn.modulePath, selector.modulePath) &&
          pattern?.loweringFamily === selector.loweringFamily && !selector.excludedIds.includes(fn.id) &&
          fn.parameters.every(({ rawType }) => split(rawType).every((type) => allowed.has(type))) &&
          fn.returns.length === 1 && fn.returns.every((type) => allowed.has(type));
      });
      if (selected.length !== selector.expectedRouteCount) {
        throw new Error(`vmath-fixed-pod selected ${selected.length} routes; reviewed count is ${selector.expectedRouteCount}`);
      }
      const seenOperators = new Set();
      for (const fn of selected) {
        const registration = luaRegistration(source, fn.member);
        if (!registration) throw new Error(`${fn.id}: no pinned vmath methods registration was found`);
        const body = functionSource(source, registration.symbol, fn.id);
        const matches = selector.terminalOperations.filter(({ sourceAnchor }) =>
          typeof sourceAnchor === "string" && body.includes(sourceAnchor));
        if (matches.length !== 1) {
          throw new Error(`${fn.id}: expected exactly one reviewed vmath terminal operation, found ${matches.length}`);
        }
        const terminal = matches[0];
        if (typeof terminal.operator !== "string" || seenOperators.has(terminal.operator) ||
            !Array.isArray(terminal.implementedCallShapes) || typeof terminal.resultCodec !== "string" ||
            !terminal.probe || typeof terminal.probe.key !== "string" ||
            !Array.isArray(terminal.probe.arguments) || !terminal.probe.expectation) {
          throw new Error(`${fn.id}: invalid or duplicate reviewed vmath terminal operation`);
        }
        seenOperators.add(terminal.operator);
        const callShapes = deriveCallShapes(fn);
        expanded.push({
          id: fn.id,
          sourceSymbol: registration.symbol,
          sourceOperation: [registration.anchor, terminal.sourceAnchor],
          operation: {
            template: family.operation.template,
            parameters: { ...family.operation.parameters, operator: terminal.operator }
          },
          callShapes,
          implementedCallShapes: terminal.implementedCallShapes,
          resultCodec: terminal.resultCodec,
          generatedFamily: family.id,
          generatedProbe: terminal.probe
        });
      }
      if (seenOperators.size !== selector.terminalOperations.length) {
        throw new Error("vmath-fixed-pod terminal operations do not map one-to-one to selected routes");
      }
      continue;
    }
    if (family?.id === "vmath-matrix4") {
      const allowedTypes = ["number", "vector3", "vector4", "quaternion", "matrix4"];
      if (!selector || !equal(selector.modulePath, ["vmath"]) ||
          selector.loweringFamily !== "defold-value" ||
          !equal(selector.allowedTypes, allowedTypes) ||
          !equal(selector.requiredIds, selector.terminalOperations?.map(({ id }) => id)) ||
          selector.expectedRouteCount !== 14 || selector.expectedCallShapeCount !== 16 ||
          !Array.isArray(selector.terminalOperations) || selector.terminalOperations.length !== 14 ||
          family.operation?.template !== "vmath-matrix4" ||
          !equal(family.operation.parameters, {
            layout: "column-major-16-float32",
            storage: "generation-checked-frame-arena",
            rejectNaNDefoldInputs: true,
            numberNarrowing: "lua-number-to-float32",
            normalization: "none"
          })) {
        throw new Error("vmath-matrix4 family metadata is not the reviewed finite selector");
      }
      const required = new Set(selector.requiredIds);
      const allowed = new Set(allowedTypes);
      const selected = [...functions.values()].filter((fn) => required.has(fn.id) &&
        fn.source === definition.irSource && equal(fn.modulePath, selector.modulePath) &&
        patterns.get(fn.id)?.loweringFamily === selector.loweringFamily &&
        fn.parameters.every(({ rawType }) => split(rawType).every((type) => allowed.has(type))) &&
        fn.returns.length === 1 && fn.returns.every((type) => allowed.has(type)));
      if (selected.length !== selector.expectedRouteCount ||
          selected.reduce((count, fn) => count + deriveCallShapes(fn).length, 0) !== selector.expectedCallShapeCount) {
        throw new Error("vmath-matrix4 selector no longer resolves the reviewed 14 routes / 16 call shapes");
      }
      const terminals = new Map(selector.terminalOperations.map((entry) => [entry.id, entry]));
      if (terminals.size !== selector.terminalOperations.length) {
        throw new Error("vmath-matrix4 terminal IDs must be unique");
      }
      for (const fn of selected) {
        const terminal = terminals.get(fn.id);
        const registration = luaRegistration(source, fn.member);
        if (!terminal || !registration) throw new Error(`${fn.id}: no reviewed Matrix4 terminal or registration`);
        const body = functionSource(source, registration.symbol, fn.id);
        if (typeof terminal.operator !== "string" || typeof terminal.sourceAnchor !== "string" ||
            !body.includes(terminal.sourceAnchor) || !Array.isArray(terminal.implementedCallShapes) ||
            typeof terminal.resultCodec !== "string" || !terminal.probe) {
          throw new Error(`${fn.id}: invalid or stale reviewed Matrix4 terminal operation`);
        }
        const callShapes = deriveCallShapes(fn);
        expanded.push({
          id: fn.id,
          sourceSymbol: registration.symbol,
          sourceOperation: [registration.anchor, terminal.sourceAnchor, ...(terminal.extraSourceAnchors ?? [])],
          operation: {
            template: family.operation.template,
            parameters: { ...family.operation.parameters, operator: terminal.operator }
          },
          callShapes,
          implementedCallShapes: terminal.implementedCallShapes,
          resultCodec: terminal.resultCodec,
          generatedFamily: family.id,
          generatedProbe: terminal.probe
        });
      }
      continue;
    }
    throw new Error(`Unknown generated value family: ${family?.id}`);
  }
  return expanded;
}

function isIrCompatibleShape(fn, shape) {
  let requiredCount = fn.parameters.length;
  while (requiredCount > 0 && fn.parameters[requiredCount - 1].optional) requiredCount -= 1;
  if (shape.length < requiredCount || shape.length > fn.parameters.length) return false;
  return shape.every((codec, index) => {
    const parameter = fn.parameters[index];
    if (codec === "Nil") return parameter.optional;
    return split(parameter.rawType).some((rawType) => codecForType.get(rawType) === codec);
  });
}

function deriveResultCodec(fn) {
  if (fn.returns.length === 0) return "None";
  if (fn.returns.length !== 1) throw new Error(`${fn.id}: value binding must return zero or one value`);
  const rawType = fn.returns[0];
  const generic = fn.generics.find((entry) => entry.slice(0, entry.indexOf(":")) === rawType);
  if (generic) {
    const types = split(generic.slice(generic.indexOf(":") + 1));
    const codecs = types.map((type) => codecForType.get(type));
    if (codecs.every((codec) => ["Vector3", "Vector4", "Quaternion"].includes(codec))) return "SameDefoldValue";
    throw new Error(`${fn.id}: unsupported generic value result ${rawType}`);
  }
  const codec = codecForType.get(rawType);
  if (!codec) throw new Error(`${fn.id}: unsupported value result ${rawType}`);
  return codec;
}

function equal(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((value, index) => equal(value, right[index]));
  }
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return equal(leftKeys, rightKeys) && leftKeys.every((key) => equal(left[key], right[key]));
}

function exactOperationParameters(binding, alternatives) {
  const parameters = binding.operation?.parameters;
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
    throw new Error(`${binding.id}: operation parameters must be an object`);
  }
  if (!alternatives.some((candidate) => equal(candidate, parameters))) {
    throw new Error(`${binding.id}: parameters do not match reviewed ${binding.operation.template} template: ${JSON.stringify(parameters)}`);
  }
}

function expectOperationContract(binding, callShapes, resultCodec) {
  if (!equal(binding.implementedCallShapes, callShapes)) {
    throw new Error(`${binding.id}: ${binding.operation.template} parameters require implemented call shapes ${JSON.stringify(callShapes)}`);
  }
  if (binding.resultCodec !== resultCodec) {
    throw new Error(`${binding.id}: ${binding.operation.template} parameters require result codec ${resultCodec}`);
  }
}

function requireSourceAnchors(binding, functionSource, anchors) {
  for (const anchor of anchors) {
    if (!functionSource.includes(anchor)) {
      throw new Error(`${binding.id}: ${binding.operation.template} source anchor ${JSON.stringify(anchor)} is stale`);
    }
  }
}

function functionSource(sourceText, symbol, id) {
  const signature = new RegExp(`(?:static\\s+)?int\\s+${symbol.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\s*\\(lua_State\\*\\s*L\\)`);
  const match = signature.exec(sourceText);
  if (!match) throw new Error(`${id}: source symbol ${symbol} is stale`);
  const open = sourceText.indexOf("{", match.index + match[0].length);
  if (open < 0) throw new Error(`${id}: source symbol ${symbol} has no body`);
  let depth = 0;
  let mode = "code";
  for (let index = open; index < sourceText.length; ++index) {
    const char = sourceText[index];
    const next = sourceText[index + 1];
    if (mode === "line-comment") { if (char === "\n") mode = "code"; continue; }
    if (mode === "block-comment") { if (char === "*" && next === "/") { mode = "code"; ++index; } continue; }
    if (mode === "string") { if (char === "\\") ++index; else if (char === '"') mode = "code"; continue; }
    if (mode === "character") { if (char === "\\") ++index; else if (char === "'") mode = "code"; continue; }
    if (char === "/" && next === "/") { mode = "line-comment"; ++index; continue; }
    if (char === "/" && next === "*") { mode = "block-comment"; ++index; continue; }
    if (char === '"') { mode = "string"; continue; }
    if (char === "'") { mode = "character"; continue; }
    if (char === "{") ++depth;
    else if (char === "}" && --depth === 0) return sourceText.slice(match.index, index + 1);
  }
  throw new Error(`${id}: source symbol ${symbol} has an unterminated body`);
}

function casePrefix(denseIndex) {
  return `    case ${denseIndex}: {`;
}

/**
 * Reviewed backend token for the addressed (world-addressing) forms of the
 * current-instance transform routes. An address may be a string, a hash or a
 * url, and each of those resolves differently against the *calling* instance's
 * collection and socket. Rather than restate that resolution natively, the
 * addressed shapes keep the argument in its own Lua representation and re-enter
 * the pinned `go` module, so Defold's own `ResolveInstance` performs the
 * socket check, the relative-path resolution and the missing-instance refusal.
 */
const ADDRESSED_TRANSFORM_BACKEND = "pinned-resolve-instance-captured-lua";

/**
 * Pinned evidence that `ResolveInstance` still owns address resolution, still
 * restricts the address to the calling collection, and still fails closed when
 * the addressed instance does not exist rather than returning a default.
 */
const RESOLVE_INSTANCE_ANCHORS = [
  "static Instance* ResolveInstance(lua_State* L, int instance_arg)",
  "if (lua_gettop(L) == instance_arg && !lua_isnil(L, instance_arg))",
  "dmScript::ResolveURL(L, instance_arg, &receiver, 0x0);",
  "if (receiver.m_Socket != dmGameObject::GetMessageSocket(i->m_Instance->m_Collection->m_HCollection))",
  "luaL_error(L, \"function called can only access instances within the same collection.\");",
  "instance = GetInstanceFromIdentifier(instance->m_Collection->m_HCollection, receiver.m_Path);",
  "luaL_error(L, \"Instance %s not found\", lua_tostring(L, instance_arg));"
];

/**
 * Emit the addressed branch of a transform route. The current-instance shape
 * keeps its direct native path; every other accepted shape carries an address
 * and re-enters the pinned Lua route through the shared captured-Lua invoker.
 */
function addressedTransformDelegation(binding, condition) {
  return `      if (${condition}) {
        if (!structuredLua || !structuredLua->invoke) {
          fail(error, errorCapacity, "Structured Lua backend is not installed");
          return DispatchStatus::kError;
        }
        return structuredLua->invoke(
            structuredLua->context,
            kStructuredLuaOperations[${binding.structuredLuaIndex}],
            frame,
            error,
            errorCapacity);
      }`;
}

function reviewedStructuredLuaTemplate(parameters, callShapes, resultCodec) {
  return {
    validate(binding) {
      exactOperationParameters(binding, [parameters]);
      if (callShapes) expectOperationContract(binding, callShapes, resultCodec);
      else {
        if (binding.resultCodec !== resultCodec ||
            binding.implementedCallShapes.length === 0 ||
            binding.implementedCallShapes.some((shape) => shape[0] !== "Node")) {
          throw new Error(`${binding.id}: ${binding.operation.template} requires Node-first call shapes and ${resultCodec} result`);
        }
      }
      const evidence = Array.isArray(binding.sourceOperation)
        ? binding.sourceOperation
        : binding.sourceOperation ? [binding.sourceOperation] : [];
      if (evidence.length === 0) {
        throw new Error(`${binding.id}: ${binding.operation.template} requires scoped source-operation evidence`);
      }
    },
    render(binding, denseIndex) {
      return `${casePrefix(denseIndex)}
      if (!structuredLua || !structuredLua->invoke) {
        fail(error, errorCapacity, "Structured Lua backend is not installed");
        return DispatchStatus::kError;
      }
      return structuredLua->invoke(
          structuredLua->context,
          kStructuredLuaOperations[${binding.structuredLuaIndex}],
          frame,
          error,
          errorCapacity);
    }`;
    }
  };
}

const VMATH_POD_CONTRACTS = new Map([
  ["quaternion-conjugate", {
    sourceAnchor: "dmVMath::Conjugate(*q)", shapes: [["Quaternion"]], result: "Quaternion"
  }],
  ["vector3-cross", {
    sourceAnchor: "dmVMath::Cross(*v1, *v2)", shapes: [["Vector3", "Vector3"]], result: "Vector3"
  }],
  ["euler-to-quaternion", {
    sourceAnchor: "dmVMath::EulerToQuat", shapes: [["Vector3"], ["Number", "Number", "Number"]], result: "Quaternion",
    extraAnchors: ["if (lua_type(L, 1) == LUA_TNUMBER)", "luaL_checknumber(L, 2)", "luaL_checknumber(L, 3)", "CheckVector3(L, 1)"]
  }],
  ["length-squared", {
    sourceAnchor: "dmVMath::LengthSqr(*v)", shapes: [["Vector3"], ["Vector4"], ["Quaternion"]], result: "Number",
    extraAnchors: ["CheckUserData(L, 1, &argument)", "dmVMath::LengthSqr(*value)"]
  }],
  ["vector3-project", {
    sourceAnchor: "dmVMath::Dot(*v1, *v2) / sq_len", shapes: [["Vector3", "Vector3"]], result: "Number",
    extraAnchors: ["float sq_len = dmVMath::LengthSqr(*v2);", "if (sq_len == 0.0f)", "return luaL_error"]
  }],
  ["quaternion-axis-angle", {
    sourceAnchor: "Quat::rotation(angle, *axis)", shapes: [["Vector3", "Number"]], result: "Quaternion",
    extraAnchors: ["(float) luaL_checknumber(L, 2)"]
  }],
  ["quaternion-basis", {
    sourceAnchor: "PushQuat(L, Quat(m))", shapes: [["Vector3", "Vector3", "Vector3"]], result: "Quaternion",
    extraAnchors: ["m.setCol0(*x)", "m.setCol1(*y)", "m.setCol2(*z)"]
  }],
  ["quaternion-from-to", {
    sourceAnchor: "Quat::rotation(*v1, *v2)", shapes: [["Vector3", "Vector3"]], result: "Quaternion"
  }],
  ["quaternion-rotation-x", {
    sourceAnchor: "Quat::rotationX(angle)", shapes: [["Number"]], result: "Quaternion",
    extraAnchors: ["(float) luaL_checknumber(L, 1)"]
  }],
  ["quaternion-rotation-y", {
    sourceAnchor: "Quat::rotationY(angle)", shapes: [["Number"]], result: "Quaternion",
    extraAnchors: ["(float) luaL_checknumber(L, 1)"]
  }],
  ["quaternion-rotate-vector3", {
    sourceAnchor: "dmVMath::Rotate(*q, *v)", shapes: [["Quaternion", "Vector3"]], result: "Vector3"
  }]
]);

const VMATH_MATRIX4_CONTRACTS = new Map([
  ["matrix-inverse", { shapes: [["Matrix4"]], result: "Matrix4", sourceAnchor: "dmVMath::Inverse(*m)" }],
  ["matrix-axis-angle", { shapes: [["Vector3", "Number"]], result: "Matrix4", sourceAnchor: "Matrix4::rotation(angle, *axis)" }],
  ["matrix-compose", { shapes: [["Vector3", "Quaternion", "Vector3"], ["Vector4", "Quaternion", "Vector3"]], result: "Matrix4", sourceAnchor: "translation_matrix * rotation_matrix * scale_matrix", extraAnchors: ["translation->getXYZ()"] }],
  ["matrix-frustum", { shapes: [["Number", "Number", "Number", "Number", "Number", "Number"]], result: "Matrix4", sourceAnchor: "Matrix4::frustum(left, right, bottom, top, near_z, far_z)", extraAnchors: ["if(near_z == 0.0f)", "dmLogWarning"] }],
  ["matrix-look-at", { shapes: [["Vector3", "Vector3", "Vector3"]], result: "Matrix4", sourceAnchor: "Matrix4::lookAt(Point3(*CheckVector3(L, 1)), Point3(*CheckVector3(L, 2)), *CheckVector3(L, 3))" }],
  ["matrix-orthographic", { shapes: [["Number", "Number", "Number", "Number", "Number", "Number"]], result: "Matrix4", sourceAnchor: "Matrix4::orthographic(left, right, bottom, top, near_z, far_z)" }],
  ["matrix-perspective", { shapes: [["Number", "Number", "Number", "Number"]], result: "Matrix4", sourceAnchor: "Matrix4::perspective(fov, aspect, near_z, far_z)", extraAnchors: ["if(near_z == 0.0f)", "dmLogWarning"] }],
  ["matrix-quaternion", { shapes: [["Quaternion"]], result: "Matrix4", sourceAnchor: "Matrix4::rotation(*CheckQuat(L, 1))" }],
  ["matrix-rotation-x", { shapes: [["Number"]], result: "Matrix4", sourceAnchor: "Matrix4::rotationX((float) luaL_checknumber(L, 1))" }],
  ["matrix-rotation-y", { shapes: [["Number"]], result: "Matrix4", sourceAnchor: "Matrix4::rotationY((float) luaL_checknumber(L, 1))" }],
  ["matrix-rotation-z", { shapes: [["Number"]], result: "Matrix4", sourceAnchor: "Matrix4::rotationZ((float) luaL_checknumber(L, 1))" }],
  ["matrix-translation", { shapes: [["Vector3"], ["Vector4"]], result: "Matrix4", sourceAnchor: "Matrix4::translation", extraAnchors: ["t1->getXYZ()"] }],
  ["matrix-ortho-inverse", { shapes: [["Matrix4"]], result: "Matrix4", sourceAnchor: "dmVMath::OrthoInverse(*m)" }],
  ["quaternion-from-matrix", { shapes: [["Matrix4"]], result: "Quaternion", sourceAnchor: "dmVMath::Quat(matrix->getUpper3x3())" }]
]);

function vmathPodPrefix(binding, denseIndex) {
  return `${casePrefix(denseIndex)}
      for (uint32_t index = 0; index < frame->argumentCount; ++index) {
        const ScriptValue& argument = frame->arguments[index];
        if (argument.tag == ScriptValueTag::kDefoldValue &&
            hasNaN(argument, argument.defoldKind == ScriptDefoldValueKind::kVector3 ? 3 : 4)) {
          fail(error, errorCapacity, "${binding.rawName} rejects NaN Defold-value components");
          return DispatchStatus::kError;
        }
      }`;
}

const OPERATION_TEMPLATES = new Map([
  ["hash-string", {
    validate(binding, source, definition) {
      exactOperationParameters(binding, [{
        algorithm: "dmHashBuffer64",
        termination: "nul-or-length",
        coercionPolicy: "documented-string-only"
      }]);
      expectOperationContract(binding, [["String"]], "Hash");
      requireSourceAnchors(binding, source, ["luaL_checkstring(L, 1)", "dmHashString64(str)"]);
      const implementationEvidence = definition.additionalSourceEvidence?.find(({ source: path }) =>
        path === "engine/dlib/src/dlib/hash.cpp");
      if (!implementationEvidence?.anchors?.includes("return dmHashBuffer64(string, strlen(string));")) {
        throw new Error(`${binding.id}: hash-string requires pinned dmHashString64 implementation evidence`);
      }
    },
    render(binding, denseIndex) {
      const prefix = casePrefix(denseIndex);
      return `${prefix}
      const ScriptValue& input = frame->arguments[0];
      const char* bytes = input.length ? static_cast<const char*>(input.data) : "";
      const void* terminator = input.length ? std::memchr(bytes, 0, input.length) : nullptr;
      const uint32_t length = terminator
          ? static_cast<uint32_t>(static_cast<const char*>(terminator) - bytes)
          : input.length;
      ScriptValue* out;
      if (!resultCell(frame, &out, error, errorCapacity)) return DispatchStatus::kError;
      out->tag = ScriptValueTag::kHandle;
      out->handleKind = ScriptHandleKind::kHash;
      out->payload = dmHashBuffer64(bytes, length);
      return DispatchStatus::kSuccess;
    }`;
    }
  }],
  ["value-constructor", {
    validate(binding, source, definition) {
      const vector3 = { kind: "Vector3", default: "zero", scalarSplat: true, rejectNaNCopy: true };
      const quaternion = { kind: "Quaternion", default: "identity", scalarSplat: false, rejectNaNCopy: true };
      exactOperationParameters(binding, [vector3, quaternion]);
      if (equal(binding.operation.parameters, vector3)) {
        expectOperationContract(binding, [[], ["Number"], ["Vector3"], ["Number", "Number", "Number"]], "Vector3");
        requireSourceAnchors(binding, source, ["Vector3(0.0f, 0.0f, 0.0f)", "Vector3(x, x, x)", "CheckVector3(L, -1)"]);
      } else {
        expectOperationContract(binding, [[], ["Quaternion"], ["Number", "Number", "Number", "Number"]], "Quaternion");
        requireSourceAnchors(binding, source, ["Quat::identity()", "CheckQuat(L, -1)"]);
      }
      const checks = definition.additionalSourceEvidence?.find(({ source: path }) =>
        path === "engine/script/src/script_vmath.cpp")?.anchors ?? [];
      if (!checks.some((anchor) => anchor.includes("!isnan(v->getZ())")) ||
          !checks.some((anchor) => anchor.includes("!isnan(v->getW())")) ||
          !checks.some((anchor) => anchor.includes("!isnan(q->getW())"))) {
        throw new Error(`${binding.id}: value-constructor requires pinned Defold component validation evidence`);
      }
    },
    render(binding, denseIndex) {
      const prefix = casePrefix(denseIndex);
      if (binding.operation.parameters.kind === "Vector3") return `${prefix}
      dmVMath::Vector3 value;
      if (frame->argumentCount == 0) value = dmVMath::Vector3(0.0f, 0.0f, 0.0f);
      else if (frame->argumentCount == 1 && frame->arguments[0].tag == ScriptValueTag::kNumber) {
        const float scalar = number(frame->arguments[0]);
        value = dmVMath::Vector3(scalar, scalar, scalar);
      } else if (frame->argumentCount == 1) {
        if (hasNaN(frame->arguments[0], 3)) { fail(error, errorCapacity, "vmath.vector3 copy rejects NaN components"); return DispatchStatus::kError; }
        value = vector3(frame->arguments[0]);
      }
      else value = dmVMath::Vector3(number(frame->arguments[0]), number(frame->arguments[1]), number(frame->arguments[2]));
      return complete(writeVector3(frame, value, error, errorCapacity));
    }`;
      return `${prefix}
      dmVMath::Quat value;
      if (frame->argumentCount == 0) value = dmVMath::Quat::identity();
      else if (frame->argumentCount == 1) {
        if (hasNaN(frame->arguments[0], 4)) { fail(error, errorCapacity, "vmath.quat copy rejects NaN components"); return DispatchStatus::kError; }
        value = quaternion(frame->arguments[0]);
      }
      else value = dmVMath::Quat(number(frame->arguments[0]), number(frame->arguments[1]), number(frame->arguments[2]), number(frame->arguments[3]));
      return complete(writeQuaternion(frame, value, error, errorCapacity));
    }`;
    }
  }],
  ["value-unary", {
    validate(binding, source, definition) {
      const kinds = ["Vector3", "Vector4", "Quaternion"];
      exactOperationParameters(binding, [
        { operator: "length", kinds, rejectNaNInput: true },
        { operator: "normalize", kinds, rejectNaNInput: true }
      ]);
      const operator = binding.operation.parameters.operator;
      expectOperationContract(binding, kinds.map((kind) => [kind]), operator === "length" ? "Number" : "SameDefoldValue");
      requireSourceAnchors(binding, source, operator === "length"
        ? ["CheckUserData(L, 1, &argument)", "dmVMath::Length(*v)", "dmVMath::Length(*value)"]
        : ["CheckUserData(L, 1, &argument)", "dmVMath::Normalize(*v)", "dmVMath::Normalize(*value)"]);
      const checks = definition.additionalSourceEvidence?.find(({ source: path }) =>
        path === "engine/script/src/script_vmath.cpp")?.anchors ?? [];
      if (checks.length !== 4 || checks.filter((anchor) => anchor.includes("!isnan(")).length !== 3 ||
          !checks.some((anchor) => anchor.includes("CheckMatrix4Components"))) {
        throw new Error(`${binding.id}: value-unary requires pinned Defold component validation evidence`);
      }
    },
    render(binding, denseIndex) {
      const prefix = casePrefix(denseIndex);
      if (binding.operation.parameters.operator === "length") return `${prefix}
      const ScriptValue& value = frame->arguments[0];
      if (hasNaN(value, value.defoldKind == ScriptDefoldValueKind::kVector3 ? 3 : 4)) { fail(error, errorCapacity, "vmath.length rejects NaN value components"); return DispatchStatus::kError; }
      double result = 0.0;
      if (value.defoldKind == ScriptDefoldValueKind::kVector3) result = dmVMath::Length(vector3(value));
      else if (value.defoldKind == ScriptDefoldValueKind::kVector4) result = dmVMath::Length(vector4(value));
      else result = dmVMath::Length(quaternion(value));
      return complete(writeNumber(frame, result, error, errorCapacity));
    }`;
      return `${prefix}
      const ScriptValue& value = frame->arguments[0];
      if (hasNaN(value, value.defoldKind == ScriptDefoldValueKind::kVector3 ? 3 : 4)) { fail(error, errorCapacity, "vmath.normalize rejects NaN value components"); return DispatchStatus::kError; }
      if (value.defoldKind == ScriptDefoldValueKind::kVector3) return complete(writeVector3(frame, dmVMath::Normalize(vector3(value)), error, errorCapacity));
      if (value.defoldKind == ScriptDefoldValueKind::kVector4) return complete(writeVector4(frame, dmVMath::Normalize(vector4(value)), error, errorCapacity));
      return complete(writeQuaternion(frame, dmVMath::Normalize(quaternion(value)), error, errorCapacity));
    }`;
    }
  }],
  ["quaternion-axis-rotation", {
    validate(binding, source) {
      exactOperationParameters(binding, [{ axis: "z" }]);
      expectOperationContract(binding, [["Number"]], "Quaternion");
      requireSourceAnchors(binding, source, ["Quat::rotationZ(angle)", "PushQuat"]);
    },
    render(binding, denseIndex) {
      return `${casePrefix(denseIndex)}
      return complete(writeQuaternion(frame, dmVMath::Quat::rotationZ(number(frame->arguments[0])), error, errorCapacity));
    }`;
    }
  }],
  ["vmath-fixed-pod", {
    validate(binding, source, definition) {
      const operator = binding.operation.parameters?.operator;
      const contract = VMATH_POD_CONTRACTS.get(operator);
      if (!contract) throw new Error(`${binding.id}: unknown vmath fixed-POD operator ${operator}`);
      exactOperationParameters(binding, [{
        rejectNaNDefoldInputs: true,
        numberNarrowing: "lua-number-to-float32",
        normalization: "none",
        operator
      }]);
      expectOperationContract(binding, contract.shapes, contract.result);
      const body = functionSource(source, binding.sourceSymbol, binding.id);
      requireSourceAnchors(binding, body, [contract.sourceAnchor, ...(contract.extraAnchors ?? [])]);
      if (body.includes("Normalize(")) {
        throw new Error(`${binding.id}: vmath fixed-POD source unexpectedly normalizes an input`);
      }
      const checks = definition.additionalSourceEvidence?.find(({ source: path }) =>
        path === "engine/script/src/script_vmath.cpp")?.anchors ?? [];
      if (checks.length !== 4 || checks.filter((anchor) => anchor.includes("!isnan(")).length !== 3 ||
          !checks.some((anchor) => anchor.includes("CheckMatrix4Components"))) {
        throw new Error(`${binding.id}: vmath-fixed-pod requires pinned Defold component validation evidence`);
      }
    },
    render(binding, denseIndex) {
      const prefix = vmathPodPrefix(binding, denseIndex);
      switch (binding.operation.parameters.operator) {
        case "quaternion-conjugate": return `${prefix}
      return complete(writeQuaternion(frame, dmVMath::Conjugate(quaternion(frame->arguments[0])), error, errorCapacity));
    }`;
        case "vector3-cross": return `${prefix}
      return complete(writeVector3(frame, dmVMath::Cross(vector3(frame->arguments[0]), vector3(frame->arguments[1])), error, errorCapacity));
    }`;
        case "euler-to-quaternion": return `${prefix}
      const dmVMath::Vector3 euler = frame->argumentCount == 1
          ? vector3(frame->arguments[0])
          : dmVMath::Vector3(number(frame->arguments[0]), number(frame->arguments[1]), number(frame->arguments[2]));
      return complete(writeQuaternion(frame, dmVMath::EulerToQuat(euler), error, errorCapacity));
    }`;
        case "length-squared": return `${prefix}
      const ScriptValue& value = frame->arguments[0];
      double result = 0.0;
      if (value.defoldKind == ScriptDefoldValueKind::kVector3) result = dmVMath::LengthSqr(vector3(value));
      else if (value.defoldKind == ScriptDefoldValueKind::kVector4) result = dmVMath::LengthSqr(vector4(value));
      else result = dmVMath::LengthSqr(quaternion(value));
      return complete(writeNumber(frame, result, error, errorCapacity));
    }`;
        case "vector3-project": return `${prefix}
      const dmVMath::Vector3 projected = vector3(frame->arguments[0]);
      const dmVMath::Vector3 target = vector3(frame->arguments[1]);
      const float squaredLength = dmVMath::LengthSqr(target);
      if (squaredLength == 0.0f) {
        fail(error, errorCapacity, "vmath.project second vector must have a length bigger than 0");
        return DispatchStatus::kError;
      }
      return complete(writeNumber(frame, dmVMath::Dot(projected, target) / squaredLength, error, errorCapacity));
    }`;
        case "quaternion-axis-angle": return `${prefix}
      return complete(writeQuaternion(frame, dmVMath::Quat::rotation(
          number(frame->arguments[1]), vector3(frame->arguments[0])), error, errorCapacity));
    }`;
        case "quaternion-basis": return `${prefix}
      dmVMath::Matrix3 basis;
      basis.setCol0(vector3(frame->arguments[0]));
      basis.setCol1(vector3(frame->arguments[1]));
      basis.setCol2(vector3(frame->arguments[2]));
      return complete(writeQuaternion(frame, dmVMath::Quat(basis), error, errorCapacity));
    }`;
        case "quaternion-from-to": return `${prefix}
      return complete(writeQuaternion(frame, dmVMath::Quat::rotation(
          vector3(frame->arguments[0]), vector3(frame->arguments[1])), error, errorCapacity));
    }`;
        case "quaternion-rotation-x": return `${prefix}
      return complete(writeQuaternion(frame, dmVMath::Quat::rotationX(number(frame->arguments[0])), error, errorCapacity));
    }`;
        case "quaternion-rotation-y": return `${prefix}
      return complete(writeQuaternion(frame, dmVMath::Quat::rotationY(number(frame->arguments[0])), error, errorCapacity));
    }`;
        case "quaternion-rotate-vector3": return `${prefix}
      return complete(writeVector3(frame, dmVMath::Rotate(
          quaternion(frame->arguments[0]), vector3(frame->arguments[1])), error, errorCapacity));
    }`;
        default: throw new Error(`${binding.id}: unrendered vmath fixed-POD operator`);
      }
    }
  }],
  ["vmath-matrix4", {
    validate(binding, source, definition) {
      const operator = binding.operation.parameters?.operator;
      const contract = VMATH_MATRIX4_CONTRACTS.get(operator);
      if (!contract) throw new Error(`${binding.id}: unknown vmath Matrix4 operator ${operator}`);
      exactOperationParameters(binding, [{
        layout: "column-major-16-float32",
        storage: "generation-checked-frame-arena",
        rejectNaNDefoldInputs: true,
        numberNarrowing: "lua-number-to-float32",
        normalization: "none",
        operator
      }]);
      expectOperationContract(binding, contract.shapes, contract.result);
      const body = functionSource(source, binding.sourceSymbol, binding.id);
      requireSourceAnchors(binding, body, [contract.sourceAnchor, ...(contract.extraAnchors ?? [])]);
      const checks = definition.additionalSourceEvidence?.find(({ source: path }) =>
        path === "engine/script/src/script_vmath.cpp")?.anchors ?? [];
      if (!checks.some((anchor) => anchor.includes("CheckMatrix4Components")) ||
          !checks.some((anchor) => anchor.includes("!isnan(v->getZ())")) ||
          !checks.some((anchor) => anchor.includes("!isnan(q->getW())"))) {
        throw new Error(`${binding.id}: vmath-matrix4 requires pinned component validation evidence`);
      }
      if (body.includes("Normalize(")) throw new Error(`${binding.id}: Matrix4 source unexpectedly normalizes an input`);
    },
    render(binding, denseIndex) {
      const prefix = `${casePrefix(denseIndex)}
      for (uint32_t index = 0; index < frame->argumentCount; ++index) {
        const ScriptValue& argument = frame->arguments[index];
        if (argument.tag != ScriptValueTag::kDefoldValue) continue;
        if (argument.defoldKind == ScriptDefoldValueKind::kMatrix4) {
          if (!matrix4Elements(frame, argument, error, errorCapacity)) return DispatchStatus::kError;
        } else if (hasNaN(argument, argument.defoldKind == ScriptDefoldValueKind::kVector3 ? 3 : 4)) {
          fail(error, errorCapacity, "${binding.rawName} rejects NaN Defold-value components");
          return DispatchStatus::kError;
        }
      }`;
      switch (binding.operation.parameters.operator) {
        case "matrix-inverse": return `${prefix}
      return complete(writeMatrix4(frame, dmVMath::Inverse(matrix4(frame, frame->arguments[0])), error, errorCapacity));
    }`;
        case "matrix-axis-angle": return `${prefix}
      return complete(writeMatrix4(frame, dmVMath::Matrix4::rotation(number(frame->arguments[1]), vector3(frame->arguments[0])), error, errorCapacity));
    }`;
        case "matrix-compose": return `${prefix}
      const dmVMath::Vector3 translation = frame->arguments[0].defoldKind == ScriptDefoldValueKind::kVector3
          ? vector3(frame->arguments[0]) : vector4(frame->arguments[0]).getXYZ();
      dmVMath::Matrix4 translationMatrix = dmVMath::Matrix4::identity();
      translationMatrix.setTranslation(translation);
      const dmVMath::Matrix4 result = translationMatrix *
          dmVMath::Matrix4::rotation(quaternion(frame->arguments[1])) *
          dmVMath::Matrix4::scale(vector3(frame->arguments[2]));
      return complete(writeMatrix4(frame, result, error, errorCapacity));
    }`;
        case "matrix-frustum": return `${prefix}
      const float nearZ = number(frame->arguments[4]);
      if (nearZ == 0.0f) dmLogWarning("perspective projection invalid, znear = 0");
      return complete(writeMatrix4(frame, dmVMath::Matrix4::frustum(
          number(frame->arguments[0]), number(frame->arguments[1]), number(frame->arguments[2]),
          number(frame->arguments[3]), nearZ, number(frame->arguments[5])), error, errorCapacity));
    }`;
        case "matrix-look-at": return `${prefix}
      return complete(writeMatrix4(frame, dmVMath::Matrix4::lookAt(
          dmVMath::Point3(vector3(frame->arguments[0])), dmVMath::Point3(vector3(frame->arguments[1])),
          vector3(frame->arguments[2])), error, errorCapacity));
    }`;
        case "matrix-orthographic": return `${prefix}
      return complete(writeMatrix4(frame, dmVMath::Matrix4::orthographic(
          number(frame->arguments[0]), number(frame->arguments[1]), number(frame->arguments[2]),
          number(frame->arguments[3]), number(frame->arguments[4]), number(frame->arguments[5])), error, errorCapacity));
    }`;
        case "matrix-perspective": return `${prefix}
      const float nearZ = number(frame->arguments[2]);
      if (nearZ == 0.0f) dmLogWarning("perspective projection invalid, znear = 0");
      return complete(writeMatrix4(frame, dmVMath::Matrix4::perspective(
          number(frame->arguments[0]), number(frame->arguments[1]), nearZ,
          number(frame->arguments[3])), error, errorCapacity));
    }`;
        case "matrix-quaternion": return `${prefix}
      return complete(writeMatrix4(frame, dmVMath::Matrix4::rotation(quaternion(frame->arguments[0])), error, errorCapacity));
    }`;
        case "matrix-rotation-x": return `${prefix}
      return complete(writeMatrix4(frame, dmVMath::Matrix4::rotationX(number(frame->arguments[0])), error, errorCapacity));
    }`;
        case "matrix-rotation-y": return `${prefix}
      return complete(writeMatrix4(frame, dmVMath::Matrix4::rotationY(number(frame->arguments[0])), error, errorCapacity));
    }`;
        case "matrix-rotation-z": return `${prefix}
      return complete(writeMatrix4(frame, dmVMath::Matrix4::rotationZ(number(frame->arguments[0])), error, errorCapacity));
    }`;
        case "matrix-translation": return `${prefix}
      const dmVMath::Vector3 translation = frame->arguments[0].defoldKind == ScriptDefoldValueKind::kVector3
          ? vector3(frame->arguments[0]) : vector4(frame->arguments[0]).getXYZ();
      return complete(writeMatrix4(frame, dmVMath::Matrix4::translation(translation), error, errorCapacity));
    }`;
        case "matrix-ortho-inverse": return `${prefix}
      return complete(writeMatrix4(frame, dmVMath::OrthoInverse(matrix4(frame, frame->arguments[0])), error, errorCapacity));
    }`;
        case "quaternion-from-matrix": return `${prefix}
      return complete(writeQuaternion(frame, dmVMath::Quat(matrix4(frame, frame->arguments[0]).getUpper3x3()), error, errorCapacity));
    }`;
        default: throw new Error(`${binding.id}: unrendered vmath Matrix4 operator`);
      }
    }
  }],
  ["current-instance-transform-get", {
    validate(binding, source, definition, moduleSource) {
      exactOperationParameters(binding, [{ property: "position", kind: "Vector3", addressed: ADDRESSED_TRANSFORM_BACKEND }]);
      expectOperationContract(binding, [[], ["String"], ["Hash"], ["Url"]], "Vector3");
      requireSourceAnchors(binding, source, ["ResolveInstance(L, 1)", "dmGameObject::GetPosition(instance)"]);
      requireSourceAnchors(binding, moduleSource, RESOLVE_INSTANCE_ANCHORS);
    },
    render(binding, denseIndex) {
      return `${casePrefix(denseIndex)}
${addressedTransformDelegation(binding, "frame->argumentCount != 0")}
      game_object::ResolvedCurrent current;
      if (!game_object::resolveCurrent(&current, error, errorCapacity)) return DispatchStatus::kError;
      float position[3]{};
      current.api->getPosition(current.api->userData, current.instance, position);
      return complete(writeVector3(frame, dmVMath::Vector3(position[0], position[1], position[2]), error, errorCapacity));
    }`;
    }
  }],
  ["current-instance-transform-set", {
    validate(binding, source, definition, moduleSource) {
      const position = { property: "position", kind: "Vector3", rejectNaN: true, addressed: ADDRESSED_TRANSFORM_BACKEND };
      const rotation = { property: "rotation", kind: "Quaternion", rejectNaN: true, addressed: ADDRESSED_TRANSFORM_BACKEND };
      exactOperationParameters(binding, [position, rotation]);
      const isPosition = equal(binding.operation.parameters, position);
      const value = isPosition ? "Vector3" : "Quaternion";
      expectOperationContract(binding,
        [[value], [value, "String"], [value, "Hash"], [value, "Url"]], "None");
      requireSourceAnchors(binding, source, isPosition
        ? ["ResolveInstance(L, 2)", "dmGameObject::SetPosition(instance, dmVMath::Point3(*v))"]
        : ["ResolveInstance(L, 2)", "dmGameObject::SetRotation(instance, *q)"]);
      requireSourceAnchors(binding, moduleSource, RESOLVE_INSTANCE_ANCHORS);
    },
    render(binding, denseIndex) {
      const prefix = casePrefix(denseIndex);
      // The NaN guard runs before the address branch so both the current-instance
      // and addressed forms refuse the same inputs at the same boundary.
      const delegation = addressedTransformDelegation(binding, "frame->argumentCount != 1");
      if (binding.operation.parameters.property === "position") return `${prefix}
      const ScriptValue& value = frame->arguments[0];
      if (std::isnan(value.defoldValue[0]) || std::isnan(value.defoldValue[1]) || std::isnan(value.defoldValue[2])) {
        fail(error, errorCapacity, "go.setPosition rejects NaN components");
        return DispatchStatus::kError;
      }
${delegation}
      game_object::ResolvedCurrent current;
      if (!game_object::resolveCurrent(&current, error, errorCapacity)) return DispatchStatus::kError;
      current.api->setPosition(current.api->userData, current.instance, value.defoldValue);
      return DispatchStatus::kSuccess;
    }`;
      return `${prefix}
      const ScriptValue& value = frame->arguments[0];
      if (std::isnan(value.defoldValue[0]) || std::isnan(value.defoldValue[1]) ||
          std::isnan(value.defoldValue[2]) || std::isnan(value.defoldValue[3])) {
        fail(error, errorCapacity, "go.setRotation rejects NaN components");
        return DispatchStatus::kError;
      }
${delegation}
      game_object::ResolvedCurrent current;
      if (!game_object::resolveCurrent(&current, error, errorCapacity)) return DispatchStatus::kError;
      current.api->setRotation(current.api->userData, current.instance, value.defoldValue);
      return DispatchStatus::kSuccess;
    }`;
    }
  }],
  ["message-post", reviewedStructuredLuaTemplate({
    backend: "captured-lua", context: "script-sender-url", maxPayloadBytes: 2048,
    descriptorLookup: true, ddfCodec: "defold-generated", fallbackCodec: "defold-table-wire",
    allocationPolicy: "engine-message-queue-may-allocate"
  }, [["String", "String"], ["String", "String", "Table"]], "None")],
  ["factory-spawn", reviewedStructuredLuaTemplate({
    backend: "captured-lua", context: "active-go", componentType: "factoryc",
    positionDefault: "sender-world-position", rotationDefault: "sender-world-rotation",
    scaleDefault: "sender-world-scale", propertyKeyReality: "string-only",
    resultPolicy: "hash-or-undefined", reentrant: true,
    allocationPolicy: "engine-property-spawn-resource-may-allocate"
  }, [["String"], ["String", "Vector3", "Nil", "Table"]], "Hash")],
  ["game-object-delete", reviewedStructuredLuaTemplate({
    backend: "captured-lua", context: "active-go", async: true, rejectBone: true,
    singleMissing: "error", listMissing: "warn-continue", explicitNil: "error",
    allocationPolicy: "bridge-zero-heap"
  }, [[], ["Hash"]], "None")],
  ["gui-node-lookup", reviewedStructuredLuaTemplate({
    backend: "captured-lua", context: "active-gui-scene",
    handlePolicy: "generational-registry-ref", notFound: "error"
  }, [["String"]], "Node")],
  ["gui-node-text-set", reviewedStructuredLuaTemplate({
    backend: "captured-lua", context: "active-gui-scene",
    handlePolicy: "generational-registry-ref", numberFormat: "lua-5.1-%.14g"
  }, [["Node", "String"], ["Node", "Number"]], "None")],
  ["gui-node-setter", reviewedStructuredLuaTemplate({
    backend: "captured-lua", context: "active-gui-scene",
    handlePolicy: "generational-registry-ref", argumentPolicy: "pinned-ir-all-call-shapes",
    allocationPolicy: "engine-defined-per-member"
  }, null, "None")]
]);

function operationTemplate(binding) {
  if (!binding.operation || typeof binding.operation !== "object" || Array.isArray(binding.operation) ||
      typeof binding.operation.template !== "string") {
    throw new Error(`${binding.id}: operation must select a declarative template`);
  }
  const template = OPERATION_TEMPLATES.get(binding.operation.template);
  if (!template) throw new Error(`${binding.id}: unknown operation template ${binding.operation.template}`);
  return template;
}

function renderOperation(binding, denseIndex) {
  return operationTemplate(binding).render(binding, denseIndex);
}

/* Operation renderers are selected only by reviewed template metadata above. Binding IDs
 * remain stable identity keys and never select native implementation code. */
function validateOperation(binding, source, definition, moduleSource) {
  operationTemplate(binding).validate(binding, source, definition, moduleSource);
}

function targetSupport(binding) {
  const nativeBackend = binding.operation.parameters.backend === "captured-lua"
    ? "generated-captured-lua"
    // Addressed transform shapes keep the current-instance form on the direct
    // native path and re-enter the pinned Lua route only to resolve an address.
    : binding.operation.parameters.addressed === ADDRESSED_TRANSFORM_BACKEND
    ? "generated-native-pod-with-addressed-captured-lua"
    : "generated-native-pod";
  const browserExecutable = binding.operation.template === "hash-string";
  return {
    arm64DynamicHermes: {
      status: "generated-executable",
      backend: nativeBackend,
      evidence: "native-focused-test-not-packaged-engine-proof"
    },
    html5BrowserHost: browserExecutable
      ? { status: "generated-executable", backend: "emscripten-primitive-c-abi" }
      : {
          status: "not-executable",
          backend: "unavailable",
          reason: "html5-browser-host-codec-or-context-not-implemented"
        }
  };
}

export function generate(irText, scalarDispatchText, patternsText, inputs) {
  const ir = JSON.parse(irText);
  const scalarDispatch = JSON.parse(scalarDispatchText);
  const patternsReport = JSON.parse(patternsText);
  const irSha256 = createHash("sha256").update(irText).digest("hex");
  if (patternsReport.schemaVersion !== 1 || patternsReport.sourceSha256 !== irSha256 ||
      !Array.isArray(patternsReport.bindings)) {
    throw new Error("Binding patterns are stale against pinned script IR");
  }
  const patterns = new Map();
  for (const pattern of patternsReport.bindings) {
    if (typeof pattern.id !== "string" || patterns.has(pattern.id)) {
      throw new Error(`Binding patterns contain an invalid or duplicate id: ${pattern.id}`);
    }
    patterns.set(pattern.id, pattern);
  }
  const scalarStableIds = new Map();
  for (const binding of scalarDispatch.bindings) {
    if (!Number.isInteger(binding.stableId)) throw new Error(`${binding.id}: scalar dispatch stable ID is invalid`);
    const collision = scalarStableIds.get(binding.stableId);
    if (collision) throw new Error(`Scalar stable ID collision: ${binding.id} and ${collision}`);
    scalarStableIds.set(binding.stableId, binding.id);
  }
  const functions = new Map(ir.functions.map((fn) => [fn.id, fn]));
  const stableIds = new Map();
  const sourceEvidence = [];
  const bindings = inputs.flatMap(({ definitionText, sourceText, additionalSources = [] }) => {
    const definition = JSON.parse(definitionText);
    if (definition.schemaVersion !== 2 || !Array.isArray(definition.bindings) ||
        (definition.families != null && !Array.isArray(definition.families)) ||
        typeof definition.irSource !== "string") {
      throw new Error("Unsupported Defold value binding schema");
    }
    const sourceSha256 = createHash("sha256").update(sourceText).digest("hex");
    if (sourceSha256 !== definition.sourceSha256) throw new Error(`Pinned ${definition.source} changed; review Defold value bindings`);
    sourceEvidence.push({ path: `upstream/defold/${definition.source}`, sha256: sourceSha256 });
    const declaredAdditional = definition.additionalSourceEvidence ?? [];
    if (!Array.isArray(declaredAdditional) || declaredAdditional.length !== additionalSources.length) {
      throw new Error(`${definition.source}: additional source evidence is incomplete`);
    }
    for (let index = 0; index < declaredAdditional.length; ++index) {
      const declared = declaredAdditional[index];
      const loaded = additionalSources[index];
      if (!declared || typeof declared.source !== "string" || typeof declared.sourceSha256 !== "string" ||
          !Array.isArray(declared.anchors) || declared.anchors.some((anchor) => typeof anchor !== "string")) {
        throw new Error(`${definition.source}: invalid additional source evidence`);
      }
      if (loaded.source !== declared.source) throw new Error(`${definition.source}: loaded the wrong additional source evidence`);
      const sha256 = createHash("sha256").update(loaded.sourceText).digest("hex");
      if (sha256 !== declared.sourceSha256) throw new Error(`Pinned ${declared.source} changed; review Defold value bindings`);
      for (const anchor of declared.anchors) {
        if (!loaded.sourceText.includes(anchor)) throw new Error(`${declared.source}: source evidence anchor ${JSON.stringify(anchor)} is stale`);
      }
      sourceEvidence.push({ path: `upstream/defold/${declared.source}`, sha256 });
    }
    return expandDefinitionBindings(definition, functions, patterns, sourceText).map((entry) => {
    const fn = functions.get(entry.id);
    if (!fn || fn.source !== definition.irSource) throw new Error(`${entry.id}: missing pinned ${definition.irSource} IR`);
    const scopedSource = entry.generatedFamily
      ? sourceText
      : functionSource(sourceText, entry.sourceSymbol, entry.id);
    const sourceOperations = entry.sourceOperation == null
      ? []
      : Array.isArray(entry.sourceOperation) ? entry.sourceOperation : [entry.sourceOperation];
    if (sourceOperations.some((anchor) => typeof anchor !== "string" || !scopedSource.includes(anchor))) {
      throw new Error(`${entry.id}: scoped source operation evidence is stale`);
    }
    if (entry.callShapes.some((shape) => shape.some((codec) => !CODECS.has(codec)))) throw new Error(`${entry.id}: unsupported codec`);
    const familyCodecs = new Map(Object.entries(entry.familyTypeCodecs ?? {}));
    const derived = deriveCallShapes(fn, familyCodecs);
    if (!equal(derived, entry.callShapes)) throw new Error(`${entry.id}: reviewed call shapes differ from pinned IR: ${JSON.stringify(derived)}`);
    const implementedCallShapes = entry.implementedCallShapes ?? entry.callShapes;
    if (implementedCallShapes.some((shape) => shape.some((codec) => !CODECS.has(codec))) ||
        implementedCallShapes.some((shape) =>
          !derived.some((candidate) => equal(candidate, shape)) && !isIrCompatibleShape(fn, shape))) {
      throw new Error(`${entry.id}: implemented call shape is not present in pinned IR`);
    }
    const derivedResult = deriveResultCodec(fn);
    if (derivedResult !== entry.resultCodec) throw new Error(`${entry.id}: reviewed result codec ${entry.resultCodec} differs from pinned IR ${derivedResult}`);
    const id = stableBindingId(entry.id);
    const scalarOwner = scalarStableIds.get(id);
    if (scalarOwner) throw new Error(`${entry.id}: stable ID collides with scalar binding ${scalarOwner}`);
    if (stableIds.has(id)) throw new Error(`Stable ID collision: ${entry.id} and ${stableIds.get(id)}`);
    stableIds.set(id, entry.id);
    const binding = {
      ...entry,
      implementedCallShapes,
      stableId: id,
      rawName: fn.rawName,
      jsName: fn.jsName,
      source: fn.source,
      line: fn.line,
      ownership: definition.ownership,
      targetSupport: targetSupport(entry)
    };
    validateOperation(binding, scopedSource, definition, sourceText);
    return binding;
    });
  }).sort((left, right) => left.stableId - right.stableId);

  const structuredLuaTemplates = new Set([
    "message-post", "factory-spawn", "game-object-delete", "gui-node-lookup", "gui-node-text-set",
    "gui-node-setter", "current-instance-transform-get", "current-instance-transform-set"
  ]);
  const structuredLuaBindings = bindings.filter(({ operation }) => structuredLuaTemplates.has(operation.template));
  structuredLuaBindings.forEach((binding, index) => {
    Object.defineProperty(binding, "structuredLuaIndex", { value: index, enumerable: false });
  });

  const shapes = bindings.flatMap(({ implementedCallShapes }) => implementedCallShapes);
  const bindingShapeOffsets = [0];
  for (const binding of bindings) bindingShapeOffsets.push(bindingShapeOffsets.at(-1) + binding.implementedCallShapes.length);
  const shapeArgumentOffsets = [0];
  for (const shape of shapes) shapeArgumentOffsets.push(shapeArgumentOffsets.at(-1) + shape.length);
  const argumentCodecs = shapes.flat();
  const bindingIds = bindings.map(({ rawName, stableId }) =>
    `  ${pascal(rawName)} = ${hexBindingId(stableId)}`).join(",\n");
  const structuredLuaOperations = structuredLuaBindings.map((binding, index) => {
    const [module, member] = binding.rawName.split(".");
    const context = binding.operation.parameters.context === "active-gui-scene"
      ? "StructuredLuaContext::kGuiScriptInstance"
      : binding.operation.parameters.context === "script-sender-url"
        ? "StructuredLuaContext::kCurrentScriptInstance"
        : "StructuredLuaContext::kScriptInstance";
    const resultCodec = binding.operation.parameters.resultPolicy === "hash-or-undefined"
      ? "HashOrUndefined"
      : binding.resultCodec;
    return `  {${index}, ${hexBindingId(binding.stableId)}, ${JSON.stringify(binding.id)}, ${JSON.stringify(module)}, ${JSON.stringify(member)}, StructuredLuaResultCodec::k${resultCodec}, ${context}},`;
  }).join("\n");
  const inputHash = createHash("sha256").update(irText).update("\0").update(scalarDispatchText)
    .update("\0").update(patternsText);
  for (const { definitionText, sourceText, additionalSources = [] } of inputs) {
    inputHash.update("\0").update(definitionText).update("\0").update(sourceText);
    for (const source of additionalSources) inputHash.update("\0").update(source.source).update("\0").update(source.sourceText);
  }
  const inputSha256 = inputHash.digest("hex");
  const report = {
    schemaVersion: 1,
    defoldRevision: ir.defoldRevision,
    inputSha256,
    sourceEvidence,
    operationTemplateVocabulary: [...OPERATION_TEMPLATES.keys()],
    coverageClaim: "The listed routes have generated native dispatch and structured call-shape validation. Captured-Lua routes have focused native backend tests but remain explicitly unverified in a packaged Defold engine until their component dispatchers run the real-engine scenarios.",
    allocationClaim: "POD dispatch uses inline ScriptValue cells, bounded context stacks, stack-local dmVMath values, and a fixed-capacity generation-checked Matrix4 frame arena with no heap fallback. Structured calls use fixed-capacity table staging and a 256-slot generational node pool; Lua registry growth and the documented engine operations may allocate. Debug dmHashBuffer64 may allocate once to register a previously unseen short string in Defold's reverse-hash table.",
    floatPolicy: "Numeric constructor arguments follow Lua-number conversion, including NaN and infinity; finite values outside float32 range deterministically become signed infinity. Defold-value and Matrix4 inputs reject NaN components through pinned CheckVector3/CheckVector4/CheckQuat/CheckMatrix4 semantics, while normalize and unchanged degenerate dmVMath operations may produce NaN from otherwise valid inputs.",
    bindingCount: bindings.length,
    callShapeCount: shapes.length,
    argumentCodecCount: argumentCodecs.length,
    bindings
  };

  const header = `// Generated by scripts/generate-script-value-bindings.mjs. Do not edit.\n#pragma once\n\n#include <cstddef>\n\n#include <defold_hermes/script_bridge_capi.hpp>\n\nnamespace defold_hermes::value_binding {\n\nenum class DispatchStatus { kMissing, kSuccess, kError };\nenum class StructuredLuaResultCodec : uint8_t { kNone, kHash, kHashOrUndefined, kNode, kVector3, kQuaternion };\nenum class StructuredLuaContext : uint8_t { kScriptInstance, kGuiScriptInstance, kCurrentScriptInstance };\nstruct StructuredLuaOperation {\n  uint16_t index;\n  uint32_t stableId;\n  const char* canonicalId;\n  const char* module;\n  const char* member;\n  StructuredLuaResultCodec resultCodec;\n  StructuredLuaContext context;\n};\nstruct StructuredLuaApi {\n  void* context = nullptr;\n  DispatchStatus (*invoke)(void* context, const StructuredLuaOperation& operation, ScriptCallFrame* frame, char* error, size_t errorCapacity) noexcept = nullptr;\n};\nenum class BindingId : uint32_t {\n${bindingIds}\n};\ninline constexpr size_t kBindingCount = ${bindings.length};\ninline constexpr size_t kCallShapeCount = ${shapes.length};\ninline constexpr size_t kStructuredLuaOperationCount = ${structuredLuaBindings.length};\nDispatchStatus dispatch(ScriptCallFrame* frame, char* error, size_t errorCapacity, const StructuredLuaApi* structuredLua = nullptr) noexcept;\n\n}  // namespace defold_hermes::value_binding\n`;

  const source = `// Generated by scripts/generate-script-value-bindings.mjs. Do not edit.\n#include <defold_hermes/generated_script_value_bindings.hpp>\n\n#include <dmsdk/dlib/hash.h>\n#include <dmsdk/dlib/vmath.h>\n\n#include <cmath>\n#include <cstdio>\n#include <cstring>\n#include <limits>\n\nnamespace defold_hermes::value_binding {\nnamespace {\nenum class Codec : uint8_t { kNumber, kString, kHash, kVector3, kVector4, kQuaternion };\nconstexpr uint32_t kStableIds[] = {\n${bindings.map(({ stableId, id }) => `  ${hexBindingId(stableId)},  // ${id}`).join("\n")}\n};\nconstexpr uint16_t kBindingShapeOffsets[] = { ${bindingShapeOffsets.join(", ")} };\nconstexpr uint16_t kShapeArgumentOffsets[] = { ${shapeArgumentOffsets.join(", ")} };\nconstexpr uint8_t kShapeArgumentCounts[] = { ${shapes.map((shape) => shape.length).join(", ")} };\nconstexpr Codec kArgumentCodecs[] = {\n${argumentCodecs.map((codec) => `  Codec::k${codec},`).join("\n")}\n};\n\nbool fail(char* error, size_t capacity, const char* message) noexcept {\n  if (error && capacity) std::snprintf(error, capacity, "%s", message);\n  return false;\n}\n\nbool matches(Codec codec, const ScriptValue& value) noexcept {\n  if (codec == Codec::kNumber) return value.tag == ScriptValueTag::kNumber;\n  if (codec == Codec::kString) return value.tag == ScriptValueTag::kString && (value.length == 0 || value.data);\n  if (codec == Codec::kHash) return value.tag == ScriptValueTag::kHandle && value.handleKind == ScriptHandleKind::kHash;\n  if (value.tag != ScriptValueTag::kDefoldValue) return false;\n  if (codec == Codec::kVector3) return value.defoldKind == ScriptDefoldValueKind::kVector3;\n  if (codec == Codec::kVector4) return value.defoldKind == ScriptDefoldValueKind::kVector4;\n  return value.defoldKind == ScriptDefoldValueKind::kQuaternion;\n}\n\nsize_t denseIndex(uint32_t stableId) noexcept {\n  for (size_t index = 0; index < kBindingCount; ++index) if (kStableIds[index] == stableId) return index;\n  return kBindingCount;\n}\n\nbool validateShape(size_t binding, const ScriptCallFrame& frame) noexcept {\n  for (size_t shape = kBindingShapeOffsets[binding]; shape < kBindingShapeOffsets[binding + 1]; ++shape) {\n    if (kShapeArgumentCounts[shape] != frame.argumentCount) continue;\n    const size_t offset = kShapeArgumentOffsets[shape];\n    bool valid = true;\n    for (size_t index = 0; index < frame.argumentCount; ++index) valid = valid && matches(kArgumentCodecs[offset + index], frame.arguments[index]);\n    if (valid) return true;\n  }\n  return false;\n}\n\nfloat number(const ScriptValue& value) noexcept {\n  const double number = value.number;\n  if (number > std::numeric_limits<float>::max()) return std::numeric_limits<float>::infinity();\n  if (number < -std::numeric_limits<float>::max()) return -std::numeric_limits<float>::infinity();\n  return static_cast<float>(number);\n}\ndmVMath::Vector3 vector3(const ScriptValue& value) noexcept { return {value.defoldValue[0], value.defoldValue[1], value.defoldValue[2]}; }\ndmVMath::Vector4 vector4(const ScriptValue& value) noexcept { return {value.defoldValue[0], value.defoldValue[1], value.defoldValue[2], value.defoldValue[3]}; }\ndmVMath::Quat quaternion(const ScriptValue& value) noexcept { return {value.defoldValue[0], value.defoldValue[1], value.defoldValue[2], value.defoldValue[3]}; }\n\nbool resultCell(ScriptCallFrame* frame, ScriptValue** out, char* error, size_t capacity) noexcept {\n  if (!frame->results || frame->resultCapacity < 1) return fail(error, capacity, "Defold value result storage is exhausted");\n  *out = &frame->results[0];\n  **out = {};\n  frame->resultCount = 1;\n  return true;\n}\n\nbool writeNumber(ScriptCallFrame* frame, double value, char* error, size_t capacity) noexcept {\n  ScriptValue* out; if (!resultCell(frame, &out, error, capacity)) return false;\n  out->tag = ScriptValueTag::kNumber; out->number = value; return true;\n}\nbool writeVector3(ScriptCallFrame* frame, const dmVMath::Vector3& value, char* error, size_t capacity) noexcept {\n  ScriptValue* out; if (!resultCell(frame, &out, error, capacity)) return false;\n  out->tag = ScriptValueTag::kDefoldValue; out->defoldKind = ScriptDefoldValueKind::kVector3;\n  out->defoldValue[0] = value.getX(); out->defoldValue[1] = value.getY(); out->defoldValue[2] = value.getZ(); return true;\n}\nbool writeVector4(ScriptCallFrame* frame, const dmVMath::Vector4& value, char* error, size_t capacity) noexcept {\n  ScriptValue* out; if (!resultCell(frame, &out, error, capacity)) return false;\n  out->tag = ScriptValueTag::kDefoldValue; out->defoldKind = ScriptDefoldValueKind::kVector4;\n  out->defoldValue[0] = value.getX(); out->defoldValue[1] = value.getY(); out->defoldValue[2] = value.getZ(); out->defoldValue[3] = value.getW(); return true;\n}\nbool writeQuaternion(ScriptCallFrame* frame, const dmVMath::Quat& value, char* error, size_t capacity) noexcept {\n  ScriptValue* out; if (!resultCell(frame, &out, error, capacity)) return false;\n  out->tag = ScriptValueTag::kDefoldValue; out->defoldKind = ScriptDefoldValueKind::kQuaternion;\n  out->defoldValue[0] = value.getX(); out->defoldValue[1] = value.getY(); out->defoldValue[2] = value.getZ(); out->defoldValue[3] = value.getW(); return true;\n}\nDispatchStatus complete(bool ok) noexcept { return ok ? DispatchStatus::kSuccess : DispatchStatus::kError; }\n}  // namespace\n\nDispatchStatus dispatch(ScriptCallFrame* frame, char* error, size_t errorCapacity) noexcept {\n  if (!frame) { fail(error, errorCapacity, "Defold value call frame is null"); return DispatchStatus::kError; }\n  const size_t binding = denseIndex(frame->stableId);\n  if (binding == kBindingCount) return DispatchStatus::kMissing;\n  frame->resultCount = 0;\n  if (frame->argumentCount && !frame->arguments) { fail(error, errorCapacity, "Defold value arguments are null"); return DispatchStatus::kError; }\n  if (!validateShape(binding, *frame)) { fail(error, errorCapacity, "Defold value arguments do not match a generated call shape"); return DispatchStatus::kError; }\n  switch (binding) {\n${bindings.map(renderOperation).join("\n")}\n    default: break;\n  }\n  fail(error, errorCapacity, "Generated Defold value binding has no implementation");\n  return DispatchStatus::kError;\n}\n\n}  // namespace defold_hermes::value_binding\n`;
  const sourceWithStructuredLua = source
    .replace(
      `size_t denseIndex(uint32_t stableId) noexcept {
  for (size_t index = 0; index < kBindingCount; ++index) if (kStableIds[index] == stableId) return index;
  return kBindingCount;
}`,
      `size_t denseIndex(uint32_t stableId) noexcept {
  size_t first = 0;
  size_t count = kBindingCount;
  while (count != 0) {
    const size_t step = count / 2;
    const size_t index = first + step;
    if (kStableIds[index] < stableId) {
      first = index + 1;
      count -= step + 1;
    } else {
      count = step;
    }
  }
  return first < kBindingCount && kStableIds[first] == stableId ? first : kBindingCount;
}`)
    .replace(
      "dmVMath::Vector3 vector3(const ScriptValue& value) noexcept",
      "bool hasNaN(const ScriptValue& value, size_t count) noexcept { for (size_t index = 0; index < count; ++index) if (std::isnan(value.defoldValue[index])) return true; return false; }\n" +
      "dmVMath::Vector3 vector3(const ScriptValue& value) noexcept")
    .replace(
      "enum class Codec : uint8_t { kNumber, kString, kHash, kVector3, kVector4, kQuaternion };",
      "enum class Codec : uint8_t { kNil, kBoolean, kNumber, kString, kHash, kUrl, kVector3, kVector4, kQuaternion, kMatrix4, kTable, kNode, kAddressArray };")
    .replace(
      "constexpr uint16_t kBindingShapeOffsets[] =",
      `constexpr StructuredLuaOperation kStructuredLuaOperations[] = {\n${structuredLuaOperations}\n};\nconstexpr uint16_t kBindingShapeOffsets[] =`)
    .replace(
      `bool matches(Codec codec, const ScriptValue& value) noexcept {
  if (codec == Codec::kNumber) return value.tag == ScriptValueTag::kNumber;
  if (codec == Codec::kString) return value.tag == ScriptValueTag::kString && (value.length == 0 || value.data);
  if (codec == Codec::kHash) return value.tag == ScriptValueTag::kHandle && value.handleKind == ScriptHandleKind::kHash;
  if (value.tag != ScriptValueTag::kDefoldValue) return false;
  if (codec == Codec::kVector3) return value.defoldKind == ScriptDefoldValueKind::kVector3;
  if (codec == Codec::kVector4) return value.defoldKind == ScriptDefoldValueKind::kVector4;
  return value.defoldKind == ScriptDefoldValueKind::kQuaternion;
}`,
      `bool matches(Codec codec, const ScriptValue& value) noexcept {
  if (codec == Codec::kNil) return value.tag == ScriptValueTag::kUndefined || value.tag == ScriptValueTag::kNull;
  if (codec == Codec::kBoolean) return value.tag == ScriptValueTag::kBoolean;
  if (codec == Codec::kNumber) return value.tag == ScriptValueTag::kNumber;
  if (codec == Codec::kString) return value.tag == ScriptValueTag::kString && (value.length == 0 || value.data);
  if (codec == Codec::kHash) return value.tag == ScriptValueTag::kHandle && value.handleKind == ScriptHandleKind::kHash;
  if (codec == Codec::kUrl) return value.tag == ScriptValueTag::kHandle && value.handleKind == ScriptHandleKind::kUrl;
  if (codec == Codec::kNode) return value.tag == ScriptValueTag::kHandle && value.handleKind == ScriptHandleKind::kGuiNode;
  if (codec == Codec::kTable) return value.tag == ScriptValueTag::kTable && (value.length == 0 || value.data);
  if (codec == Codec::kAddressArray) return false;
  if (value.tag != ScriptValueTag::kDefoldValue) return false;
  if (codec == Codec::kVector3) return value.defoldKind == ScriptDefoldValueKind::kVector3;
  if (codec == Codec::kVector4) return value.defoldKind == ScriptDefoldValueKind::kVector4;
  if (codec == Codec::kQuaternion) return value.defoldKind == ScriptDefoldValueKind::kQuaternion;
  return value.defoldKind == ScriptDefoldValueKind::kMatrix4;
}`)
    .replace(
      "DispatchStatus complete(bool ok) noexcept { return ok ? DispatchStatus::kSuccess : DispatchStatus::kError; }",
      `const float* matrix4Elements(ScriptCallFrame* frame, const ScriptValue& value, char* error, size_t capacity) noexcept {
  if (!frame->matrix4Arena) { fail(error, capacity, "Matrix4 frame arena is unavailable"); return nullptr; }
  const float* elements = frame->matrix4Arena->resolve(value);
  if (!elements) { fail(error, capacity, "Matrix4 token is stale or belongs to another frame arena"); return nullptr; }
  for (size_t index = 0; index < 16; ++index) {
    if (std::isnan(elements[index])) { fail(error, capacity, "Matrix4 input rejects NaN components"); return nullptr; }
  }
  return elements;
}
dmVMath::Matrix4 matrix4(ScriptCallFrame* frame, const ScriptValue& value) noexcept {
  const float* e = frame->matrix4Arena->resolve(value);
  return dmVMath::Matrix4(
      dmVMath::Vector4(e[0], e[1], e[2], e[3]), dmVMath::Vector4(e[4], e[5], e[6], e[7]),
      dmVMath::Vector4(e[8], e[9], e[10], e[11]), dmVMath::Vector4(e[12], e[13], e[14], e[15]));
}
bool writeMatrix4(ScriptCallFrame* frame, const dmVMath::Matrix4& value, char* error, size_t capacity) noexcept {
  if (!frame->matrix4Arena) return fail(error, capacity, "Matrix4 frame arena is unavailable");
  if (frame->matrix4Arena->used >= ScriptMatrix4Arena::kCapacity) return fail(error, capacity, "Matrix4 frame arena is exhausted");
  ScriptValue* out; if (!resultCell(frame, &out, error, capacity)) return false;
  alignas(16) float elements[16];
  for (size_t column = 0; column < 4; ++column) {
    for (size_t row = 0; row < 4; ++row) elements[column * 4 + row] = value.getElem(column, row);
  }
  if (!frame->matrix4Arena->store(elements, out)) return fail(error, capacity, "Matrix4 frame arena store failed");
  return true;
}
DispatchStatus complete(bool ok) noexcept { return ok ? DispatchStatus::kSuccess : DispatchStatus::kError; }`)
    .replace(
      "DispatchStatus dispatch(ScriptCallFrame* frame, char* error, size_t errorCapacity) noexcept {",
      "DispatchStatus dispatch(ScriptCallFrame* frame, char* error, size_t errorCapacity, const StructuredLuaApi* structuredLua) noexcept {");
  const sourceWithContext = sourceWithStructuredLua.replace(
    "#include <defold_hermes/generated_script_value_bindings.hpp>\n",
    "#include <defold_hermes/generated_script_value_bindings.hpp>\n#include <defold_hermes/active_game_object_context.hpp>\n#include <defold_hermes/script_matrix4_arena.hpp>\n#ifndef DLIB_LOG_DOMAIN\n#define DLIB_LOG_DOMAIN \"DEFOLD_HERMES\"\n#endif\n#include <dmsdk/dlib/log.h>\n");
  const browserUnsupported = bindings.filter(({ targetSupport: support }) =>
    support.html5BrowserHost.status === "not-executable");
  const targetSupportSource = `// Generated by scripts/generate-script-value-bindings.mjs. Do not edit.\n` +
    `export function assertValueRouteTargetSupport(stableId: number, target: string | undefined): void {\n` +
    `  if (target !== "html5-browser-host") return;\n` +
    `  switch (stableId >>> 0) {\n` +
    browserUnsupported.map(({ stableId, id }) =>
      `    case ${hexBindingId(stableId).replace(/u$/, "")}: throw new Error(${JSON.stringify(`${id} is not executable in the HTML5 browser host`)});`).join("\n") +
    `\n    default: return;\n  }\n}\n`;
  return {
    report: `${JSON.stringify(report, null, 2)}\n`,
    header,
    source: sourceWithContext,
    targetSupportSource
  };
}

export async function loadGenerationInputs() {
  const [irText, scalarDispatchText, patternsText] = await Promise.all([
    readFile(irUrl, "utf8"), readFile(scalarDispatchUrl, "utf8"), readFile(patternsUrl, "utf8")
  ]);
  const inputs = await Promise.all(definitionUrls.map(async (definitionUrl) => {
    const definitionText = await readFile(definitionUrl, "utf8");
    const definition = JSON.parse(definitionText);
    const sourceText = await readFile(new URL(`upstream/defold/${definition.source}`, root), "utf8");
    const additionalSources = await Promise.all((definition.additionalSourceEvidence ?? []).map(async ({ source }) => ({
      source,
      sourceText: await readFile(new URL(`upstream/defold/${source}`, root), "utf8")
    })));
    return { definitionText, sourceText, additionalSources };
  }));
  return { irText, scalarDispatchText, patternsText, inputs };
}

async function main(argv = process.argv.slice(2)) {
  const unknown = argv.filter((argument) => argument !== "--check");
  if (unknown.length) throw new Error(`Unknown argument: ${unknown[0]}`);
  const check = argv.includes("--check");
  const { irText, scalarDispatchText, patternsText, inputs } = await loadGenerationInputs();
  const outputs = generate(irText, scalarDispatchText, patternsText, inputs);
  for (const [url, content] of [
    [reportUrl, outputs.report],
    [headerUrl, outputs.header],
    [sourceUrl, outputs.source],
    [targetSupportUrl, outputs.targetSupportSource]
  ]) {
    if (check) {
      if (await readFile(url, "utf8") !== content) throw new Error(`${url.pathname} is stale`);
    } else await writeFile(url, content);
  }
  console.log(`${check ? "Verified" : "Generated"} ${JSON.parse(outputs.report).bindingCount} native Defold value bindings.`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
