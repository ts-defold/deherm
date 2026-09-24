import { MAX_PLAYERS, SESSION_TOKEN_BYTES } from "./constants.ts";

/**
 * Authenticated resume credentials for the War Battles control plane.
 *
 * This module deliberately has no dependency on MatchServer. Issuing and
 * checking a credential happens only at hello/welcome boundaries, so the
 * asynchronous API and bounded HMAC work are not part of the fixed-step
 * simulation.
 * Revocation is still stateful: a caller must persist and compare the
 * generation in the claims against its bounded slot ledger.
 */

export const SESSION_TOKEN_VERSION = 1;
export const SESSION_TOKEN_HEADER_BYTES = 24;
export const SESSION_TOKEN_TAG_BYTES = 16;
export { SESSION_TOKEN_BYTES };

export interface SessionTokenClaims {
  /** Match identifier carried in the hello/welcome context. */
  readonly matchId: number;
  /** Zero-based roster slot. */
  readonly slot: number;
  /** Monotonically rotating credential generation; zero is never valid. */
  readonly generation: number;
  /** Authoritative tick at which this credential was issued. */
  readonly issuedAtTick: number;
  /** Zero means no wall/tick expiry; the ledger still revokes generations. */
  readonly expiresAtTick: number;
}

export interface SessionTokenExpectation {
  readonly matchId: number;
  readonly nowTick: number;
  readonly rosterSize?: number;
}

export interface SessionTokenKey {
  /** Small key identifier allows bounded key rotation without widening tokens. */
  readonly id: number;
  readonly secret: Uint8Array;
}

export interface SessionTokenServiceOptions {
  /** At least 128 bits is required; use deployment secret material here. */
  readonly keys: readonly SessionTokenKey[];
  /** New credentials use this key. Verification accepts every configured key. */
  readonly activeKeyId?: number;
}

/** Async seam for a hosted issuer/verifier or deterministic test double. */
export interface SessionTokenProvider {
  issue(claims: SessionTokenClaims): Promise<Uint8Array>;
  verify(token: Uint8Array, expected: SessionTokenExpectation): Promise<SessionTokenClaims | null>;
}

/** Stable machine-readable failures for configuration, not peer input. */
export class SessionTokenConfigurationError extends Error {
  readonly code = "session-token-configuration";

  constructor(message: string) {
    super(message);
    this.name = "SessionTokenConfigurationError";
  }
}

/**
 * HMAC-SHA-256 credentials with a fixed 40-byte binary representation.
 *
 * The body is deterministic for a given claim set and secret. Its security is
 * from the configured secret, never from a predictable process salt. A caller
 * should use a fresh generation for every successful welcome and reject a
 * generation that is not current in its durable ledger.
 */
export class SessionTokenService implements SessionTokenProvider {
  readonly tokenBytes = SESSION_TOKEN_BYTES;
  readonly activeKeyId: number;
  private readonly keys = new Map<number, Uint8Array>();
  private readonly importedKeys = new Map<number, Promise<CryptoKey>>();

  constructor(options: SessionTokenServiceOptions) {
    if (options.keys.length === 0) throw new SessionTokenConfigurationError("at least one token key is required");
    for (const key of options.keys) {
      if (!Number.isInteger(key.id) || key.id < 0 || key.id > 0xffff) {
        throw new SessionTokenConfigurationError("token key id must fit uint16");
      }
      if (this.keys.has(key.id)) throw new SessionTokenConfigurationError("token key ids must be unique");
      if (key.secret.byteLength < 16) throw new SessionTokenConfigurationError("token secrets must be at least 16 bytes");
      this.keys.set(key.id, new Uint8Array(key.secret));
    }
    this.activeKeyId = options.activeKeyId ?? options.keys[0]!.id;
    if (!this.keys.has(this.activeKeyId)) throw new SessionTokenConfigurationError("active token key is not configured");
  }

  /** Mints a credential. This is control-plane work and intentionally async. */
  async issue(claims: SessionTokenClaims): Promise<Uint8Array> {
    validateClaims(claims);
    const body = encodeBody(this.activeKeyId, claims);
    const key = await this.cryptoKey(this.activeKeyId);
    const signature = new Uint8Array(await globalThis.crypto.subtle.sign(
      "HMAC",
      key,
      body as unknown as BufferSource,
    ));
    const token = new Uint8Array(SESSION_TOKEN_BYTES);
    token.set(body, 0);
    token.set(signature.subarray(0, SESSION_TOKEN_TAG_BYTES), SESSION_TOKEN_HEADER_BYTES);
    return token;
  }

