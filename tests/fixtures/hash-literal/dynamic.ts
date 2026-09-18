import { hashLiteral } from "@ts-defold/deherm";

declare const runtimeHashName: `#${string}`;
export const invalidDynamicHash = hashLiteral(runtimeHashName);
