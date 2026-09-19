---
type: Research Note
title: Hermes-X upstream evaluation
description: Commit-level evaluation of tmikov/hermes, its Hermes-X integration branch and its faster-moving preview branches against déherm's pinned Meta Static Hermes toolchain.
tags: [research, hermes-x, static-hermes, toolchain, jsi, wasm, jit, android, windows]
status: active
generated: { by: codex/gpt-5, at: 2026-09-19T13:50:13-04:00 }
sources:
  - id: hermes-x-repository
    resource: https://github.com/tmikov/hermes
    title: tmikov/hermes
    author: Tzvetan Mikov
  - id: hermes-x-head
    resource: https://github.com/tmikov/hermes/commit/bacc663f7671ddec995308ac05833f87075f958d
    title: Hermes-X head inspected on 2026-09-19
    author: Tzvetan Mikov
  - id: cross-fork-comparison
    resource: https://github.com/facebook/hermes/compare/static_h...tmikov:hermes-x
    title: Meta static_h compared with tmikov/hermes hermes-x
    author: team:github
  - id: deherm-hermes-pin
    resource: https://github.com/facebook/hermes/commit/4947871513667919bf2fe225134af3e3a1a3772c
    title: Meta Hermes revision pinned by déherm
    author: team:meta-hermes
  - id: hermes-x-readme
    resource: https://github.com/tmikov/hermes/blob/bacc663f7671ddec995308ac05833f87075f958d/README.md
    title: Hermes-X README at the inspected revision
    author: Tzvetan Mikov
  - id: hermes-x-branches
    resource: https://github.com/tmikov/hermes/blob/bacc663f7671ddec995308ac05833f87075f958d/doc/Branches.md
    title: Hermes branches and releases
    author: Tzvetan Mikov
  - id: hermes-x-wasm
    resource: https://github.com/tmikov/hermes/tree/wasm-new
    title: Hermes-X WebAssembly preview branch
    author: Tzvetan Mikov
  - id: hermes-x-jit
    resource: https://github.com/tmikov/hermes/tree/x86-jit
    title: Hermes-X x86-64 and arm64 JIT development branch
    author: Tzvetan Mikov
  - id: hermes-x-no-icu
    resource: https://github.com/tmikov/hermes/tree/no-icu
    title: Hermes-X self-contained Unicode development branch
    author: Tzvetan Mikov
  - id: hermes-node-api
    resource: https://github.com/tmikov/hermes/blob/bacc663f7671ddec995308ac05833f87075f958d/API/napi/README.md
    title: Hermes Node-API v10 implementation and limitations
    author: team:meta-hermes
  - id: hermes-license
    resource: https://github.com/tmikov/hermes/blob/bacc663f7671ddec995308ac05833f87075f958d/LICENSE
    title: Hermes MIT license
    author: team:meta-hermes
  - id: preview-announcement
    resource: https://x.com/tmikov/status/2095911349020700856
    title: Preview-fork announcement and intended feature list
    author: Tzvetan Mikov
---

# Outcome

Hermes-X is the right **upstream repository for déherm to track**. It is the
author's exact fork of Meta's Static Hermes line: new work lands there first
and flows back into Meta more slowly. Déherm should therefore treat Hermes-X as
the leading source and Meta `static_h` as the downstream convergence line.

That repository decision is distinct from selecting today's exact production
commit. The named `hermes-x` integration branch is temporarily behind déherm's
current Meta pin, while its newest capabilities remain on sibling branches, so
the production-pin change still needs an integrated exact SHA rather than a
blind default-branch switch.

The repository is exactly the expected fork: `tmikov/hermes` is a public fork
of `facebook/hermes`, and `hermes-x` is its default branch. The announcement
describes the intended model accurately: work such as Wasm, x86-64 JIT, workers
and smaller features can be published there while Meta's export takes longer.
Commit history confirms that this development is real and active.
It also supports the stated upstreaming model: Meta `static_h` already contains
large Tzvetan-authored JIT and compiler series from the same lineage through
late August. What is not proven is a schedule for any particular preview
branch, or that the named integration branch is always ahead.

