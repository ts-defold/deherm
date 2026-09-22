import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { API } from "typescript/unstable/sync";
import { SyntaxKind } from "typescript/unstable/ast";
import {
  isArrowFunction,
  isAsExpression,
  isCallExpression,
  isClassDeclaration,
  isConstructorDeclaration,
  isExportAssignment,
  isFunctionExpression,
  isIdentifier,
  isMethodDeclaration,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isPropertyDeclaration,
  isSatisfiesExpression,
  isStringLiteral
} from "typescript/unstable/ast/is";

import { componentProxyConstants } from "./component-proxy-contract.mjs";

const {
  componentIdNamespace: COMPONENT_ID_NAMESPACE,
  generatedMarker: GENERATED_MARKER,
  generator: GENERATOR,
  lifecycleSlots,
  proxyRuntimeCapability: PROXY_RUNTIME_CAPABILITY,
  sourceKinds: componentSourceKinds,
  resourceKinds
} = componentProxyConstants;

const propertyCodecs = Object.freeze({
  number: { codecId: 1 },
  boolean: { codecId: 2 },
  string: { codecId: 3 },
  hash: { codecId: 4 },
  url: { codecId: 5 },
  vector3: { codecId: 6 },
  vector4: { codecId: 7 },
  quaternion: { codecId: 8 }
});

