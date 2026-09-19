// Contract-level headless conformance planning.
//
// The canonical lowering plan interns 926 script routes down to 82 distinct
// script contracts. Conformance is therefore planned per contract, never per
// route: a contract exercised against the real engine is the tractable unit,
// and route-level scenario authoring is not.
//
// Everything here is derived from the pinned generated IR. There is no route
// allowlist and no per-contract special case: a route becomes a fixture only
// when every predicate below holds structurally, and a contract with no
// eligible route is recorded as an explicit machine-readable blocker rather
// than being skipped.
//
// Two structural mechanisms widen what a fixture can reach:
//
//   * fixture profiles - a profile declares the components its generated
//     collection carries, the engine configuration the driver passes for it,
//     and the script contexts it therefore supplies. A contract is assigned
//     the profile that makes the most of its routes eligible.
//   * handle provenance - the generated borrowed-handle classification
//     partitions every handle route into producers and consumers. A parameter
//     whose type names a borrowed handle kind is satisfied by calling that
//     kind's producer chain against the same live engine, so a consumer route
//     becomes reachable without any hand-authored scenario.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { buildConformancePlan, loadConformanceInputs } from "../../packages/cli/src/conformance.mjs";
import { publicScriptRootName } from "../../packages/compiler/src/script-public-api-policy.mjs";

export const HEADLESS_CONFORMANCE_SCHEMA_VERSION = 2;

/** Deterministic inhabitants for the parameter types the harness can synthesize. */
const SCALAR_INHABITANTS = Object.freeze({
  number: 0,
  integer: 0,
  boolean: false,
  string: "deherm_conformance"
});

/** Raw parameter types that name a component address rather than a plain string. */
const ADDRESS_MEMBERS = Object.freeze(["url"]);

/** Type member that means "this result may be absent"; it never selects a handle kind. */
const ABSENT_MEMBER = "nil";

/**
 * The context every fixture supplies unconditionally. A route needing only
 * this observes nothing but its own arguments, which is what makes it usable
 * as a synthesized value inhabitant.
 */
const AMBIENT_CONTEXT = "engine";

/** An optional parameter a positional call has to pass over, spelled as nil. */
const ABSENT_ARGUMENT = Object.freeze({ kind: "literal", value: null });

/**
 * Parameter names that address an element of a Lua-side collection. Lua is
 * one-based, so zero is never an inhabitant of such a parameter and the scalar
 * inhabitant would be refused by every engine range check.
 */
const ONE_BASED_INDEX_PARAMETER = /(^|_)index$/;

/**
 * How deep a synthesized record may nest before the harness gives up.
 *
 * A declared record whose required fields are themselves inhabitable is an
 * inhabitant like any other; a recursive one fails closed here rather than
 * looping.
 */
const RECORD_SYNTHESIS_DEPTH_LIMIT = 3;

/** Most routes carrying one contract are redundant evidence; exercise a bounded sample. */
export const MAX_EXERCISES_PER_CONTRACT = 16;

/** Repetitions used by the bounded-scratch property. */
export const SCRATCH_REUSE_REPETITIONS = 64;

/** How many producer hops a handle provider chain may take before it fails closed. */
export const PROVIDER_CHAIN_DEPTH_LIMIT = 6;

const SCRATCH_CONTRACT_TOKEN = "caller-owned-bounded-reentrant-scratch";
const ERROR_MODEL_CONTRACT_TOKEN = "status-return-and-target-exception";

// Structural effect guard beyond the shared conformance execution policy. A
// conformance fixture may not persist state outside the engine instance it
// runs in, because the driver reuses one process for every case.
const EXTERNAL_WRITE_LEAF = /^(write|dump)/;

/**
 * Fixture profiles.
 *
 * A profile is a shape of generated collection, not a scenario: it declares
 * what components the single generated game object carries, what engine
 * configuration the driver passes for that case, which script contexts the
 * resulting instance therefore supplies, and which borrowed-handle contexts
 * can be rooted from it. Nothing here names a route or a contract.
 *
 * `physicsBackendPath` is the pinned Defold source directory whose script
 * bindings this profile's physics backend implements. A borrowed handle kind
 * is admissible in a profile only when every source the classification cites
 * for that kind lies under the profile's backend directory, so 2D and 3D
 * handle algebra can never be mixed into one engine instance.
 */
export const FIXTURE_PROFILES = Object.freeze([
  Object.freeze({
    id: "engine",
    summary: "One game object carrying only the generated déherm script component.",
    suppliedContexts: Object.freeze(["engine", "game-object"]),
    handleContexts: Object.freeze(["runtime-global"]),
    physicsBackendPath: null,
    components: Object.freeze([]),
    componentAddresses: Object.freeze([]),
    engineConfig: Object.freeze([])
  }),
  Object.freeze({
    id: "physics-2d",
    summary: "One game object carrying the déherm script and a dynamic box collision object, with the Box2D backend selected.",
    suppliedContexts: Object.freeze(["engine", "game-object"]),
    handleContexts: Object.freeze(["runtime-global", "game-object-instance", "explicit-physics-handle"]),
    physicsBackendPath: "/gamesys/scripts/box2d/",
    components: Object.freeze(["collisionobject"]),
    componentAddresses: Object.freeze(["#physics", "/probe_b#physics"]),
    engineConfig: Object.freeze(["physics.type=2D"])
  }),
  Object.freeze({
    id: "physics-3d",
    summary: "One game object carrying the déherm script and a dynamic box collision object, with the Bullet backend selected.",
    suppliedContexts: Object.freeze(["engine", "game-object"]),
    handleContexts: Object.freeze(["runtime-global", "game-object-instance", "explicit-physics-handle"]),
    physicsBackendPath: "/gamesys/scripts/bullet3d/",
    components: Object.freeze(["collisionobject"]),
    componentAddresses: Object.freeze(["#physics", "/probe_b#physics"]),
    engineConfig: Object.freeze(["physics.type=3D"])
  })
]);