  /**
   * Verifies syntax, key, context, expiry, and MAC. Malformed or unverifiable
   * peer input always returns null; it never throws or falls through to anon.
   */
  async verify(token: Uint8Array, expected: SessionTokenExpectation): Promise<SessionTokenClaims | null> {
    try {
      if (token.byteLength !== SESSION_TOKEN_BYTES) return null;
      if (!Number.isInteger(expected.matchId) || expected.matchId < 0 || expected.matchId > 0xffff_ffff) return null;
      if (!Number.isInteger(expected.nowTick) || expected.nowTick < 0 || expected.nowTick > 0xffff_ffff) return null;
      const view = new DataView(token.buffer, token.byteOffset, token.byteLength);
      if (view.getUint8(0) !== SESSION_TOKEN_VERSION || view.getUint8(1) !== 0) return null;
      if (view.getUint8(9) !== 0 || view.getUint16(10, true) !== 0) return null;
      const keyId = view.getUint16(2, true);
      if (!this.keys.has(keyId)) return null;
      const claims: SessionTokenClaims = {
        matchId: view.getUint32(4, true),
        slot: view.getUint8(8),
        generation: view.getUint32(12, true),
        issuedAtTick: view.getUint32(16, true),
        expiresAtTick: view.getUint32(20, true),
      };
      if (claims.matchId !== expected.matchId || claims.generation === 0) return null;
      if (claims.slot >= MAX_PLAYERS) return null;
      if (expected.rosterSize !== undefined && (!Number.isInteger(expected.rosterSize) || claims.slot >= expected.rosterSize)) return null;
      if (claims.issuedAtTick > expected.nowTick) return null;
      if (claims.expiresAtTick !== 0 && expected.nowTick > claims.expiresAtTick) return null;
      validateClaims(claims);
      const body = token.subarray(0, SESSION_TOKEN_HEADER_BYTES);
      const key = await this.cryptoKey(keyId);
      const signature = new Uint8Array(await globalThis.crypto.subtle.sign(
        "HMAC",
        key,
        body as unknown as BufferSource,
      ));
      if (!constantTimeEqual(signature, token.subarray(SESSION_TOKEN_HEADER_BYTES))) return null;
      return claims;
    } catch (_error: unknown) {
      // A crypto/provider failure is an authentication failure at this seam.
      return null;
    }
  }

  private cryptoKey(id: number): Promise<CryptoKey> {
    let pending = this.importedKeys.get(id);
    if (pending !== undefined) return pending;
    const secret = this.keys.get(id);
    if (secret === undefined) throw new SessionTokenConfigurationError("token key is not configured");
    pending = globalThis.crypto.subtle.importKey(
      "raw",
      secret as unknown as BufferSource,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    this.importedKeys.set(id, pending);
    return pending;
  }
}

function encodeBody(keyId: number, claims: SessionTokenClaims): Uint8Array {
  const body = new Uint8Array(SESSION_TOKEN_HEADER_BYTES);
  const view = new DataView(body.buffer);
  view.setUint8(0, SESSION_TOKEN_VERSION);
  view.setUint8(1, 0);
  view.setUint16(2, keyId, true);
  view.setUint32(4, claims.matchId >>> 0, true);
  view.setUint8(8, claims.slot);
  view.setUint8(9, 0);
  view.setUint16(10, 0, true);
  view.setUint32(12, claims.generation >>> 0, true);
  view.setUint32(16, claims.issuedAtTick >>> 0, true);
  view.setUint32(20, claims.expiresAtTick >>> 0, true);
  return body;
}

function validateClaims(claims: SessionTokenClaims): void {
  unsigned(claims.matchId, "matchId");
  unsigned(claims.slot, "slot");
  if (claims.slot >= MAX_PLAYERS) throw new RangeError(`slot must be in [0, ${MAX_PLAYERS})`);
  unsigned(claims.generation, "generation");
  unsigned(claims.issuedAtTick, "issuedAtTick");
  unsigned(claims.expiresAtTick, "expiresAtTick");
  if (claims.generation === 0) throw new RangeError("generation must be nonzero");
  if (claims.expiresAtTick !== 0 && claims.expiresAtTick < claims.issuedAtTick) {
    throw new RangeError("expiresAtTick must be zero or at/after issuedAtTick");
  }
}

function unsigned(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) throw new RangeError(`${field} must fit uint32`);
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (right.byteLength !== SESSION_TOKEN_TAG_BYTES || left.byteLength < SESSION_TOKEN_TAG_BYTES) return false;
  let difference = SESSION_TOKEN_TAG_BYTES ^ right.byteLength;
  for (let index = 0; index < SESSION_TOKEN_TAG_BYTES; index += 1) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

export function createSessionTokenService(options: SessionTokenServiceOptions): SessionTokenService {
  return new SessionTokenService(options);
}
