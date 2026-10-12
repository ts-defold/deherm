---
type: Research Note
title: Static Hermes TS2Flow return-annotation upstream fix
description: Reproduction, patch, official-test evidence, draft PR, and carry policy for missing TypeScript return conversion on function expressions.
tags: [research, static-hermes, typescript, ts2flow, upstream]
status: active
generated: { by: codex/gpt-5, at: 2026-09-17T19:57:43-04:00 }
sources:
  - id: draft-pr
    resource: https://github.com/facebook/hermes/pull/2188
    title: "Draft PR #2188: TS2Flow: convert function expression return types"
    author: Justin Walsh
  - id: pinned-converter
    resource: https://github.com/facebook/hermes/blob/4947871513667919bf2fe225134af3e3a1a3772c/lib/AST/TS2Flow.cpp
    title: TS2Flow converter at the Deherm Hermes pin
    author: team:meta-hermes
  - id: contributing
    resource: https://github.com/facebook/hermes/blob/static_h/CONTRIBUTING.md
    title: Hermes contribution guide
    author: team:meta-hermes
---

# Outcome

The fix is published as draft upstream PR
[`facebook/hermes#2188`](https://github.com/facebook/hermes/pull/2188). It targets
`static_h`, contains one commit (`dcd1758427b1a1c1c336cc5f4e606fcb34e47091`),
and changes only:

* `lib/AST/TS2Flow.cpp`;
* `test/AST/ts2flow/function-expression-return-types.ts`.

The PR intentionally remains a draft. The Meta import checks pass, while the
Meta CLA check currently reports `ACTION_REQUIRED`; the maintainer must finish
that external account step before asking upstream for review.

# Reproduced claim

Deherm pins Hermes revision
`4947871513667919bf2fe225134af3e3a1a3772c`. Building unmodified `shermes` from
that revision and compiling a function expression, arrow function, and class
method with explicit TypeScript return annotations produced three diagnostics:

```text
ts2flow: remaining TS node TSTypeAnnotation in FunctionExpression
ts2flow: remaining TS node TSTypeAnnotation in ArrowFunctionExpression
ts2flow: remaining TS node TSTypeAnnotation in FunctionExpression
```

The exact compiler shape was:

```sh
shermes -fno-std-globals -typed -parse-ts \
  -dump-transpiled-ast -pretty -script repro.ts
```

The then-current `static_h` head was
`49d1fc1f6e3f757c1e1f76ad625db1453f97dadb`. The relevant converter and test
directory had not changed between the Deherm pin and that head, so the branch
was created from current `static_h` without changing the reproduced root cause.

# Root cause and scope

`TS2FlowConverter` already converted the scalar `_returnType` field in its
specialized `FunctionDeclaration` visitor. Generic child traversal cannot
replace a TypeScript node stored in a scalar field. `FunctionExpression` and
`ArrowFunctionExpression` therefore retained `TSTypeAnnotation`; class methods
failed because their method value is represented as `FunctionExpression`.

The patch adds equivalent visitors for those two runtime function node kinds.
It does not change generic type parameters, add new TypeScript type forms, or
combine the separate TypedLib/global-library concerns into this PR.

# Verification

The unpatched pinned build failed with all three diagnostics above. After the
two-visitor fix, the official lit regression and the complete focused TS2Flow
AST directory passed:

```sh
cmake --build build/native --target shermes FileCheck -j4

python3 build/native/bin/hermes-lit -sv \
  --param test_exec_root=/tmp/deherm-hermes-lit \
  --param shermes=build/native/bin/shermes \
  --param FileCheck=build/native/bin/FileCheck \
  --param FileCheckOrRegen=build/native/bin/FileCheck \
  upstream/hermes/test/AST/ts2flow
```

Observed result: `Expected Passes: 5`.

# Compile/run preflight (2026-10-12)

The pinned checkout is still `4947871513667919bf2fe225134af3e3a1a3772c`.
Its source has the special `FunctionDeclarationNode` visitor that converts
`_returnType`, but no equivalent visitors for `FunctionExpressionNode` or
`ArrowFunctionExpressionNode`. The manifest-verified cached `shermes`
(`48fbc165eb43d9bd7925a17142a52bbad3eebedbf064b182bc8b54a4e258befd`) reports
the three expected remaining-`TSTypeAnnotation` errors for a function
expression, arrow, and class method under:

```sh
shermes -fno-std-globals -typed -parse-ts \
  -dump-transpiled-ast -pretty -script repro.ts
```

The same pinned source build executes an explicitly typed function declaration
with `-parse-ts -typed -strict -script -exec` and prints `42`. This confirms
the compile/run invocation; it does not clear the expression/arrow regression.

The PR's AST regression should be supplemented with this focused
compile-and-run lit test after the visitor fix. It covers the same two visitor
paths and the class-method representation, then checks the observable result:

```ts
// RUN: %shermes -fno-std-globals -typed -strict -parse-ts -script -exec %s

const expression = function (value: number): number { return value + 1; };
const arrow = (value: number): number => value + 2;
class ReturnTypes {
  method(value: number): number { return value + 3; }
}
if (expression(39) + arrow(39) + new ReturnTypes().method(39) !== 126) {
  throw "return-type smoke failed";
}
```

TypeScript `number` return annotations already map to Flow's existing
`NumberTypeAnnotation` inside the existing `TypeAnnotation` wrapper. The
change is parity in the TS-to-Flow conversion path, not a new type-system or
optimization feature. The compile/run test shows that the converted
annotations reach the existing typed checker and execute; it does not prove a
performance gain or validate a whole application.

## Deherm parser/runtime smoke boundary (2026-10-12)

The Deherm fixture
`tests/fixtures/static-hermes-flow-compatible-function-return-types.ts` is
compiled without `-parse-ts`, so it exercises the typed Flow-compatible
grammar and runtime only. It is not evidence for TS2Flow conversion. The
manifest-verified cached compiler accepts it with
`-fno-std-globals -typed -strict -O -emit-c`; the CMake-integrated runner also
executes it using the local source-built compiler from the same upstream
revision (not the manifest-identical binary).

Adding `-parse-ts` to that same pinned compiler fails on all four annotated
function expressions: the extern callback, ordinary function expression,
arrow function, and class method each retain `TSTypeAnnotation`. Therefore the
fixture and runner are labeled as a typed Flow-compatible parser/runtime smoke;
only the separate Hermes lit test and PR diff are TS2Flow conversion evidence.
The focused command is:

```sh
cmake --build build/native --target defold-hermes-static-runner --parallel 4
build/native/defold-hermes-static-runner --flow-compatible-only
```

This is a compile-and-run smoke against the application runtime, not an
independent upstream lit-suite pass, TS2Flow conversion test, or evidence that
the complete game bundle is sound-typed.

I attempted a fresh read of draft PR #2188, but GitHub was unavailable in this
environment (`gh` could not connect to `api.github.com`, and `git fetch` could
not resolve `github.com`). The pinned source and the prior recorded PR identity
remain locally inspectable; the current remote diff, checks, and CLA state
could not be independently refreshed in this preflight.

# Carry and removal policy

Keep `HERMES_REV` on the verified upstream commit in `upstream.lock`; do not
replace the product dependency with the contributor fork. Until the fix lands
and the pin advances to a containing revision, the Deherm strict-TypeScript
build may carry only the exact two-visitor patch represented by commit
`dcd1758427b1a1c1c336cc5f4e606fcb34e47091`, with the focused lit test run as a
bootstrap gate.

The current nested checkout contains that commit for local development, but
`scripts/bootstrap-upstreams.sh` resets Hermes to `HERMES_REV`. Therefore a
clean bootstrap must not silently claim strict TypeScript support unless it
either applies a checksum-recorded copy of the patch or pins an upstream
revision containing the merged change.

Remove any carried patch immediately after `HERMES_REV` advances to a commit
that contains the upstream fix, then rerun the strict application, exported C
unit, and focused TS2Flow tests against the unmodified upstream tree.