const rootMemberNames = new Set(["properties", ...Object.keys(lifecycleSlots)]);
const ignoredDirectories = new Set([
  ".deherm",
  ".git",
  "build",
  "dist",
  "node_modules",
  "upstream"
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalRelativePath(projectRoot, file) {
  const relative = path.relative(projectRoot, file).split(path.sep).join("/");
  if (!relative || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) {
    throw new Error(`${file}: component source must be inside project root ${projectRoot}`);
  }
  if (!componentSourceKinds.some(({ suffix }) => relative.endsWith(suffix))) {
    throw new Error(`${relative}: component source must end in .script.ts, .gui.ts, .render.ts, or legacy .gui_script.ts`);
  }
  if (/[\u0000-\u001f\u007f]/.test(relative)) {
    throw new Error(`${JSON.stringify(relative)}: component source path may not contain control characters`);
  }
  return relative;
}

function componentSourceKind(relativeSource) {
  const kind = [...componentSourceKinds].sort((left, right) => right.suffix.length - left.suffix.length)
    .find(({ suffix }) => relativeSource.endsWith(suffix));
  if (!kind) throw new Error(`${relativeSource}: unsupported component source suffix`);
  return kind;
}

function proxyRelativePath(relativeSource, sourceKind = componentSourceKind(relativeSource)) {
  return `${relativeSource.slice(0, -sourceKind.suffix.length)}${sourceKind.proxySuffix}`;
}

function componentId(relativeSource) {
  return `${COMPONENT_ID_NAMESPACE}/${sha256(`${COMPONENT_ID_NAMESPACE}\0${relativeSource}`)}`;
}

function unwrapExpression(node) {
  while (
    isParenthesizedExpression(node) ||
    isAsExpression(node) ||
    isSatisfiesExpression(node) ||
    node.kind === SyntaxKind.NonNullExpression ||
    node.kind === SyntaxKind.TypeAssertionExpression
  ) {
    node = node.expression;
  }
  return node;
}

function nodeName(node, sourceFile, context) {
  if (isIdentifier(node) || isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  throw new Error(`${context}: computed, numeric, and private property names are not supported (${node.getText(sourceFile)})`);
}

function objectMembers(object, sourceFile, context) {
  const members = new Map();
  for (const member of object.properties) {
    if (!isPropertyAssignment(member) && !isMethodDeclaration(member)) {
      throw new Error(`${context}: only explicit property assignments and methods are supported (${member.getText(sourceFile)})`);
    }
    const name = nodeName(member.name, sourceFile, context);
    if (members.has(name)) throw new Error(`${context}: duplicate member ${JSON.stringify(name)}`);
    members.set(name, member);
  }
  return members;
}

function stringLiteral(node, sourceFile, context) {
  node = unwrapExpression(node);
  if (!isStringLiteral(node) && !isNoSubstitutionTemplateLiteral(node)) {
    throw new Error(`${context}: expected a string literal, received ${node.getText(sourceFile)}`);
  }
  return node.text;
}

function numberLiteral(node, sourceFile, context) {
  node = unwrapExpression(node);
  let sign = 1;
  if (isPrefixUnaryExpression(node)) {
    if (node.operator === SyntaxKind.MinusToken) sign = -1;
    else if (node.operator !== SyntaxKind.PlusToken) {
      throw new Error(`${context}: expected a numeric literal, received ${node.getText(sourceFile)}`);
    }
    node = unwrapExpression(node.operand);
  }
  if (!isNumericLiteral(node)) {
    throw new Error(`${context}: expected a numeric literal, received ${node.getText(sourceFile)}`);
  }
  const value = sign * Number(node.text.replaceAll("_", ""));
  if (!Number.isFinite(value) || Object.is(value, -0)) {
    throw new Error(`${context}: numeric default must be finite and may not be negative zero`);
  }
  return value;
}

function luaString(value) {
  let output = '"';
  for (const character of value) {
    const code = character.codePointAt(0);
    if (character === "\\") output += "\\\\";
    else if (character === '"') output += '\\"';
    else if (character === "\n") output += "\\n";
    else if (character === "\r") output += "\\r";
    else if (character === "\t") output += "\\t";
    else if (code < 32 || code === 127) output += `\\${String(code).padStart(3, "0")}`;
    else output += character;
  }
  return `${output}"`;
}

function luaNumber(value) {
  return Number.isInteger(value) ? String(value) : String(value);
}

function propertyCall(member, sourceFile, propertyName) {
  if (!isPropertyAssignment(member) && !isPropertyDeclaration(member)) {
    throw new Error(`property ${JSON.stringify(propertyName)}: expected property.<kind>(...)`);
  }
  const initializer = unwrapExpression(member.initializer);
  if (!isCallExpression(initializer)) {
    throw new Error(`property ${JSON.stringify(propertyName)}: default must be a direct property.<kind>(...) call`);
  }
  const callee = unwrapExpression(initializer.expression);
  if (!isPropertyAccessExpression(callee) || !isIdentifier(callee.expression) || callee.expression.text !== "property") {
    throw new Error(`property ${JSON.stringify(propertyName)}: default must be a direct property.<kind>(...) call`);
  }
  return { kind: callee.name.text, arguments: [...initializer.arguments] };
}

function exactArity(args, expected, context) {
  if (args.length !== expected) {
    throw new Error(`${context}: expected ${expected} argument${expected === 1 ? "" : "s"}, received ${args.length}`);
  }
}

function zeroOrOneArgument(args, context) {
  if (args.length > 1) throw new Error(`${context}: expected zero or one argument, received ${args.length}`);
}

function parseProperty(member, sourceFile, name, slot) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || name.startsWith("__deherm_")) {
    throw new Error(`property ${JSON.stringify(name)}: name must be a Lua-safe identifier and may not use the __deherm_ prefix`);
  }
  const call = propertyCall(member, sourceFile, name);
  const context = `property ${JSON.stringify(name)} (${call.kind})`;

  if (call.kind === "number") {
    exactArity(call.arguments, 1, context);
    const value = numberLiteral(call.arguments[0], sourceFile, context);
    return { name, slot, kind: call.kind, codecId: propertyCodecs.number.codecId, default: value, luaDefault: luaNumber(value) };
  }
  if (call.kind === "boolean") {
    exactArity(call.arguments, 1, context);
    const argument = unwrapExpression(call.arguments[0]);
    if (argument.kind !== SyntaxKind.TrueKeyword && argument.kind !== SyntaxKind.FalseKeyword) {
      throw new Error(`${context}: expected true or false, received ${argument.getText(sourceFile)}`);
    }
    const value = argument.kind === SyntaxKind.TrueKeyword;
    return { name, slot, kind: call.kind, codecId: propertyCodecs.boolean.codecId, default: value, luaDefault: String(value) };
  }
  if (call.kind === "string" || call.kind === "hash") {
    exactArity(call.arguments, 1, context);
    const value = stringLiteral(call.arguments[0], sourceFile, context);
    const luaDefault = call.kind === "hash" ? `hash(${luaString(value)})` : luaString(value);
    return { name, slot, kind: call.kind, codecId: propertyCodecs[call.kind].codecId, default: value, luaDefault };
  }
  if (call.kind === "url") {
    exactArity(call.arguments, 0, context);
    return { name, slot, kind: call.kind, codecId: propertyCodecs.url.codecId, default: null, luaDefault: "msg.url()" };
  }

  const vectorArity = call.kind === "vector3" ? 3 : call.kind === "vector4" || call.kind === "quaternion" ? 4 : undefined;
  if (vectorArity !== undefined) {
    exactArity(call.arguments, vectorArity, context);
    const value = call.arguments.map((argument, index) => numberLiteral(argument, sourceFile, `${context} argument ${index + 1}`));
    const constructor = call.kind === "quaternion" ? "quat" : call.kind;
    return {
      name,
      slot,
      kind: call.kind,
      codecId: propertyCodecs[call.kind].codecId,
      default: value,
      luaDefault: `vmath.${constructor}(${value.map(luaNumber).join(", ")})`
    };
  }

  const resourceKind = resourceKinds[call.kind];
  if (resourceKind) {
    zeroOrOneArgument(call.arguments, context);
    const value = call.arguments.length ? stringLiteral(call.arguments[0], sourceFile, context) : null;
    return {
      name,
      slot,
      kind: "resource",
      resourceKind,
      codecId: 9,
      default: value,
      luaDefault: `resource.${resourceKind}(${value === null ? "" : luaString(value)})`
    };
  }

  throw new Error(`${context}: unsupported property kind; supported kinds are number, boolean, string, hash, url, vector3, vector4, quaternion, ${Object.keys(resourceKinds).join(", ")}`);
}

function validateLifecycle(member, sourceFile, name) {
  let callable;
  if (isMethodDeclaration(member)) {
    if (!member.body) throw new Error(`${name}: lifecycle method must have an implementation`);
    callable = member;
  } else {
    const value = unwrapExpression(member.initializer);
    if (!isArrowFunction(value) && !isFunctionExpression(value)) {
      throw new Error(`${name}: lifecycle must be a method, arrow function, or function expression`);
    }
    callable = value;
  }
  if (callable.modifiers?.some(({ kind }) => kind === SyntaxKind.AsyncKeyword) || callable.asteriskToken) {
    throw new Error(`${name}: lifecycle must be synchronous and may not be a generator`);
  }
}

function hasModifier(node, kind) {
  return Boolean(node.modifiers?.some((modifier) => modifier.kind === kind));
}

function parseClassDefinition(sourceFile, relativeSource, sourceKind, argument) {
  argument = unwrapExpression(argument);
  if (!isIdentifier(argument)) {
    throw new Error(`${relativeSource}: component argument must name a class declared in the same file`);
  }
  const declarations = sourceFile.statements.filter((statement) =>
    isClassDeclaration(statement) && statement.name?.text === argument.text
  );
  if (declarations.length !== 1) {
    throw new Error(`${relativeSource}: component class ${JSON.stringify(argument.text)} must have exactly one declaration in the same file`);
  }
  const declaration = declarations[0];
  const extendsClauses = (declaration.heritageClauses ?? [])
    .filter((clause) => clause.token === SyntaxKind.ExtendsKeyword);
  const baseTypes = extendsClauses.flatMap((clause) => [...clause.types]);
  if (baseTypes.length !== 1 || !isIdentifier(unwrapExpression(baseTypes[0].expression))) {
    throw new Error(`${relativeSource}: component class ${argument.text} must directly extend its context base class`);
  }
  const actualBase = unwrapExpression(baseTypes[0].expression).text;
  const expectedBase = sourceKind.contextKind === "game-object" ? "ScriptComponent" :
    sourceKind.contextKind === "gui-scene" ? "GuiComponent" : "RenderComponent";
  if (actualBase !== expectedBase) {
    throw new Error(`${relativeSource}: ${sourceKind.proxyKind} class components must extend ${expectedBase}, received ${actualBase}`);
  }

  const members = new Map();
  let propertiesMember;
  for (const member of declaration.members) {
    if (isConstructorDeclaration(member)) {
      if (member.parameters.length !== 0) {
        throw new Error(`${relativeSource}: component class constructor must accept zero arguments`);
      }
      continue;
    }
    if (!member.name) continue;
    const name = nodeName(member.name, sourceFile, `${relativeSource}: component class`);
    const isStatic = hasModifier(member, SyntaxKind.StaticKeyword);
    if (name === "properties") {
      if (!isStatic || !isPropertyDeclaration(member) || !member.initializer) {
        throw new Error(`${relativeSource}: class properties must be a static field initialized with an object literal`);
      }
      if (propertiesMember) throw new Error(`${relativeSource}: duplicate class properties declaration`);
      propertiesMember = member;
      continue;
    }
    if (!Object.hasOwn(lifecycleSlots, name)) continue;
    if (isStatic) throw new Error(`${relativeSource}: lifecycle ${JSON.stringify(name)} must be an instance method`);
    if (!isMethodDeclaration(member)) {
      throw new Error(`${relativeSource}: class lifecycle ${JSON.stringify(name)} must be a prototype method`);
    }
    if (members.has(name)) throw new Error(`${relativeSource}: duplicate lifecycle ${JSON.stringify(name)}`);
    members.set(name, member);
  }

  return {
    authoringStyle: "class",
    className: argument.text,
    members,
    propertiesMember
  };
}

function diagnosticText(message) {
  if (typeof message === "string") return message;
  const parts = [];
  let current = message;
  while (current) {
    parts.push(current.messageText);
    current = current.next?.[0];
  }
  return parts.join(" ");
}

function parseSourceFile(sourceFile, relativeSource, sourceText) {
  const sourceKind = componentSourceKind(relativeSource);
  const exports = sourceFile.statements.filter(isExportAssignment).filter((statement) => !statement.isExportEquals);
  if (exports.length !== 1) throw new Error(`${relativeSource}: expected exactly one export default defineComponent(...) or component(...)`);

  const exported = unwrapExpression(exports[0].expression);
  if (!isCallExpression(exported) || !isIdentifier(exported.expression) ||
      (exported.expression.text !== "defineComponent" && exported.expression.text !== "component")) {
    throw new Error(`${relativeSource}: default export must be a direct defineComponent({...}) or component(ClassName) call`);
  }
  const factoryName = exported.expression.text;
  exactArity([...exported.arguments], 1, `${relativeSource}: ${factoryName}`);

  let authoring;
  if (factoryName === "defineComponent") {
    const definition = unwrapExpression(exported.arguments[0]);
    if (!isObjectLiteralExpression(definition)) {
      throw new Error(`${relativeSource}: defineComponent argument must be an object literal`);
    }
    authoring = {
      authoringStyle: "object",
      members: objectMembers(definition, sourceFile, `${relativeSource}: component definition`),
      propertiesMember: undefined
    };
    authoring.propertiesMember = authoring.members.get("properties");
  } else {
    authoring = parseClassDefinition(sourceFile, relativeSource, sourceKind, exported.arguments[0]);
  }

  const { members, propertiesMember } = authoring;
  for (const name of members.keys()) {
    if (!rootMemberNames.has(name)) throw new Error(`${relativeSource}: unsupported component member ${JSON.stringify(name)}`);
    if (Object.hasOwn(lifecycleSlots, name) && !sourceKind.lifecycle.supported.includes(name)) {
      throw new Error(`${relativeSource}: ${sourceKind.proxyKind} components do not support lifecycle ${JSON.stringify(name)}; supported lifecycles are ${sourceKind.lifecycle.supported.join(", ")}`);
    }
  }

  let properties = [];
  if (propertiesMember) {
    if (!sourceKind.supportsProperties) {
      throw new Error(`${relativeSource}: ${sourceKind.proxyKind} components do not support go.property editor properties`);
    }
    if (!isPropertyAssignment(propertiesMember) && !isPropertyDeclaration(propertiesMember)) {
      throw new Error(`${relativeSource}: properties must be an object literal`);
    }
    const value = unwrapExpression(propertiesMember.initializer);
    if (!isObjectLiteralExpression(value)) throw new Error(`${relativeSource}: properties must be an object literal`);
    const propertyMembers = objectMembers(value, sourceFile, `${relativeSource}: properties`);
    properties = [...propertyMembers.entries()].map(([name, member], slot) => parseProperty(member, sourceFile, name, slot));
  }

  const propertyNames = new Set();
  for (const property of properties) {
    const folded = property.name.toLowerCase();
    if (propertyNames.has(folded)) throw new Error(`${relativeSource}: property names must be unique ignoring case (${property.name})`);
    propertyNames.add(folded);
  }

  const lifecycles = {};
  let lifecycleMask = 0;
  for (const [name, slot] of Object.entries(lifecycleSlots)) {
    const member = members.get(name);
    const requiredClassInitializer = authoring.authoringStyle === "class" && name === "init";
    lifecycles[name] = Boolean(member) || requiredClassInitializer;
    if (member) {
      validateLifecycle(member, sourceFile, `${relativeSource}: ${name}`);
    }
    if (lifecycles[name]) {
      lifecycleMask |= 1 << slot;
    }
  }

  const id = componentId(relativeSource);
  const schema = {
    componentId: id,
    source: relativeSource,
    authoringStyle: authoring.authoringStyle,
    ...(authoring.className ? { className: authoring.className } : {}),
    reloadPolicy: "preserve-instance-state",
    lifecycles,
    properties: properties.map(({ name, slot, kind, resourceKind, codecId, default: defaultValue }) => ({
      name,
      slot,
      kind,
      ...(resourceKind ? { resourceKind } : {}),
      codecId,
      default: defaultValue
    }))
  };
  return {
    ...schema,
    proxy: proxyRelativePath(relativeSource, sourceKind),
    authoredSuffix: sourceKind.suffix,
    canonicalAuthoredSuffix: sourceKind.canonicalSuffix,
    proxySuffix: sourceKind.proxySuffix,
    legacyAuthoredSuffix: sourceKind.legacy,
    supportedLifecycles: sourceKind.lifecycle.supported,
    teardownPolicy: sourceKind.lifecycle.teardownPolicy,
    lifecycleEvidence: sourceKind.lifecycle.evidence,
    proxyKind: sourceKind.proxyKind,
    contextKind: sourceKind.contextKind,
    lifecycleMask,
    sourceSha256: sha256(sourceText),
    schemaFingerprint: sha256(JSON.stringify(schema)),
    nativeSymbol: `deherm_component_${id.slice(id.lastIndexOf("/") + 1, id.lastIndexOf("/") + 33)}`,
    properties
  };
}

function renderLua(component) {
  const luaModule = PROXY_RUNTIME_CAPABILITY.luaModule;
  const lines = [
    GENERATED_MARKER,
    `-- source: ${component.source}`,
    `-- schema-sha256: ${component.schemaFingerprint}`,
    `-- component-id: ${component.componentId}`,
    `-- proxy-kind: ${component.proxyKind}`,
    `-- context-kind: ${component.contextKind}`,
    `-- teardown-policy: ${component.teardownPolicy}`,
    `-- proxy-runtime: ${PROXY_RUNTIME_CAPABILITY.state}`,
    ""
  ];
  for (const property of component.properties) {
    lines.push(`go.property(${luaString(property.name)}, ${property.luaDefault})`);
  }
  if (component.properties.length) lines.push("");
  lines.push(
    `local COMPONENT_ID = ${luaString(component.componentId)}`,
    `local SCHEMA_FINGERPRINT = ${luaString(component.schemaFingerprint)}`,
    `local COMPONENT_CONTEXT = ${luaString(component.contextKind)}`,
    "local PROPERTY_SPECIALIZATIONS = {"
  );
  for (const property of component.properties) {
    lines.push(`    { ${luaString(property.name)}, ${property.codecId} },`);
  }
  lines.push(
    "}",
    ""
  );

  lines.push("function init(self)", `    assert(${luaModule}.attachComponent(self, COMPONENT_ID, SCHEMA_FINGERPRINT, COMPONENT_CONTEXT, PROPERTY_SPECIALIZATIONS))`);
  if (component.lifecycles.init) lines.push(`    ${luaModule}.dispatchLifecycle(self, COMPONENT_ID, "init")`);
  lines.push("end", "");

  if (component.lifecycles.update) {
    lines.push(
      "function update(self, dt)",
      `    ${luaModule}.dispatchLifecycle(self, COMPONENT_ID, "update", dt)`,
      "end",
      ""
    );
  }

  if (component.teardownPolicy === "final-callback-detach") {
    lines.push("function final(self)");
    if (component.lifecycles.final) {
      lines.push(
        `    local ok, result = pcall(${luaModule}.dispatchLifecycle, self, COMPONENT_ID, "final")`,
        `    ${luaModule}.detachComponent(self, COMPONENT_ID)`,
        "    if not ok then error(result, 0) end"
      );
    } else {
      lines.push(`    ${luaModule}.detachComponent(self, COMPONENT_ID)`);
    }
    lines.push("end", "");
  }

  if (component.lifecycles.onMessage) {
    lines.push(
      "function on_message(self, message_id, message, sender)",
      `    ${luaModule}.dispatchMessage(self, COMPONENT_ID, message_id, message, sender)`,
      "end",
      ""
    );
  }
  if (component.lifecycles.onInput) {
    lines.push(
      "function on_input(self, action_id, action)",
      `    return ${luaModule}.dispatchInput(self, COMPONENT_ID, action_id, action)`,
      "end",
      ""
    );
  }
  if (component.lifecycles.onReload) {
    lines.push(
      "function on_reload(self)",
      `    ${luaModule}.dispatchReload(self, COMPONENT_ID)`,
      "end",
      ""
    );
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function publicComponent(component) {
  return {
    componentId: component.componentId,
    source: component.source,
    proxy: component.proxy,
    authoredSuffix: component.authoredSuffix,
    canonicalAuthoredSuffix: component.canonicalAuthoredSuffix,
    proxySuffix: component.proxySuffix,
    legacyAuthoredSuffix: component.legacyAuthoredSuffix,
    supportedLifecycles: component.supportedLifecycles,
    teardownPolicy: component.teardownPolicy,
    ...(component.lifecycleEvidence ? { lifecycleEvidence: component.lifecycleEvidence } : {}),
    proxyKind: component.proxyKind,
    contextKind: component.contextKind,
    authoringStyle: component.authoringStyle,
    ...(component.className ? { className: component.className } : {}),
    sourceSha256: component.sourceSha256,
    schemaFingerprint: component.schemaFingerprint,
    reloadPolicy: component.reloadPolicy,
    lifecycleMask: component.lifecycleMask,
    lifecycles: component.lifecycles,
    properties: component.properties.map(({ luaDefault: _luaDefault, ...property }) => property),
    native: { symbol: component.nativeSymbol }
  };
}

function renderJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function registryImportPath(component) {
  const fromRegistry = path.posix.relative(
    ".deherm/generated/components",
    component.source
  ).replace(/\.ts$/, ".js");
  return fromRegistry.startsWith(".") ? fromRegistry : `./${fromRegistry}`;
}

function renderRegistry(components) {
  const imports = components.map((component, index) =>
    `import component${index} from ${JSON.stringify(registryImportPath(component))};`
  );
  const entries = components.map((component, index) => [
    `  ${JSON.stringify(component.componentId)}: Object.freeze({`,
    `    schemaFingerprint: ${JSON.stringify(component.schemaFingerprint)},`,
    `    contextKind: ${JSON.stringify(component.contextKind)},`,
    `    definition: component${index}`,
    "  })"
  ].join("\n"));
  return `${[
    "// Generated by @ts-defold/deherm component-proxy-generator/v1. Do not edit.",
    ...imports,
    "",
    "const registry = Object.freeze({",
    entries.join(",\n"),
    "});",
    "",
    "(globalThis as typeof globalThis & {",
    "  __defoldComponentsV1?: typeof registry;",
    "}).__defoldComponentsV1 = registry;",
    "",
    "export { registry as __defoldComponentsV1 };",
    ""
  ].join("\n")}`;
}

function outputsFor(components, outputRoot) {
  const manifest = {
    schemaVersion: 1,
    generator: GENERATOR,
    componentIdNamespace: COMPONENT_ID_NAMESPACE,
    proxyRuntimeCapability: PROXY_RUNTIME_CAPABILITY,
    sourceConventions: componentSourceKinds.map(({ suffix, canonicalSuffix, proxySuffix, proxyKind, contextKind, supportsProperties, legacy, lifecycle }) => ({
      authoredSuffix: suffix,
      canonicalAuthoredSuffix: canonicalSuffix,
      proxySuffix,
      proxyKind,
      contextKind,
      supportsProperties,
      legacy,
      supportedLifecycles: lifecycle.supported,
      teardownPolicy: lifecycle.teardownPolicy,
      ...(lifecycle.evidence ? { lifecycleEvidence: lifecycle.evidence } : {})
    })),
    components: components.map(publicComponent)
  };
  const specializations = {
    schemaVersion: 1,
    generator: GENERATOR,
    proxyRuntimeCapability: PROXY_RUNTIME_CAPABILITY,
    lifecycleSlots,
    propertyCodecs: {
      1: "number",
      2: "boolean",
      3: "string",
      4: "hash",
      5: "url",
      6: "vector3",
      7: "vector4",
      8: "quaternion",
      9: "resource"
    },
    components: components.map((component) => ({
      componentId: component.componentId,
      schemaFingerprint: component.schemaFingerprint,
      nativeSymbol: component.nativeSymbol,
      proxyKind: component.proxyKind,
      contextKind: component.contextKind,
      authoringStyle: component.authoringStyle,
      ...(component.className ? { className: component.className } : {}),
      supportedLifecycles: component.supportedLifecycles,
      teardownPolicy: component.teardownPolicy,
      reloadPolicy: component.reloadPolicy,
      lifecycleMask: component.lifecycleMask,
      dispatchSlots: Object.fromEntries(Object.entries(lifecycleSlots).filter(([name]) => component.lifecycles[name])),
      propertySlots: component.properties.map(({ name, slot, codecId, resourceKind }) => ({
        name,
        slot,
        codecId,
        ...(resourceKind ? { resourceKind } : {})
      }))
    }))
  };

  const outputs = components.map((component) => ({
    path: path.join(outputRoot, component.proxy),
    content: renderLua(component),
    generatedLua: true,
    owner: { source: component.source, componentId: component.componentId }
  }));
  outputs.push(
    {
      path: path.join(outputRoot, ".deherm", "generated", "components", "manifest.json"),
      content: renderJson(manifest)
    },
    {
      path: path.join(outputRoot, ".deherm", "generated", "components", "specializations.json"),
      content: renderJson(specializations)
    },
    {
      path: path.join(outputRoot, ".deherm", "generated", "components", "registry.ts"),
      content: renderRegistry(components)
    }
  );
  return { manifest, specializations, outputs };
}

function proxyOwnership(content) {
  if (!content.startsWith(GENERATED_MARKER)) return null;
  const source = content.match(/^-- source: (.+)$/m)?.[1];
  const componentId = content.match(/^-- component-id: (.+)$/m)?.[1];
  return source && componentId ? { source, componentId } : null;
}

function assertProxyOwnership(file, content, expected, action) {
  const actual = proxyOwnership(content);
  if (!actual) {
    throw new Error(`${file}: refusing to ${action} a .script, .gui_script, or .render_script file without complete Deherm ownership headers`);
  }
  if (actual.source !== expected.source || actual.componentId !== expected.componentId) {
    throw new Error(
      `${file}: refusing to ${action} proxy owned by ${actual.source} (${actual.componentId}); expected ${expected.source} (${expected.componentId})`
    );
  }
}

async function readExisting(file) {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

function confinedOutputPath(outputRoot, relative, label) {
  if (typeof relative !== "string" || !relative || path.isAbsolute(relative)) {
    throw new Error(`${label}: expected a non-empty relative output path`);
  }
  const target = path.resolve(outputRoot, relative);
  const confined = path.relative(outputRoot, target);
  if (!confined || confined === ".." || confined.startsWith(`..${path.sep}`) || path.isAbsolute(confined)) {
    throw new Error(`${label}: output path escapes the output root`);
  }
  return target;
}

async function previousManifest(outputRoot) {
  const manifestPath = path.join(outputRoot, ".deherm", "generated", "components", "manifest.json");
  const source = await readExisting(manifestPath);
  if (source === undefined) return null;
  let manifest;
  try {
    manifest = JSON.parse(source);
  } catch {
    throw new Error(`${manifestPath}: refusing to overwrite an invalid component manifest`);
  }
  if (manifest.generator !== GENERATOR || !Array.isArray(manifest.components)) {
    throw new Error(`${manifestPath}: refusing to overwrite a component manifest not owned by ${GENERATOR}`);
  }
  return manifest;
}

async function stageWrites(writes) {
  const staged = [];
  try {
    for (const write of writes) {
      await mkdir(path.dirname(write.path), { recursive: true });
      const temporary = `${write.path}.tmp-${process.pid}-${sha256(write.path).slice(0, 8)}`;
      await writeFile(temporary, write.content, "utf8");
      staged.push({ ...write, temporary });
    }
    for (const write of staged) await rename(write.temporary, write.path);
  } finally {
    await Promise.all(staged.map(({ temporary }) => rm(temporary, { force: true })));
  }
}

export async function discoverComponentSources(projectRoot) {
  const root = path.resolve(projectRoot);
  const found = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareCodeUnits(left.name, right.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) await visit(absolute);
      } else if (entry.isFile() && componentSourceKinds.some(({ suffix }) => entry.name.endsWith(suffix))) {
        found.push(absolute);
      }
    }
  }
  await visit(root);
  return found;
}

export async function compileComponentSources({ projectRoot, sourceFiles }) {
  const root = path.resolve(projectRoot);
  const files = sourceFiles.map((file) => path.resolve(file));
  const records = files.map((file) => ({ file, relative: canonicalRelativePath(root, file) }));
  records.sort((left, right) => compareCodeUnits(left.relative, right.relative));

  await Promise.all(records.map(async (record) => {
    record.sourceText = await readFile(record.file, "utf8");
  }));

  const foldedPaths = new Set();
  for (const record of records) {
    const folded = record.relative.toLowerCase();
    if (foldedPaths.has(folded)) throw new Error(`component source paths must be unique ignoring case (${record.relative})`);
    foldedPaths.add(folded);
  }

  const api = new API();
  try {
    const snapshot = api.updateSnapshot({ openFiles: records.map(({ file }) => file) });
    try {
      const components = [];
      const ids = new Map();
      for (const record of records) {
        const project = snapshot.getDefaultProjectForFile(record.file);
        if (!project) throw new Error(`${record.relative}: TypeScript did not create a project for the source`);
        const sourceFile = project.program.getSourceFile(record.file);
        if (!sourceFile) throw new Error(`${record.relative}: TypeScript did not parse the source`);
        const diagnostics = project.program.getSyntacticDiagnostics(record.file);
        if (diagnostics.length) {
          throw new Error(`${record.relative}: TypeScript syntax error: ${diagnostics.map(({ messageText }) => diagnosticText(messageText)).join("; ")}`);
        }
        const sourceTextAfterParse = await readFile(record.file, "utf8");
        if (sourceTextAfterParse !== record.sourceText) {
          throw new Error(`${record.relative}: source changed while component generation was running; retry generation`);
        }
        const component = parseSourceFile(sourceFile, record.relative, record.sourceText);
        const collision = ids.get(component.componentId);
        if (collision && collision !== record.relative) {
          throw new Error(`component ID collision: ${collision} and ${record.relative} both map to ${component.componentId}`);
        }
        ids.set(component.componentId, record.relative);
        components.push(component);
      }
      const proxies = new Map();
      for (const component of components) {
        const folded = component.proxy.toLowerCase();
        const collision = proxies.get(folded);
        if (collision) {
          const canonicalSource = component.proxy.replace(/\.gui_script$/, ".gui.ts");
          throw new Error(`component proxy collision: ${collision.source} and ${component.source} both generate ${component.proxy}; prefer canonical ${canonicalSource}`);
        }
        proxies.set(folded, component);
      }
      return components;
    } finally {
      snapshot.dispose();
    }
  } finally {
    api.close();
  }
}

export async function generateComponentProxies({ projectRoot, sourceFiles, outputRoot = projectRoot, check = false }) {
  const root = path.resolve(projectRoot);
  const output = path.resolve(outputRoot);
  const files = await discoverComponentSources(root);
  if (sourceFiles?.length) {
    const inventory = new Set(files.map((file) => path.resolve(file)));
    for (const requested of sourceFiles) {
      const absolute = path.resolve(requested);
      canonicalRelativePath(root, absolute);
      if (!inventory.has(absolute)) {
        throw new Error(`${absolute}: explicit component input is not a regular discovered project source`);
      }
    }
  }
  const components = await compileComponentSources({ projectRoot: root, sourceFiles: files });
  const generated = outputsFor(components, output);
  const prior = await previousManifest(output);

  const currentOwners = new Map(generated.outputs
    .filter(({ generatedLua }) => generatedLua)
    .map(({ path: file, owner }) => [path.relative(output, file).split(path.sep).join("/"), owner]));
  const orphans = [];
  if (prior) {
    const priorProxies = new Set();
    for (const component of prior.components) {
      const proxy = component?.proxy;
      const expected = { source: component?.source, componentId: component?.componentId };
      const orphanPath = confinedOutputPath(output, proxy, "Previous component manifest proxy");
      const folded = proxy.toLowerCase();
      if (priorProxies.has(folded)) throw new Error(`Previous component manifest contains duplicate proxy ${proxy}`);
      priorProxies.add(folded);
      const current = currentOwners.get(proxy);
      if (current) {
        if (current.source !== expected.source || current.componentId !== expected.componentId) {
          throw new Error(`${orphanPath}: proxy ownership changed from ${expected.source} (${expected.componentId}) to ${current.source} (${current.componentId})`);
        }
        continue;
      }
      const existing = await readExisting(orphanPath);
      if (existing === undefined) continue;
      assertProxyOwnership(orphanPath, existing, expected, "delete");
      orphans.push(orphanPath);
    }
  }

  const stale = [];
  const defoldResourceStale = [];
  const writes = [];
  for (const output of generated.outputs) {
    const existing = await readExisting(output.path);
    if (existing !== output.content) stale.push(output.path);
    if (existing !== output.content && output.generatedLua) defoldResourceStale.push(output.path);
    if (existing !== undefined && existing !== output.content && output.generatedLua) {
      assertProxyOwnership(output.path, existing, output.owner, "overwrite");
    }
    if (existing !== output.content) writes.push(output);
  }
  stale.push(...orphans);
  defoldResourceStale.push(...orphans);
  if (check && stale.length) {
    throw new Error(`component proxy outputs are missing or stale:\n${stale.map((file) => `- ${file}`).join("\n")}`);
  }
  if (!check) {
    await stageWrites(writes);
    await Promise.all(orphans.map((file) => rm(file)));
  }
  return { ...generated, stale, defoldResourceStale };
}

export { componentProxyConstants };
