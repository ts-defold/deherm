import { createHash, randomBytes } from "node:crypto";

/**
 * Every bundle that `defold_hermes::Runtime::load` evaluates must publish its
 * own exact content fingerprint, because the runtime reports HMR activation by
 * echoing that value back across the engine boundary. This module is the single
 * definition of that contract so no bundler can drift from the runtime reader in
 * `defold/defold_hermes/src/runtime.cpp`.
 */
export const BUNDLE_FINGERPRINT_GLOBAL = "__DEFOLD_HERMES_BUILD_FINGERPRINT__";

/** Hexadecimal characters in a SHA-256 digest; the runtime rejects any other width. */
export const BUNDLE_FINGERPRINT_LENGTH = 64;

/**
 * A fresh, unguessable token of exactly fingerprint width. Using a random token
 * rather than a fixed sentinel guarantees that the placeholder cannot collide
 * with bundled program text, so the single-occurrence check below is exact.
 */
export function createBundleFingerprintPlaceholder() {
  return randomBytes(BUNDLE_FINGERPRINT_LENGTH / 2).toString("hex");
}

/**
 * Every bundle is strict. Hermes evaluates a plain script in sloppy mode
 * otherwise, and sloppy mode is not a milder dialect - it is different
 * semantics: assigning an undeclared name creates a global instead of throwing,
 * `this` in a plain call is the global object instead of undefined, and
 * function declarations in blocks hoist differently. A bundle that silently got
 * sloppy semantics would diverge from what the TypeScript sources mean, and
 * from the ES modules they were authored as, which are always strict.
 *
 * This is emitted as part of the banner rather than through a separate
 * mechanism because position is the whole contract: a directive only takes
 * effect in the directive prologue, so `"use strict"` must precede every
 * statement including the fingerprint assignment. Keeping them in one string is
 * what guarantees nothing can be inserted between them. Strict mode at script
 * level covers the IIFE esbuild wraps the program in, so one directive makes
 * the entire bundle strict.
 */
export const BUNDLE_STRICT_DIRECTIVE = '"use strict";';

/** The banner that publishes the placeholder into the evaluated bundle scope. */
export function bundleFingerprintBanner(placeholder) {
  assertFingerprintShape(placeholder, "placeholder");
  return `${BUNDLE_STRICT_DIRECTIVE}\nvar ${BUNDLE_FINGERPRINT_GLOBAL} = "${placeholder}";`;
}

function assertFingerprintShape(value, description) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`bundle fingerprint ${description} must be 64 lowercase hex characters`);
  }
}

/**
 * Replace the placeholder with the bundle's own SHA-256. The digest is taken
 * over the source with the placeholder zeroed, so the fingerprint is a pure
 * function of the compiled program and is reproducible from the final artifact.
 */
export function applyBundleFingerprint(source, placeholder) {
  assertFingerprintShape(placeholder, "placeholder");
  const occurrences = source.split(placeholder).length - 1;
  if (occurrences !== 1) {
    throw new Error(`expected one build fingerprint placeholder, found ${occurrences}`);
  }
  const index = source.indexOf(placeholder);
  const head = source.slice(0, index);
  const tail = source.slice(index + BUNDLE_FINGERPRINT_LENGTH);
  const fingerprint = createHash("sha256")
    .update(`${head}${"0".repeat(BUNDLE_FINGERPRINT_LENGTH)}${tail}`)
    .digest("hex");
  return { fingerprint, source: `${head}${fingerprint}${tail}` };
}
