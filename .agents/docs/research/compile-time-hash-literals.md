---
title: Compile-time Defold hash literals
description: Checker-bound ttsc lowering from typed hash sigils to exact Defold uint64 constants, with native vectors and target-separated evidence.
type: research
status: active
---

# Compile-time Defold hash literals

Déherm now treats a `#name` string literal as compile-time hash syntax whenever
TypeScript's contextual target is unambiguously `DefoldHash`. Thus both
`const fire: DefoldHash = "#fire"` and `takesHash("#fire")` emit Defold's exact
unsigned 64-bit constant without a runtime call. `hashLiteral("#name")` remains
an explicit intrinsic for contexts where no target type exists. The leading
`#` is an authoring sigil and is not part of the hashed bytes, so `"#up"` in a
hash context is exactly Defold `dmHashString64("up")`.

The checker recognizes the generated `__dehermHashV1` nominal contract rather
than relying on a type name. It handles typed declarations, arguments,
nullable values, object properties, arrays, tuples, assignments, and returns.
It deliberately leaves ambiguous `string | DefoldHash` contexts unchanged.
This syntax is also intentionally distinct from an address such as
`address("#sprite")`; arbitrary strings and Defold addresses are never
rewritten.

The TypeScript signature returns `DefoldHash<"name">`, rejects ordinary dynamic
strings, and rejects the empty `"#"` spelling. The ttsc plugin additionally
fails closed unless it sees one literal argument and resolves the callee symbol
to the `hashLiteral` import from `@ts-defold/deherm` or `@deherm/project`. A
locally shadowed function with the same name is left alone.

The transform is a TypeScript-Go `ProgramPlugin`, not an emit-only transformer.
That distinction matters because the pinned `ttsc` utility host applies linked
program plugins and then emits the mutated source-file AST. Both the JavaScript
reference implementation and Go transformer implement Defold's exact
`dmHashBufferNoReverse64` Murmur64 order over UTF-8 bytes. They emit a padded
unsigned bigint literal, for example `0x80356add32e752e9n`, rather than a
runtime `defold.hash` call.

## Evidence matrix

| Boundary | Evidence | Current result |
| --- | --- | --- |
| Defold ground truth | A constructor probe injected into the pinned macOS arm64 `dmengine` calls exported `dmHashString64` and `dmHashBufferNoReverse64` | `my_hash=a2bc06d97f580aab`, `up=80356add32e752e9`, Unicode `räksmörgås🚀=686b6237f73adab7` |
| Type surface | Negative `tsc` fixture plus positive contextual assignments/calls | Dynamic `string` and empty `"#"` fail; `#name` source literals are accepted only by the hash source-language branch |
| Actual ttsc host | Pinned `ttsc` compiles the fixture through the package plugin descriptor | Declarations, calls, nullable values, records, arrays, tuples, assignments, and returns become exact bigints; ambiguous unions, addresses, ordinary strings, and local shadows remain strings/calls |
| Development bundler | War Battles GUI compiles through `createIncrementalCompiler` and authenticated precompiled `dehermc` | Nine input-action hashes are constants; final bundle contains no `hashLiteral`, `defold.hash`, or hash stable-ID dispatch; the packed offline test proves no user-side Go host build |
| Diagnostic bundler | `deherm dev --no-ttsc` intentionally bypasses the transform plugin | A real diagnostic bundle retained the runtime `hashLiteral` call and reached packaged Wasm before the packaging guard; this mode remains inspectable but is now rejected by `verify-bundle`, `verify-generated`, and the Bob wrapper |
| Dynamic Hermes | The resulting War bundle compiles with the pinned `hermesc -emit-binary` | Bytecode generation passes with exact bigint constants |
| Browser host | The same ES2020 bundle is browser-compatible and the existing generated browser ABI splits unsigned bigints into two uint32 lanes | Compile/bundle shape proven; this wave did not execute the War input path in a live browser |
| Static Hermes | A strict sound-typed fixture consumes and compares the exact bigint, reports its explicit low/high lanes through `extern_c`, and emits C with pinned `shermes` | Typed constant representation proven; automatic `DefoldHash`-to-static-universal-handle materialization is still a backend integration gap |

The War Battles actions now dogfood the intrinsic. The generator enables the
ttsc plugin in generated project configuration, so this is a repeatable tool
path rather than hand-rewritten output.

The diagnostic path is intentionally different. A `--no-ttsc` bundle leaves
`hashLiteral` in JavaScript so runtime inspection can proceed, but it is not a
valid release or Bob input: the retained call once reached the packaged Wasm
bundle in a real War Battles run. The freshness record now carries the
transform setting, and all pre-Bob gates fail closed on `ttsc: false` while the
default inspection command continues to report the bundle and its fingerprints.

## Honest limitations

Compile-time use of `dmHashBufferNoReverse64` preserves the exact 64-bit value
but intentionally does not execute Defold's debug reverse-hash registration.
If human-readable reverse lookup is required in a debug profile, the compiler
should emit one deduplicated registration manifest rather than reintroducing a
hash call on every initialization path.

Static Hermes accepts the exact bigint in sound-typed code, but the current
universal Static provider represents hash-like handles as explicit low/high
uint32 lanes. A generated backend adapter still needs to split the compile-time
constant at the call boundary before this wave can claim a real Static Hermes
engine hash call. No such runtime claim is made here.

## Focused verification

```sh
node --test tests/hash-literal.test.mjs
pnpm exec tsc -p examples/war-battles-online/defold/tsconfig.deherm.gui.json
```