The fork's faster development model is reproduced by its active preview
branches. The narrower claim that the default `hermes-x` branch already
contains all of that work is **not reproduced at the inspected revision**.
At `bacc663f7671ddec995308ac05833f87075f958d` on 2026-09-19, the named branch:

* is 17 commits behind and two documentation/issue commits ahead of Meta's
  `static_h` head;
* is 12 implementation commits behind déherm's own Meta pin
  `4947871513667919bf2fe225134af3e3a1a3772c`;
* has no GitHub Releases, and its `v0.x` tags are inherited 2019 history;
* does not contain the active `wasm-new`, `x86-jit` or `no-icu` work. Those are
  sibling branches, respectively 96, 69 and 30 commits ahead of their common
  Meta base when inspected.

This is an integration-timing distinction, not uncertainty about which
repository to use. The recommended course is to add a Hermes-X canary lane now,
pin exact commits from the fork, and promote an integrated revision after it
contains both déherm's current fixes and the preview feature set we intend to
consume.

# Reproduced snapshot

The observations below came from `git ls-remote`, a filtered checkout with a
second `facebook/hermes` remote, Git ancestry and tree comparisons, and a local
compiler build. Social posts were used only to identify the intended project.

| Subject | Exact observation on 2026-09-19 |
| --- | --- |
| Repository identity | `tmikov/hermes`, GitHub fork parent `facebook/hermes`, default branch `hermes-x`, MIT |
| Hermes-X head | `bacc663f7671ddec995308ac05833f87075f958d`, committed 2026-09-05 |
| Meta `static_h` head | `7508017ae267ecffe4c4df38656713034f35d9bf`, committed 2026-09-18 |
| Common ancestor | `db0c2ed9fcd0ab099739023893158347b2d1ddf1`, committed 2026-09-01 |
| Named-branch divergence | Meta has 17 unique commits; Hermes-X has two unique commits, both docs/issue bookkeeping |
| Déherm pin versus Hermes-X | Déherm's pin has 12 commits Hermes-X lacks; Hermes-X has its two docs/issue commits |
| Preview activity | `x86-jit` head `1b2233df0` on 2026-09-19; `wasm-new` head `071eecf53` on 2026-09-14; `no-icu` head `c502b7ad9` on 2026-09-02 |
| Branch protection | GitHub reports `hermes-x` unprotected, with no required status checks |
| Published releases | GitHub Releases list is empty |

The 12 commits déherm would lose by changing only the URL/ref today include the
Windows `shermes` compiler-command path fix, `queueMicrotask`, JSON number
formatting improvements, RegExp capture-name fixes, and TypedLib String/Number
trampolines. The pinned revision is therefore newer in product-relevant ways.

# Toolchain reproduction

The exact Hermes-X head configured on macOS arm64 with the flags used by
`toolchains/hermes/build-host-compilers.sh`:

```sh
cmake -S . -B /private/tmp/deherm-hermes-x-build -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DHERMES_ENABLE_TEST_SUITE=OFF \
  -DHERMES_ENABLE_NAPI=OFF \
  -DHERMES_ENABLE_INTL=OFF
cmake --build /private/tmp/deherm-hermes-x-build \
  --target hermesc shermes --parallel 8
```

Both targets built successfully (256 Ninja steps). `hermesc --version` and
`shermes --version` report Hermes 1.0.0 and HBC bytecode version 99. A tiny JS
program emitted a 348-byte `.hbc`; a strict typed TypeScript program emitted a
4.7-KiB C unit with déherm's real invocation shape:

```sh
shermes -fno-std-globals -parse-ts -typed -strict -O -emit-c \
  -o smoke.c smoke.ts
```

This proves host-tool source compatibility on this host only. It does not prove
the target runtime archives, Extender linkage, packaged Defold execution, or
the other four host compiler packages.

# Compatibility matrix

