// Source derivation consumes the compiler-owned policy schema and sealing
// contract. The generator owns discovery inputs; the compiler owns what a
// published policy means and how a consumer realizes it.
export * from "../../../compiler/src/api-policy.mjs";
