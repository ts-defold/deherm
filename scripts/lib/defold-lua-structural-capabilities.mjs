const ENGINE_TARGET = "defold-engine-box2d-v3";

export function parseCanonicalLuaRegistrationSurface(text) {
  const report = JSON.parse(text);
  if (report.schemaVersion !== 1 || !report.targets?.[ENGINE_TARGET]) {
    throw new Error("canonical Lua registration surface is missing the pinned engine target");
  }
  const target = report.targets[ENGINE_TARGET];
  if (target.status !== "verified" || !Array.isArray(target.routes)) {
    throw new Error("canonical Lua registration surface target is not verified");
  }
  return { report, target, routes: new Map(target.routes.map((route) => [route.name, route])) };
}

export function registeredRouteCapability(surface, routeName, expectedSourcePath) {
  const route = surface.routes.get(routeName);
  if (
    !route ||
    route.registration?.path !== expectedSourcePath ||
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

function functionBody(source, symbol) {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const signature = new RegExp(
    `(?:^|\\n)\\s*(?:(?:static|inline|extern)\\s+)?[A-Za-z_][A-Za-z0-9_:<>*&\\s]*?\\b${escaped}\\s*\\([^;{}]*\\)\\s*(?:const\\s*)?\\{`,
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
    else if (char === "}" && --depth === 0) return source.slice(open, index + 1);
  }
  return null;
}

function compact(source) {
  return source.replace(/\s+/g, "");
}

export function guiNodeUserdataCapability(surface, source, fn) {
  const route = surface.routes.get("gui.get_node");
  const registration = registeredRouteCapability(surface, "gui.get_node", "gui/src/gui_script.cpp");
  if (
    !route ||
    !registration ||
    route.cFunction !== "LuaGetNode" ||
    !fn ||
    JSON.stringify(fn.returns) !== JSON.stringify(["node"])
  )
    return null;
  const body = functionBody(source, registration.cFunction);
  const check = functionBody(source, "NodeProxy_Check");
  if (!body || !check) return null;
  const bodyCode = compact(body);
  const checkCode = compact(check);
  const allCode = compact(source);
  const inputTypes = route.parameters?.map(({ derived }) => [...(derived?.types ?? [])].sort()) ?? [];
  if (
    JSON.stringify(inputTypes) !== JSON.stringify([["hash", "string"]]) ||
    route.results?.derived?.min !== 1 ||
    route.results?.derived?.max !== 1 ||
    !bodyCode.includes("GuiScriptInstance_Check(L)") ||
    !bodyCode.includes("GetNodeById(scene,id)") ||
    !/lua_newuserdata\(L,sizeof\(NodeProxy\)\)/.test(bodyCode) ||
    !/->m_Scene=scene/.test(bodyCode) ||
    !/->m_Node=node/.test(bodyCode) ||
    !bodyCode.includes("luaL_getmetatable(L,NODE_PROXY_TYPE_NAME)") ||
    !bodyCode.includes("lua_setmetatable(L,-2)") ||
    !checkCode.includes("dmScript::CheckUserType(L,index,NODE_PROXY_TYPE_HASH,0)") ||
    !allCode.includes("dmScript::RegisterUserType(L,NODE_PROXY_TYPE_NAME,NodeProxy_methods,NodeProxy_meta)") ||
    !allCode.includes('{"__index",NodeProxy_index}') ||
    !allCode.includes('{"__newindex",NodeProxy_newindex}') ||
    !allCode.includes('{"__eq",NodeProxy_eq}')
  ) {
    return null;
  }
  return {
    registration,
    context: { kind: "active-gui-scene", check: "GuiScriptInstance_Check" },
    inputCodecs: inputTypes,
    result: { codec: "Node", source: "one registered Lua result" },
    userdata: {
      kind: "full-userdata",
      cType: "NodeProxy",
      metatable: "NodeProxy",
      registeredType: "NODE_PROXY_TYPE_HASH",
      checkedBy: "dmScript::CheckUserType",
      metamethods: ["__index", "__newindex", "__eq"],
    },
  };
}

export function contextCapability(source, symbol, kind) {
  const body = functionBody(source, symbol.split("::").at(-1));
  if (!body) return null;
  const expected =
    kind === "gui-script-instance"
      ? "GuiScriptInstance_Check"
      : kind === "render-script-instance"
        ? "RenderScriptInstance_Check"
        : null;
  if (expected && !compact(body).includes(`${expected}(L)`)) return null;
  return { kind, evidence: expected ?? "captured-lua-route" };
}
