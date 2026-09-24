#!/usr/bin/env node

// Derive the component-proxy facts that belong to one Defold revision.
// Stable lowering recipes live in @deherm/compiler; callback availability,
// proxy resource suffixes, go.property types, and resource constructors come
// from the engine and therefore travel in policy.

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readLifecycleCallbacks } from "./lib/script-lifecycle-callbacks.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = path.join(root, "packages", "bindings", "generated", "defold-component-proxy-contract.json");
const scriptIrPath = path.join(root, "packages", "bindings", "generated", "defold-script-api-ir.json");
const buildersPath = path.join(
  root,
  "upstream", "defold", "com.dynamo.cr", "com.dynamo.cr.bob", "src", "com", "dynamo", "bob", "pipeline", "ScriptBuilders.java"
);

const contextKinds = Object.freeze({
  script: Object.freeze({ contextKind: "game-object", supportsProperties: true }),
  gui_script: Object.freeze({ contextKind: "gui-scene", supportsProperties: false }),
  render_script: Object.freeze({ contextKind: "render-instance+graphics", supportsProperties: false })
});

// These are compiler codec capabilities, not Defold spellings. The emitted
// policy maps each revision's source token onto one of them so the installed
// compiler never needs an alias list such as `resource`/`resource_data`.
const propertyCodecBySemanticName = Object.freeze({
  number: "number",
  boolean: "boolean",
  string: "string",
  hash: "hash",
  url: "url",
  vector3: "vector3",
  vector4: "vector4",
  quaternion: "quaternion"
});

function camel(value) {
  return value.replace(/_([a-z0-9])/gu, (_whole, character) => character.toUpperCase());
}

function builderExtensions(source) {
  const extensions = new Set();
  for (const match of source.matchAll(/@BuilderParams\s*\([^)]*\binExts\s*=\s*"(\.[a-z0-9_]+)"[^)]*\)/gu)) {
    extensions.add(match[1]);
  }
  return extensions;
}

export async function buildComponentProxyPolicy(options = {}) {
  const sourceRoot = options.sourceRoot ?? root;
  const scriptIr = options.scriptIr ?? JSON.parse(await readFile(path.join(sourceRoot, path.relative(root, scriptIrPath)), "utf8"));
  const buildersSource = options.buildersSource ?? await readFile(path.join(sourceRoot, path.relative(root, buildersPath)), "utf8");
  const lifecycle = options.lifecycle ?? await readLifecycleCallbacks(path.join(sourceRoot, "upstream", "defold"));
  const extensions = builderExtensions(buildersSource);

  const contexts = [];
  for (const table of lifecycle.tables) {
    const shape = contextKinds[table.proxyKind];
    assert(shape, `${table.proxyKind}: component authoring has no stable context recipe`);
    const proxySuffix = `.${table.proxyKind}`;
    assert(extensions.has(proxySuffix), `${buildersPath}: no @BuilderParams input for ${proxySuffix}`);
    contexts.push({
      ...shape,
      proxyKind: table.proxyKind,
      proxySuffix,
      callbacks: table.callbacks,
      evidence: {
        lifecycle: `${table.source}:${table.symbol}`,
        resource: "com.dynamo.cr/com.dynamo.cr.bob/src/com/dynamo/bob/pipeline/ScriptBuilders.java:@BuilderParams"
      }
    });
  }

  const property = scriptIr.functions.filter(({ rawName }) => rawName === "go.property");
  assert.equal(property.length, 1, `expected exactly one go.property declaration, found ${property.length}`);
  const valueParameter = property[0].parameters.find(({ rawName }) => rawName === "value");
  assert(valueParameter?.rawType, "go.property has no declared value type");
  const valueTypes = valueParameter.rawType.split("|").map((value) => value.trim()).filter(Boolean);

  const resourceConstructors = scriptIr.functions
    .filter((fn) => fn.modulePath.length === 1 && fn.modulePath[0] === "resource")
    // Defold 1.13.x described these constructors as returning `hash`; newer
    // revisions name the semantic result `resource_data`. The stable fact is
    // their source documentation contract: they are the resource functions
    // legal only inside go.property. Do not pin the generator to either era's
    // return-token spelling.
    .filter((fn) => /only be called within\s+(?:\[(?:ref:)?go\.property\]|`go\.property`|go\.property)/iu.test(fn.description ?? ""))
    .map((fn) => ({
      authoringName: fn.jsName ?? camel(fn.member),
      engineName: fn.member,
      route: fn.rawName,
      source: `${fn.source}:${fn.line}`
    }))
    .sort((left, right) => left.engineName < right.engineName ? -1 : left.engineName > right.engineName ? 1 : 0);
  assert(resourceConstructors.length > 0, "no resource constructors restricted to go.property were derived");
  const resourceReturnTypes = new Set(scriptIr.functions
    .filter((fn) => resourceConstructors.some(({ route }) => route === fn.rawName))
    .flatMap((fn) => fn.returns ?? []));
  const valueTypeCodecs = Object.fromEntries(valueTypes.map((name) => {
    const codec = propertyCodecBySemanticName[name] ??
      (resourceReturnTypes.has(name) || /resource/iu.test(name) ? "resource" : "unsupported");
    return [name, codec];
  }));

  return {
    schemaVersion: 1,
    kind: "deherm.policy.component-proxy-contract",
    generator: "scripts/generate-component-proxy-contract.mjs",
    defoldRevision: scriptIr.defoldRevision,
    contexts,
    property: {
      route: property[0].rawName,
      valueTypes,
      valueTypeCodecs,
      source: `${property[0].source}:${property[0].line}`,
      resourceConstructors
    }
  };
}

export async function runComponentProxyPolicyGenerator(options = {}) {
  const check = options.check ?? process.argv.includes("--check");
  const target = options.outputPath ?? outputPath;
  const source = `${JSON.stringify(await buildComponentProxyPolicy(options), null, 2)}\n`;
  if (check) {
    const current = await readFile(target, "utf8").catch(() => null);
    assert.equal(current, source, `${path.relative(root, target)} is stale; run node scripts/generate-component-proxy-contract.mjs`);
  } else {
    await writeFile(target, source);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runComponentProxyPolicyGenerator();
}
