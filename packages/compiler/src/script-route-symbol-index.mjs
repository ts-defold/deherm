// The checker-facing join between the generated TypeScript script surface and
// the canonical route identity.
//
// ttsc resolves a call site to a member declared on an interface in
// `generated/script/types.ts`. That member path — `GuiApi.getNode`,
// `B2dApi.body.applyForce` — is the only name the checker can produce. This
// index turns it into the stable route ID every later stage already speaks, so
// reachability is expressed in canonical identity rather than in a spelling.
//
// It is derived, never authored: the script API IR owns the public member
// spelling and the canonical lowering plan owns identity and disposition. A
// member the two authorities disagree about is a hard error, because a silent
// mismatch would make a route look unreachable and delete it from a release.

import { createHash } from "node:crypto";

import { publicScriptModulePath } from "./script-public-api-policy.mjs";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

// Mirrors scripts/generate-script-sdk.mjs `pascal`; the declaring interface for
// a public root is exactly `${pascal(root)}Api`.
function pascal(value) {
  const words = value.replace(/^defold_(?:api|enum)\./, "").split(/[^A-Za-z0-9]+/).filter(Boolean);
  const joined = words.map((word) => word[0].toUpperCase() + word.slice(1)).join("") || "Anonymous";
  return /^[A-Za-z_$]/.test(joined) ? joined : `_${joined}`;
}

// Mirrors scripts/generate-script-sdk.mjs `camel`; nested Lua module segments
// become camel-cased members of the declaring interface.
function camel(value) {
  if (/^[A-Z][A-Z0-9_]*$/.test(value)) return value;
  return value.replace(/_([a-zA-Z0-9])/g, (_, character) => character.toUpperCase());
}

/** The declared member path a checker resolves for one script API route. */
export function scriptRouteMemberPath(modulePath, jsName) {
  const [root, ...nested] = publicScriptModulePath(modulePath);
  return [`${pascal(root)}Api`, ...nested.map(camel), jsName].join(".");
}

function validatePlanIdentity(plan) {
  if (plan?.schemaVersion !== 2 || typeof plan.planSha256 !== "string") {
    throw new Error(`Route symbol index requires canonical lowering-plan schema v2, got ${plan?.schemaVersion ?? "missing"}`);
  }
  const { planSha256, ...body } = plan;
  if (sha256(JSON.stringify(body)) !== planSha256) {
    throw new Error("Route symbol index requires a lowering plan with a valid internal digest");
  }
}

/**
 * Build the member-path to route-identity index.
 *
 * Every script route in the lowering plan gets exactly one member path, and
 * every member path names exactly one route. A collision means the public
 * TypeScript spelling has become ambiguous, which would make the checker's
 * answer unsound; it fails rather than guessing.
 */
export function buildScriptRouteSymbolIndex(scriptApiIr, loweringPlan) {
  validatePlanIdentity(loweringPlan);
  if (scriptApiIr?.defoldRevision !== loweringPlan.defoldRevision) {
    throw new Error("Script API IR and lowering plan revisions differ");
  }
  const functions = new Map(scriptApiIr.functions.map((item) => [item.id, item]));
  if (functions.size !== scriptApiIr.functions.length) throw new Error("Script API IR contains duplicate route ids");
  // Constants have generated stable-ID transport units in the lowering plan,
  // but their TypeScript surface is literal/intrinsic and therefore has no
  // callable member path for the checker to resolve.
  const scriptUnits = loweringPlan.units.filter(({ identity, sourceRef }) =>
    identity.surface === "script" && sourceRef?.input === "scriptProjection");
  const members = {};
  const byStableId = {};
  const namespaces = {};
  for (const unit of scriptUnits) {
    const fn = functions.get(unit.identity.id);
    if (!fn) throw new Error(`Lowering plan route ${unit.identity.id} is absent from the script API IR`);
    const member = scriptRouteMemberPath(fn.modulePath, fn.jsName);
    if (members[member]) {
      throw new Error(`Public member ${member} is claimed by both ${members[member].id} and ${unit.identity.id}`);
    }
    const [namespace] = publicScriptModulePath(fn.modulePath);
    const [declaringInterface] = member.split(".");
    namespaces[namespace] = declaringInterface;
    const selections = Object.fromEntries(Object.entries(unit.backends)
      .map(([target, backend]) => [target, backend.selection])
      .sort(([left], [right]) => compareCodeUnits(left, right)));
    members[member] = {
      id: unit.identity.id,
      stableId: unit.identity.stableId,
      namespace,
      selections
    };
    if (byStableId[unit.identity.stableId]) {
      throw new Error(`Stable ID ${unit.identity.stableId} is claimed by two routes`);
    }
    byStableId[unit.identity.stableId] = unit.identity.id;
  }
  if (Object.keys(members).length !== scriptUnits.length) {
    throw new Error("Route symbol index lost routes while deriving member paths");
  }
  const body = {
    schemaVersion: 1,
    generator: "@ts-defold/deherm script-route-symbol-index/v1",
    defoldRevision: loweringPlan.defoldRevision,
    loweringPlanSha256: loweringPlan.planSha256,
    // The declaration file whose members the checker is allowed to resolve.
    // Anything resolved elsewhere is the user's own symbol.
    declarationSuffix: "/generated/script/types.ts",
    routeCount: scriptUnits.length,
    namespaces: Object.fromEntries(Object.entries(namespaces).sort(([left], [right]) => compareCodeUnits(left, right))),
    members: Object.fromEntries(Object.entries(members).sort(([left], [right]) => compareCodeUnits(left, right))),
    byStableId: Object.fromEntries(Object.entries(byStableId).sort(([left], [right]) => Number(left) - Number(right)))
  };
  return { ...body, indexSha256: sha256(JSON.stringify(body)) };
}

/** Routes whose canonical disposition never reaches a native emission target. */
export function compileTimeIntrinsicRoutes(index, target = "dynamicHermesJsi") {
  return Object.values(index.members)
    .filter((member) => member.selections[target] === "compile-time-intrinsic")
    .map(({ id }) => id)
    .sort(compareCodeUnits);
}
