// The layered API policy artifact: one Defold revision's source-derived surface.
// stored as content-addressed per-namespace subtrees.
//
// See `.agents/docs/decisions/layered-api-policy-cache.md`. Three properties are
// load-bearing here and every function in this file exists to hold one of them:
//
//   * **The policy is a function of the engine's declaration inputs, never of
//     the version string.** Nothing in a policy object may carry the Defold
//     revision, the channel it came from, a timestamp, or a whole-artifact
//     evidence digest computed over bytes that themselves carry the revision.
//     Two revisions with an identical declared surface must hash identically,
//     because that is what makes "unchanged inputs publish nothing" true rather
//     than aspirational. `assertNoRevisionLeak` enforces it.
//
//   * **The root hashes subtrees, not a blob.** If only `gui` moved between two
//     revisions, only `gui`'s subtree hash and the root differ; every other
//     subtree is the same object at the same URL and is therefore already in the
//     caller's cache. A single-file policy would share nothing and force an
//     explicit delta format later to recover what structure gives for free.
//
//   * **Objects are self-verifying.** The path is the hash of the exact bytes,
//     so a consumer fetches `/v1/object/<hash>.json`, hashes what it received
//     and compares. Only the index - the mutable sha-to-root mapping - needs
//     trust, which is why the index is small enough to ship in the package.
//
// Hash choice follows the boundary the decision draws: these hashes are claims a
// third party checks, so they are SHA-256. Murmur2-64A stays on the other side
// of that boundary, where a hash only decides whether to redo work.

import { createHash } from "node:crypto";

export const POLICY_SCHEMA_VERSION = 1;

// Capabilities are stable identifiers for package-owned realization algorithms.
// A policy names the capabilities its source-derived data requires; adding a new
// Defold revision does not require a package release unless that revision needs
// a realization construct the installed package does not implement.
export const POLICY_REALIZER_CAPABILITY_REGISTRY = Object.freeze({
  "policy.content-addressed-graph.v1": Object.freeze({ introducedInVersion: "0.0.0" }),
  "policy.compiler-surface.references.v1": Object.freeze({ introducedInVersion: "0.0.0" }),
  "policy.compiler-document.copy-json.v1": Object.freeze({ introducedInVersion: "0.0.0" }),
  "policy.compiler-document.defold-value-layouts.v1": Object.freeze({ introducedInVersion: "0.0.0" }),
  "policy.compiler-document.dmsdk-universal.v1": Object.freeze({ introducedInVersion: "0.0.0" }),
  "sdk.compatibility-source.copy.v1": Object.freeze({ introducedInVersion: "0.0.0" }),
  "sdk.dmsdk.index.render.v1": Object.freeze({ introducedInVersion: "0.0.0" }),
  "sdk.dmsdk.browser-arena.render.v1": Object.freeze({ introducedInVersion: "0.0.0" }),
  "sdk.dmsdk.scalar.render.v1": Object.freeze({ introducedInVersion: "0.0.0" }),
  "sdk.dmsdk.runtime.render.v1": Object.freeze({ introducedInVersion: "0.0.0" }),
  "sdk.dmsdk.types.render.v1": Object.freeze({ introducedInVersion: "0.0.0" }),
  "sdk.dmsdk.universal.render.v1": Object.freeze({ introducedInVersion: "0.0.0" }),
  "sdk.script.handle-lowering.render.v1": Object.freeze({ introducedInVersion: "0.0.0" }),
  "sdk.script.browser-target-support.render.v1": Object.freeze({ introducedInVersion: "0.0.0" }),
  "sdk.script.index.render.v1": Object.freeze({ introducedInVersion: "0.0.0" }),
  "sdk.script.modules.render.v1": Object.freeze({ introducedInVersion: "0.0.0" }),
  "sdk.script.runtime.render.v1": Object.freeze({ introducedInVersion: "0.0.0" }),
  "sdk.script.types.render.v1": Object.freeze({ introducedInVersion: "0.0.0" }),
  "sdk.script.universal-value.render.v1": Object.freeze({ introducedInVersion: "0.0.0" }),
  "binding.raw-unverified-fallback.v1": Object.freeze({ introducedInVersion: "0.0.0" })
});
export const POLICY_REALIZER_CAPABILITIES = Object.freeze(Object.keys(POLICY_REALIZER_CAPABILITY_REGISTRY).sort());

