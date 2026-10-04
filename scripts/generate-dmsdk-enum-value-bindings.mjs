import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { indexDmSdkValuePlan, inferEnumValueSemantics } from "../packages/compiler/src/dmsdk-value-plan.mjs";
import {
  createDmSdkEnumValueRecipeFacts,
  DMSDK_ENUM_VALUE_RECIPE_FACTS_NAME,
  renderDmSdkEnumValueOutputs,
} from "../packages/compiler/src/dmsdk-enum-value-output-emitter.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const paths = {
  ir: "packages/bindings/generated/defold-sdk-ir.json",
  shapes: "packages/bindings/generated/defold-dmsdk-abi-shapes.json",
  valuePlan: "packages/bindings/generated/defold-dmsdk-value-plan.json",
  scalarReport: "packages/bindings/generated/defold-dmsdk-scalar-thunks.json",
  overrides: "packages/bindings/overrides/dmsdk-enum-value-bindings.json",
};

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const snake = (value) =>
  value
    .replace(/::/g, "_")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
const leaf = (value) => String(value).split("::").at(-1);

function parseArgs(argv) {
  const result = { outRoot: root, check: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--check") result.check = true;
    else if (argv[index] === "--out-root") result.outRoot = resolve(argv[++index]);
    else throw new Error(`Unknown argument ${argv[index]}`);
  }
  return result;
}

function typeIndex(ir) {
  const exact = new Map();
  const leaves = new Map();
  for (const declaration of ir.declarations) {
    if (!declaration.name || !["enum", "type-alias"].includes(declaration.kind)) continue;
    if (!exact.has(declaration.name) || declaration.kind === "enum") exact.set(declaration.name, declaration);
    const values = leaves.get(leaf(declaration.name)) ?? [];
    values.push(declaration);
    leaves.set(leaf(declaration.name), values);
  }
  return { exact, leaves };
}

