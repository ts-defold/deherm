const revisionPattern = /^[0-9a-f]{40}$/u;

export function bobMirrorTag(revision) {
  if (!revisionPattern.test(revision)) throw new Error(`Invalid Defold revision: ${revision}`);
  return `defold-bob-${revision}`;
}

export function bobMirrorUrl(revision) {
  return `https://github.com/ts-defold/deherm/releases/download/${bobMirrorTag(revision)}/bob.jar`;
}
