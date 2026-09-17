import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");

const ABI_TYPES = Object.freeze({
  void: { c: "void", suffix: "v" },
  bool: { c: "uint8_t", suffix: "bool" },
  uint16_t: { c: "uint16_t", suffix: "u16" },
  uint32_t: { c: "uint32_t", suffix: "u32" },
  uint64_t: { c: "uint64_t", suffix: "u64" },
  float: { c: "float", suffix: "f32" },
});

const MODULES = Object.freeze({
  endian: {
    headers: [
      "upstream/defold/engine/dlib/src/dmsdk/dlib/endian.h",
      "upstream/defold/engine/dlib/src/dmsdk/dlib/endian.hpp",
    ],
    include: "dmsdk/dlib/endian.hpp",
    linkTest: true,
    conformanceTest: true,
  },
  log: {
    headers: ["upstream/defold/engine/dlib/src/dmsdk/dlib/log.h"],
    include: "dmsdk/dlib/log.h",
    linkTest: false,
    conformanceTest: false,
  },
  profile: {
    headers: ["upstream/defold/engine/dlib/src/dmsdk/dlib/profile.h"],
    include: "dmsdk/dlib/profile.h",
    linkTest: false,
    conformanceTest: false,
  },
  time: {
    headers: ["upstream/defold/engine/dlib/src/dmsdk/dlib/time.h"],
    include: "dmsdk/dlib/time.h",
    linkTest: true,
    conformanceTest: true,
  },
  trig: {
    headers: ["upstream/defold/engine/dlib/src/dmsdk/dlib/trig_lookup.h"],
    include: "dmsdk/dlib/trig_lookup.h",
    linkTest: true,
    conformanceTest: true,
  },
  utf8: {
    headers: ["upstream/defold/engine/dlib/src/dmsdk/dlib/utf8.h"],
    include: "dmsdk/dlib/utf8.h",
    linkTest: true,
    conformanceTest: true,
  },
});

const BLOCKED_HEADERS = Object.freeze({
  "upstream/defold/engine/graphics/src/dmsdk/graphics/graphics.h": {
    blocker: "The pinned source-tree header includes <graphics/graphics_ddf.h>, but that generated SDK header is absent from the checkout.",
    missingDependency: "graphics/graphics_ddf.h",
    checkedPath: "upstream/defold/engine/graphics/src/graphics/graphics_ddf.h",
  },
});

const BLOCKED_SYMBOLS = Object.freeze({
  "dmLog::LogFinalize": {
    blocker: "Process-global logging teardown is not part of the default script-callable ABI.",
    policy: "lifecycle-capability-required",
  },
  dmLogFinalize: {
    blocker: "Process-global logging teardown is not part of the default script-callable ABI.",
    policy: "lifecycle-capability-required",
  },
  ProfileInitialize: {
    blocker: "Process-global profiler initialization is owned by the Defold engine lifecycle.",
    policy: "lifecycle-capability-required",
  },
  ProfileFinalize: {
    blocker: "Process-global profiler teardown is owned by the Defold engine lifecycle.",
    policy: "lifecycle-capability-required",
  },
});