function versionTuple(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(version);
  if (!match) throw new Error(`Capability introducedInVersion is not a stable semantic version: ${version}`);
  return match.slice(1).map(Number);
}

function laterVersion(left, right) {
  const a = versionTuple(left);
  const b = versionTuple(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? left : right;
  }
  return left;
}

/** Derive only the package-owned algorithms this policy payload actually uses. */
export function buildPolicyRealizer({ compilerSurface, capabilityRegistry = POLICY_REALIZER_CAPABILITY_REGISTRY }) {
  const required = new Set(["policy.content-addressed-graph.v1"]);
  if (compilerSurface) {
    required.add("policy.compiler-surface.references.v1");
    const recipes = compilerSurface.realizationRecipes;
    if (!recipes || typeof recipes !== "object") throw new Error("Compiler surface has no explicit realization recipes");
    for (const section of ["documents", "sdk"]) {
      const values = compilerSurface[section] ?? {};
      const selected = recipes[section] ?? {};
      for (const name of Object.keys(values)) {
        const capability = selected[name];
        if (typeof capability !== "string" || capability.length === 0) {
          throw new Error(`${section}.${name}: no explicit policy realization recipe selected`);
        }
        required.add(capability);
      }
      const stale = Object.keys(selected).filter((name) => !(name in values));
      if (stale.length) throw new Error(`${section}: realization recipes name absent values: ${stale.join(", ")}`);
    }
  }
  const requiredCapabilities = [...required].sort();
  const minimumPackageVersion = requiredCapabilities
    .map((capability) => {
      const metadata = capabilityRegistry[capability];
      if (!metadata) throw new Error(`Policy realization capability ${capability} has no registry entry`);
      return metadata.introducedInVersion;
    })
    .reduce(laterVersion);
  return { minimumPackageVersion, requiredCapabilities };
}

// Subtree keys are Lua module namespaces. A Lua identifier cannot contain `@`,
// so the prefix partitions reserved cross-cutting subtrees off from namespaces
// with no possibility of collision.
export const RESERVED_SUBTREE_PREFIX = "@";
export const TOOLCHAIN_SUBTREE = "@toolchain";
export const SHARED_SUBTREE = "@shared";
export const PROFILES_SUBTREE = "@profiles";
export const COMPILER_SUBTREE = "@compiler";
export const COMPILER_DOCUMENT_SUBTREE_PREFIX = "@compiler:document:";
export const COMPILER_SDK_SUBTREE_PREFIX = "@compiler:sdk:";
export const DEFOLD_REVISION_TOKEN = "${DEFOLD_REVISION}";

// Type names in the script IR are written in one of these declaration
// namespaces before the module they belong to. `defold_api.gui` and
// `defold_enum.gui.ADJUST` are both `gui`; stripping the prefix is what keeps a
// gui-only change inside gui's subtree instead of moving a shared enum blob.
const TYPE_NAME_PREFIXES = Object.freeze(["defold_api.", "defold_enum.", "message."]);

// The registration parser marks a Lua name registered outside any module with
// `<globals>`, which is a parser marker and not a namespace - it is not even a
// legal Lua identifier. Its rows go to the shared subtree rather than inventing
// a namespace key that no consumer could ask for by name. `_G` is different and
// stays a namespace of its own: the global table is a real, stable scope that
// the base library registers into.
const NON_MODULE_REGISTRATION_SCOPES = Object.freeze(new Set(["<globals>", ""]));

/** Recursively key-sorted copy, so serialization depends on content alone. */
export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