export const DEFAULT_FIXTURE_PROFILE = FIXTURE_PROFILES[0];

/** Contexts this harness can supply, across every profile. */
export const SUPPLIED_CONTEXTS = Object.freeze(
  [...new Set(FIXTURE_PROFILES.flatMap((profile) => profile.suppliedContexts))].sort()
);

/**
 * Contexts no generated fixture can supply, and the exact obstacle for each.
 *
 * These are recorded so `context-fixture-missing` never reads as "somebody
 * should write a fixture": for two of them no fixture is sufficient, because
 * déherm's bootstrap attachment itself only accepts a game-object instance.
 */
export const UNSUPPLIED_CONTEXTS = Object.freeze([
  Object.freeze({
    context: "gui-scene",
    obstacle: "bootstrap-attachment-requires-game-object-instance",
    evidence: "defold/defold_hermes/src/extension.cpp AttachLuaInstance calls dmScript::CheckGOInstance, " +
      "so a .gui_script instance cannot attach the déherm runtime",
    unblockedBy: "component-proxy gui-script attachment (.gui.ts transport)"
  }),
  Object.freeze({
    context: "render-script",
    obstacle: "bootstrap-attachment-requires-game-object-instance",
    evidence: "defold/defold_hermes/src/extension.cpp AttachLuaInstance calls dmScript::CheckGOInstance, " +
      "so a .render_script instance cannot attach the déherm runtime",
    unblockedBy: "a render-script attachment lane"
  }),
  Object.freeze({
    context: "window",
    obstacle: "headless-variant-selects-the-null-window-backend",
    evidence: "engine/platform/src/platform_window_null.cpp is what the headless appmanifest links",
    unblockedBy: "a windowed packaged-engine lane, which is not this instrument"
  }),
  Object.freeze({
    context: "network",
    obstacle: "hermetic-run-has-no-live-socket",
    evidence: "the driver runs offline and must stay deterministic",
    unblockedBy: "a loopback server fixture owned by the driver"
  }),
  Object.freeze({
    context: "browser",
    obstacle: "target-is-arm64-macos-not-js-web",
    evidence: "html5 script routes require target js-web",
    unblockedBy: "the browser/wasm conformance lane"
  })
]);

const INPUT_PATHS = Object.freeze({
  loweringPlan: "packages/bindings/generated/defold-binding-lowering-plan.json",
  scriptIr: "packages/bindings/generated/defold-script-api-ir.json",
  universalValueBindings: "packages/bindings/generated/defold-script-universal-value-bindings.json",
  scalarDispatch: "packages/bindings/generated/defold-script-scalar-dispatch.json",
  borrowedHandles: "packages/bindings/generated/defold-script-borrowed-handle-classification.json",
  routeAvailability: "packages/bindings/generated/defold-script-route-availability-profiles.json",
  handleLowering: "packages/bindings/generated/defold-script-handle-lowering.json",
  valueLayouts: "packages/bindings/generated/defold-value-layouts.json",
  projection: "packages/bindings/generated/defold-script-projection-ir.json"
});

/**
 * The Defold runtime profile the headless driver's engine actually presents.
 *
 * The driver links the pinned SDK archives the `headless` appmanifest selects,
 * which carry Box2D v2 and Bullet. déherm detects the profile at runtime from
 * the registered Lua symbols; `scripts/check-headless-conformance.mjs` asserts
 * that the detected profile equals this one, so a plan can never claim a route
 * the linked engine does not register.
 */
export const HEADLESS_RUNTIME_PROFILE = "default-legacy-bullet";

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function typeMembers(rawType) {
  return String(rawType).split("|").map((member) => member.trim()).filter((member) => member.length > 0);
}

/**
 * Route availability under one runtime profile.
 *
 * `catalog` is every route any profile documents. A route inside the catalog
 * but outside the active profile's available set does not exist in the engine
 * the driver links, so exercising it would record an exception that says
 * nothing about the route's contract.
 */
export function buildRouteAvailability(document, runtimeProfile) {
  const profiles = document?.profiles ?? {};
  const active = profiles[runtimeProfile];
  if (!active) {
    throw new Error(`Unknown Defold runtime profile ${runtimeProfile}; known: ${Object.keys(profiles).join(", ")}`);
  }
  const catalog = new Set();
  for (const profile of Object.values(profiles)) {
    for (const route of profile.documentedRoutes ?? []) catalog.add(route.id ?? route);
  }
  const available = new Set((active.availableRoutes ?? []).map((route) => route.id ?? route));
  return { runtimeProfile, features: [...(active.features ?? [])], catalog, available };
}

const EMPTY_AVAILABILITY = Object.freeze({
  runtimeProfile: null,
  features: [],
  catalog: new Set(),
  available: new Set()
});

/**
 * The handle algebra a profile can root, derived from the generated
 * borrowed-handle classification rather than from any name list here.
 */