function resolveType(type, symbol, index) {
  const clean = String(type)
    .replace(/\b(?:const|volatile|enum|struct|class)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (index.exact.has(clean)) return index.exact.get(clean);
  const namespace = String(symbol).split("::").slice(0, -1).join("::");
  if (namespace && index.exact.has(`${namespace}::${clean}`)) return index.exact.get(`${namespace}::${clean}`);
  const matches = index.leaves.get(leaf(clean)) ?? [];
  return matches.length === 1 ? matches[0] : undefined;
}

function abiType(type, symbol, index, seen = new Set()) {
  const direct = { void: "void", bool: "bool", uint32_t: "u32", uint64_t: "u64" }[type];
  if (direct) return { kind: direct, native: type };
  const resolved = resolveType(type, symbol, index);
  if (!resolved || seen.has(resolved.id)) throw new Error(`Unresolved enum-value ABI type ${type} in ${symbol}`);
  seen.add(resolved.id);
  if (resolved.kind === "enum") return { kind: "i32", native: type, enum: resolved };
  return abiType(resolved.type, resolved.name, index, seen);
}

function wrapperName(declaration, parameters) {
  const suffix = parameters.length ? parameters.map(({ abi }) => abi.kind).join("_") : "v";
  return `deherm_dmsdk_enum_${snake(declaration.name)}_${suffix}`;
}

function sourceGroup(header) {
  const marker = "/dmsdk/";
  const index = header.indexOf(marker);
  if (index < 0) throw new Error(`No public dmSDK include path in ${header}`);
  const include = `dmsdk/${header.slice(index + marker.length)}`;
  const filename = include.split("/").at(-1);
  const name = filename
    .replace(/\.[^.]+$/u, "")
    .replace(/[^A-Za-z0-9]+/gu, "_")
    .toLowerCase();
  if (!name) throw new Error(`No deterministic enum-value source group for ${header}`);
  return { name, include };
}

export { inferEnumValueSemantics };

function enumDomain(abi) {
  return abi.enum
    ? [
        ...new Set(
          abi.enum.members
            .filter(({ name }) => !/(?:^|_)(?:MAX|COUNT|NUM)(?:_|$)/.test(name))
            .map(({ value }) => value),
        ),
      ].sort((a, b) => a - b)
    : undefined;
}

export async function build() {
  const contents = Object.fromEntries(
    await Promise.all(
      Object.entries(paths).map(async ([name, path]) => [name, await readFile(resolve(root, path), "utf8")]),
    ),
  );
  const ir = JSON.parse(contents.ir);
  const shapes = JSON.parse(contents.shapes);
  const valuePlan = JSON.parse(contents.valuePlan);
  const scalarReport = JSON.parse(contents.scalarReport);
  const overrides = JSON.parse(contents.overrides);
  if (overrides.schemaVersion !== 2 || overrides.family !== "enum-value" || !overrides.recipe)
    throw new Error("Invalid enum-value structural policy");
  const declarationById = new Map(ir.declarations.map((declaration) => [declaration.id, declaration]));
  const index = typeIndex(ir);
  const planById = indexDmSdkValuePlan(valuePlan, {
    revision: ir.defoldRevision,
    sourceHashes: {
      ir: sha256(contents.ir),
      shapes: sha256(contents.shapes),
      enumValue: sha256(contents.overrides),
    },
  });
  const patterns = valuePlan.patternRegistry.filter(
    ({ id }) => id === "value.enum-domain-direct" || id === "universal.default",
  );
  const candidates = shapes.rows
    .map((candidate) => {
      const declaration = declarationById.get(candidate.id);
      const decision = planById.get(candidate.id);
      return decision?.patternId === "value.enum-domain-direct"
        ? { candidate, declaration, semantics: decision.semantics, decision }
        : null;
    })
    .filter(Boolean)
    .sort((left, right) => left.candidate.id.localeCompare(right.candidate.id));
  const reportRows = [];
  const entries = [];
  for (const { candidate, declaration, semantics, decision } of candidates) {
    const common = {
      ...candidate,
      patternDecision: decision.patternId,
      semanticEvidence: semantics.evidence,
    };
    if (semantics.capabilityBlocker) {
      reportRows.push({
        ...common,
        emitted: false,
        blocker: semantics.capabilityBlocker,
        stages: {
          generated: "blocked-by-policy",
          compiled: "not-applicable",
          linked: "not-applicable",
          runtime: "not-applicable",
        },
      });
      continue;
    }
    const result = abiType(declaration.returns ?? "void", declaration.name, index);
    const parameters = declaration.parameters.map((parameter) => ({
      parameter,
      abi: abiType(parameter.type, declaration.name, index),
    }));
    const group = sourceGroup(declaration.header);
    const entry = {
      id: entries.length,
      declaration,
      result,
      parameters,
      group,
      wrapper: wrapperName(declaration, parameters),
    };
    entries.push(entry);
    const hostRuntime = group.name === "buffer" || group.name === "log";
    reportRows.push({
      ...common,
      emitted: true,
      bindingId: entry.id,
      wrapper: entry.wrapper,
      enumDomains: Object.fromEntries(
        parameters.filter(({ abi }) => abi.enum).map(({ parameter, abi }) => [parameter.name, enumDomain(abi)]),
      ),
      stages: {
        generated: "complete",
        compiled: "packaged-sdk-object-test",
        linked: hostRuntime ? "packaged-sdk-host-link-test" : "extension-link-pending",
        runtime: hostRuntime ? "packaged-sdk-host-runtime-test" : "engine-context-pending",
      },
    });
  }
  const recipeFacts = createDmSdkEnumValueRecipeFacts(entries);
  const rendered = renderDmSdkEnumValueOutputs(recipeFacts);
  const artifacts = new Map();
  artifacts.set("defold/defold_hermes/include/defold_hermes/generated_dmsdk_enum_value.h", rendered.header);
  for (const group of Object.keys(rendered.sources)) {
    artifacts.set(`defold/defold_hermes/src/generated_dmsdk_enum_value_${group}.cpp`, rendered.sources[group]);
  }
  artifacts.set(
    "defold/defold_hermes/include/defold_hermes/generated_dmsdk_enum_value_runtime.h",
    rendered.runtimeHeader,
  );
  artifacts.set("defold/defold_hermes/src/generated_dmsdk_enum_value_runtime.cpp", rendered.runtime);
  artifacts.set("defold/defold_hermes/include/defold_hermes/generated_dmsdk_enum_value_jsi.hpp", rendered.jsiHeader);
  artifacts.set("defold/defold_hermes/src/generated_dmsdk_enum_value_jsi.cpp", rendered.jsi);
  artifacts.set("packages/sdk/src/generated/dmsdk/enum-value.ts", rendered.typescript);
  const report = {
    schemaVersion: 1,
    defoldRevision: ir.defoldRevision,
    sources: paths,
    sourceHashes: Object.fromEntries(Object.entries(contents).map(([name, content]) => [name, sha256(content)])),
    policy: {
      ...overrides.recipe,
      cEnumRepresentation: "int32_t",
      enumInputs: "generated exact-domain validation before native call",
      uint64: "C uint64_t and native JSI bigint",
      allocation: "stack-only fixed slots; no glue allocation or ownership transfer",
      html5: "fail-closed until Wasm BigInt and linked-symbol matrix are validated",
      patternRegistry: patterns.map(({ id, family, emitter, priority, cost, fallback, when }) => ({
        id,
        family,
        emitter,
        priority,
        cost,
        fallback,
        when,
      })),
    },
    universalFallback: {
      preserved: true,
      catalog: "packages/bindings/generated/defold-dmsdk-universal-bindings.json",
      mutation: "none",
    },
    coverage: {
      baselineRuntimePending: shapes.coverage.runtimePending,
      previouslyEmittedScalar: scalarReport.coverage.generated,
      discovered: candidates.length,
      emitted: entries.length,
      blocked: reportRows.filter(({ emitted }) => !emitted).length,
      hostRuntimeVerified: reportRows.filter(({ stages }) => stages.runtime === "packaged-sdk-host-runtime-test")
        .length,
      engineContextPending: reportRows.filter(({ stages }) => stages.runtime === "engine-context-pending").length,
      remainingWithoutGeneratedAdapters:
        shapes.coverage.runtimePending - scalarReport.coverage.generated - entries.length,
    },
    artifactHashes: Object.fromEntries(
      [...artifacts].sort(([a], [b]) => a.localeCompare(b)).map(([path, content]) => [path, sha256(content)]),
    ),
    artifacts: [...artifacts.keys()].sort(),
    declarations: reportRows,
  };
  artifacts.set(
    `packages/bindings/generated/${DMSDK_ENUM_VALUE_RECIPE_FACTS_NAME}`,
    `${JSON.stringify(recipeFacts, null, 2)}\n`,
  );
  artifacts.set(
    "packages/bindings/generated/defold-dmsdk-enum-value-bindings.json",
    `${JSON.stringify(report, null, 2)}\n`,
  );
  return { artifacts, report };
}

async function writeOrCheck(outRoot, relative, content, check) {
  const path = resolve(outRoot, relative);
  if (check) {
    if ((await readFile(path, "utf8")) !== content) throw new Error(`${relative} is stale`);
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

export async function run(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const { artifacts, report } = await build();
  for (const [path, content] of artifacts) await writeOrCheck(options.outRoot, path, content, options.check);
  process.stdout.write(
    `${options.check ? "Verified" : "Generated"} ${report.coverage.emitted}/${report.coverage.discovered} enum-value dmSDK bindings; ${report.coverage.blocked} optimization-blocked.\n`,
  );
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await run();