const DEFINITION_SPECS = Object.freeze({
  "dmGraphics::Finalize": [
    ["upstream/defold/engine/graphics/src/graphics.cpp", "void Finalize()"],
  ],
  "dmLog::LogFinalize": [
    ["upstream/defold/engine/dlib/src/dlib/log.cpp", "void LogFinalize()"],
  ],
  dmLogFinalize: [
    ["upstream/defold/engine/dlib/src/dlib/log.cpp", "void dmLogFinalize()"],
  ],
  "dmTime::GetTime": [
    ["upstream/defold/engine/dlib/src/dlib/time_apple.cpp", "uint64_t GetTime()"],
    ["upstream/defold/engine/dlib/src/dlib/time_posix.cpp", "uint64_t GetTime()"],
    ["upstream/defold/engine/dlib/src/dlib/time_win32.cpp", "uint64_t GetTime()"],
  ],
  "dmTime::GetMonotonicTime": [
    ["upstream/defold/engine/dlib/src/dlib/time_apple.cpp", "uint64_t GetMonotonicTime()"],
    ["upstream/defold/engine/dlib/src/dlib/time_posix.cpp", "uint64_t GetMonotonicTime()"],
    ["upstream/defold/engine/dlib/src/dlib/time_win32.cpp", "uint64_t GetMonotonicTime()"],
  ],
  "dmTime::Sleep": [
    ["upstream/defold/engine/dlib/src/dlib/time_apple.cpp", "void Sleep(uint32_t useconds)"],
    ["upstream/defold/engine/dlib/src/dlib/time_posix.cpp", "void Sleep(uint32_t useconds)"],
    ["upstream/defold/engine/dlib/src/dlib/time_win32.cpp", "void Sleep(uint32_t useconds)"],
  ],
  "dmTrigLookup::Cos": [
    ["upstream/defold/engine/dlib/src/dlib/trig_lookup.cpp", "const float* COS_TABLE = _COS_TABLE;"],
  ],
  "dmTrigLookup::Sin": [
    ["upstream/defold/engine/dlib/src/dlib/trig_lookup.cpp", "const float* COS_TABLE = _COS_TABLE;"],
  ],
  ProfileInitialize: [
    ["upstream/defold/engine/dlib/src/dlib/profile/profile.cpp", "void ProfileInitialize()"],
    ["upstream/defold/engine/dlib/src/dlib/profile/profile_null.cpp", "void ProfileInitialize()"],
  ],
  ProfileFinalize: [
    ["upstream/defold/engine/dlib/src/dlib/profile/profile.cpp", "void ProfileFinalize()"],
    ["upstream/defold/engine/dlib/src/dlib/profile/profile_null.cpp", "void ProfileFinalize()"],
  ],
  ProfileIsInitialized: [
    ["upstream/defold/engine/dlib/src/dlib/profile/profile.cpp", "bool ProfileIsInitialized()"],
    ["upstream/defold/engine/dlib/src/dlib/profile/profile_null.cpp", "bool ProfileIsInitialized()"],
  ],
});