export function buildHandleAlgebra(classification) {
  const sourcePathById = new Map((classification?.inputEvidence?.defoldSources ?? []).map((item) => [item.id, item.path]));
  const backendByKind = new Map();
  const kindByRawType = new Map();
  for (const kind of classification?.handleKinds ?? []) {
    for (const rawType of kind.rawTypes ?? []) kindByRawType.set(rawType, kind.id);
    const paths = (kind.sourceEvidence ?? []).map((id) => sourcePathById.get(id) ?? "");
    const backends = new Set();
    for (const profile of FIXTURE_PROFILES) {
      if (profile.physicsBackendPath === null) continue;
      if (paths.length > 0 && paths.every((path) => path.includes(profile.physicsBackendPath))) {
        backends.add(profile.physicsBackendPath);
      }
    }
    backendByKind.set(kind.id, backends.size === 1 ? [...backends][0] : null);
  }
  const rowsById = new Map((classification?.rows ?? []).map((row) => [row.id, row]));
  return { backendByKind, kindByRawType, rowsById };
}

function kindAdmissible(profile, algebra, kindId) {
  const backend = algebra.backendByKind.get(kindId) ?? null;
  if (backend === null) return true;
  return profile.physicsBackendPath === backend;
}

/**
 * Synthesize one argument for one parameter.
 *
 * Order matters and is structural: a parameter naming a borrowed handle kind
 * with a live producer chain is satisfied by that chain, a parameter naming a
 * component address is satisfied by the profile's published address, and
 * anything else falls back to the scalar inhabitants.
 */
function synthesizeArgument(parameter, context, depth = 0) {
  const rawType = parameter?.rawType;
  if (typeof rawType !== "string" || rawType.length === 0) return { ok: false, reason: "untyped-parameter" };
  const { profile, providers, algebra, ordinals } = context;
  const members = typeMembers(rawType);

  for (const member of members) {
    const kindId = algebra.kindByRawType.get(member);
    if (kindId !== undefined && providers.has(kindId)) {
      // Each occurrence of one handle kind in one call gets its own ordinal so
      // a route needing two distinct engine objects is given two, not the same
      // object twice.
      const ordinal = ordinals.handles.get(kindId) ?? 0;
      ordinals.handles.set(kindId, ordinal + 1);
      return { ok: true, spec: { kind: "handle", handleKind: kindId, ordinal } };
    }
  }

  // A parameter that names a component address takes one of the profile's
  // published addresses instead of an arbitrary string, so the engine resolves
  // it for real rather than refusing it.
  if (profile.componentAddresses.length > 0 &&
      members.some((member) => ADDRESS_MEMBERS.includes(member))) {
    const ordinal = ordinals.addresses;
    ordinals.addresses += 1;
    return { ok: true, spec: { kind: "address", ordinal } };
  }

  if (rawType === "integer" && ONE_BASED_INDEX_PARAMETER.test(String(parameter.rawName ?? ""))) {
    return { ok: true, spec: { kind: "literal", value: 1 } };
  }

  if (Object.hasOwn(SCALAR_INHABITANTS, rawType)) {
    return { ok: true, spec: { kind: "literal", value: SCALAR_INHABITANTS[rawType] } };
  }
  // A union whose inhabitants include a synthesizable scalar is satisfied by
  // that inhabitant. This is a shape rule, not a symbol allowlist.
  if (members.length > 1) {
    for (const key of Object.keys(SCALAR_INHABITANTS)) {
      if (members.includes(key)) return { ok: true, spec: { kind: "literal", value: SCALAR_INHABITANTS[key] } };
    }
  }

  // A Defold value type is inhabited by calling the engine's own zero-argument
  // constructor for it. Which route that is comes from the pinned IR - the one
  // route with no required parameter whose single declared result is that
  // value type - not from a name written here.
  const valueConstructor = context.valueConstructors?.get(rawType);
  if (valueConstructor) {
    return { ok: true, spec: { kind: "value", valueType: rawType, accessor: valueConstructor.accessor } };
  }

  // A declared record is inhabited field by field. Only required fields are
  // synthesized: an optional field the harness leaves out is a legal call, and
  // a required field it cannot inhabit fails the whole parameter closed with
  // that field's own reason rather than a generic one.
  const record = context.records?.get(rawType);
  if (record) {
    if (depth >= RECORD_SYNTHESIS_DEPTH_LIMIT) {
      return { ok: false, reason: `record-synthesis-depth-exceeded:${rawType}` };
    }
    const fields = [];
    for (const field of record.fields ?? []) {
      if (field.optional) continue;
      const synthesized = synthesizeArgument(
        { rawName: field.rawName, rawType: field.rawType }, context, depth + 1);
      if (!synthesized.ok) {
        return { ok: false, reason: `${synthesized.reason}@${rawType}.${field.rawName}` };
      }
      fields.push({ name: field.rawName, value: synthesized.spec });
    }
    return { ok: true, spec: { kind: "record", recordType: rawType, fields } };
  }

  for (const member of members) {
    const kindId = algebra.kindByRawType.get(member);
    if (kindId !== undefined) {
      return {
        ok: false,
        reason: kindAdmissible(profile, algebra, kindId)
          ? `no-handle-producer-chain:${member}`
          : `handle-kind-outside-fixture-profile:${member}`
      };
    }
  }
  return { ok: false, reason: `unsynthesizable-parameter-type:${rawType}` };
}

