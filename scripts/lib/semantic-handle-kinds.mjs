// Dense numeric identity for the semantic borrowed-handle kinds.
//
// Two transports agree on this numbering: the handle-lowering table emits it
// as `SemanticHandleKind`, and the universal-value transport emits the same
// value as a route's declared result kind so a handle either transport
// captures is the same generation-checked registry identity. Both derive it
// here, from the one pinned classification, so the two tables cannot drift
// apart into a representation the other refuses.
//
// Declaration-only tokens are excluded: they never become a runtime handle.

const RUNTIME_REPRESENTATIONS = Object.freeze(["lua-rooted-userdata", "numeric-graphics-asset-handle"]);

/** Kinds that are a rooted Lua userdata, and therefore capturable from the stack. */
export const ROOTED_USERDATA_REPRESENTATION = "lua-rooted-userdata";

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * The classification's runtime handle kinds, sorted by id and numbered from 1.
 * Zero is reserved for "this value is not a semantic handle".
 */
export function semanticHandleKinds(classification) {
  const kinds = (classification?.handleKinds ?? [])
    .filter(({ representation }) => RUNTIME_REPRESENTATIONS.includes(representation))
    .sort((left, right) => compareCodeUnits(left.id, right.id));
  return kinds.map((kind, index) => ({ ...kind, numericId: index + 1 }));
}

/** Map from handle-kind id to its dense numeric identity. */
export function semanticHandleKindIds(classification) {
  return new Map(semanticHandleKinds(classification).map(({ id, numericId }) => [id, numericId]));
}
