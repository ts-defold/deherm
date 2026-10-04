export class SpecializationEvidenceDrift extends Error {}

export function split(value, delimiter = "|") {
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

export function cartesian(parts) {
  return parts.reduce((rows, alternatives) => rows.flatMap((row) => alternatives.map((item) => [...row, item])), [[]]);
}

export function factoryImplementedCallShapes(callShapes) {
  if (callShapes.length === 0 || callShapes.some((shape) => shape.length < 1 || shape.length > 5)) {
    throw new Error("script:factory.create must retain its pinned one-to-five argument contract");
  }
  if (callShapes.some((shape) => shape[0] === "Nil")) {
    throw new Error("script:factory.create never accepts nil for its factory address");
  }
  const expanded = callShapes.flatMap((shape) =>
    cartesian(shape.map((codec, index) => (index === 0 ? [codec] : [codec, "Nil"]))),
  );
  const unique = new Map(expanded.map((shape) => [JSON.stringify(shape), shape]));
  return [...unique.values()];
}

export function equal(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => equal(value, right[index]))
    );
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
    throw new Error(
      `${binding.id}: parameters do not match reviewed ${binding.operation.template} template: ${JSON.stringify(parameters)}`,
    );
  }
}

function expectOperationContract(binding, callShapes, resultCodec) {
  if (!equal(binding.implementedCallShapes, callShapes)) {
    throw new Error(
      `${binding.id}: ${binding.operation.template} parameters require implemented call shapes ${JSON.stringify(callShapes)}`,
    );
  }
  if (binding.resultCodec !== resultCodec) {
    throw new Error(`${binding.id}: ${binding.operation.template} parameters require result codec ${resultCodec}`);
  }
}

function requireSourceAnchors(binding, functionSource, anchors) {
  for (const anchor of anchors) {
    if (!functionSource.includes(anchor)) {
      throw new SpecializationEvidenceDrift(
        `${binding.id}: ${binding.operation.template} source anchor ${JSON.stringify(anchor)} is stale`,
      );
    }
  }
}

/**
 * Require semantic call sites without pinning their argument spelling.
 *
 * Defold owns the called function's ABI. A revision may add an explicit
 * collection/context argument while preserving the Lua contract, as happened
 * to the game-object transform routes in 1.14.0. The lowering decision depends
 * on which operations the Lua entry point performs, not on the local variable
 * names or the exact argument list used by that engine revision.
 */
function requireSourceCalls(binding, functionSource, callees) {
  for (const callee of callees) {
    const escaped = callee.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!new RegExp(`(?:^|[^A-Za-z0-9_])${escaped}\\s*\\(`, "u").test(functionSource)) {
      throw new SpecializationEvidenceDrift(
        `${binding.id}: ${binding.operation.template} source call ${JSON.stringify(callee)} is stale`,
      );
    }
  }
}

