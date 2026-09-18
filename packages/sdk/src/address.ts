declare const defoldUrlBrand: unique symbol;
declare const defoldRelativeAddressBrand: unique symbol;

/** Authoring spelling accepted by the compile-time hash intrinsic. */
export type DefoldHashLiteral<Name extends string = string> =
  Name extends "" ? never : `#${Name}`;

/**
 * A Defold hash in authored TypeScript.
 *
 * At runtime this is always an exact unsigned 64-bit bigint. The `#name`
 * branch is source-language syntax accepted only so ttsc can contextually
 * replace a literal with that bigint before JavaScript is emitted.
 */
export type DefoldHash<Name extends string = string> =
  | (bigint & { readonly __dehermHashV1: Name })
  | (DefoldHashLiteral<Name> & { readonly __dehermHashV1?: Name });

type HashLiteralName<Value extends DefoldHashLiteral> =
  Value extends `#${infer Name}` ? Name : never;

/**
 * Compile-time-only Defold hash intrinsic.
 *
 * The ttsc transform replaces `hashLiteral("#name")` with the exact unsigned
 * 64-bit bigint produced by Defold for `hash("name")`. The `#` is a sigil and
 * is not hashed. A dynamic string is deliberately rejected by the type.
 */
export function hashLiteral<const Value extends DefoldHashLiteral>(
  _value: Value & (Value extends "#" ? never : unknown)
): DefoldHash<HashLiteralName<Value>> {
  throw new Error("hashLiteral() must be compiled by the deherm ttsc transform");
}

/** Parsed Defold URL value with exact-width engine hashes. */
export interface DefoldUrl {
  readonly __dehermUrlV1: true;
  readonly socket: DefoldHash;
  /** Exact Defold ABI lane. Keep it even though engine APIs treat it as reserved. */
  readonly reserved: DefoldHash;
  readonly path: DefoldHash;
  readonly fragment: DefoldHash;
  readonly [defoldUrlBrand]: true;
}

/** Construct an explicitly branded, exact-width Defold URL for the native bridge. */
export function defoldUrl(
  socket: DefoldHash,
  path: DefoldHash,
  fragment: DefoldHash,
  reserved: DefoldHash = 0n as DefoldHash
): DefoldUrl {
  return { __dehermUrlV1: true, socket, reserved, path, fragment } as DefoldUrl;
}

/** A component on the current or a relative game object. */
export type DefoldFragmentAddress = `${string}#${string}`;

/** An absolute game-object path in the current socket. */
export type DefoldAbsolutePath = `/${string}`;

/** A socket-qualified address, including system sockets such as `@render:`. */
export type DefoldSocketAddress = `${string}:${string}`;

/** Defold's two context-relative shorthands. */
export type DefoldAddressShorthand = "." | "#";

/**
 * String literals whose Defold address structure can be checked by TypeScript.
 * Bare relative ids use `relativeAddress()` so an arbitrary string is never
 * silently accepted as an address.
 */
export type DefoldAddressLiteral =
  | DefoldAddressShorthand
  | DefoldFragmentAddress
  | DefoldAbsolutePath
  | DefoldSocketAddress;

export type DefoldRelativeAddress<Value extends string = string> = Value & {
  readonly [defoldRelativeAddressBrand]: true;
};

export type DefoldAddress = DefoldUrl | DefoldHash | DefoldAddressLiteral | DefoldRelativeAddress;

type WithoutAddressSeparators<Value extends string> =
  Value extends `${string}:${string}` | `${string}#${string}` ? never : Value;

/** Mark a bare relative game-object id after statically rejecting URL separators. */
export function relativeAddress<const Value extends string>(
  value: Value & WithoutAddressSeparators<Value>
): DefoldRelativeAddress<Value> {
  return value as unknown as DefoldRelativeAddress<Value>;
}

/** Identity helper that validates a structured Defold address literal. */
export function address<const Value extends DefoldAddressLiteral>(value: Value): Value {
  return value;
}