| Concern | Déherm Meta pin | Hermes-X named branch today | Preview branch implication | Decision |
| --- | --- | --- | --- | --- |
| Static Hermes compiler/runtime | Already used and packaged | `shermes`, `static_h.h` and the C emission path build; `static_h.h` is byte-identical to the déherm pin | `x86-jit` adds a Static Hermes `Math.imul` ABI entry | Compatible at the named head, but always rebuild compiler and runtime from one commit |
| Hermes bytecode | HBC 99 | HBC 99 | `wasm-new` deliberately bumps to HBC 100 | Never mix `.hbc`, host compiler and VM across pins; bundle fingerprint must include Hermes identity and HBC version |
| Core JSI API | Current `API/jsi` tree | Byte-identical to the déherm pin | `wasm-new` adds `IWasmModuleResolver`/`IWasmModuleProvider`; Meta head has a documentation-only event-loop edit | Source-compatible at the named head; recompile all glue anyway because C++ ABI is not promised by the matching header hash |
| Hermes embedding API | `makeHermesRuntime`, `IHermes::evaluateSHUnit`, runtime config | Same required surfaces | Wasm adds extension/runtime configuration; feature branches can change internals | Add compile probes for every symbol déherm consumes, not only a tree hash |
| TypeScript/Static Hermes | Partial TS-to-Flow conversion plus déherm's known upstream fix work | Same partial converter; docs explicitly say typed support is under development | No inspected branch contains déherm's function-expression return-annotation patch | Hermes-X does not remove the need for the TS conformance corpus or upstream patch gate |
| macOS/Linux | Current builders exist | Host compilers reproduced on macOS arm64; source layout and targets match | JIT feature branches are actively tested on desktop architectures | Canary build and run; no special migration required at the named head |
| Windows | CI builder exists; current pin includes the Windows `shermes` CC path fix | Named branch predates that fix | `x86-jit` documents x86-64 SysV as non-Windows; it is not a Windows JIT | Do not promote until Windows native compiler, emitted-C and `hermes.lib` lanes pass |
| iOS | Interpreter/bytecode and Static Hermes AOT; JIT is not needed | No material named-branch delta | JIT config disables unsupported Apple targets except macOS/Mac Catalyst | Keep JIT off; rebuild arm64 device and simulator archives and run packaged smoke tests |
| Android ICU | Current pin uses déherm's filtered static ICU backend and static fbjni | Named branch has the same backend layout | `no-icu` replaces ICU with generated Hermes tables, but is not in `hermes-x`; Android still defaults to Java unless déherm selects the new Hermes backend | Exact named-head migration does not fix Android CI; evaluate `no-icu` separately before deleting ICU |
| Android fbjni | Still required by `API/hermes/hermes.cpp` under `__ANDROID__`; déherm suppresses the JNI finalizer runner explicitly | Same | `no-icu` removes ICU, not the unconditional fbjni reference in the inspected lineage | Keep fbjni and the explicit empty `ThreadRunner`; rerun GC/finalizer device evidence |
| Web target | Browser's own JS VM; no Hermes in Defold Wasm | Unaffected | `wasm-new` is Wasm *inside Hermes*; old `shermes-wasm` is 2,117 commits behind Meta and not a viable product pin | Preserve browser-host design; evaluate Static-Hermes-to-Wasm only as a separate optional benchmark lane |
| Debugger/CDP | Debugger-enabled second runtime archive; CDP transport still déherm work | Public debugger and instrumentation headers are byte-identical; branch lacks the newer `Uncaught` exception-display fix | JIT and Wasm add new execution paths that need debugger coverage | Run breakpoints, source maps, CPU sampling and heap snapshots before promotion |
| React Native modules | JSI is present, React Native/TurboModule runtime is not | Same JSI header compatibility | Preview work does not bundle React Native's codegen/module registry | Plain JSI libraries can be adapted; TurboModules/Nitro modules are not drop-in |
| Node-API addons | Déherm builds with `HERMES_ENABLE_NAPI=OFF` | Source advertises N-API v10, but the same build option disables it | `hermes-node` exercises a broader host, but is a separate integration branch | Treat N-API as a future opt-in runtime profile with loader/event-loop/ABI tests, not current compatibility |
| License | Meta Hermes MIT plus déherm's current ICU/fbjni notices | Root remains MIT | Wasm vendors WABT under Apache-2.0; x86 JIT vendors asmjit under zlib; generated Unicode-data provenance still needs a release-package notice audit | Legally compatible in principle; generate a per-pin third-party inventory before shipping |
| Release provenance | Exact SHA, content-addressed host and target archives | Branch is moving and unprotected; no release assets | Feature branches move independently | Pin a full SHA only; never consume the branch name or an unverified binary |

