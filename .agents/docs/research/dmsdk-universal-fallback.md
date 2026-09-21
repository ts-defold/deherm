---
title: dmSDK universal fallback and usage materializer
description: Deterministic all-declaration recipes and a fail-closed caller-owned C ABI materialization path for dmSDK.
type: research
status: active
---

# dmSDK universal fallback

The dmSDK compiler now emits a mechanically consumable recipe for every one of
the 1,361 runtime declarations in the pinned Clang-derived projection IR. This
is the completeness fallback beneath the specialized scalar, span, handle, and
string families; specialized adapters remain preferred whenever they exist.

Each recipe contains the exact source declaration identity, header/include,
native signature shapes, receiver and template invocation form, caller-owned
frame layout, required semantic tokens, and target projections for C ABI,
Dynamic Hermes, Static Hermes, browser/Wasm direct memory, and TypeScript.
There is no “unsupported and omitted” catalog state. That is not the same as
claiming every recipe is safe to instantiate without policy. Shapes that
cannot be eagerly instantiated become usage-materialized recipes. Specialized
adapter bypasses, record layout assumptions, callback trampolines, typed
variadic facades, and out/scratch storage require structured acknowledgements
with a reason and evidence. Callback parameters additionally require an
explicit named trampoline. The materializer refuses these cases otherwise.

The common ABI uses a fixed 24-byte value cell and a caller-owned argument
frame. The dispatcher performs exact ID, arity, and storage validation without
heap allocation and invokes an installed generated provider. Each generated
catalog has a SHA-256 identity embedded in C, TypeScript, recipes, CLI input,
and materialization reports; mismatched catalogs fail before code emission.
HTML5 metadata calls
the same memory ABI directly and explicitly does not use Embind.

Native Dynamic Hermes installs a generated `DmSdkUniversal.call(id, values)`
JSI module into `__defoldModulesV1`. It validates the catalog identity, exact
IDs and arity, finite numbers, signed/unsigned bigint ranges, pointer width,
and the discriminated address/memory/native-value objects before dispatch.
Results are decoded from the ABI tag without lossy integer conversion. The
browser registration deliberately exposes `DmSdkUniversalRaw`, not the typed
`DmSdkUniversal` bridge: it is a direct-memory ABI requiring a browser-side
arena adapter that has not yet been implemented. Its Emscripten dependency
list retains both dispatch and catalog symbols. Static Hermes continues to use
the generated direct-memory extern-C surface rather than JSI.

`@deherm/compiler/dmsdk-universal-materializer` accepts the reachable
declaration IDs plus any required type substitutions and emits the C++ thunks
for that user project. The generated recipe catalog is therefore complete,
while the final native or Wasm binary only links materialized reachable thunks.
Generated thunks validate scalar tags and narrow integer ranges, boolean
domains, non-null pointer/reference/receiver addresses, target pointer width,
and native alignment. Enum arguments fail closed until the usage supplies an
explicit finite domain. Scalar-backed handles use their scalar cell tag;
address-backed handles use the address tag.

Every emitted production wrapper now has a same-resolution exact twin. Both
are derived in one pass from the selected recipe, receiver type, template
arguments, type substitutions, enum domains, callback trampoline, custom
argument expressions, and result override. The verification manifest records
the compile-time call expression and overload ABI, receiver mode, ordered
native parameters, fake result, and declared transport-level ownership
contract. Its native driver installs the exact provider, calls the common
production dispatcher, and requires one ABI-compatible recording-fake call
with matching receiver/arguments and result cell. This demonstrates ABI
carrier, order, and result handling, not linkage to the Defold library or
runtime ownership lifecycle effects.

Generic by-value record arguments and results fail closed until a typed
size/alignment/lifetime provider exists. Pointer/span pairs retain distinct
ordered pointer and length observations.
Constructor and destructor vectors preserve the caller-storage receiver ABI
and carry declared construct/destroy contracts, but the fake does not execute
or observe an object-lifetime transition. Callback and handle vectors check
identity transport without claiming that unresolved semantic lifetime or
ownership policy has been solved.

The arbitrary C extension-header generator follows the same manifest contract
for every unblocked route: compile-time `extern "C"` call/signature identity,
ordered arguments, result, and call/failure counters. Its ownership metadata
is a declared contract and is not recorded as a runtime effect. Record, pointer,
and variadic extension declarations remain explicitly blocked until that
generator owns their layout or facade policy.