/**
 * The exact bytes an object is stored and served as.
 *
 * Compact and newline-free on purpose: the file content is the canonical JSON
 * and nothing else, so `sha256(bytes) === <hash in the path>` holds for a
 * consumer that never parses the body.
 */
export function serializeObject(value) {
  return JSON.stringify(canonicalize(value));
}

export function hashBytes(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Serialize once, hash the result; never hash a re-serialization. */
export function sealObject(value) {
  const bytes = serializeObject(value);
  return { bytes, hash: hashBytes(bytes) };
}

/** The namespace a script route belongs to: the first Lua module segment. */
export function scriptNamespaceOfModulePath(modulePath) {
  const segments = Array.isArray(modulePath) ? modulePath : String(modulePath ?? "").split(".");
  const head = segments.filter((segment) => segment.length > 0)[0];
  return head ?? SHARED_SUBTREE;
}

/**
 * The namespace a declared type belongs to.
 *
 * A type is attributed to a module only when the module actually exists in the
 * registered surface. `hash`, `url`, `vector3` and the lifecycle callback shapes
 * belong to no module and go to the shared subtree rather than inventing one -
 * a namespace that exists only because a type was misfiled would be a namespace
 * two revisions could not share.
 */
export function scriptNamespaceOfTypeName(name, moduleNamespaces) {
  let rest = String(name ?? "");
  for (const prefix of TYPE_NAME_PREFIXES) {
    if (rest.startsWith(prefix)) {
      rest = rest.slice(prefix.length);
      break;
    }
  }
  const head = rest.split(".")[0];
  return moduleNamespaces.has(head) ? head : SHARED_SUBTREE;
}

/**
 * The namespace a dmSDK declaration belongs to: the directory under `dmsdk/`
 * that its public header lives in. That is the engine's own grouping, not ours,
 * and it is the only grouping a consumer can rederive from the header path.
 */
export function dmsdkNamespaceOfHeader(header) {
  const match = /(?:^|\/)dmsdk\/([^/]+)\//.exec(String(header ?? ""));
  return match ? match[1] : null;
}

/**
 * Strip an absolute checkout prefix from a value that should be repo-relative.
 *
 * The dmSDK IR records anonymous-record names using the absolute path clang was
 * given, which makes those strings a function of where the repository happens to
 * be cloned. A policy carrying them would hash differently on two machines
 * deriving the same revision, so they are normalized here and the generator
 * refuses any that survive.
 */
export function normalizePaths(value, repositoryRoot) {
  const prefix = repositoryRoot.endsWith("/") ? repositoryRoot : `${repositoryRoot}/`;
  if (typeof value === "string") return value.split(prefix).join("");
  if (Array.isArray(value)) return value.map((entry) => normalizePaths(entry, repositoryRoot));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalizePaths(entry, repositoryRoot)]));
  }
  return value;
}

/**
 * Replace the revision in compiler IR with a stable token before sealing it.
 * The index owns the revision; the compiler subtree owns the semantic program
 * that a client materializes after resolving that index entry.
 */
export function abstractDefoldRevision(value, revision) {
  if (typeof value === "string") return value.split(revision).join(DEFOLD_REVISION_TOKEN);
  if (Array.isArray(value)) return value.map((entry) => abstractDefoldRevision(entry, revision));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, abstractDefoldRevision(entry, revision)]));
  }
  return value;
}

/** Restore the exact revision only after a content-addressed policy resolves. */
export function restoreDefoldRevision(value, revision) {
  if (typeof value === "string") return value.split(DEFOLD_REVISION_TOKEN).join(revision);
  if (Array.isArray(value)) return value.map((entry) => restoreDefoldRevision(entry, revision));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, restoreDefoldRevision(entry, revision)]));
  }
  return value;
}

