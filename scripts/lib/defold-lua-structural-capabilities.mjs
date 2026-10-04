const ENGINE_TARGET = "defold-engine-box2d-v3";

export function parseCanonicalLuaRegistrationSurface(text, targetId = ENGINE_TARGET) {
  const report = JSON.parse(text);
  if (report.schemaVersion !== 1 || !report.targets?.[targetId]) {
    throw new Error(`canonical Lua registration surface is missing target '${targetId}'`);
  }
  const target = report.targets[targetId];
  if (target.status !== "verified" || !Array.isArray(target.routes)) {
    throw new Error("canonical Lua registration surface target is not verified");
  }
  const routes = new Map();
  const routeVariants = new Map();
  for (const route of target.routes) {
    if (
      !route ||
      typeof route.name !== "string" ||
      route.name.length === 0 ||
      typeof route.module !== "string" ||
      typeof route.cFunction !== "string" ||
      route.cFunction.length === 0 ||
      typeof route.registration?.path !== "string" ||
      route.registration.path.length === 0 ||
      !Number.isInteger(route.registration.line) ||
      route.registration.line <= 0 ||
      !(route.registration.array === null || typeof route.registration.array === "string")
    ) {
      throw new Error("canonical Lua registration surface contains a malformed registered route");
    }
    const variants = routeVariants.get(route.name) ?? [];
    variants.push(route);
    routeVariants.set(route.name, variants);
    // Preserve the historical map view for consumers that only inspect a
    // route's declaration/codec facts. Capability admission below uses the
    // variant set and therefore never guesses across duplicate platform rows.
    routes.set(route.name, route);
  }
  return { report, target, routes, routeVariants };
}

export function registeredRouteCapability(surface, routeName, expectedSourcePath = null) {
  const variants =
    surface.routeVariants?.get(routeName) ?? (surface.routes.has(routeName) ? [surface.routes.get(routeName)] : []);
  const matching =
    expectedSourcePath === null
      ? variants
      : variants.filter((route) => route.registration?.path === expectedSourcePath);
  if (matching.length !== 1) return null;
  const route = matching[0];
  if (
    !route ||
    !(route.registration?.array === null || typeof route.registration?.array === "string") ||
    typeof route.cFunction !== "string"
  ) {
    return null;
  }
  return {
    route: route.name,
    module: route.module,
    cFunction: route.cFunction,
    sourcePath: route.registration.path,
    registrationArray: route.registration.array,
    registrationLine: route.registration.line,
  };
}

function functionDefinition(source, symbol) {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const signature = new RegExp(
    `(?:^|\\n)\\s*(?:(?:static|inline|extern)\\s+)?[A-Za-z_][A-Za-z0-9_:<>*&\\s]*?\\b${escaped}\\s*\\(([^;{}]*)\\)\\s*(?:const\\s*)?\\{`,
    "m",
  );
  const match = signature.exec(source);
  if (!match) return null;
  const open = match.index + match[0].lastIndexOf("{");
  let depth = 0;
  let mode = "code";
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (mode === "line-comment") {
      if (char === "\n") mode = "code";
      continue;
    }
    if (mode === "block-comment") {
      if (char === "*" && next === "/") {
        mode = "code";
        index += 1;
      }
      continue;
    }
    if (mode === "string" || mode === "character") {
      if (char === "\\") index += 1;
      else if ((mode === "string" && char === '"') || (mode === "character" && char === "'")) mode = "code";
      continue;
    }
    if (char === "/" && next === "/") {
      mode = "line-comment";
      index += 1;
    } else if (char === "/" && next === "*") {
      mode = "block-comment";
      index += 1;
    } else if (char === '"') mode = "string";
    else if (char === "'") mode = "character";
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) {
      const parameters = match[1]
        .split(",")
        .map((parameter) => /([A-Za-z_][A-Za-z0-9_]*)\s*(?:\[[^\]]*\])?\s*$/.exec(parameter)?.[1] ?? null);
      return { body: source.slice(open, index + 1), parameters };
    }
  }
  return null;
}

