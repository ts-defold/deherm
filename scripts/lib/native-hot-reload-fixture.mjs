export const rejectedCandidateMarker = "deherm-hot-reload-rejected-candidate";

function replaceExactlyOnce(source, search, replacement, description) {
  const first = source.indexOf(search);
  if (first === -1) throw new Error(`hot-reload fixture did not find ${description}`);
  if (source.indexOf(search, first + search.length) !== -1) {
    throw new Error(`hot-reload fixture found multiple ${description} sites`);
  }
  return `${source.slice(0, first)}${replacement}${source.slice(first + search.length)}`;
}

export function createRejectedCandidate(source) {
  const hook = "init() {";
  return replaceExactlyOnce(
      source,
      hook,
      `${hook}\n        throw new Error(${JSON.stringify(rejectedCandidateMarker)});`,
      "application init hook");
}

export function createValidCandidate(source) {
  return replaceExactlyOnce(
      source,
      "add(20, 22)",
      "add(40, 44)",
      "expected module expression");
}
