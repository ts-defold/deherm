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