function functionBody(source, symbol) {
  return functionDefinition(source, symbol)?.body ?? null;
}

function stripCommentsPreservingLiterals(source) {
  let output = "";
  let mode = "code";
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (mode === "line-comment") {
      if (char === "\n") {
        output += "\n";
        mode = "code";
      } else output += " ";
      continue;
    }
    if (mode === "block-comment") {
      if (char === "*" && next === "/") {
        output += "  ";
        index += 1;
        mode = "code";
      } else output += char === "\n" ? "\n" : " ";
      continue;
    }
    output += char;
    if (mode === "string" || mode === "character") {
      if (char === "\\") {
        output += next ?? "";
        index += 1;
      } else if ((mode === "string" && char === '"') || (mode === "character" && char === "'")) {
        mode = "code";
      }
      continue;
    }
    if (char === "/" && next === "/") {
      output += " ";
      index += 1;
      mode = "line-comment";
    } else if (char === "/" && next === "*") {
      output += " ";
      index += 1;
      mode = "block-comment";
    } else if (char === '"') mode = "string";
    else if (char === "'") mode = "character";
  }
  return output;
}

function compact(source) {
  return source.replace(/\s+/g, "");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function callLeaf(value) {
  return value.split("::").at(-1);
}

function callAssignedTo(body, typePattern, argumentPattern = "L") {
  const code = compact(body);
  const match = new RegExp(
    `(?:${typePattern})[A-Za-z_][A-Za-z0-9_]*=([A-Za-z_][A-Za-z0-9_:]*)\\(${argumentPattern}\\)`,
  ).exec(code);
  return match?.[1] ?? null;
}

function stringConstants(source) {
  const constants = new Map();
  for (const match of source.matchAll(/^\s*#\s*define\s+([A-Za-z_][A-Za-z0-9_]*)\s+"([^"\n]*)"/gm)) {
    constants.set(match[1], match[2]);
  }
  for (const match of source.matchAll(
    /(?:const\s+)?char\s*(?:const\s*)?\*\s*(?:const\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"([^"\n]*)"/g,
  )) {
    constants.set(match[1], match[2]);
  }
  return constants;
}

function resolvedStringExpression(expression, constants) {
  const value = expression.trim();
  const literal = /^"([^"\n]*)"$/.exec(value);
  if (literal) return literal[1];
  return constants.get(value) ?? null;
}

function registeredUserTypes(source) {
  const structuralSource = stripCommentsPreservingLiterals(source);
  const code = compact(structuralSource);
  const constants = stringConstants(structuralSource);
  const candidates = [];
  for (const match of code.matchAll(
    /((?:[A-Za-z_][A-Za-z0-9_]*::)*[A-Za-z_][A-Za-z0-9_]*)=dmScript::RegisterUserType\(L,([^,]+),/g,
  )) {
    const metatable = resolvedStringExpression(match[2], constants);
    if (metatable) candidates.push({ kind: "register-user-type", metatable, typeHash: callLeaf(match[1]) });
  }
  if (/dmScript::RegisterUserType\(L,[^,]+,[^,]+,[^)]+\)/.test(code)) {
    for (const match of code.matchAll(/\{([^,{}]+),[^{}]*&((?:[A-Za-z_][A-Za-z0-9_]*::)*[A-Za-z_][A-Za-z0-9_]*)\}/g)) {
      const metatable = resolvedStringExpression(match[1], constants);
      if (metatable) candidates.push({ kind: "registration-record", metatable, typeHash: callLeaf(match[2]) });
    }
  }
  return candidates;
}