export function functionSource(sourceText, symbol, id) {
  const signature = new RegExp(
    `(?:static\\s+)?int\\s+${symbol.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\s*\\(lua_State\\*\\s*L\\)`,
  );
  const match = signature.exec(sourceText);
  if (!match) throw new SpecializationEvidenceDrift(`${id}: source symbol ${symbol} is stale`);
  const open = sourceText.indexOf("{", match.index + match[0].length);
  if (open < 0) throw new SpecializationEvidenceDrift(`${id}: source symbol ${symbol} has no body`);
  let depth = 0;
  let mode = "code";
  for (let index = open; index < sourceText.length; ++index) {
    const char = sourceText[index];
    const next = sourceText[index + 1];
    if (mode === "line-comment") {
      if (char === "\n") mode = "code";
      continue;
    }
    if (mode === "block-comment") {
      if (char === "*" && next === "/") {
        mode = "code";
        ++index;
      }
      continue;
    }
    if (mode === "string") {
      if (char === "\\") ++index;
      else if (char === '"') mode = "code";
      continue;
    }
    if (mode === "character") {
      if (char === "\\") ++index;
      else if (char === "'") mode = "code";
      continue;
    }
    if (char === "/" && next === "/") {
      mode = "line-comment";
      ++index;
      continue;
    }
    if (char === "/" && next === "*") {
      mode = "block-comment";
      ++index;
      continue;
    }
    if (char === '"') {
      mode = "string";
      continue;
    }
    if (char === "'") {
      mode = "character";
      continue;
    }
    if (char === "{") ++depth;
    else if (char === "}" && --depth === 0) return sourceText.slice(match.index, index + 1);
  }
  throw new SpecializationEvidenceDrift(`${id}: source symbol ${symbol} has an unterminated body`);
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
export const ADDRESSED_TRANSFORM_BACKEND = "pinned-resolve-instance-captured-lua";

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

function validateStructuredLuaContract(binding, parameters, callShapes, resultCodec) {
  exactOperationParameters(binding, [parameters]);
  if (callShapes) {
    const expectedCallShapes = typeof callShapes === "function" ? callShapes(binding.callShapes) : callShapes;
    expectOperationContract(binding, expectedCallShapes, resultCodec);
  } else if (
    binding.resultCodec !== resultCodec ||
    binding.implementedCallShapes.length === 0 ||
    binding.implementedCallShapes.some((shape) => shape[0] !== "Node")
  ) {
    throw new Error(
      `${binding.id}: ${binding.operation.template} requires Node-first call shapes and ${resultCodec} result`,
    );
  }
}

function reviewedStructuredLuaTemplate(parameters, callShapes, resultCodec, requiredCapability = null) {
  return {
    validate(binding) {
      validateStructuredLuaContract(binding, parameters, callShapes, resultCodec);
      if (requiredCapability === "gui-node-userdata") {
        const proof = binding.structuralCapabilities;
        if (
          proof?.registration?.route !== "gui.get_node" ||
          proof.registration.module !== "gui" ||
          proof.registration.cFunction !== binding.sourceSymbol ||
          proof.context?.kind !== "active-gui-scene" ||
          proof.context?.capability?.evidence !== "registered-instance-userdata-check" ||
          proof.inputCodecs?.length !== 1 ||
          !proof.inputCodecs[0]?.includes("hash") ||
          !proof.inputCodecs[0]?.includes("string") ||
          proof.result?.codec !== "Node" ||
          proof.userdata?.kind !== "full-userdata" ||
          typeof proof.userdata?.metatable !== "string" ||
          typeof proof.userdata?.registeredType !== "string" ||
          proof.userdata?.initializedFieldCount < 2 ||
          proof.userdata?.checkedBy !== "dmScript::CheckUserType" ||
          !proof.userdata?.metamethods?.includes("__index") ||
          !proof.userdata?.metamethods?.includes("__newindex")
        ) {
          throw new Error(`${binding.id}: ${binding.operation.template} lacks GUI node userdata capability evidence`);
        }
        return;
      }
      if (
        ["factory-spawn", "message-post", "gui-node-text-set"].includes(binding.operation.template) &&
        binding.structuralCapabilities?.operation?.registration?.route !== binding.rawName
      ) {
        throw new Error(
          `${binding.id}: ${binding.operation.template} lacks structural value/effect capability evidence`,
        );
      }
      const evidence = Array.isArray(binding.sourceOperation)
        ? binding.sourceOperation
        : binding.sourceOperation
          ? [binding.sourceOperation]
          : [];
      if (
        evidence.length === 0 &&
        !binding.structuralCapabilities?.operation &&
        !binding.structuralCapabilities?.registration
      ) {
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
    },
  };
}

/**
 * A captured-Lua route delegates semantics to Defold's registered function.
 * Its source proof therefore stops at the actual boundary: the member still
 * registers the reviewed C function. Its admitted argument classes and result
 * are already derived from the pinned IR and checked against the generated
 * codec contract. Private implementation details below that boundary are
 * Defold's responsibility.
 */
function reviewedRegisteredLuaTemplate(parameters, callShapes, resultCodec, member) {
  const template = reviewedStructuredLuaTemplate(parameters, callShapes, resultCodec);
  return {
    ...template,
    validate(binding) {
      validateStructuredLuaContract(binding, parameters, callShapes, resultCodec);
      const registration = binding.structuralCapabilities?.registration;
      if (
        !registration ||
        registration.cFunction !== binding.sourceSymbol ||
        registration.route.split(".").at(-1) !== member
      ) {
        throw new SpecializationEvidenceDrift(
          `${binding.id}: registered Lua callable ${JSON.stringify(member)} no longer resolves to ${binding.sourceSymbol}`,
        );
      }
    },
  };
}

const VMATH_POD_CONTRACTS = new Map([
  [
    "quaternion-conjugate",
    {
      sourceAnchor: "dmVMath::Conjugate(*q)",
      shapes: [["Quaternion"]],
      result: "Quaternion",
    },
  ],
  [
    "vector3-cross",
    {
      sourceAnchor: "dmVMath::Cross(*v1, *v2)",
      shapes: [["Vector3", "Vector3"]],
      result: "Vector3",
    },
  ],
  [
    "euler-to-quaternion",
    {
      sourceAnchor: "dmVMath::EulerToQuat",
      shapes: [["Vector3"], ["Number", "Number", "Number"]],
      result: "Quaternion",
      extraAnchors: [
        "if (lua_type(L, 1) == LUA_TNUMBER)",
        "luaL_checknumber(L, 2)",
        "luaL_checknumber(L, 3)",
        "CheckVector3(L, 1)",
      ],
    },
  ],
  [
    "length-squared",
    {
      sourceAnchor: "dmVMath::LengthSqr(*v)",
      shapes: [["Vector3"], ["Vector4"], ["Quaternion"]],
      result: "Number",
      extraAnchors: ["CheckUserData(L, 1, &argument)", "dmVMath::LengthSqr(*value)"],
    },
  ],
  [
    "vector3-project",
    {
      sourceAnchor: "dmVMath::Dot(*v1, *v2) / sq_len",
      shapes: [["Vector3", "Vector3"]],
      result: "Number",
      extraAnchors: ["float sq_len = dmVMath::LengthSqr(*v2);", "if (sq_len == 0.0f)", "return luaL_error"],
    },
  ],
  [
    "quaternion-axis-angle",
    {
      sourceAnchor: "Quat::rotation(angle, *axis)",
      shapes: [["Vector3", "Number"]],
      result: "Quaternion",
      extraAnchors: ["(float) luaL_checknumber(L, 2)"],
    },
  ],
  [
    "quaternion-basis",
    {
      sourceAnchor: "PushQuat(L, Quat(m))",
      shapes: [["Vector3", "Vector3", "Vector3"]],
      result: "Quaternion",
      extraAnchors: ["m.setCol0(*x)", "m.setCol1(*y)", "m.setCol2(*z)"],
    },
  ],
  [
    "quaternion-from-to",
    {
      sourceAnchor: "Quat::rotation(*v1, *v2)",
      shapes: [["Vector3", "Vector3"]],
      result: "Quaternion",
    },
  ],
  [
    "quaternion-rotation-x",
    {
      sourceAnchor: "Quat::rotationX(angle)",
      shapes: [["Number"]],
      result: "Quaternion",
      extraAnchors: ["(float) luaL_checknumber(L, 1)"],
    },
  ],
  [
    "quaternion-rotation-y",
    {
      sourceAnchor: "Quat::rotationY(angle)",
      shapes: [["Number"]],
      result: "Quaternion",
      extraAnchors: ["(float) luaL_checknumber(L, 1)"],
    },
  ],
  [
    "quaternion-rotate-vector3",
    {
      sourceAnchor: "dmVMath::Rotate(*q, *v)",
      shapes: [["Quaternion", "Vector3"]],
      result: "Vector3",
    },
  ],
]);

const VMATH_MATRIX4_CONTRACTS = new Map([
  ["matrix-inverse", { shapes: [["Matrix4"]], result: "Matrix4", sourceAnchor: "dmVMath::Inverse(*m)" }],
  [
    "matrix-axis-angle",
    { shapes: [["Vector3", "Number"]], result: "Matrix4", sourceAnchor: "Matrix4::rotation(angle, *axis)" },
  ],
  [
    "matrix-compose",
    {
      shapes: [
        ["Vector3", "Quaternion", "Vector3"],
        ["Vector4", "Quaternion", "Vector3"],
      ],
      result: "Matrix4",
      sourceAnchor: "translation_matrix * rotation_matrix * scale_matrix",
      extraAnchors: ["translation->getXYZ()"],
    },
  ],
  [
    "matrix-frustum",
    {
      shapes: [["Number", "Number", "Number", "Number", "Number", "Number"]],
      result: "Matrix4",
      sourceAnchor: "Matrix4::frustum(left, right, bottom, top, near_z, far_z)",
      extraAnchors: ["if(near_z == 0.0f)", "dmLogWarning"],
    },
  ],
  [
    "matrix-look-at",
    {
      shapes: [["Vector3", "Vector3", "Vector3"]],
      result: "Matrix4",
      sourceAnchor: "Matrix4::lookAt(Point3(*CheckVector3(L, 1)), Point3(*CheckVector3(L, 2)), *CheckVector3(L, 3))",
    },
  ],
  [
    "matrix-orthographic",
    {
      shapes: [["Number", "Number", "Number", "Number", "Number", "Number"]],
      result: "Matrix4",
      sourceAnchor: "Matrix4::orthographic(left, right, bottom, top, near_z, far_z)",
    },
  ],
  [
    "matrix-perspective",
    {
      shapes: [["Number", "Number", "Number", "Number"]],
      result: "Matrix4",
      sourceAnchor: "Matrix4::perspective(fov, aspect, near_z, far_z)",
      extraAnchors: ["if(near_z == 0.0f)", "dmLogWarning"],
    },
  ],
  [
    "matrix-quaternion",
    { shapes: [["Quaternion"]], result: "Matrix4", sourceAnchor: "Matrix4::rotation(*CheckQuat(L, 1))" },
  ],
  [
    "matrix-rotation-x",
    { shapes: [["Number"]], result: "Matrix4", sourceAnchor: "Matrix4::rotationX((float) luaL_checknumber(L, 1))" },
  ],
  [
    "matrix-rotation-y",
    { shapes: [["Number"]], result: "Matrix4", sourceAnchor: "Matrix4::rotationY((float) luaL_checknumber(L, 1))" },
  ],
  [
    "matrix-rotation-z",
    { shapes: [["Number"]], result: "Matrix4", sourceAnchor: "Matrix4::rotationZ((float) luaL_checknumber(L, 1))" },
  ],
  [
    "matrix-translation",
    {
      shapes: [["Vector3"], ["Vector4"]],
      result: "Matrix4",
      sourceAnchor: "Matrix4::translation",
      extraAnchors: ["t1->getXYZ()"],
    },
  ],
  ["matrix-ortho-inverse", { shapes: [["Matrix4"]], result: "Matrix4", sourceAnchor: "dmVMath::OrthoInverse(*m)" }],
  [
    "quaternion-from-matrix",
    { shapes: [["Matrix4"]], result: "Quaternion", sourceAnchor: "dmVMath::Quat(matrix->getUpper3x3())" },
  ],
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
  [
    "hash-string",
    {
      validate(binding, source, definition) {
        exactOperationParameters(binding, [
          {
            algorithm: "dmHashBuffer64",
            termination: "nul-or-length",
            coercionPolicy: "documented-string-only",
          },
        ]);
        expectOperationContract(binding, [["String"]], "Hash");
        requireSourceAnchors(binding, source, ["luaL_checkstring(L, 1)", "dmHashString64(str)"]);
        const implementationEvidence = definition.additionalSourceEvidence?.find(
          ({ source: path }) => path === "engine/dlib/src/dlib/hash.cpp",
        );
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
      },
    },
  ],
  [
    "value-constructor",
    {
      validate(binding, source, definition) {
        const vector3 = { kind: "Vector3", default: "zero", scalarSplat: true, rejectNaNCopy: true };
        const quaternion = { kind: "Quaternion", default: "identity", scalarSplat: false, rejectNaNCopy: true };
        exactOperationParameters(binding, [vector3, quaternion]);
        if (equal(binding.operation.parameters, vector3)) {
          expectOperationContract(binding, [[], ["Number"], ["Vector3"], ["Number", "Number", "Number"]], "Vector3");
          requireSourceAnchors(binding, source, [
            "Vector3(0.0f, 0.0f, 0.0f)",
            "Vector3(x, x, x)",
            "CheckVector3(L, -1)",
          ]);
        } else {
          expectOperationContract(
            binding,
            [[], ["Quaternion"], ["Number", "Number", "Number", "Number"]],
            "Quaternion",
          );
          requireSourceAnchors(binding, source, ["Quat::identity()", "CheckQuat(L, -1)"]);
        }
        const checks =
          definition.additionalSourceEvidence?.find(({ source: path }) => path === "engine/script/src/script_vmath.cpp")
            ?.anchors ?? [];
        if (
          !checks.some((anchor) => anchor.includes("!isnan(v->getZ())")) ||
          !checks.some((anchor) => anchor.includes("!isnan(v->getW())")) ||
          !checks.some((anchor) => anchor.includes("!isnan(q->getW())"))
        ) {
          throw new Error(`${binding.id}: value-constructor requires pinned Defold component validation evidence`);
        }
      },
      render(binding, denseIndex) {
        const prefix = casePrefix(denseIndex);
        if (binding.operation.parameters.kind === "Vector3")
          return `${prefix}
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
      },
    },
  ],
  [
    "value-unary",
    {
      validate(binding, source, definition) {
        const kinds = ["Vector3", "Vector4", "Quaternion"];
        exactOperationParameters(binding, [
          { operator: "length", kinds, rejectNaNInput: true },
          { operator: "normalize", kinds, rejectNaNInput: true },
        ]);
        const operator = binding.operation.parameters.operator;
        expectOperationContract(
          binding,
          kinds.map((kind) => [kind]),
          operator === "length" ? "Number" : "SameDefoldValue",
        );
        requireSourceAnchors(
          binding,
          source,
          operator === "length"
            ? ["CheckUserData(L, 1, &argument)", "dmVMath::Length(*v)", "dmVMath::Length(*value)"]
            : ["CheckUserData(L, 1, &argument)", "dmVMath::Normalize(*v)", "dmVMath::Normalize(*value)"],
        );
        const checks =
          definition.additionalSourceEvidence?.find(({ source: path }) => path === "engine/script/src/script_vmath.cpp")
            ?.anchors ?? [];
        if (
          checks.length !== 4 ||
          checks.filter((anchor) => anchor.includes("!isnan(")).length !== 3 ||
          !checks.some((anchor) => anchor.includes("CheckMatrix4Components"))
        ) {
          throw new Error(`${binding.id}: value-unary requires pinned Defold component validation evidence`);
        }
      },
      render(binding, denseIndex) {
        const prefix = casePrefix(denseIndex);
        if (binding.operation.parameters.operator === "length")
          return `${prefix}
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
      },
    },
  ],
  [
    "quaternion-axis-rotation",
    {
      validate(binding, source) {
        exactOperationParameters(binding, [{ axis: "z" }]);
        expectOperationContract(binding, [["Number"]], "Quaternion");
        requireSourceAnchors(binding, source, ["Quat::rotationZ(angle)", "PushQuat"]);
      },
      render(binding, denseIndex) {
        return `${casePrefix(denseIndex)}
      return complete(writeQuaternion(frame, dmVMath::Quat::rotationZ(number(frame->arguments[0])), error, errorCapacity));
    }`;
      },
    },
  ],
  [
    "vmath-fixed-pod",
    {
      validate(binding, source, definition) {
        const operator = binding.operation.parameters?.operator;
        const contract = VMATH_POD_CONTRACTS.get(operator);
        if (!contract) throw new Error(`${binding.id}: unknown vmath fixed-POD operator ${operator}`);
        exactOperationParameters(binding, [
          {
            rejectNaNDefoldInputs: true,
            numberNarrowing: "lua-number-to-float32",
            normalization: "none",
            operator,
          },
        ]);
        expectOperationContract(binding, contract.shapes, contract.result);
        const body = functionSource(source, binding.sourceSymbol, binding.id);
        requireSourceAnchors(binding, body, [contract.sourceAnchor, ...(contract.extraAnchors ?? [])]);
        if (body.includes("Normalize(")) {
          throw new Error(`${binding.id}: vmath fixed-POD source unexpectedly normalizes an input`);
        }
        const checks =
          definition.additionalSourceEvidence?.find(({ source: path }) => path === "engine/script/src/script_vmath.cpp")
            ?.anchors ?? [];
        if (
          checks.length !== 4 ||
          checks.filter((anchor) => anchor.includes("!isnan(")).length !== 3 ||
          !checks.some((anchor) => anchor.includes("CheckMatrix4Components"))
        ) {
          throw new Error(`${binding.id}: vmath-fixed-pod requires pinned Defold component validation evidence`);
        }
      },
      render(binding, denseIndex) {
        const prefix = vmathPodPrefix(binding, denseIndex);
        switch (binding.operation.parameters.operator) {
          case "quaternion-conjugate":
            return `${prefix}
      return complete(writeQuaternion(frame, dmVMath::Conjugate(quaternion(frame->arguments[0])), error, errorCapacity));
    }`;
          case "vector3-cross":
            return `${prefix}
      return complete(writeVector3(frame, dmVMath::Cross(vector3(frame->arguments[0]), vector3(frame->arguments[1])), error, errorCapacity));
    }`;
          case "euler-to-quaternion":
            return `${prefix}
      const dmVMath::Vector3 euler = frame->argumentCount == 1
          ? vector3(frame->arguments[0])
          : dmVMath::Vector3(number(frame->arguments[0]), number(frame->arguments[1]), number(frame->arguments[2]));
      return complete(writeQuaternion(frame, dmVMath::EulerToQuat(euler), error, errorCapacity));
    }`;
          case "length-squared":
            return `${prefix}
      const ScriptValue& value = frame->arguments[0];
      double result = 0.0;
      if (value.defoldKind == ScriptDefoldValueKind::kVector3) result = dmVMath::LengthSqr(vector3(value));
      else if (value.defoldKind == ScriptDefoldValueKind::kVector4) result = dmVMath::LengthSqr(vector4(value));
      else result = dmVMath::LengthSqr(quaternion(value));
      return complete(writeNumber(frame, result, error, errorCapacity));
    }`;
          case "vector3-project":
            return `${prefix}
      const dmVMath::Vector3 projected = vector3(frame->arguments[0]);
      const dmVMath::Vector3 target = vector3(frame->arguments[1]);
      const float squaredLength = dmVMath::LengthSqr(target);
      if (squaredLength == 0.0f) {
        fail(error, errorCapacity, "vmath.project second vector must have a length bigger than 0");
        return DispatchStatus::kError;
      }
      return complete(writeNumber(frame, dmVMath::Dot(projected, target) / squaredLength, error, errorCapacity));
    }`;
          case "quaternion-axis-angle":
            return `${prefix}
      return complete(writeQuaternion(frame, dmVMath::Quat::rotation(
          number(frame->arguments[1]), vector3(frame->arguments[0])), error, errorCapacity));
    }`;
          case "quaternion-basis":
            return `${prefix}
      dmVMath::Matrix3 basis;
      basis.setCol0(vector3(frame->arguments[0]));
      basis.setCol1(vector3(frame->arguments[1]));
      basis.setCol2(vector3(frame->arguments[2]));
      return complete(writeQuaternion(frame, dmVMath::Quat(basis), error, errorCapacity));
    }`;
          case "quaternion-from-to":
            return `${prefix}
      return complete(writeQuaternion(frame, dmVMath::Quat::rotation(
          vector3(frame->arguments[0]), vector3(frame->arguments[1])), error, errorCapacity));
    }`;
          case "quaternion-rotation-x":
            return `${prefix}
      return complete(writeQuaternion(frame, dmVMath::Quat::rotationX(number(frame->arguments[0])), error, errorCapacity));
    }`;
          case "quaternion-rotation-y":
            return `${prefix}
      return complete(writeQuaternion(frame, dmVMath::Quat::rotationY(number(frame->arguments[0])), error, errorCapacity));
    }`;
          case "quaternion-rotate-vector3":
            return `${prefix}
      return complete(writeVector3(frame, dmVMath::Rotate(
          quaternion(frame->arguments[0]), vector3(frame->arguments[1])), error, errorCapacity));
    }`;
          default:
            throw new Error(`${binding.id}: unrendered vmath fixed-POD operator`);
        }
      },
    },
  ],
  [
    "vmath-matrix4",
    {
      validate(binding, source, definition) {
        const operator = binding.operation.parameters?.operator;
        const contract = VMATH_MATRIX4_CONTRACTS.get(operator);
        if (!contract) throw new Error(`${binding.id}: unknown vmath Matrix4 operator ${operator}`);
        exactOperationParameters(binding, [
          {
            layout: "column-major-16-float32",
            storage: "generation-checked-frame-arena",
            rejectNaNDefoldInputs: true,
            numberNarrowing: "lua-number-to-float32",
            normalization: "none",
            operator,
          },
        ]);
        expectOperationContract(binding, contract.shapes, contract.result);
        const body = functionSource(source, binding.sourceSymbol, binding.id);
        requireSourceAnchors(binding, body, [contract.sourceAnchor, ...(contract.extraAnchors ?? [])]);
        const checks =
          definition.additionalSourceEvidence?.find(({ source: path }) => path === "engine/script/src/script_vmath.cpp")
            ?.anchors ?? [];
        if (
          !checks.some((anchor) => anchor.includes("CheckMatrix4Components")) ||
          !checks.some((anchor) => anchor.includes("!isnan(v->getZ())")) ||
          !checks.some((anchor) => anchor.includes("!isnan(q->getW())"))
        ) {
          throw new Error(`${binding.id}: vmath-matrix4 requires pinned component validation evidence`);
        }
        if (body.includes("Normalize("))
          throw new Error(`${binding.id}: Matrix4 source unexpectedly normalizes an input`);
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
          case "matrix-inverse":
            return `${prefix}
      return complete(writeMatrix4(frame, dmVMath::Inverse(matrix4(frame, frame->arguments[0])), error, errorCapacity));
    }`;
          case "matrix-axis-angle":
            return `${prefix}
      return complete(writeMatrix4(frame, dmVMath::Matrix4::rotation(number(frame->arguments[1]), vector3(frame->arguments[0])), error, errorCapacity));
    }`;
          case "matrix-compose":
            return `${prefix}
      const dmVMath::Vector3 translation = frame->arguments[0].defoldKind == ScriptDefoldValueKind::kVector3
          ? vector3(frame->arguments[0]) : vector4(frame->arguments[0]).getXYZ();
      dmVMath::Matrix4 translationMatrix = dmVMath::Matrix4::identity();
      translationMatrix.setTranslation(translation);
      const dmVMath::Matrix4 result = translationMatrix *
          dmVMath::Matrix4::rotation(quaternion(frame->arguments[1])) *
          dmVMath::Matrix4::scale(vector3(frame->arguments[2]));
      return complete(writeMatrix4(frame, result, error, errorCapacity));
    }`;
          case "matrix-frustum":
            return `${prefix}
      const float nearZ = number(frame->arguments[4]);
      if (nearZ == 0.0f) dmLogWarning("perspective projection invalid, znear = 0");
      return complete(writeMatrix4(frame, dmVMath::Matrix4::frustum(
          number(frame->arguments[0]), number(frame->arguments[1]), number(frame->arguments[2]),
          number(frame->arguments[3]), nearZ, number(frame->arguments[5])), error, errorCapacity));
    }`;
          case "matrix-look-at":
            return `${prefix}
      return complete(writeMatrix4(frame, dmVMath::Matrix4::lookAt(
          dmVMath::Point3(vector3(frame->arguments[0])), dmVMath::Point3(vector3(frame->arguments[1])),
          vector3(frame->arguments[2])), error, errorCapacity));
    }`;
          case "matrix-orthographic":
            return `${prefix}
      return complete(writeMatrix4(frame, dmVMath::Matrix4::orthographic(
          number(frame->arguments[0]), number(frame->arguments[1]), number(frame->arguments[2]),
          number(frame->arguments[3]), number(frame->arguments[4]), number(frame->arguments[5])), error, errorCapacity));
    }`;
          case "matrix-perspective":
            return `${prefix}
      const float nearZ = number(frame->arguments[2]);
      if (nearZ == 0.0f) dmLogWarning("perspective projection invalid, znear = 0");
      return complete(writeMatrix4(frame, dmVMath::Matrix4::perspective(
          number(frame->arguments[0]), number(frame->arguments[1]), nearZ,
          number(frame->arguments[3])), error, errorCapacity));
    }`;
          case "matrix-quaternion":
            return `${prefix}
      return complete(writeMatrix4(frame, dmVMath::Matrix4::rotation(quaternion(frame->arguments[0])), error, errorCapacity));
    }`;
          case "matrix-rotation-x":
            return `${prefix}
      return complete(writeMatrix4(frame, dmVMath::Matrix4::rotationX(number(frame->arguments[0])), error, errorCapacity));
    }`;
          case "matrix-rotation-y":
            return `${prefix}
      return complete(writeMatrix4(frame, dmVMath::Matrix4::rotationY(number(frame->arguments[0])), error, errorCapacity));
    }`;
          case "matrix-rotation-z":
            return `${prefix}
      return complete(writeMatrix4(frame, dmVMath::Matrix4::rotationZ(number(frame->arguments[0])), error, errorCapacity));
    }`;
          case "matrix-translation":
            return `${prefix}
      const dmVMath::Vector3 translation = frame->arguments[0].defoldKind == ScriptDefoldValueKind::kVector3
          ? vector3(frame->arguments[0]) : vector4(frame->arguments[0]).getXYZ();
      return complete(writeMatrix4(frame, dmVMath::Matrix4::translation(translation), error, errorCapacity));
    }`;
          case "matrix-ortho-inverse":
            return `${prefix}
      return complete(writeMatrix4(frame, dmVMath::OrthoInverse(matrix4(frame, frame->arguments[0])), error, errorCapacity));
    }`;
          case "quaternion-from-matrix":
            return `${prefix}
      return complete(writeQuaternion(frame, dmVMath::Quat(matrix4(frame, frame->arguments[0]).getUpper3x3()), error, errorCapacity));
    }`;
          default:
            throw new Error(`${binding.id}: unrendered vmath Matrix4 operator`);
        }
      },
    },
  ],
  [
    "current-instance-transform-get",
    {
      validate(binding, source) {
        exactOperationParameters(binding, [
          { property: "position", kind: "Vector3", addressed: ADDRESSED_TRANSFORM_BACKEND },
        ]);
        expectOperationContract(binding, [[], ["String"], ["Hash"], ["Url"]], "Vector3");
        requireSourceCalls(binding, source, ["ResolveInstance", "dmGameObject::GetPosition"]);
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
      },
    },
  ],
  [
    "current-instance-transform-set",
    {
      validate(binding, source) {
        const position = {
          property: "position",
          kind: "Vector3",
          rejectNaN: true,
          addressed: ADDRESSED_TRANSFORM_BACKEND,
        };
        const rotation = {
          property: "rotation",
          kind: "Quaternion",
          rejectNaN: true,
          addressed: ADDRESSED_TRANSFORM_BACKEND,
        };
        exactOperationParameters(binding, [position, rotation]);
        const isPosition = equal(binding.operation.parameters, position);
        const value = isPosition ? "Vector3" : "Quaternion";
        expectOperationContract(binding, [[value], [value, "String"], [value, "Hash"], [value, "Url"]], "None");
        requireSourceCalls(
          binding,
          source,
          isPosition
            ? ["ResolveInstance", "dmGameObject::SetPosition"]
            : ["ResolveInstance", "dmGameObject::SetRotation"],
        );
      },
      render(binding, denseIndex) {
        const prefix = casePrefix(denseIndex);
        // The NaN guard runs before the address branch so both the current-instance
        // and addressed forms refuse the same inputs at the same boundary.
        const delegation = addressedTransformDelegation(binding, "frame->argumentCount != 1");
        if (binding.operation.parameters.property === "position")
          return `${prefix}
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
      },
    },
  ],
  [
    "message-post",
    reviewedStructuredLuaTemplate(
      {
        backend: "captured-lua",
        context: "script-sender-url",
        maxPayloadBytes: 2048,
        descriptorLookup: true,
        ddfCodec: "defold-generated",
        fallbackCodec: "defold-table-wire",
        allocationPolicy: "engine-message-queue-may-allocate",
      },
      [
        ["String", "String"],
        ["String", "String", "Table"],
      ],
      "None",
    ),
  ],
  [
    "factory-spawn",
    reviewedStructuredLuaTemplate(
      {
        backend: "captured-lua",
        context: "active-go",
        componentType: "factoryc",
        positionDefault: "sender-world-position",
        rotationDefault: "sender-world-rotation",
        scaleDefault: "sender-world-scale",
        propertyKeyReality: "string-only",
        resultPolicy: "hash-or-undefined",
        reentrant: true,
        allocationPolicy: "engine-property-spawn-resource-may-allocate",
      },
      factoryImplementedCallShapes,
      "Hash",
    ),
  ],
  [
    "game-object-delete",
    reviewedRegisteredLuaTemplate(
      {
        backend: "captured-lua",
        context: "active-go",
        async: true,
        rejectBone: true,
        singleMissing: "error",
        listMissing: "warn-continue",
        explicitNil: "error",
        allocationPolicy: "bridge-zero-heap",
      },
      [[], ["Hash"]],
      "None",
      "delete",
    ),
  ],
  [
    "gui-node-lookup",
    reviewedStructuredLuaTemplate(
      {
        backend: "captured-lua",
        context: "active-gui-scene",
        handlePolicy: "generational-registry-ref",
        notFound: "error",
      },
      [["String"]],
      "Node",
      "gui-node-userdata",
    ),
  ],
  [
    "gui-node-text-set",
    reviewedStructuredLuaTemplate(
      {
        backend: "captured-lua",
        context: "active-gui-scene",
        handlePolicy: "generational-registry-ref",
        numberFormat: "lua-5.1-%.14g",
      },
      [
        ["Node", "String"],
        ["Node", "Number"],
      ],
      "None",
    ),
  ],
  [
    "gui-node-setter",
    reviewedStructuredLuaTemplate(
      {
        backend: "captured-lua",
        context: "active-gui-scene",
        handlePolicy: "generational-registry-ref",
        argumentPolicy: "pinned-ir-all-call-shapes",
        allocationPolicy: "engine-defined-per-member",
      },
      null,
      "None",
    ),
  ],
]);

export const operationTemplateVocabulary = Object.freeze([...OPERATION_TEMPLATES.keys()]);

function operationTemplate(binding) {
  if (
    !binding.operation ||
    typeof binding.operation !== "object" ||
    Array.isArray(binding.operation) ||
    typeof binding.operation.template !== "string"
  ) {
    throw new Error(`${binding.id}: operation must select a declarative template`);
  }
  const template = OPERATION_TEMPLATES.get(binding.operation.template);
  if (!template) throw new Error(`${binding.id}: unknown operation template ${binding.operation.template}`);
  return template;
}

export function renderOperation(binding, denseIndex) {
  return operationTemplate(binding).render(binding, denseIndex);
}

/* Operation renderers are selected only by reviewed template metadata above. Binding IDs
 * remain stable identity keys and never select native implementation code. */
export function validateOperation(binding, source, definition, moduleSource) {
  operationTemplate(binding).validate(binding, source, definition, moduleSource);
}