# Feature assessment

## x86-64 and improved arm64 JIT

The work is substantial: the branch carried 69 commits not in Meta `static_h`
at inspection time and documents a complete x86-64 SysV backend plus shared
arm64 improvements. It is valuable for desktop development and potentially
long-running dynamic code. It is not the release execution model déherm is
optimizing first: iOS remains no-JIT, browser builds use the browser engine,
and Static Hermes release units are already AOT native code.

Adopt it only as an opt-in development runtime after measuring game workloads.
Do not enable it in every archive merely because it exists; that would trade
binary size and executable-memory policy for a speedup that typed AOT routes do
not use.

## WebAssembly support

`wasm-new` is active and meaningful, but it is easy to conflate three different
things:

1. Hermes compiling/running as an Emscripten Wasm engine;
2. `shermes` compiling JS/TS to Wasm;
3. the `wasm-new` branch adding `WebAssembly.*` support **inside Hermes**.

The preview branch is primarily (3). It adds embedder interfaces for trusted
precompiled Wasm modules and bumps HBC from 99 to 100. That could eventually let
native déherm code consume Wasm-native libraries consistently, but it is not a
reason to put Hermes inside Defold's HTML5 build. The existing browser-host lane
remains smaller and more ergonomic.

The old `shermes-wasm` branch is four commits ahead but 2,117 commits behind the
current Meta line; it is historical evidence, not a pin candidate.

## Self-contained Unicode / no ICU

This is the preview with the largest immediate build payoff for déherm. The
`no-icu` branch adds generated normalization, case-conversion and DUCET
collation tables, and a `HERMES_PLATFORM_UNICODE_HERMES` backend. If it passes
size and conformance gates, it could delete the most expensive part of the
Android Dockerfile and eliminate its ICU source/data downloads.

It does **not** eliminate fbjni by itself. Android `hermes.cpp` still compiles
fbjni finalizer-thread support based on `__ANDROID__`, and déherm's explicit
empty finalizer runner remains required unless that source contract also
changes. Android must select the new backend explicitly while
`HERMES_IS_ANDROID=OFF`; otherwise `__ANDROID__` still chooses the Java backend.

# React Native and module compatibility

Hermes-X improves the engine, not the surrounding React Native product. The
core `jsi.h`, `instrumentation.h` and `static_h.h` trees at the named head match
déherm's current pin, which is encouraging for source-level JSI adapters.

That does not make an arbitrary React Native module portable. A TurboModule or
Nitro module can depend on React Native codegen, CallInvoker, scheduler, Fabric,
JNI/ObjC scaffolding, package registration, Yoga or the Nitro runtime. Déherm
would have to generate or implement those host contracts. Modules whose native
core already exposes plain C/C++ or JSI are the best candidates.

Hermes' Node-API v10 implementation is a second compatibility route, but
déherm currently disables it in every build. Enabling it adds a native addon
loader, host async/event-loop integration and packaging/security questions.
The upstream README itself records skipped Node tests and weak-reference
shutdown limitations, so it is not a zero-work substitute for generated
Defold bindings.

# Concrete déherm changes required for a pin

No source or pin was changed by this evaluation. A future promotion must be one
atomic toolchain update, not an `upstream.lock` URL edit by itself:

1. Change `HERMES_URL`, `HERMES_REF` and `HERMES_REV` in `upstream.lock`, with
   the full commit SHA. The revision, not the branch, is authoritative.
2. Regenerate the recorded Hermes revision in
   `packages/toolchains/host-compilers.json` and
   `packages/toolchains/native-artifacts.json`.
3. Rebuild all five host compiler archives and every native Defold target.
   `scripts/lib/artifact-releases.mjs` already fingerprints `HERMES_URL` and
   `HERMES_REV`, so both `hermes-host` and `native-artifacts` release tags must
   rotate; `dehermc` correctly must not rotate.
4. Regenerate `packages/toolchains/release-tags.json`, package digests and byte
   counts only from completed artifacts. Never relabel an old Meta-built
   archive under the new fork pin, even when public headers compare equal.