function sortBy(rows, key) {
  return [...rows].sort((left, right) => {
    const a = key(left);
    const b = key(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

function bucket(map, namespace) {
  if (!map.has(namespace)) map.set(namespace, {});
  return map.get(namespace);
}

function section(namespaceBucket, name, factory) {
  if (!namespaceBucket[name]) namespaceBucket[name] = factory();
  return namespaceBucket[name];
}

/**
 * Build the per-namespace policy subtrees, the root that names them, and the
 * exact bytes of every object.
 *
 * Every input is already-derived state: the script API IR, the dmSDK IR, the
 * source-derived Lua registration surface, the route availability profiles, the
 * resource declaration schema, and the engine's own toolchain pins. This
 * function derives nothing new from source - it decides what belongs to which
 * subtree and seals the result.
 */
export function buildPolicy(inputs) {
  const {
    scriptIr,
    dmsdkIr,
    registrationSurface,
    routeProfiles,
    resourceSchema,
    toolchain,
    compilerSurface,
    generator,
    repositoryRoot = ""
  } = inputs;

  const realizer = buildPolicyRealizer({ compilerSurface });

  const namespaces = new Map();
  const shared = bucket(namespaces, SHARED_SUBTREE);

  // ── Script API surface ────────────────────────────────────────────────────
  const moduleNamespaces = new Set();
  for (const fn of scriptIr.functions) moduleNamespaces.add(scriptNamespaceOfModulePath(fn.modulePath));

  for (const fn of scriptIr.functions) {
    const namespace = scriptNamespaceOfModulePath(fn.modulePath);
    const script = section(bucket(namespaces, namespace), "script", () => ({ functions: [], types: [] }));
    script.functions.push(fn);
  }
  for (const type of scriptIr.types) {
    const namespace = scriptNamespaceOfTypeName(type.name, moduleNamespaces);
    const script = section(bucket(namespaces, namespace), "script", () => ({ functions: [], types: [] }));
    script.types.push(type);
  }

  // ── dmSDK declarations ────────────────────────────────────────────────────
  const dmsdkBlockers = [];
  for (const declaration of dmsdkIr.declarations) {
    const namespace = dmsdkNamespaceOfHeader(declaration.header);
    if (!namespace) {
      // Fail closed: a declaration whose public header is not under `dmsdk/`
      // cannot be attributed to a namespace, and guessing one would put it in a
      // subtree two revisions could not meaningfully share.
      dmsdkBlockers.push({ code: "dmsdk-declaration-without-namespace", id: declaration.id, header: declaration.header });
      continue;
    }
    const dmsdk = section(bucket(namespaces, namespace), "dmsdk", () => ({ declarations: [] }));
    dmsdk.declarations.push(declaration);
  }
  if (dmsdkBlockers.length) {
    const error = new Error(`${dmsdkBlockers.length} dmSDK declarations carry no dmsdk/<namespace>/ header`);
    error.blockers = dmsdkBlockers;
    throw error;
  }
  shared.dmsdk = {
    // What the declaration surface was PARSED under, not a platform this policy
    // is for. The field used to be `platform: "arm64-macos"` - the deriving
    // host's label, copied into every published policy - so a consumer could
    // read it as "this policy describes macOS". It describes the whole declared
    // target set; which target gets which declaration is a separate answer.
    parseEnvironment: dmsdkIr.parseEnvironment,
    opaqueTypes: normalizePaths(dmsdkIr.opaqueTypes ?? [], repositoryRoot),
    unresolvedTypes: normalizePaths(dmsdkIr.unresolvedTypes ?? [], repositoryRoot)
  };
  shared.script = section(shared, "script", () => ({ functions: [], types: [] }));
  shared.script.unresolvedTypes = scriptIr.unresolvedTypes ?? [];

  // ── Source-derived Lua registration, including every refusal ──────────────
  //
  // Only engine targets belong in a Defold revision's policy. An extension's
  // registration is a layer-1/layer-2 policy keyed by that extension's own
  // content hash, and folding it in here would make the engine policy a
  // function of which extensions this checkout happened to have.
  const engineTargets = sortBy(
    Object.values(registrationSurface.targets).filter((target) => target.kind === "engine-tree"),
    (target) => target.id
  );
  for (const target of engineTargets) {
    const perNamespace = new Map();
    const take = (namespace, field) => {
      if (!perNamespace.has(namespace)) {
        perNamespace.set(namespace, {
          routes: [],
          declaredButUnregistered: [],
          registeredButUndeclared: [],
          registeredConstants: [],
          commentedOutRegistrations: [],
          modules: {}
        });
      }
      return perNamespace.get(namespace)[field];
    };
    const moduleOf = (row) => {
      const namespace = scriptNamespaceOfModulePath(row.module ?? "");
      return NON_MODULE_REGISTRATION_SCOPES.has(namespace) ? SHARED_SUBTREE : namespace;
    };
    for (const route of target.routes) take(moduleOf(route), "routes").push(route);
    for (const row of target.declaredButUnregistered) take(moduleOf(row), "declaredButUnregistered").push(row);
    for (const row of target.registeredButUndeclared) take(moduleOf(row), "registeredButUndeclared").push(row);
    for (const row of target.registeredConstants) take(moduleOf(row), "registeredConstants").push(row);
    for (const row of target.commentedOutRegistrations ?? []) take(moduleOf(row), "commentedOutRegistrations").push(row);
    for (const [module, stats] of Object.entries(target.namespaces ?? {})) {
      const namespace = moduleOf({ module });
      if (!perNamespace.has(namespace)) take(namespace, "routes");
      perNamespace.get(namespace).modules[module] = stats;
    }
    for (const [namespace, payload] of perNamespace) {
      const registration = section(bucket(namespaces, namespace), "registration", () => ({}));
      registration[target.id] = {
        routes: sortBy(payload.routes, (row) => row.name),
        declaredButUnregistered: sortBy(payload.declaredButUnregistered, (row) => row.name),
        registeredButUndeclared: sortBy(payload.registeredButUndeclared, (row) => row.name),
        registeredConstants: sortBy(payload.registeredConstants, (row) => `${row.module}.${row.member}`),
        commentedOutRegistrations: sortBy(payload.commentedOutRegistrations, (row) => row.name ?? ""),
        modules: payload.modules
      };
    }
    // Blockers are sites in C that the parser refused, so they are attributed to
    // a file rather than to a namespace. They are the queue of real parser work
    // and the reason a later generation does not guess, so they are carried
    // whole rather than dropped for not fitting the namespace split.
    shared.registration = shared.registration ?? {};
    shared.registration[target.id] = {
      kind: target.kind,
      status: target.status,
      inputs: { root: target.inputs.root, variantExclusions: target.inputs.variantExclusions ?? [] },
      summary: target.summary,
      blockerHistogram: target.blockerHistogram,
      blockers: target.blockers ?? [],
      diagnostics: target.diagnostics ?? [],
      policyNotes: target.policyNotes ?? [],
      registrationEntryPoints: target.registrationEntryPoints ?? []
    };
  }
  shared.registration = shared.registration ?? {};
  shared.registrationContract = registrationSurface.contract;

  // ── Route availability per build profile ──────────────────────────────────
  //
  // A profile is a cross-namespace object - it names an app manifest and the
  // feature set that manifest links - so the profile definitions live in their
  // own reserved subtree and each namespace carries only the availability of
  // its own routes under each profile.
  const profileDefinitions = {};
  for (const [name, profile] of Object.entries(routeProfiles.profiles)) {
    // The runtime handshake's `defoldRevision` and `catalogSha256` are keyed to
    // the revision, so carrying them would make an otherwise identical surface
    // hash differently per revision. They are reconstituted at resolution time
    // instead: the consumer already knows the revision, because looking it up in
    // the index is how it reached this policy at all, and `catalogRecipe` below
    // says exactly how to rebuild the catalog digest around it.
    const { defoldRevision: _revision, catalogSha256: _catalog, ...handshake } = profile.runtimeHandshake;
    profileDefinitions[name] = {
      manifest: profile.manifest,
      manifestSha256: profile.manifestSha256,
      features: profile.features,
      runtimeHandshake: handshake,
      boundAtResolution: ["defoldRevision", "catalogSha256"]
    };
    const classify = (rows, state) => {
      for (const row of rows) {
        const namespace = scriptNamespaceOfModulePath(row.rawName);
        const routes = section(bucket(namespaces, namespace), "routeAvailability", () => ({}));
        const perProfile = routes[name] ?? (routes[name] = { available: [], unavailable: [] });
        perProfile[state].push({ id: row.id, stableId: row.stableId, rawName: row.rawName });
      }
    };
    classify(profile.availableRoutes ?? [], "available");
    classify(profile.unavailableRoutes ?? [], "unavailable");
  }
  const featureDefinitions = {};
  for (const [name, feature] of Object.entries(routeProfiles.features)) {
    featureDefinitions[name] = {
      capabilityBit: feature.capabilityBit,
      documentedRouteSetSha256: feature.documentedRouteSetSha256,
      availableRouteSetSha256: feature.availableRouteSetSha256
    };
    for (const row of feature.documentedRoutes ?? []) {
      const namespace = scriptNamespaceOfModulePath(row.rawName);
      const features = section(bucket(namespaces, namespace), "routeFeatures", () => ({}));
      (features[name] ?? (features[name] = [])).push({ id: row.id, stableId: row.stableId, rawName: row.rawName });
    }
  }
  const profiles = {
    schemaVersion: POLICY_SCHEMA_VERSION,
    kind: "deherm.policy.profiles",
    handshakeContract: routeProfiles.handshakeContract,
    // How a consumer rebuilds the revision-keyed catalog digest the runtime
    // handshake fails closed on. Key order is part of the digest, so it is
    // stated rather than implied by this object's own (sorted) key order.
    catalogRecipe: {
      hash: "sha256",
      encoding: "JSON.stringify of an object with keys in the stated order",
      material: ["defoldRevision", "profiles"],
      profileOrder: Object.keys(routeProfiles.profiles),
      profileFields: ["features", "capabilityBits", "routeSetSha256"]
    },
    registrationAudit: routeProfiles.registrationAudit,
    manifestAudit: routeProfiles.manifestAudit,
    handleFeatures: routeProfiles.handleFeatures,
    handleProfiles: routeProfiles.handleProfiles,
    features: featureDefinitions,
    profiles: profileDefinitions
  };

  // ── Resource declaration schema ───────────────────────────────────────────
  //
  // Keyed by the resource extension rather than by a Lua module, so it lands in
  // the shared subtree: a `.collection` declaration namespace is not owned by
  // any one Lua module and attributing it to one would be an invention.
  shared.resources = {
    derivation: resourceSchema.derivation,
    resources: resourceSchema.resources,
    blockers: resourceSchema.blockers
  };

  // ── Seal ──────────────────────────────────────────────────────────────────
  const objects = new Map();
  const seal = (value) => {
    const { bytes, hash } = sealObject(value);
    if (!objects.has(hash)) objects.set(hash, bytes);
    return hash;
  };

  const subtrees = {};
  for (const namespace of [...namespaces.keys()].sort()) {
    const payload = namespaces.get(namespace);
    // Sort every list that a map iteration order could otherwise decide.
    if (payload.script) {
      payload.script.functions = sortBy(payload.script.functions ?? [], (row) => row.id);
      payload.script.types = sortBy(payload.script.types ?? [], (row) => row.name);
    }
    if (payload.dmsdk?.declarations) payload.dmsdk.declarations = sortBy(payload.dmsdk.declarations, (row) => row.id);
    if (payload.routeAvailability) {
      for (const perProfile of Object.values(payload.routeAvailability)) {
        perProfile.available = sortBy(perProfile.available, (row) => row.id);
        perProfile.unavailable = sortBy(perProfile.unavailable, (row) => row.id);
      }
    }
    if (payload.routeFeatures) {
      for (const [name, rows] of Object.entries(payload.routeFeatures)) {
        payload.routeFeatures[name] = sortBy(rows, (row) => row.id);
      }
    }
    subtrees[namespace] = seal({
      schemaVersion: POLICY_SCHEMA_VERSION,
      kind: namespace.startsWith(RESERVED_SUBTREE_PREFIX) ? "deherm.policy.shared" : "deherm.policy.namespace",
      namespace,
      ...payload
    });
  }
  subtrees[PROFILES_SUBTREE] = seal(profiles);
  subtrees[TOOLCHAIN_SUBTREE] = seal({
    schemaVersion: POLICY_SCHEMA_VERSION,
    kind: "deherm.policy.toolchain",
    ...toolchain
  });
  if (compilerSurface) {
    const normalizedDocuments = abstractDefoldRevision(
      normalizePaths(compilerSurface.documents, repositoryRoot), scriptIr.defoldRevision);
    const normalizedSdk = abstractDefoldRevision(
      normalizePaths(compilerSurface.sdk, repositoryRoot), scriptIr.defoldRevision);
    const documentManifest = {};
    for (const [name, value] of Object.entries(normalizedDocuments).sort(([left], [right]) => left < right ? -1 : 1)) {
      const namespace = `${COMPILER_DOCUMENT_SUBTREE_PREFIX}${name}`;
      subtrees[namespace] = seal({
        schemaVersion: POLICY_SCHEMA_VERSION,
        kind: "deherm.policy.compiler-document",
        namespace,
        name,
        value
      });
      documentManifest[name] = {
        object: namespace,
        recipe: compilerSurface.realizationRecipes.documents[name]
      };
    }
    const sdkManifest = {};
    for (const [name, record] of Object.entries(normalizedSdk).sort(([left], [right]) => left < right ? -1 : 1)) {
      if (typeof record.source === "string" && hashBytes(record.source) !== record.sha256) {
        throw new Error(
          `${name}: SDK manifest digest is not over revision-abstracted source bytes; ` +
          "canonicalize Defold revision tokens before hashing"
        );
      }
      const manifestRecord = {
        mode: record.mode,
        sha256: record.sha256,
        recipe: compilerSurface.realizationRecipes.sdk[name],
        inputs: [...(record.inputs ?? [])]
      };
      if (typeof record.source === "string") {
        const namespace = `${COMPILER_SDK_SUBTREE_PREFIX}${name}`;
        subtrees[namespace] = seal({
          schemaVersion: POLICY_SCHEMA_VERSION,
          kind: "deherm.policy.compiler-sdk-source",
          namespace,
          name,
          source: record.source
        });
        manifestRecord.sourceObject = namespace;
      }
      sdkManifest[name] = manifestRecord;
    }
    subtrees[COMPILER_SUBTREE] = seal({
      schemaVersion: POLICY_SCHEMA_VERSION,
      kind: "deherm.policy.compiler-surface",
      namespace: COMPILER_SUBTREE,
      revisionToken: DEFOLD_REVISION_TOKEN,
      manifestVersion: 2,
      documents: {
        schemaVersion: 1,
        kind: "deherm.policy.compiler-document-manifest",
        entries: documentManifest
      },
      sdk: {
        schemaVersion: 1,
        kind: "deherm.policy.sdk-manifest",
        entries: sdkManifest
      },
      realizationRecipes: compilerSurface.realizationRecipes
    });
  }

  const namespaceKeys = Object.keys(subtrees).filter((key) => !key.startsWith(RESERVED_SUBTREE_PREFIX));
  const root = {
    schemaVersion: POLICY_SCHEMA_VERSION,
    kind: "deherm.policy.root",
    hash: "sha256",
    // The generator revision is part of the root, so a policy derived by an
    // older parser hashes differently and is detectably stale rather than
    // quietly trusted. It is deliberately NOT part of a subtree: a parser
    // improvement that changes nothing about `gui` must not move gui's object.
    generator,
    realizer: {
      minimumPackageVersion: realizer.minimumPackageVersion,
      requiredCapabilities: [...realizer.requiredCapabilities]
    },
    subtrees: Object.fromEntries(Object.keys(subtrees).sort().map((key) => [key, subtrees[key]])),
    counts: {
      subtrees: Object.keys(subtrees).length,
      namespaces: namespaceKeys.length
    }
  };
  const sealedRoot = sealObject(root);
  return { root, rootBytes: sealedRoot.bytes, rootHash: sealedRoot.hash, objects, subtrees };
}

/**
 * Refuse a policy that carries anything keyed to the revision rather than to the
 * declared surface.
 *
 * This is the guard that keeps "many shas point at one policy" true. Without it
 * a single `defoldRevision` field copied through from an input artifact would
 * make every revision produce a distinct root, and the storage argument for
 * content addressing would quietly stop holding.
 */
export function assertNoRevisionLeak({ rootBytes, objects, revision }) {
  if (!revision) throw new Error("assertNoRevisionLeak requires the revision it must not find");
  const offenders = [];
  if (rootBytes.includes(revision)) offenders.push("policy root");
  for (const [hash, bytes] of objects) if (bytes.includes(revision)) offenders.push(`object ${hash}`);
  if (offenders.length) {
    throw new Error(
      `Policy content carries the Defold revision (${offenders.join(", ")}). ` +
      "A policy is a function of the declared surface, not of the version string; " +
      "the sha-to-root mapping belongs in the index alone."
    );
  }
}

/** The index entry for one revision: the only mutable, trust-requiring mapping. */
/**
 * One Defold revision's resolution point.
 *
 * An entry is a pure function of the engine revision, and carries no artifact
 * references. Embedding them here was tried and reverted: release tags are a
 * function of the BUILD RECIPE, not of the engine, so a change to a Dockerfile
 * rotated a tag, which drifted the entry, which failed the store check - a
 * build-script edit invalidating the derived API surface of an unrelated engine
 * revision. It also broke the write-once rule the entry's trust argument rests
 * on. The artifact mapping now lives in a sibling document emitted at publish
 * time; see artifactsPath.
 */
export function buildIndexEntry({ defoldRevision, policyRoot, generator, realizer }) {
  if (!realizer || typeof realizer.minimumPackageVersion !== "string" ||
      !Array.isArray(realizer.requiredCapabilities) || realizer.requiredCapabilities.length === 0) {
    throw new Error("Policy index realization requires minimumPackageVersion and requiredCapabilities");
  }
  return {
    schemaVersion: POLICY_SCHEMA_VERSION,
    kind: "deherm.policy.index-entry",
    defoldRevision,
    policyRoot,
    generator,
    realizer: {
      minimumPackageVersion: realizer.minimumPackageVersion,
      requiredCapabilities: [...realizer.requiredCapabilities]
    }
  };
}

/** Object paths, relative to the owned prefix. The schema version is in the path. */
export function objectPath(layoutVersion, hash) {
  return `${layoutVersion}/object/${hash}.json`;
}

export function policyPath(layoutVersion, rootHash) {
  return `${layoutVersion}/policy/${rootHash}.json`;
}

export function indexPath(layoutVersion, revision) {
  return `${layoutVersion}/index/${revision}.json`;
}

/**
 * Where the artifact mapping for a revision is served.
 *
 * Deliberately NOT part of the content-addressed store and never committed: it
 * names the release tags the current build recipe publishes, so it changes when
 * the recipe changes and not when the engine does. Emitting it at publish time
 * keeps the store a pure function of the engine revision, and keeps a change to
 * a build script from invalidating a policy derived months earlier.
 */
export function artifactsPath(layoutVersion, revision) {
  return `${layoutVersion}/artifacts/${revision}.json`;
}

export const ARTIFACTS_DOCUMENT_KIND = "deherm.policy.artifacts";
