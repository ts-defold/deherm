import { address, hashLiteral, type DefoldHash } from "@ts-defold/deherm";

export const up: DefoldHash<"up"> = hashLiteral("#up");
export const unicode: DefoldHash<"räksmörgås🚀"> = hashLiteral("#räksmörgås🚀");
export const fire: DefoldHash = "#fire";

function acceptsHash(value: DefoldHash): DefoldHash {
  return value;
}

export const argumentHash = acceptsHash("#argument");
export const optionalHash: DefoldHash | undefined = "#optional";
export const configuredHash: { readonly id: DefoldHash } = { id: "#configured" };
export const hashArray: readonly DefoldHash[] = ["#array"];
export const hashTuple: readonly [DefoldHash, number] = ["#tuple", 7];

let assignedHash: DefoldHash = "#initial";
assignedHash = "#assigned";
export { assignedHash };

export function returnedHash(): DefoldHash {
  return "#returned";
}

function acceptsStringOrHash(value: string | DefoldHash): string | DefoldHash {
  return value;
}

// The target is ambiguous, so the compiler must preserve the string.
export const ambiguousString = acceptsStringOrHash("#ambiguous");
export const componentAddress = address("#sprite");
export const untouchedDynamicString = "ordinary";

export function localShadowIsNotAnIntrinsic(): string {
  const hashLiteral = (value: string): string => value;
  return hashLiteral("#local");
}