5. Keep `hermesc`, `shermes`, `libhermes` and generated HBC/C units from one
   revision. Record HBC version, JSI-tree digest, `static_h.h` blob ID and CMake
   feature flags in the release manifest as diagnostics, not as permission to
   mix revisions.
6. If the selected revision includes `no-icu`, replace the Android ICU recipe
   deliberately and add Unicode size/conformance tests; do not merely remove
   libraries until unresolved-symbol and non-ASCII runtime probes pass.
7. If it includes Wasm or JIT, make each feature an explicit build profile. New
   defaults must not silently inflate every release archive.

# Staged evaluation gates

## Gate 0: candidate identity and delta

* Resolve the selected branch to a full SHA and archive the cross-fork compare.
* Require the candidate to contain déherm's current pin or enumerate and
  consciously restore every missing fix.
* Produce a machine-readable delta for HBC version, JSI headers, Static Hermes
  C ABI header, exported symbols, CMake options and third-party licenses.
* Reject a moving ref, missing license inventory, or unexplained bytecode bump.

## Gate 1: host compiler matrix

Build `hermesc` and `shermes` on darwin-arm64, darwin-x64, linux-arm64,
linux-x64 and win32-x64. Run:

* `--version` and bytecode-version probes;
* bytecode compilation and execution;
* the strict TypeScript-to-C corpus, including the known TS2Flow edge cases;
* generated déherm typed-native bridge emission;
* Windows paths containing spaces, because the named Hermes-X head currently
  predates that upstream fix.

## Gate 2: target library matrix

Build release and debugger archives for macOS, Linux, Windows, iOS device and
simulator, and all three Android ABIs. Compare exported symbols and archive
members with the current pin. Link them through the real Extender, not a
standalone CMake executable.

## Gate 3: packaged runtime conformance

For each target class, run source, HBC and mixed Static Hermes units through the
same generated Defold-call trace. Exercise GC/finalizers, weak references,
callbacks, hot reload and shutdown. Android additionally needs a host-function
and HostObject finalization cycle proving the explicit runner prevents fbjni
attachment; `no-icu` additionally needs normalization, case, collation and date
vectors outside ASCII.

## Gate 4: developer tooling

Prove source maps, breakpoints, exception rendering, CPU sampling, allocation
tracking and heap snapshots with the debugger archive. If JIT is enabled, repeat
breakpoint and profiler probes before and after tier-up. A debug archive that
links is not debugger evidence.

## Gate 5: performance and size

Measure startup, update-loop tail latency, peak RSS, GC pauses, final package
size and typed-native call cost against the existing Meta pin. Run JIT and
no-JIT as separate profiles. Promote only a profile with an explicit win or a
needed capability; do not average incompatible target policies together.

## Gate 6: promotion and rollback

Publish artifacts under the new content-derived tags, run the installed npm
package against them, then change the default pin. Retain the previous release
tags and a one-switch rollback until the full example and nightly matrix pass.

# Explicit unknowns and alerts

* When the `hermes-x` integration branch will absorb `wasm-new`, `x86-jit` and
  `no-icu` is not documented.
* No release SLA, signed tags, required status checks or published binary ABI
  promise was found. The announcement says ABI-compatible binaries are
  optional, not delivered.
* The exact compatibility policy between the fork's preview binaries and React
  Native releases is not published. Déherm must assume source pinning and full
  rebuilds, never binary interchangeability.
* The no-ICU branch's generated Unicode data needs a packaging-level provenance
  and notice audit before distribution, even though the surrounding source is
  MIT.
* Wasm, JIT and no-ICU currently live on separate branches. Their combined
  merge behavior is unproven; selecting one does not select the others.
* Windows JIT is explicitly outside the inspected x86-64 SysV design. Windows
  engine/runtime support and Windows JIT support are separate claims.
* The Hermes-X host compiler build succeeded only on macOS arm64 in this
  evaluation. Every other platform remains unverified until the staged matrix
  runs.

Create an alert/report whenever the resolved `hermes-x` SHA changes. The report
should state ahead/behind counts against both Meta `static_h` and déherm's pin,
which preview branches are contained, whether HBC or public ABI digests moved,
and which gates need to rerun. A new upstream commit is a candidate, not an
automatic rebuild or promotion.