function checkedUserType(source, typeHash) {
  const hash = escapeRegExp(typeHash);
  return new RegExp(`dmScript::CheckUserType\\(L,[^,]+,(?:[A-Za-z_][A-Za-z0-9_]*::)*${hash}(?:,|\\))`).test(
    compact(stripCommentsPreservingLiterals(source)),
  );
}

function allocatedUserdataForMetatable(source, metatable) {
  const structuralSource = stripCommentsPreservingLiterals(source);
  const code = compact(structuralSource);
  const constants = stringConstants(structuralSource);
  const matches = [
    ...code.matchAll(
      /lua_newuserdata\(L,sizeof\(([A-Za-z_][A-Za-z0-9_:]*)\)\)(?:(?!lua_newuserdata).)*?luaL_getmetatable\(L,([^,)]+)\);lua_setmetatable\(L,-2\)/g,
    ),
  ].filter((match) => resolvedStringExpression(match[2], constants) === metatable);
  return matches.length > 0 ? { extent: "sizeof-wrapper-type", constructions: matches.length } : null;
}

function requiredString(spec, field) {
  const value = spec?.[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Lua handle representation capability needs ${field}`);
  }
  return value;
}

/**
 * Prove only the Lua value shape a replay transport consumes.
 *
 * The returned record intentionally excludes payload fields, native validity
 * predicates, destroy paths, and finalizers. Those are lifecycle/effect
 * evidence and callers must keep them as a separate gate where an operation
 * can invalidate an identity or transfer GC responsibility.
 */
export function luaHandleRepresentationCapability(source, spec) {
  if (typeof source !== "string") return null;
  const kind = requiredString(spec, "kind");
  const sourceEvidence = requiredString(spec, "sourceEvidence");
  const structuralSource = stripCommentsPreservingLiterals(source);

  if (kind === "lua-full-userdata") {
    const metatable = requiredString(spec, "metatableLiteral");
    const registrations = registeredUserTypes(structuralSource).filter(
      (candidate) => candidate.metatable === metatable,
    );
    if (registrations.length !== 1) return null;
    const registration = registrations[0];
    const allocation = allocatedUserdataForMetatable(structuralSource, metatable);
    if (!allocation || !checkedUserType(structuralSource, registration.typeHash)) return null;
    return {
      kind: "full-userdata",
      sourceEvidence,
      allocation,
      metatable,
      typeCheck: { api: "dmScript::CheckUserType", identity: "registered-user-type-hash" },
      registration: { kind: registration.kind, metatable, typeHashRelation: "same-registered-hash" },
      rooting: "lua-registry-rootable",
    };
  }

  if (kind === "lua-light-userdata") {
    if (!/lua_pushlightuserdata\s*\(\s*L\s*,/.test(structuralSource)) return null;
    return {
      kind: "light-userdata",
      sourceEvidence,
      pushCodec: "lua-light-userdata",
      metatable: null,
      typeCheck: null,
      rooting: "not-rootable-as-semantic-identity",
    };
  }

  if (kind === "lua-number-asset-handle") {
    if (!/lua_pushnumber\s*\(\s*L\s*,/.test(structuralSource) || !/lua_isnumber\s*\(\s*L\s*,/.test(structuralSource))
      return null;
    return {
      kind: "number-asset-handle",
      sourceEvidence,
      pushCodec: "lua-number",
      typeCheck: "lua-number",
      rooting: "value-copy",
    };
  }

  if (kind === "declaration-token") {
    return {
      kind,
      sourceEvidence,
      representation: "public-declaration-type",
      rooting: "not-runtime",
    };
  }

  throw new Error(`unsupported Lua handle representation capability '${kind}'`);
}

const lifecycleEffectChecks = Object.freeze({
  "generation-or-version-check": (source) => {
    return (
      /->m_[A-Za-z0-9_]*(?:Generation|Version)[A-Za-z0-9_]*\s*(?:==|!=)/.test(source) ||
      /(?:==|!=)\s*[^;\n]*->m_[A-Za-z0-9_]*(?:Generation|Version)[A-Za-z0-9_]*/.test(source)
    );
  },
  "native-validity-check": (source, spec) => {
    const subject = requiredString(spec, "subject");
    const name = new RegExp(`${escapeRegExp(subject)}[A-Za-z0-9_]*Valid`, "i");
    return [...source.matchAll(/\b((?:[A-Za-z_][A-Za-z0-9_]*::)*[A-Za-z_][A-Za-z0-9_]*)\s*(?=\()/g)].some(
      (match) => name.test(match[1]) && (match[1].includes("::") || /^[a-z_]/.test(callLeaf(match[1]))),
    );
  },
  "pointer-upcast-validity": (source) => /\b[A-Za-z_][A-Za-z0-9_:]*::upcast\s*\(/.test(source),
  "identity-registry": (source) =>
    /HashTable[A-Za-z0-9_:<>,]*\s+[A-Za-z_][A-Za-z0-9_]*\s*;/.test(source) && /\.(?:Put|Get|Erase)\s*\(/.test(source),
  "destroy-or-invalidate-effect": (source) =>
    /\b(?:[A-Za-z_][A-Za-z0-9_]*::)*[A-Za-z0-9_]*(?:Destroy|Delete|Invalidate)[A-Za-z0-9_]*\s*\(/.test(source) ||
    /->m_[A-Za-z0-9_]*(?:Deleted|Valid)\s*=\s*(?:0|1|true|false)\s*;/.test(source),
  "owner-index-identity": (source) =>
    /m_[A-Za-z0-9_]*Owner[A-Za-z0-9_]*\s*;/.test(source) && /m_[A-Za-z0-9_]*Index[A-Za-z0-9_]*\s*;/.test(source),
  "ownership-domain": (source) =>
    /enum\s+[A-Za-z_][A-Za-z0-9_]*Owner[A-Za-z0-9_]*\s*\{[^}]*=[^,}]+,[^}]*=[^,}]+,[^}]*=[^,}]+/s.test(source),
  "scene-identity-check": (source) =>
    /->m_[A-Za-z0-9_]*(?:Scene|Context)[A-Za-z0-9_]*\s*!=\s*[A-Za-z_][A-Za-z0-9_:]*\s*\(\s*L\s*\)/.test(source),
  "checked-userdata": (source) => /dmScript::CheckUserType\s*\(\s*L\s*,/.test(source),
});

/** Prove lifecycle facts separately from the Lua representation shape. */
export function luaHandleLifecycleCapability(source, spec) {
  if (typeof source !== "string") return null;
  const sourceEvidence = requiredString(spec, "sourceEvidence");
  if (!Array.isArray(spec.effects) || spec.effects.length === 0) {
    throw new Error("Lua handle lifecycle capability needs effects");
  }
  const effects = [];
  for (const effect of spec.effects) {
    const check = lifecycleEffectChecks[effect];
    if (!check) throw new Error(`unsupported Lua handle lifecycle effect '${effect}'`);
    if (!check(source, spec)) return null;
    effects.push(effect);
  }
  return { sourceEvidence, effects, ...(spec.subject ? { subject: spec.subject } : {}) };
}

export function guiNodeUserdataCapability(surface, source, fn) {
  const structuralSource = stripCommentsPreservingLiterals(source);
  const route = surface.routes.get("gui.get_node");
  const registration = registeredRouteCapability(surface, "gui.get_node", "gui/src/gui_script.cpp");
  if (!route || !registration || !fn || JSON.stringify(fn.returns) !== JSON.stringify(["node"])) return null;
  const body = functionBody(structuralSource, registration.cFunction);
  if (!body) return null;
  const bodyCode = compact(body);
  const allCode = compact(structuralSource);
  const inputTypes = route.parameters?.map(({ derived }) => [...(derived?.types ?? [])].sort()) ?? [];
  const allocation =
    /([A-Za-z_][A-Za-z0-9_:]*)\*([A-Za-z_][A-Za-z0-9_]*)=\([^)]*\)lua_newuserdata\(L,sizeof\(\1\)\)/.exec(bodyCode);
  const metatable = /luaL_getmetatable\(L,([A-Za-z_][A-Za-z0-9_:]*)\);lua_setmetatable\(L,-2\)/.exec(bodyCode);
  const initializedFields = allocation
    ? [...bodyCode.matchAll(new RegExp(`${escapeRegExp(allocation[2])}->([A-Za-z_][A-Za-z0-9_]*)=`, "g"))].map(
        (match) => match[1],
      )
    : [];
  const registered = metatable
    ? new RegExp(`([A-Za-z_][A-Za-z0-9_:]*)=dmScript::RegisterUserType\\(L,${escapeRegExp(metatable[1])},`).exec(
        allCode,
      )
    : null;
  const typeHash = registered?.[1] ?? null;
  const checked = typeHash ? checkedUserType(structuralSource, typeHash) : false;
  const context = contextCapability(structuralSource, registration.cFunction, "gui-script-instance");
  if (
    JSON.stringify(inputTypes) !== JSON.stringify([["hash", "string"]]) ||
    route.results?.derived?.min !== 1 ||
    route.results?.derived?.max !== 1 ||
    !context ||
    !allocation ||
    !metatable ||
    initializedFields.length < 2 ||
    !registered ||
    !checked ||
    !bodyCode.includes("return1;") ||
    !["__index", "__newindex", "__eq"].every((name) =>
      new RegExp(`\\{["']${name}["'],[A-Za-z_][A-Za-z0-9_:]*\\}`).test(allCode),
    )
  ) {
    return null;
  }
  return {
    registration,
    context: { kind: "active-gui-scene", capability: context },
    inputCodecs: inputTypes,
    result: { codec: "Node", source: "one registered Lua result" },
    userdata: {
      kind: "full-userdata",
      allocation: "sizeof-wrapper-type",
      initializedFieldCount: initializedFields.length,
      metatable: metatable[1],
      registeredType: typeHash,
      checkedBy: "dmScript::CheckUserType",
      metamethods: ["__index", "__newindex", "__eq"],
    },
  };
}

export function contextCapability(source, symbol, kind) {
  const structuralSource = stripCommentsPreservingLiterals(source);
  const body = functionBody(structuralSource, symbol.split("::").at(-1));
  if (!body) return null;
  if (kind !== "gui-script-instance" && kind !== "render-script-instance") {
    return { kind, evidence: "captured-lua-route" };
  }
  const typePattern =
    kind === "gui-script-instance"
      ? "(?:(?:dmGui::)?HScene|(?:dmGui::)?Scene\\*)"
      : "(?:[A-Za-z_][A-Za-z0-9_:]*::)?RenderScriptInstance\\*";
  const contextCall = callAssignedTo(body, typePattern);
  if (!contextCall) return null;
  const check = functionBody(structuralSource, callLeaf(contextCall));
  if (!check) return null;
  const checked = /dmScript::CheckUserType\(L,[^,]+,([A-Za-z_][A-Za-z0-9_:]*)(?:,|\))/.exec(compact(check));
  if (!checked) return null;
  const typeHash = checked[1];
  const registration = new RegExp(
    `${escapeRegExp(typeHash)}=dmScript::RegisterUserType\\(L,([A-Za-z_][A-Za-z0-9_:]*),`,
  ).exec(compact(structuralSource));
  if (!registration) return null;
  return {
    kind,
    evidence: "registered-instance-userdata-check",
    contextType: kind === "gui-script-instance" ? "gui-scene" : "render-script-instance",
    typeHash,
    metatable: registration[1],
  };
}

function nodeInputCapability(source, body, luaStateParameter) {
  const structuralSource = stripCommentsPreservingLiterals(source);
  const code = compact(stripCommentsPreservingLiterals(body));
  if (typeof luaStateParameter !== "string") return null;
  const state = escapeRegExp(luaStateParameter);
  const input = new RegExp(
    `(?:^|[;{}])(?:const)?[A-Za-z_][A-Za-z0-9_:<>]*\\*([A-Za-z_][A-Za-z0-9_]*)=([A-Za-z_][A-Za-z0-9_:]*)\\(${state},1,[^)]*\\)`,
  ).exec(code);
  if (!input) return null;
  const helper = functionDefinition(structuralSource, callLeaf(input[2]));
  if (!helper || helper.parameters.length < 2 || helper.parameters.some((parameter) => parameter === null)) return null;
  const [helperState, helperSlot] = helper.parameters;
  const helperCode = compact(helper.body);
  const proxy = new RegExp(
    `(?:^|[;{}])(?:const)?[A-Za-z_][A-Za-z0-9_:<>]*\\*([A-Za-z_][A-Za-z0-9_]*)=([A-Za-z_][A-Za-z0-9_:]*)\\(${escapeRegExp(helperState)},${escapeRegExp(helperSlot)}\\)`,
  ).exec(helperCode);
  if (!proxy) return null;
  const proxyVariable = proxy[1];
  const proxyCheck = functionDefinition(structuralSource, callLeaf(proxy[2]));
  if (!proxyCheck || proxyCheck.parameters.length < 2) return null;
  const [checkState, checkSlot] = proxyCheck.parameters;
  const typeCheck = new RegExp(
    `dmScript::CheckUserType\\(${escapeRegExp(checkState)},${escapeRegExp(checkSlot)},([A-Za-z_][A-Za-z0-9_:]*)(?:,|\\))`,
  ).exec(compact(proxyCheck.body));
  if (!typeCheck) return null;
  const registrations = registeredUserTypes(structuralSource).filter(
    ({ typeHash }) => typeHash === callLeaf(typeCheck[1]),
  );
  if (registrations.length !== 1) return null;
  const sceneRelation = new RegExp(
    `${escapeRegExp(proxyVariable)}->([A-Za-z_][A-Za-z0-9_]*)!=[A-Za-z_][A-Za-z0-9_:]*\\(${escapeRegExp(helperState)}\\)`,
  ).exec(helperCode);
  if (!sceneRelation) return null;
  return {
    codec: "Node",
    index: 1,
    checkedUserdata: {
      api: "dmScript::CheckUserType",
      metatable: registrations[0].metatable,
      typeHashRelation: "same-registered-hash",
    },
    sceneIdentity: true,
  };
}

/**
 * Prove only the registered replay boundary consumed by hand-structured
 * captured-Lua adapters. Factory and message internals remain Defold semantics
 * behind that boundary. GUI text replay additionally proves the rooted Node
 * identity/scene relation it transports, without inspecting text mutation.
 */
export function structuredLuaReplayCapability({ surface, source, routeName, expectedSourcePath, template }) {
  const registration = registeredRouteCapability(surface, routeName, expectedSourcePath);
  if (!registration || typeof source !== "string") return null;
  const definition = functionDefinition(source, registration.cFunction);
  if (!definition) return null;
  const { body } = definition;

  if (template === "factory-spawn") {
    return {
      registration,
      replayBoundary: { context: "current-script-instance", transport: "registered-lua-call" },
    };
  }

  if (template === "message-post") {
    return {
      registration,
      replayBoundary: { context: "current-script-sender-url", transport: "registered-lua-call" },
    };
  }

  if (template === "gui-node-text-set") {
    const node = nodeInputCapability(source, body, definition.parameters[0]);
    if (!node) return null;
    return {
      registration,
      replayBoundary: { context: "active-gui-scene", transport: "registered-lua-call" },
      transportedHandle: node,
    };
  }

  throw new Error(`unsupported structured Lua capability template '${template}'`);
}
