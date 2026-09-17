---
type: Architecture Decision
title: Add directive-scoped math and shader language tooling
description: Reserve checker-aware use-math and use-gpu regions for operator syntax, backend-neutral math IR, TypeGPU integration, and first-class VS Code feedback.
tags: [decision, tooling, vscode, ttsc, math, typegpu, shaders, language-server]
status: proposed
generated: { by: codex/gpt-5, at: 2026-09-17T23:30:00-04:00 }
sources:
  - id: typegpu-unplugin
    resource: https://docs.swmansion.com/TypeGPU/tooling/unplugin-typegpu/
    title: TypeGPU build plugin
    author: team:software-mansion
  - id: typegpu-functions
    resource: https://docs.swmansion.com/TypeGPU/apis/functions/
    title: TypeGPU shader functions
    author: team:software-mansion
  - id: ttsc
    resource: https://ttsc.dev/docs
    title: ttsc compiler plugin documentation
    author: team:samchon
---

# Decision

Keep a future directive-scoped language lane on the VS Code frontier:

```ts
const integrate = defineMath((position: Vec3, velocity: Vec3, dt: number) => {
  "use math";
  return position + velocity * dt;
});
```

Inside the directive range, binary and unary expressions lower to a small
semantic math IR rather than ordinary JavaScript operators. Outside it,
TypeScript behavior is unchanged. Backend selection maps the same IR to
Defold `vmath`, xMath, Static-Hermes-native SIMD-friendly functions, TypeGPU,
or shader expressions.

The directive is a standard string-literal prologue, so source remains valid
TypeScript syntax and ordinary parsers can preserve it. It does **not** make
TypeScript's stock checker accept `Vec3 + Vec3`. This feature therefore requires
one coherent compiler/tooling implementation, not an emit-only AST rewrite:

* a ttsc transform-stage plugin must recognize the region, resolve operand
  types with the checker, validate operations, produce math IR, and emit the
  selected backend;
* the matching ttsc VS Code integration or Deherm language server must replace
  stock arithmetic diagnostics inside the region and provide hovers,
  completions, semantic highlighting, inlay result types, and a “show lowered
  form” command;
* source maps must map runtime failures and shader diagnostics back to the
  original operator expression.

No global operator overloading, prototype mutation, or runtime proxy is added.

# Math IR

The initial IR is intentionally small and typed:

```ts
type MathExpr =
  | { op: "literal"; type: ScalarType | VectorType; value: unknown }
  | { op: "load"; type: MathType; symbol: string }
  | { op: "add" | "sub" | "mul" | "div"; type: MathType; left: MathExpr; right: MathExpr }
  | { op: "neg" | "normalize"; type: MathType; value: MathExpr }
  | { op: "dot"; type: "f32"; left: MathExpr; right: MathExpr }
  | { op: "construct" | "swizzle"; type: MathType; values: readonly MathExpr[] };
```

Every operator rule is a table entry keyed by operand semantic types and
backend capability. That makes ambiguity visible. For example, vector-vector
`*` must be declared as componentwise multiplication, dot product, or forbidden;
the generator may not guess. Matrix/vector order, scalar promotion, precision,
temporary allocation, mutation, and NaN behavior receive the same explicit
tokens as the Defold API bindings.

# Backend contract

```text
TypeScript directive range
  -> checker-resolved math IR
     -> vmath calls
     -> xMath native module calls
     -> Static Hermes direct C ABI
     -> TypeGPU expression graph
     -> Defold GLSL shader assets
```

User configuration selects a default backend by semantic capability, not by
text substitution. xMath can override operations it proves equivalent and
fall back to `vmath` for the rest. Reachability analysis includes only selected
operators and adapters.

`"use gpu"` remains TypeGPU-owned where its compiler already supplies the
shader function model. Deherm should consume or adapt TypeGPU's graph rather
than fork its language. A later shared expression layer can allow a pure math
helper to be referenced from both `"use math"` gameplay code and `"use gpu"`
shader code when its operations exist in both capability sets.

# VS Code experience

VS Code is the only supported TypeScript authoring surface. The language tools
must show:

* the active math backend and resolved operation on hover;
* errors for unsupported operand pairs before build;
* semantic tokens that distinguish host math, native math, and shader math;
* inferred scalar/vector/matrix precision and allocation behavior as inlays;
* generated Defold material/uniform types for shader entry points;
* live lowered-code/IR preview for debugging the compiler rather than asking
  users to trust invisible magic.

# Gate before implementation

This lane remains behind complete API semantic resolution. Its first spike must
prove one vector integration function through the ttsc CLI and VS Code with
identical diagnostics, source maps, `vmath` and xMath lowerings, and no runtime
operator machinery. The shader extension then proves the same helper through
TypeGPU and Defold's shader pipeline. If ttsc cannot replace the relevant
checker diagnostics before emission, the syntax must fall back to explicit
typed combinators rather than suppressing real TypeScript errors.
