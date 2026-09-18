import { hashLiteral } from "@ts-defold/deherm";

declare const ordinaryString: string;

// @ts-expect-error a runtime string cannot be a compile-time hash literal
hashLiteral(ordinaryString);
// @ts-expect-error the sigil must be followed by a non-empty hash name
hashLiteral("#");