## Current evidence

- 1,361 unique declaration IDs produce 1,361 recipes and stable numeric IDs.
- All 1,361 have C ABI, Dynamic Hermes metadata, Static Hermes, browser direct
  memory, and TypeScript projections; the omission count is zero.
- 146 declarations prefer an existing specialized generated family; the other
  1,215 retain the universal usage-materialized path. Of those 146, 59 have a
  callable generated adapter and 87 remain provider-gated.
- Clean-room regeneration reproduces all universal artifacts byte-for-byte.
- The generated common dispatcher is compiled into the local native runtime.
- A mixed usage selection generates, compiles, links, and executes pinned
  `dmEndian` direct calls, a monomorphized `dmMath::Clamp<int32_t>`, plus
  `dmArray<uint32_t>` construction, member access, and destruction through the
  common C ABI dispatcher.
- The generated recording driver also executes representative enum, scalar and
  pointer-backed handles, callback trampoline, C string, reference/value, and
  pointer/length span routes. Each vector compiles the selected call
  expression/overload and checks ABI carrier, receiver, ordered native
  arguments, and result encoding. A negative test proves generic by-value
  `dmSocket::Address` transport fails closed without a typed provider.
- The compiler-owned Static Hermes applicability partition accounts for all
  486 universal-ready exact vectors from the same manifest. All 486 currently
  fit the 32-cell frame and its declared wire-tag set, so the strict sound-typed
  unit executes each through acquire/set/dispatch/result/release, checks exact
  call/failure observations, and compares all six result-cell fields. Future
  over-capacity or unknown-tag vectors remain in the report with
  machine-readable `blocked-capability` reasons.
  The runtime report independently records 486 executed vectors, a maximum
  exercised arity of nine, argument tag mask `0x3e`, and result tag mask
  `0x3f`; planned/applicable counts are not promoted to runtime evidence.
- The native harness exercises unsigned narrowing rejection, receiver-backed
  construction/member/destruction, and uses `std::destroy_at` for deterministic
  destructor generation. Negative generator tests cover catalog drift,
  specialized-bypass policy, and illegal arity overrides.
- An executable Hermes test calls generated `dmEndian::ToNetwork(uint32_t)`
  and `ToHost(uint32_t)` materialized thunks through the installed JSI module
  and common C dispatcher, and verifies the bigint round trip. This proves the
  two selected usage-materialized routes, not all catalog recipes.
- The canonical 486-vector universal-ready corpus now has a generated browser
  applicability partition derived from wire tags and arity. All 486 current
  vectors are applicable. A pinned Emscripten 4.0.6 module and Chrome run import
  the production generated `browser-arena.ts` adapter, encode every vector into
  the live Emscripten heap, call the common dispatcher through direct exports,
  and compare the generated call count, failure count, and decoded result.
  The run balanced 994 scratch allocations with 994 reverse-order releases and
  observed a 240-byte peak; it uses no mock memory, Embind, `ccall`, or `cwrap`.
  Memory growth is enabled. A forced-growth regression proves string allocation
  cannot leave a detached `DataView`, and exact C-string fixtures now carry and
  verify their UTF-8 byte length in the universal auxiliary field.

This does not claim that all 1,361 native engine implementations have been
linked or behavior-tested. Most are recipes awaiting a real project's reachable
usage and semantic policy. It does prove that the compiler has a deterministic
code-generation path instead of silently dropping those declarations.

The emitted production transports remain the common native C ABI provider,
the generic Dynamic Hermes `DmSdkUniversal` module, Static Hermes direct-memory
C ABI, browser/Wasm direct memory, and TypeScript stable-ID surface. The exact
twin is consumed by both the native verification transport and the real-browser
JavaScript arena runner for the declaration-only ready corpus. It does not add
usage-specific Static Hermes or browser runners for the 875 recipes that still
need call-site specialization, nor does the arbitrary extension-header lane
install JSI, Static Hermes, or browser modules.

Remaining blockers are explicit: callback trampolines still need a project
callback registry; all generic by-value record arguments/results and
out-storage recipes need per-shape typed size/alignment/lifetime providers;
enum domains should eventually be
harvested directly from the SDK IR instead of supplied by reachable usage; and
the full catalog has not yet been linked and behavior-tested against every
engine feature/target matrix.