function parseArguments(argv) {
  const options = { outRoot: repositoryRoot, check: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") options.check = true;
    else if (argument === "--out-root") options.outRoot = resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function snakeCase(value) {
  return value
    .replace(/::/g, "_")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function wrapperName(declaration) {
  const suffix = declaration.parameters.length === 0
    ? ABI_TYPES.void.suffix
    : declaration.parameters.map(({ type }) => ABI_TYPES[type]?.suffix ?? "unsupported").join("_");
  return `deherm_dmsdk_${snakeCase(declaration.name)}_${suffix}`;
}

function moduleForHeader(header) {
  for (const [name, module] of Object.entries(MODULES)) {
    if (module.headers.includes(header)) return name;
  }
  return undefined;
}

function lineContaining(content, needle) {
  const lines = content.split(/\r?\n/);
  const index = lines.findIndex((line) => line.includes(needle));
  if (index < 0) throw new Error(`Expected source evidence not found: ${needle}`);
  return { line: index + 1, text: lines[index].trim() };
}

function declarationEvidence(content, declaration) {
  const lines = content.split(/\r?\n/);
  const leaf = declaration.name.split("::").at(-1);
  const start = Math.max(0, declaration.line - 1);
  const end = Math.min(lines.length, start + 32);
  const candidates = [];
  for (let index = start; index < end; index += 1) {
    if (new RegExp(`\\b${leaf}\\s*\\(`).test(lines[index])) candidates.push({ line: index + 1, text: lines[index].trim() });
  }
  const candidate = candidates.find(({ text }) => {
    if (!text.includes(declaration.returns)) return false;
    return declaration.parameters.every(({ type }) => text.includes(type));
  });
  if (!candidate) throw new Error(`Could not validate ${declaration.type} for ${declaration.id} near ${declaration.header}:${declaration.line}`);
  return candidate;
}

async function sourceEvidence(relativePath, needle) {
  const content = await readFile(resolve(repositoryRoot, relativePath), "utf8");
  const match = lineContaining(content, needle);
  return { path: relativePath, ...match, sha256: sha256(content) };
}

function abiDeclaration(declaration, name) {
  const returnType = ABI_TYPES[declaration.returns].c;
  const parameters = declaration.parameters.map((parameter) => `${ABI_TYPES[parameter.type].c} ${parameter.name}`).join(", ");
  return `${returnType} ${name}(${parameters || "void"});`;
}

function abiDefinition(declaration, name) {
  const returnType = ABI_TYPES[declaration.returns].c;
  const parameters = declaration.parameters.map((parameter) => `${ABI_TYPES[parameter.type].c} ${parameter.name}`).join(", ");
  const argumentsList = declaration.parameters.map(({ name: parameterName }) => parameterName).join(", ");
  const call = `${declaration.name}(${argumentsList})`;
  let body;
  if (declaration.returns === "void") body = `    ${call};`;
  else if (declaration.returns === "bool") body = `    return ${call} ? UINT8_C(1) : UINT8_C(0);`;
  else body = `    return ${call};`;
  return `${returnType} ${name}(${parameters || "void"})\n{\n${body}\n}`;
}

function renderHeader(entries) {
  const declarations = entries.map((entry) => abiDeclaration(entry.declaration, entry.wrapper)).join("\n");
  return `// Generated by scripts/generate-dmsdk-scalar-thunks.mjs. Do not edit.\n#ifndef DEFOLD_HERMES_GENERATED_DMSDK_SCALAR_H\n#define DEFOLD_HERMES_GENERATED_DMSDK_SCALAR_H\n\n#include <stdint.h>\n\n#ifdef __cplusplus\nextern \"C\" {\n#endif\n\n${declarations}\n\n#ifdef __cplusplus\n} // extern \"C\"\n#endif\n\n#endif // DEFOLD_HERMES_GENERATED_DMSDK_SCALAR_H\n`;
}

function renderSource(moduleName, module, entries) {
  const definitions = entries.map((entry) => abiDefinition(entry.declaration, entry.wrapper)).join("\n\n");
  const nativeInclude = entries.length > 0
    ? `#ifndef DLIB_LOG_DOMAIN\n#define DLIB_LOG_DOMAIN \"defold_hermes\"\n#endif\n#include <${module.include}>\n`
    : "";
  return `// Generated by scripts/generate-dmsdk-scalar-thunks.mjs. Do not edit.\n#include <defold_hermes/generated_dmsdk_scalar.h>\n${nativeInclude}\nextern \"C\" {\n\n${definitions}\n\n} // extern \"C\"\n`;
}

function stage(status, evidence, note = undefined) {
  return { status, evidence, ...(note ? { note } : {}) };
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function writeOrCheck(outRoot, relativePath, content, check) {
  const path = resolve(outRoot, relativePath);
  if (check) {
    const existing = await readFile(path, "utf8");
    if (existing !== content) throw new Error(`${relativePath} is stale; regenerate dmSDK scalar thunks`);
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

export async function build() {
  const ir = JSON.parse(await readFile(resolve(repositoryRoot, "bindings/generated/defold-sdk-ir.json"), "utf8"));
  const patterns = JSON.parse(await readFile(resolve(repositoryRoot, "bindings/generated/defold-dmsdk-binding-patterns.json"), "utf8"));
  const scalarIds = new Set(patterns.bindings.filter(({ primaryFamily }) => primaryFamily === "scalar-direct").map(({ id }) => id));
  const declarations = ir.declarations
    .filter(({ id }) => scalarIds.has(id))
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  if (declarations.length !== 31) throw new Error(`Expected the reviewed scalar-direct frontier to contain 31 declarations, got ${declarations.length}`);

  const emitted = [];
  const reportEntries = [];
  const seenWrappers = new Set();
  for (const declaration of declarations) {
    const headerContent = await readFile(resolve(repositoryRoot, declaration.header), "utf8");
    const declarationMatch = declarationEvidence(headerContent, declaration);
    const headerEvidence = {
      path: declaration.header,
      irDocumentationLine: declaration.line,
      declarationLine: declarationMatch.line,
      declarationText: declarationMatch.text,
      sha256: sha256(headerContent),
    };
    const definitions = [];
    for (const [path, needle] of DEFINITION_SPECS[declaration.name] ?? []) {
      definitions.push(await sourceEvidence(path, needle));
    }

    const blocked = BLOCKED_HEADERS[declaration.header];
    if (blocked) {
      if (!headerContent.includes(`#include <${blocked.missingDependency}>`)) {
        throw new Error(`Blocked dependency evidence disappeared from ${declaration.header}: ${blocked.missingDependency}`);
      }
      if (await pathExists(resolve(repositoryRoot, blocked.checkedPath))) {
        throw new Error(`Blocked dependency is now present and must be re-evaluated: ${blocked.checkedPath}`);
      }
      reportEntries.push({
        id: declaration.id,
        symbol: declaration.name,
        nativeSignature: declaration.type,
        headerEvidence,
        definitionEvidence: definitions,
        emitted: false,
        blocker: blocked,
        stages: {
          generated: stage("blocked", declaration.header, blocked.blocker),
          compiled: stage("blocked-on-generation", declaration.header),
          linked: stage("blocked-on-generation", declaration.header),
          conformant: stage("blocked-on-generation", declaration.header),
        },
      });
      continue;
    }

    const policyBlock = BLOCKED_SYMBOLS[declaration.name];
    if (policyBlock) {
      reportEntries.push({
        id: declaration.id,
        symbol: declaration.name,
        nativeSignature: declaration.type,
        headerEvidence,
        definitionEvidence: definitions,
        emitted: false,
        blocker: policyBlock,
        stages: {
          generated: stage("blocked-by-policy", declaration.header, policyBlock.blocker),
          compiled: stage("blocked-on-generation", declaration.header),
          linked: stage("blocked-on-generation", declaration.header),
          conformant: stage("blocked-on-generation", declaration.header),
        },
      });
      continue;
    }

    const allTypes = [declaration.returns, ...declaration.parameters.map(({ type }) => type)];
    const unsupported = allTypes.filter((type) => !ABI_TYPES[type]);
    if (unsupported.length > 0) throw new Error(`Unsupported scalar ABI type(s) for ${declaration.id}: ${unsupported.join(", ")}`);
    const moduleName = moduleForHeader(declaration.header);
    if (!moduleName) throw new Error(`No reviewed scalar module for ${declaration.header}`);
    const module = MODULES[moduleName];
    const wrapper = wrapperName(declaration);
    if (seenWrappers.has(wrapper)) throw new Error(`C ABI wrapper collision: ${wrapper}`);
    seenWrappers.add(wrapper);
    const artifact = `defold/defold_hermes/src/generated_dmsdk_scalar_${moduleName}.cpp`;
    const entry = { declaration, moduleName, wrapper, artifact };
    emitted.push(entry);
    reportEntries.push({
      id: declaration.id,
      symbol: declaration.name,
      nativeSignature: declaration.type,
      wrapper,
      cAbiSignature: abiDeclaration(declaration, wrapper),
      module: moduleName,
      headerEvidence,
      definitionEvidence: definitions.length > 0 ? definitions : [headerEvidence],
      emitted: true,
      policy: {
        boolRepresentation: declaration.returns === "bool" ? "uint8_t canonicalized to 0 or 1" : "not-applicable",
        uint64Representation: allTypes.includes("uint64_t") ? "fixed-width C ABI; JavaScript adapters must preserve all 64 bits (BigInt or split words)" : "not-applicable",
        lifecycleSensitive: /(?:Finalize|Initialize)$/.test(declaration.name),
        mayBlock: declaration.name === "dmTime::Sleep",
      },
      stages: {
        generated: stage("complete", artifact, `C ABI declaration is in defold/defold_hermes/include/defold_hermes/generated_dmsdk_scalar.h`),
        compiled: stage("covered-by-reproducible-test", "tests/dmsdk-scalar-thunks.test.mjs: strict object compilation of every emitted module"),
        linked: module.linkTest
          ? stage("covered-by-host-source-link-test", "native/dmsdk_scalar_thunks_test.cpp", "Links selected pinned Defold implementation sources, not packaged Defold engine libraries or every target.")
          : stage("not-yet-tested", artifact, "Requires the corresponding packaged Defold native library and engine lifecycle."),
        conformant: module.conformanceTest
          ? stage("covered-by-host-behavior-test", "native/dmsdk_scalar_thunks_test.cpp", "Behavior is checked on the host against the pinned source implementation; cross-target conformance remains open.")
          : stage("not-yet-tested", artifact, "The thunk is syntax-compiled only; runtime behavior is not claimed."),
      },
    });
  }

  const artifacts = new Map();
  artifacts.set("defold/defold_hermes/include/defold_hermes/generated_dmsdk_scalar.h", renderHeader(emitted));
  for (const [moduleName, module] of Object.entries(MODULES)) {
    const entries = emitted.filter((entry) => entry.moduleName === moduleName);
    artifacts.set(`defold/defold_hermes/src/generated_dmsdk_scalar_${moduleName}.cpp`, renderSource(moduleName, module, entries));
  }

  const report = {
    schemaVersion: 1,
    defoldRevision: ir.defoldRevision,
    sourceIr: "bindings/generated/defold-sdk-ir.json",
    sourceClassification: "bindings/generated/defold-dmsdk-binding-patterns.json",
    scope: "The 31 declarations classified as primary scalar-direct. Stage counts describe this generated family only, not overall dmSDK coverage.",
    abiPolicy: {
      linkage: "extern C",
      integerWidths: "stdint fixed-width types",
      boolean: "uint8_t, canonical 0 or 1",
      allocation: "thunks are direct calls and contain no allocation or ownership transfer",
      exceptions: "no exception translation; reviewed declarations are non-throwing Defold C/C++ APIs by contract, but the C++ type system does not encode noexcept",
    },
    coverage: {
      reviewed: reportEntries.length,
      generated: reportEntries.filter(({ emitted: value }) => value).length,
      objectCompileCovered: reportEntries.filter(({ emitted: value }) => value).length,
      hostSourceLinkCovered: reportEntries.filter(({ stages }) => stages.linked.status === "covered-by-host-source-link-test").length,
      hostBehaviorCovered: reportEntries.filter(({ stages }) => stages.conformant.status === "covered-by-host-behavior-test").length,
      blocked: reportEntries.filter(({ emitted: value }) => !value).length,
      policyBlocked: reportEntries.filter(({ blocker }) => blocker?.policy === "lifecycle-capability-required").length,
      sourceBlocked: reportEntries.filter(({ blocker }) => blocker?.missingDependency).length,
      packagedLibraryLinked: 0,
      allTargetConformant: 0,
    },
    artifacts: [...artifacts.keys()].sort(),
    declarations: reportEntries,
  };
  artifacts.set("bindings/generated/defold-dmsdk-scalar-thunks.json", `${JSON.stringify(report, null, 2)}\n`);
  return { artifacts, report };
}

export async function run(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const { artifacts, report } = await build();
  for (const [relativePath, content] of artifacts) await writeOrCheck(options.outRoot, relativePath, content, options.check);
  process.stdout.write(`${options.check ? "Verified" : "Generated"} ${report.coverage.generated}/${report.coverage.reviewed} scalar dmSDK thunks; ${report.coverage.blocked} explicitly blocked.\n`);
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await run();
