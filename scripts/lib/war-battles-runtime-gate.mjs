import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { generateComponentProxies } from "../../packages/compiler/src/component-proxy-generator.mjs";
import { stableBindingId } from "./binding-identity.mjs";
import { publicScriptRootName } from "../../packages/compiler/src/script-public-api-policy.mjs";

const GO_PROPERTY_ID = "script:go.property";

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label}: invalid JSON: ${error.message}`);
  }
}

function uniqueBy(items, key, label) {
  const output = new Map();
  for (const item of items) {
    const value = item[key];
    if (output.has(value)) throw new Error(`${label}: duplicate ${key} ${JSON.stringify(value)}`);
    output.set(value, item);
  }
  return output;
}

function exactLifecycles(component) {
  return Object.entries(component.lifecycles)
    .filter(([, present]) => present)
    .map(([name]) => name);
}

function validateComponentSurface(inventory, manifest) {
  const generatedBySource = uniqueBy(manifest.components, "source", "component manifest");
  const expectedSources = new Set(inventory.components.map(({ source }) => source));
  const unexpected = manifest.components.map(({ source }) => source).filter((source) => !expectedSources.has(source));
  if (unexpected.length) throw new Error(`component manifest: unexpected War Battles components: ${unexpected.join(", ")}`);

  return inventory.components.map((expected) => {
    const generated = generatedBySource.get(expected.source);
    if (!generated) throw new Error(`component manifest: missing ${expected.source}`);
    if (generated.proxyKind !== expected.proxyKind) {
      throw new Error(`${expected.source}: expected ${expected.proxyKind} proxy, received ${generated.proxyKind}`);
    }
    const actualLifecycles = exactLifecycles(generated);
    const actualLifecycleSet = [...actualLifecycles].sort();
    const expectedLifecycleSet = [...expected.lifecycles].sort();
    if (JSON.stringify(actualLifecycleSet) !== JSON.stringify(expectedLifecycleSet)) {
      throw new Error(`${expected.source}: lifecycle mismatch; expected ${expected.lifecycles.join(", ")}, received ${actualLifecycles.join(", ")}`);
    }
    const actualProperties = generated.properties.map(({ name, kind, default: defaultValue }) => ({
      name,
      type: kind,
      default: defaultValue
    }));
    const expectedProperties = expected.editorProperties.map(({ name, type, default: defaultValue }) => ({
      name,
      type,
      default: defaultValue
    }));
    if (JSON.stringify(actualProperties) !== JSON.stringify(expectedProperties)) {
      throw new Error(`${expected.source}: editor property mismatch`);
    }
    return {
      source: expected.source,
      proxy: generated.proxy,
      proxyKind: generated.proxyKind,
      contextKind: generated.contextKind,
      lifecycleMask: generated.lifecycleMask,
      lifecycles: actualLifecycles,
      editorProperties: actualProperties,
      generated: true
    };
  });
}

function sourceToken(requirement) {
  if (requirement.id === "script:hash") return `${publicScriptRootName("builtins")}.hash(`;
  if (requirement.id === GO_PROPERTY_ID) return "property.vector3(";
  return `${requirement.typescriptName}(`;
}

function validateSourceCoverage(inventory, sources) {
  return inventory.apiUsage.map((requirement) => {
    const token = sourceToken(requirement);
    const files = [...sources.entries()]
      .filter(([, source]) => source.includes(token))
      .map(([file]) => file);
    if (files.length === 0) throw new Error(`${requirement.id}: fixture does not express ${token}`);
    return { id: requirement.id, token, sources: files };
  });
}

function validateCompileTimeProperty(manifest, rocketProxy) {
  const rocket = manifest.components.find(({ source }) => source === "src/scripts/rocket.script.ts");
  const property = rocket?.properties.find(({ name }) => name === "dir");
  const manifestMatches = property?.kind === "vector3" && JSON.stringify(property.default) === "[0,0,0]";
  const proxyDeclaration = 'go.property("dir", vmath.vector3(0, 0, 0))';
  const proxyMatches = rocketProxy.includes(proxyDeclaration);
  return {
    satisfied: manifestMatches && proxyMatches,
    evidence: {
      manifest: "tests/fixtures/war-battles/.deherm/generated/components/manifest.json#src/scripts/rocket.script.ts/properties/dir",
      proxy: "tests/fixtures/war-battles/src/scripts/rocket.script",
      declaration: proxyDeclaration,
      manifestMatches,
      proxyMatches
    }
  };
}

export async function buildWarBattlesRuntimeGate(repositoryRoot) {
  const root = path.resolve(repositoryRoot);
  const fixtureProjectRoot = path.join(root, "tests/fixtures/war-battles");
  const componentOutputRoot = await mkdtemp(path.join(tmpdir(), "deherm-war-battles-gate-"));
  let componentManifestText;
  try {
    await generateComponentProxies({
      projectRoot: fixtureProjectRoot,
      outputRoot: componentOutputRoot
    });
    componentManifestText = await readFile(
      path.join(componentOutputRoot, ".deherm/generated/components/manifest.json"),
      "utf8"
    );
  } finally {
    await rm(componentOutputRoot, { recursive: true, force: true });
  }
  const relativePaths = {
    inventory: ".agents/docs/data/war-battles-api-usage.json",
    ir: "packages/bindings/generated/defold-script-api-ir.json",
    scalarDispatch: "packages/bindings/generated/defold-script-scalar-dispatch.json",
    valueDispatch: "packages/bindings/generated/defold-script-value-bindings.json",
    componentManifest: "tests/fixtures/war-battles/.deherm/generated/components/manifest.json",
    rocketProxy: "tests/fixtures/war-battles/src/scripts/rocket.script"
  };
  const sourcePaths = [
    "tests/fixtures/war-battles/src/scripts/player.script.ts",
    "tests/fixtures/war-battles/src/scripts/rocket.script.ts",
    "tests/fixtures/war-battles/src/scripts/ui.gui_script.ts"
  ];
  const entries = await Promise.all(
    [...Object.entries(relativePaths), ...sourcePaths.map((file) => [file, file])]
      .map(async ([key, file]) => [
        key,
        file,
        key === "componentManifest"
          ? componentManifestText
          : await readFile(path.join(root, file), "utf8")
      ])
  );
  const texts = new Map(entries.map(([key, , text]) => [key, text]));
  const inventory = parseJson(texts.get("inventory"), relativePaths.inventory);
  const ir = parseJson(texts.get("ir"), relativePaths.ir);
  const scalarDispatch = parseJson(texts.get("scalarDispatch"), relativePaths.scalarDispatch);
  const valueDispatch = parseJson(texts.get("valueDispatch"), relativePaths.valueDispatch);
  const manifest = parseJson(texts.get("componentManifest"), relativePaths.componentManifest);
  if (inventory.schemaVersion !== 1 || ir.schemaVersion !== 1 || scalarDispatch.schemaVersion !== 1 || valueDispatch.schemaVersion !== 1 || manifest.schemaVersion !== 1) {
    throw new Error("War Battles gate only supports schemaVersion 1 inputs");
  }
  if (inventory.sourceSelection.defoldRevision !== ir.defoldRevision || ir.defoldRevision !== scalarDispatch.defoldRevision || ir.defoldRevision !== valueDispatch.defoldRevision) {
    throw new Error("War Battles gate inputs do not share the pinned Defold revision");
  }

  const irById = uniqueBy(ir.functions, "id", "script API IR");
  const scalarById = uniqueBy(scalarDispatch.bindings, "id", "scalar dispatch");
  const valueById = uniqueBy(valueDispatch.bindings, "id", "Defold value dispatch");
  const componentSurface = validateComponentSurface(inventory, manifest);
  const fixtureSources = new Map(sourcePaths.map((file) => [file, texts.get(file)]));
  const sourceCoverage = validateSourceCoverage(inventory, fixtureSources);
  const compileTimeProperty = validateCompileTimeProperty(manifest, texts.get("rocketProxy"));

  const requirements = inventory.apiUsage.map((usage) => {
    const api = irById.get(usage.id);
    if (!api) throw new Error(`${usage.id}: missing from script API IR`);
    const calculatedStableId = stableBindingId(usage.id);
    if (calculatedStableId !== usage.stableId) {
      throw new Error(`${usage.id}: inventory stable ID ${usage.stableId} does not match generated identity ${calculatedStableId}`);
    }
    if (usage.id === GO_PROPERTY_ID) {
      return {
        ...usage,
        rawName: api.rawName,
        route: "compile-time-component-proxy",
        status: compileTimeProperty.satisfied ? "compile-time-generated" : "missing-compile-time-generation",
        executable: compileTimeProperty.satisfied,
        engineContextVerified: false,
        evidence: compileTimeProperty.evidence
      };
    }
    const binding = scalarById.get(usage.id) ?? valueById.get(usage.id);
    if (binding && binding.stableId !== usage.stableId) {
      throw new Error(`${usage.id}: scalar dispatch stable ID does not match usage inventory`);
    }
    return {
      ...usage,
      rawName: api.rawName,
      route: binding ? (valueById.has(usage.id) ? "generated-native-defold-value-dispatch" : "generated-stable-id-lua-dispatch") : "none",
      status: binding ? "generated-executable-route" : "missing-executable-binding",
      executable: Boolean(binding),
      engineContextVerified: false,
      evidence: binding ? {
        artifact: valueById.has(usage.id) ? relativePaths.valueDispatch : relativePaths.scalarDispatch,
        stableId: binding.stableId,
        executableStatus: binding.executableStatus ?? "generated native POD dispatch enabled; gameplay execution not yet claimed"
      } : {
        apiIr: `${relativePaths.ir}#${usage.id}`,
        declarationOnly: true,
        reason: "The generated TypeScript declaration and API IR do not provide an executable engine binding."
      }
    };
  });

  const missing = requirements.filter(({ executable }) => !executable);
  const runtimeRequirements = requirements.filter(({ id }) => id !== GO_PROPERTY_ID);
  const generatedRuntimeRoutes = runtimeRequirements.filter(({ executable }) => executable);
  const ready = missing.length === 0;
  const inputFiles = Object.fromEntries(
    entries
      .map(([, file, text]) => [file, { sha256: sha256(text) }])
      .sort(([left], [right]) => left.localeCompare(right, "en"))
  );

  return {
    schemaVersion: 1,
    title: "War Battles Deherm executable API readiness gate",
    status: ready ? "ready" : "blocked",
    readinessMeaning: "Every API used by the TypeScript fixture has a generated executable route (or an intentional compile-time proxy route). Gameplay execution is a separate later proof.",
    gameplayExecutionObserved: false,
    defoldRevision: ir.defoldRevision,
    inputs: inputFiles,
    componentSurface: {
      status: "generated",
      ready: true,
      componentCount: componentSurface.length,
      components: componentSurface
    },
    sourceCoverage: {
      ready: true,
      requiredApiCount: sourceCoverage.length,
      requirements: sourceCoverage
    },
    counts: {
      requiredApiCount: requirements.length,
      compileTimeGeneratedCount: requirements.filter(({ status }) => status === "compile-time-generated").length,
      runtimeRequiredCount: runtimeRequirements.length,
      generatedRuntimeRouteCount: generatedRuntimeRoutes.length,
      missingExecutableCount: missing.length
    },
    missingExecutableIds: missing.map(({ id }) => id),
    requirements
  };
}

export function renderWarBattlesRuntimeGate(report) {
  return `${JSON.stringify(report, null, 2)}\n`;
}