/**
 * Zero-argument constructors for the Defold value types the pinned layout
 * report models.
 *
 * Discovered, not listed: a route with no required parameter whose single
 * declared result is that value type constructs an inhabitant of it. The
 * candidate set is the pinned layout report's own type names, so a value type
 * Defold adds or removes moves this set without an edit here.
 */
export function buildValueConstructors(irFunctions, valueLayouts, isCallable = () => true) {
  const valueTypes = new Set([
    ...Object.keys(valueLayouts?.transparent ?? {}),
    ...Object.keys(valueLayouts?.opaque ?? {})
  ]);
  const byType = new Map();
  const sorted = [...irFunctions].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  for (const irFunction of sorted) {
    const returns = irFunction.returns ?? [];
    if (returns.length !== 1 || !valueTypes.has(returns[0])) continue;
    if ((irFunction.parameters ?? []).some((parameter) => !parameter.optional)) continue;
    if (byType.has(returns[0])) continue;
    if (!isCallable(irFunction)) continue;
    byType.set(returns[0], { routeId: irFunction.id, accessor: accessorPath(irFunction) });
  }
  return byType;
}

// The generated TypeScript surface spells nested module segments in camel
// case, exactly as the shared conformance plan's type access does.
function camelSegment(value) {
  if (/^[A-Z][A-Z0-9_]*$/.test(value)) return value;
  return String(value).replace(/_([a-zA-Z0-9])/g, (_match, character) => character.toUpperCase());
}

function accessorPath(irFunction) {
  const [root, ...nested] = irFunction.modulePath;
  return [publicScriptRootName(root), ...nested.map(camelSegment), irFunction.jsName];
}

function contractSlug(index) {
  return `contract_${String(index).padStart(4, "0")}`;
}

const EMPTY_ALGEBRA = Object.freeze({
  backendByKind: new Map(),
  kindByRawType: new Map(),
  rowsById: new Map()
});

/**
 * Decide whether one route can act as a real-engine fixture for its contract
 * under one fixture profile. Returns either `{ eligible: true, exercise }` or
 * `{ eligible: false, reason }` where `reason` is a stable machine-readable
 * token.
 */
export function classifyRoute({
  unit,
  irFunction,
  universalBinding,
  scalarBinding,
  conformanceCase,
  profile = DEFAULT_FIXTURE_PROFILE,
  providers = new Map(),
  algebra = EMPTY_ALGEBRA,
  availability = EMPTY_AVAILABILITY,
  valueConstructors = new Map(),
  records = new Map(),
  projectionRow = null,
  admitDestructive = false
}) {
  if (!irFunction) return { eligible: false, reason: "absent-from-script-projection" };
  if (!universalBinding) return { eligible: false, reason: "no-generated-universal-adapter" };
  if (unit.backends.luaStack.selection !== "emit") {
    return { eligible: false, reason: `lua-stack-${unit.backends.luaStack.selection}` };
  }
  if (!conformanceCase) return { eligible: false, reason: "absent-from-conformance-plan" };
  // A route the catalog documents but the linked engine does not register is
  // not reachable at all; exercising it would only observe déherm's own
  // profile refusal, which is evidence about availability, not about the
  // route's contract.
  if (availability.catalog.has(unit.identity.id) && !availability.available.has(unit.identity.id)) {
    return { eligible: false, reason: `route-unavailable-in-runtime-profile:${availability.runtimeProfile}` };
  }
  // The driver creates and destroys one engine instance per contract, so a
  // destructive operation cannot reach any other contract's evidence. It is
  // still admitted only as a last resort - see `admitDestructive` at the call
  // site - because within one contract it would invalidate the engine objects
  // its sibling exercises depend on.
  const destructive = conformanceCase.execution.policy === "destructive";
  if (conformanceCase.execution.policy !== "safe" && !(destructive && admitDestructive)) {
    return { eligible: false, reason: `execution-policy-${conformanceCase.execution.policy}` };
  }
  const contexts = conformanceCase.requiredContexts ?? [];
  if (!contexts.some((context) => profile.suppliedContexts.includes(context))) {
    return { eligible: false, reason: `context-fixture-missing:${contexts.join("|") || "unknown"}` };
  }
  const leaf = String(irFunction.member ?? "");
  if (EXTERNAL_WRITE_LEAF.test(leaf)) {
    return { eligible: false, reason: `harness-effect-guard:${leaf}` };
  }
  if (universalBinding.variadic) {
    return { eligible: false, reason: "variadic-argument-shape-unmodelled" };
  }
  if (universalBinding.maximumResultCount > 1) {
    return { eligible: false, reason: "multi-result-shape-unmodelled" };
  }
  const classificationRow = algebra.rowsById.get(unit.identity.id) ?? null;
  const context = {
    profile, providers, algebra, valueConstructors, records,
    ordinals: { handles: new Map(), addresses: 0 }
  };
  // Lua argument passing is positional, so an optional parameter that sits
  // before a required one is a hole that still has to be filled. The
  // minimum-arity call therefore fills it with an explicit nil - which is what
  // "this optional parameter is absent" means in a positional call - and only
  // the optional *tail* after the last required parameter may be truncated.
  // Dropping the hole instead would silently shift every later argument left,
  // and the engine would type-check the wrong value.
  // Optionality is taken from the projected signature when there is one. The
  // projection corrects a documented-optional parameter the registered Lua
  // surface proves is required, and synthesizing from the uncorrected IR would
  // silently call the route with fewer arguments than the engine accepts.
  const projectedParameters = projectionRow?.signature?.parameters ?? null;
  const parameters = (irFunction.parameters ?? []).map((parameter, index) => {
    const projected = projectedParameters?.[index];
    return projected === undefined || projected.optional === parameter.optional
      ? parameter
      : { ...parameter, optional: projected.optional };
  });
  const synthesizedByIndex = parameters.map((parameter) => synthesizeArgument(parameter, context));
  let lastRequiredIndex = -1;
  for (const [index, parameter] of parameters.entries()) {
    if (parameter.optional) continue;
    if (!synthesizedByIndex[index].ok) return { eligible: false, reason: synthesizedByIndex[index].reason };
    lastRequiredIndex = index;
  }
  const required = [];
  const widened = [];
  for (let index = 0; index <= lastRequiredIndex; index += 1) {
    const synthesized = synthesizedByIndex[index];
    if (!parameters[index].optional) {
      required.push(synthesized.spec);
      widened.push(synthesized.spec);
      continue;
    }
    required.push(ABSENT_ARGUMENT);
    widened.push(synthesized.ok ? synthesized.spec : ABSENT_ARGUMENT);
  }
  const optional = [];
  for (let index = lastRequiredIndex + 1; index < parameters.length; index += 1) {
    // Stop extending the tail at the first inhabitant this harness cannot
    // synthesize; beyond it every position would be a guess.
    if (!synthesizedByIndex[index].ok) break;
    optional.push(synthesizedByIndex[index].spec);
  }
  if (required.length < universalBinding.minimumArgumentCount ||
      required.length > universalBinding.maximumArgumentCount) {
    return { eligible: false, reason: "argument-arity-disagrees-with-projection" };
  }
  const base = {
    routeId: unit.identity.id,
    stableId: unit.identity.stableId,
    accessor: accessorPath(irFunction),
    minimumArgumentCount: universalBinding.minimumArgumentCount,
    maximumArgumentCount: universalBinding.maximumArgumentCount,
    minimumResultCount: universalBinding.minimumResultCount,
    maximumResultCount: universalBinding.maximumResultCount,
    loweringFamily: universalBinding.loweringFamily,
    resultCodec: scalarBinding ? scalarBinding.result.codec : null,
    resultNullable: scalarBinding ? Boolean(scalarBinding.result.nullable) : null,
    destructive,
    returnHandleKind: classificationRow?.returnHandleKinds?.length === 1
      ? classificationRow.returnHandleKinds[0]
      : null
  };
  return {
    eligible: true,
    exercise: { ...base, arity: "required", arguments: required },
    // An optional tail the harness can inhabit is a second, additive
    // observation of the same route at a wider arity. It never replaces the
    // required-only observation.
    optionalExercise: (optional.length > 0 || widened.some((spec, index) => spec !== required[index])) && !destructive
      ? { ...base, arity: "required-and-optional", arguments: [...widened, ...optional] }
      : null
  };
}

/**
 * Build the handle provider chains one fixture profile can root.
 *
 * A producer is a classified route returning exactly one borrowed handle
 * kind. It becomes a provider when the profile can supply its context and
 * every one of its own parameters, which may itself be a handle produced by
 * an already-resolved provider. The fixpoint is bounded so a cyclic handle
 * algebra fails closed instead of looping.
 */
export function handleProducers(irFunctions, algebra) {
  const producers = [];
  for (const irFunction of irFunctions) {
    const returns = irFunction.returns ?? [];
    if (returns.length !== 1) continue;
    const kinds = new Set(typeMembers(returns[0])
      .filter((member) => member !== ABSENT_MEMBER)
      .map((member) => algebra.kindByRawType.get(member))
      .filter((kindId) => kindId !== undefined));
    if (kinds.size !== 1) continue;
    producers.push({ id: irFunction.id, handleKind: [...kinds][0] });
  }
  return producers.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

export function buildHandleProviders({ profile, algebra, availability, lookup, valueConstructors, records }) {
  const providers = new Map();
  const producers = handleProducers([...lookup.irById.values()], algebra);

  for (let depth = 0; depth < PROVIDER_CHAIN_DEPTH_LIMIT; depth += 1) {
    let added = false;
    for (const producer of producers) {
      const kindId = producer.handleKind;
      if (providers.has(kindId)) continue;
      if (!kindAdmissible(profile, algebra, kindId)) continue;
      const row = algebra.rowsById.get(producer.id);
      if (row?.requiredContext && !profile.handleContexts.includes(row.requiredContext)) continue;
      const unit = lookup.unitById.get(producer.id);
      if (!unit) continue;
      const decision = classifyRoute({
        unit,
        irFunction: lookup.irById.get(producer.id),
        universalBinding: lookup.universalById.get(producer.id),
        scalarBinding: lookup.scalarById.get(producer.id),
        conformanceCase: lookup.conformanceById.get(producer.id),
        profile,
        providers,
        algebra,
        availability,
        valueConstructors,
        records,
        projectionRow: lookup.projectionById.get(producer.id) ?? null
      });
      if (!decision.eligible) continue;
      providers.set(kindId, {
        handleKind: kindId,
        routeId: producer.id,
        accessor: decision.exercise.accessor,
        arguments: decision.exercise.arguments,
        depth: depth + 1
      });
      added = true;
    }
    if (!added) break;
  }
  return providers;
}

/**
 * Cross-transport agreement for each handle kind a fixture profile can root.
 *
 * A handle-lowered consumer accepts exactly one representation: a
 * generation-checked semantic handle rooted in the shared registry. Two
 * transports can produce it - the handle-lowering table, and the
 * universal-value transport for a route whose declared result the
 * classification names as a rooted handle kind. What matters is therefore
 * whether the producer's transport captures the kind semantically at all, not
 * which table the producer happens to live in: a constructor that takes a
 * definition record is marshalled by the universal transport by construction,
 * because a table-shaped parameter outranks a handle when its lowering family
 * is chosen.
 *
 * When no transport captures the producer's result semantically while its
 * consumers are handle-lowered, every consumer refuses a handle that a live
 * engine really did produce. That disagreement is recorded here rather than
 * left to be rediscovered from a runtime transcript.
 */
export function handleTransportAgreement(providers, loweredRouteIds, consumersByKind, semanticCaptureByRoute = new Map()) {
  return [...providers.values()]
    .sort((left, right) => (left.handleKind < right.handleKind ? -1 : 1))
    .map((provider) => {
      const consumers = consumersByKind.get(provider.handleKind) ?? [];
      const loweredConsumers = consumers.filter((id) => loweredRouteIds.has(id));
      const producerLowered = loweredRouteIds.has(provider.routeId);
      const universalCapture = semanticCaptureByRoute.get(provider.routeId) === provider.handleKind;
      const producerTransport = producerLowered
        ? "handle-lowering"
        : universalCapture ? "universal-value-semantic-capture" : "universal-value-anonymous";
      return {
        handleKind: provider.handleKind,
        producerRouteId: provider.routeId,
        producerHandleLowered: producerLowered,
        producerTransport,
        producerCapturesSemanticHandle: producerLowered || universalCapture,
        consumerCount: consumers.length,
        handleLoweredConsumerCount: loweredConsumers.length,
        agreement: producerLowered || universalCapture || loweredConsumers.length === 0
          ? "agreed"
          : "producer-outside-semantic-handle-capture"
      };
    });
}

function propertiesForContract(contractRecord) {
  const properties = ["result-arity"];
  if (contractRecord.scratch?.token === SCRATCH_CONTRACT_TOKEN) properties.push("scratch-reuse");
  if (contractRecord.errorModel?.token === ERROR_MODEL_CONTRACT_TOKEN) properties.push("error-model");
  return properties;
}

export async function loadHeadlessConformanceInputs(root) {
  const entries = await Promise.all(Object.entries(INPUT_PATHS).map(async ([name, relative]) => {
    const text = await readFile(new URL(relative, root), "utf8");
    return [name, { text, value: JSON.parse(text), path: relative, sha256: sha256(text) }];
  }));
  const documents = Object.fromEntries(entries);
  documents.conformance = await loadConformanceInputs();
  return documents;
}

export function buildHeadlessConformancePlan(documents, {
  target = "arm64-macos",
  runtimeProfile = HEADLESS_RUNTIME_PROFILE
} = {}) {
  const loweringPlan = documents.loweringPlan.value;
  if (loweringPlan.schemaVersion !== 2) {
    throw new Error(`Headless conformance requires canonical lowering-plan schema v2, got ${loweringPlan.schemaVersion}`);
  }
  const conformancePlan = buildConformancePlan(documents.conformance, { target, contexts: ["*"], shard: "0/1" });
  const classification = documents.borrowedHandles?.value ?? null;
  const algebra = buildHandleAlgebra(classification);
  const availability = buildRouteAvailability(documents.routeAvailability?.value ?? null, runtimeProfile);

  const lookup = {
    conformanceById: new Map(conformancePlan.cases.map((item) => [item.id, item])),
    irById: new Map(documents.scriptIr.value.functions.map((item) => [item.id, item])),
    universalById: new Map(documents.universalValueBindings.value.bindings.map((item) => [item.id, item])),
    scalarById: new Map(documents.scalarDispatch.value.bindings.map((item) => [item.id, item])),
    unitById: new Map(loweringPlan.units.map((unit) => [unit.identity.id, unit])),
    projectionById: new Map((documents.projection?.value?.rows ?? []).map((row) => [row.id, row]))
  };

  const loweredRouteIds = new Set((documents.handleLowering?.value?.routes ?? []).map((route) => route.id));
  // The universal transport captures a declared rooted-handle result into the
  // same semantic registry the handle-lowering table uses, so a route here
  // produces a representation handle-lowered consumers accept.
  const semanticCaptureByRoute = new Map(documents.universalValueBindings.value.bindings
    .filter((binding) => binding.resultSemanticKind)
    .map((binding) => [binding.id, binding.resultSemanticKind]));
  const consumersByKind = new Map();
  for (const irFunction of lookup.irById.values()) {
    for (const parameter of irFunction.parameters ?? []) {
      for (const member of typeMembers(parameter.rawType ?? "")) {
        const kindId = algebra.kindByRawType.get(member);
        if (kindId === undefined) continue;
        if (!consumersByKind.has(kindId)) consumersByKind.set(kindId, []);
        consumersByKind.get(kindId).push(irFunction.id);
      }
    }
  }

  // A route is only usable as a value constructor when the plan can actually
  // call it, and when calling it observes nothing but the value: it must be in
  // the universal catalog, its conformance case must be safe, and it must need
  // no context beyond the ambient engine. The last condition is what keeps a
  // synthesized inhabitant from silently reading the surrounding game object -
  // `go.get_position` would also satisfy the shape.
  const valueConstructors = buildValueConstructors(
    [...lookup.irById.values()],
    documents.valueLayouts?.value ?? null,
    (irFunction) => {
      const conformanceCase = lookup.conformanceById.get(irFunction.id);
      return lookup.universalById.has(irFunction.id) &&
        conformanceCase?.execution?.policy === "safe" &&
        (conformanceCase.requiredContexts ?? []).every((context) => context === AMBIENT_CONTEXT);
    }
  );
  const records = new Map((documents.scriptIr.value.types ?? [])
    .filter((type) => type.kind === "class")
    .map((type) => [type.name, type]));

  const profileProviders = new Map(FIXTURE_PROFILES.map((profile) => [
    profile.id,
    buildHandleProviders({ profile, algebra, availability, lookup, valueConstructors, records })
  ]));

  const byContract = new Map();
  for (const unit of loweringPlan.units) {
    if (unit.identity.surface !== "script") continue;
    const index = unit.contractDetails;
    if (!byContract.has(index)) byContract.set(index, []);
    byContract.get(index).push(unit);
  }

  const contracts = [];
  for (const index of [...byContract.keys()].sort((left, right) => left - right)) {
    const units = byContract.get(index).slice().sort((left, right) =>
      left.identity.id < right.identity.id ? -1 : left.identity.id > right.identity.id ? 1 : 0);
    const contractRecord = loweringPlan.tables.contracts[index];

    // Every profile is tried; the contract takes the one that makes the most
    // of its routes eligible, with the cheapest profile winning a tie.
    let chosen = null;
    for (const profile of FIXTURE_PROFILES) {
      const providers = profileProviders.get(profile.id);
      const classify = (admitDestructive) => {
        const eligible = [];
        const optional = [];
        const blockerCounts = new Map();
        const blockerExamples = new Map();
        for (const unit of units) {
          const decision = classifyRoute({
            unit,
            irFunction: lookup.irById.get(unit.identity.id),
            universalBinding: lookup.universalById.get(unit.identity.id),
            scalarBinding: lookup.scalarById.get(unit.identity.id),
            conformanceCase: lookup.conformanceById.get(unit.identity.id),
            profile,
            providers,
            algebra,
            availability,
            valueConstructors,
            records,
            projectionRow: lookup.projectionById.get(unit.identity.id) ?? null,
            admitDestructive
          });
          if (decision.eligible) {
            eligible.push(decision.exercise);
            if (decision.optionalExercise) optional.push(decision.optionalExercise);
            continue;
          }
          blockerCounts.set(decision.reason, (blockerCounts.get(decision.reason) ?? 0) + 1);
          if (!blockerExamples.has(decision.reason)) blockerExamples.set(decision.reason, unit.identity.id);
        }
        return { eligible, optional, blockerCounts, blockerExamples };
      };

      // A contract with no safe route is retried admitting destructive ones,
      // and then exercises exactly one: the engine instance is disposable, but
      // a destroyed engine object must not be seen by a sibling exercise.
      let { eligible, optional, blockerCounts, blockerExamples } = classify(false);
      if (eligible.length === 0) {
        const retried = classify(true);
        if (retried.eligible.length > 0) {
          eligible = retried.eligible.slice(0, 1);
          optional = [];
          blockerCounts = retried.blockerCounts;
          blockerExamples = retried.blockerExamples;
        }
      }
      // A profile that admits more of the contract's handle algebra wins even
      // when neither profile can reach the contract, so the recorded blocker
      // names the real obstacle rather than the profile mismatch, and a route
      // that merely returns a handle still lands in a fixture that owns the
      // engine world that handle belongs to.
      const mismatched = [...blockerCounts.entries()]
        .filter(([reason]) => reason.startsWith("handle-kind-outside-fixture-profile"))
        .reduce((total, [, count]) => total + count, 0);
      const grounded = eligible.filter((exercise) =>
        (exercise.returnHandleKind !== null && kindAdmissible(profile, algebra, exercise.returnHandleKind)) ||
        exercise.arguments.some((argument) => argument.kind === "handle")).length;
      const candidate = { profile, eligible, optional, blockerCounts, blockerExamples, providers, mismatched, grounded };
      const better = chosen === null ||
        eligible.length > chosen.eligible.length ||
        (eligible.length === chosen.eligible.length && grounded > chosen.grounded) ||
        (eligible.length === chosen.eligible.length && grounded === chosen.grounded && mismatched < chosen.mismatched);
      if (better) chosen = candidate;
    }

    const blockers = [...chosen.blockerCounts.entries()]
      .sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1))
      .map(([reason, routeCount]) => ({ reason, routeCount, exampleRouteId: chosen.blockerExamples.get(reason) }));

    const properties = propertiesForContract(contractRecord);
    const slug = contractSlug(index);
    const record = {
      contractIndex: index,
      id: slug,
      routeCount: units.length,
      eligibleRouteCount: chosen.eligible.length,
      contract: {
        context: contractRecord.context?.kind ?? null,
        ownershipResult: contractRecord.ownership?.result ?? null,
        lifetime: contractRecord.lifetime?.result ?? null,
        thread: contractRecord.thread?.call ?? null,
        callbackPresent: Boolean(contractRecord.callback?.present),
        invalidation: contractRecord.invalidation?.token ?? null,
        errorModel: contractRecord.errorModel?.token ?? null,
        scratch: contractRecord.scratch?.token ?? null
      },
      properties,
      disposition: chosen.eligible.length > 0 ? "fixture" : "unreachable",
      blockers
    };
    if (chosen.eligible.length > 0) {
      const destructive = chosen.eligible.some((exercise) => exercise.destructive);
      const exercises = chosen.eligible.slice(0, destructive ? 1 : MAX_EXERCISES_PER_CONTRACT);
      // The optional-arity variants ride in the remaining budget so a wider
      // arity is never bought by dropping a route from the sample.
      const budget = Math.max(0, MAX_EXERCISES_PER_CONTRACT - exercises.length);
      const exercisedRoutes = new Set(exercises.map((exercise) => exercise.routeId));
      const extras = chosen.optional
        .filter((exercise) => exercisedRoutes.has(exercise.routeId))
        .slice(0, budget);
      record.profile = chosen.profile.id;
      if (destructive) record.executionPolicy = "destructive-last-resort";
      record.collection = `/conformance/${slug}.collectionc`;
      record.engineConfig = [...chosen.profile.engineConfig];
      record.exercises = [...exercises, ...extras];
      // Transitive closure: a consumed handle kind drags in every producer its
      // own chain depends on, so the recorded provenance is complete.
      const usedKinds = new Set();
      const visit = (kindId) => {
        if (usedKinds.has(kindId)) return;
        usedKinds.add(kindId);
        for (const argument of chosen.providers.get(kindId)?.arguments ?? []) {
          if (argument.kind === "handle") visit(argument.handleKind);
        }
      };
      for (const exercise of record.exercises) {
        for (const argument of exercise.arguments) {
          if (argument.kind === "handle") visit(argument.handleKind);
        }
      }
      record.handleProviders = [...usedKinds].sort().map((kindId) => {
        const provider = chosen.providers.get(kindId);
        return { handleKind: kindId, routeId: provider.routeId, depth: provider.depth };
      });
    }
    contracts.push(record);
  }

  const reachable = contracts.filter((item) => item.disposition === "fixture");
  const usedProfiles = [...new Set(reachable.map((item) => item.profile))].sort();
  return {
    schemaVersion: HEADLESS_CONFORMANCE_SCHEMA_VERSION,
    defoldRevision: loweringPlan.defoldRevision,
    target,
    variant: "headless",
    runtimeProfile: availability.runtimeProfile,
    runtimeProfileFeatures: availability.features,
    evidenceBoundary:
      "Runtime evidence only. A fixture disposition states that the harness can reach the contract " +
      "from a headless engine instance; it never promotes generation, compilation or linkage evidence, " +
      "and it makes no claim for a contract this plan records as unreachable.",
    suppliedContexts: [...SUPPLIED_CONTEXTS],
    unsuppliedContexts: UNSUPPLIED_CONTEXTS.map((entry) => ({ ...entry })),
    scratchReuseRepetitions: SCRATCH_REUSE_REPETITIONS,
    maxExercisesPerContract: MAX_EXERCISES_PER_CONTRACT,
    providerChainDepthLimit: PROVIDER_CHAIN_DEPTH_LIMIT,
    fixtureProfiles: FIXTURE_PROFILES.map((profile) => ({
      id: profile.id,
      summary: profile.summary,
      suppliedContexts: [...profile.suppliedContexts],
      handleContexts: [...profile.handleContexts],
      components: [...profile.components],
      componentAddresses: [...profile.componentAddresses],
      engineConfig: [...profile.engineConfig],
      contractCount: reachable.filter((item) => item.profile === profile.id).length,
      handleProviders: [...profileProviders.get(profile.id).values()]
        .sort((left, right) => (left.handleKind < right.handleKind ? -1 : 1)),
      handleTransportAgreement: handleTransportAgreement(
        profileProviders.get(profile.id), loweredRouteIds, consumersByKind, semanticCaptureByRoute)
    })),
    usedProfiles,
    inputs: Object.fromEntries(Object.entries(INPUT_PATHS).map(([name, relative]) => [
      relative,
      documents[name].sha256
    ])),
    contractCount: contracts.length,
    reachableContractCount: reachable.length,
    unreachableContractCount: contracts.length - reachable.length,
    exercisedRouteCount: reachable.reduce(
      (total, item) => total + new Set(item.exercises.map((exercise) => exercise.routeId)).size, 0),
    exerciseCount: reachable.reduce((total, item) => total + item.exercises.length, 0),
    eligibleRouteCount: contracts.reduce((total, item) => total + item.eligibleRouteCount, 0),
    blockerSummary: summarizeBlockers(contracts),
    contracts
  };
}

function summarizeBlockers(contracts) {
  const counts = new Map();
  for (const contract of contracts) {
    if (contract.disposition !== "unreachable") continue;
    for (const blocker of contract.blockers) {
      const family = blocker.reason.split(":")[0];
      if (!counts.has(family)) counts.set(family, { contractCount: 0, routeCount: 0 });
      counts.get(family).routeCount += blocker.routeCount;
    }
    const families = new Set(contract.blockers.map((blocker) => blocker.reason.split(":")[0]));
    for (const family of families) counts.get(family).contractCount += 1;
  }
  return [...counts.entries()]
    .sort((left, right) => right[1].contractCount - left[1].contractCount || (left[0] < right[0] ? -1 : 1))
    .map(([family, value]) => ({ family, ...value }));
}
