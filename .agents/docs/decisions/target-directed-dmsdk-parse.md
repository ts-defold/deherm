---
type: Architecture Decision
title: Parse the dmSDK under a declared, platform-neutral environment, never the deriving host's
description: The declaration inventory is taken with an explicit clang triple and a digest-pinned sysroot, in an assignment where no platform branch is taken, so a Linux runner and a macOS laptop derive the same policy root; which target gets which declaration is answered separately from the same declared macro assignment.
tags: [decision, generator, dmsdk, derivation, reproducibility, ci, policy]
status: accepted
generated: { by: claude/opus-5, at: 2026-09-19T12:00:00-04:00 }
sources:
  - id: revision-parametric-derivation
    resource: ./revision-parametric-derivation.md
    title: Derive another revision in a scratch workspace, never in the checkout
    author: project:deherm
  - id: layered-cache
    resource: ./layered-api-policy-cache.md
    title: Cache source-derived API policies in layers, keyed by content hash
    author: project:deherm
  - id: build-input
    resource: https://github.com/defold/defold/blob/7f0f554f41f9dce1e0ddff99bf08200657d1ee05/share/extender/build_input.yml
    title: Defold's own per-bundle-target define lists
    author: team:defold
  - id: wasi-sysroot
    resource: https://github.com/WebAssembly/wasi-sdk/releases/tag/wasi-sdk-25
    title: wasi-sysroot 25.0
    author: team:wasi-sdk
---

# Problem

`scripts/import-defold-sdk.py` is the head of the derivation chain: every other
generated artifact, and the published API policy, is a function of the inventory
it produces. It used to produce that inventory with the host `clang++`, no
`-target`, `-DDM_PLATFORM_OSX=1` hardcoded into the command, and
`"platform": "arm64-macos"` written into the output unconditionally.

That made the policy a function of the machine. Three consequences, each
measured rather than supposed:

* **The nightly derivation was pinned to macOS.** `policy-revisions.yml` carried
  `runs-on: macos-15` with a comment saying why: an Ubuntu runner would produce
  an IR labelled for a platform it was not parsed for. The pin did not fix the
  defect, it hid it.
* **The two hosts genuinely disagree.** Running the importer's own parse on
  Ubuntu 24.04 and on macOS 15 produced different declarations in **79 of the
  121** public headers. The first one is `dmDDF::OPTION_OFFSET_POINTERS`, whose
  type is `const uint32_t` on one host and `const int` on the other, because
  `<stdint.h>` resolved on one and not the other and clang recovered silently.
* **The host label reached the published policy.** `@shared` carried
  `dmsdk.platform: "arm64-macos"`, so every consumer of every published policy
  was told the engine's declaration surface was a macOS one.

# Decision

**The parse environment is declared, not inherited.** Two declarations, in the
two places that already own their kind of ground truth.

`packages/bindings/overrides/dmsdk-target-macros.json` gains a
`declarationParse` block naming the clang triple and the defines the parse runs
under. `upstream.lock` gains `DMSDK_PARSE_SYSROOT_URL`, `_SHA256` and
`_INCLUDE`, pinning the C library headers the parse resolves against.

**No platform branch is taken.** The triple is `wasm32-unknown-unknown`, the one
real clang triple that predefines none of `__APPLE__`, `__APPLE_CC__`,
`__linux__`, `_WIN32`, `_MSC_VER`, `ANDROID`, `__ANDROID__` or `__EMSCRIPTEN__`,
and no `DM_PLATFORM_*` is passed. Every platform conditional in a dmSDK header
therefore falls to its `#else`.

This is what makes the parse possible on any machine at all.
`dmsdk/graphics/graphics_native.h` includes `<objc/objc.h>` for Apple,
`<Windows.h>` for Windows, `<GL/glx.h>` for Linux and the EGL/Android headers
for Android - and supplies a `typedef void*` fallback beside each one. No
machine has all four SDKs, and shipping stand-ins for them would mean inventing
an API rather than deriving one. Taking the fallback arm needs none of them.

The neutrality is **asked of the compiler**, not asserted: the importer runs
`clang++ -target <triple> -dM -E` and refuses to derive anything if any macro in
the declared `neutralOf` list turns out to be predefined. A future clang that
started predefining `__linux__` for this triple would otherwise silently change
which branch every conditional in the dmSDK takes.

**The C library is pinned like every other ground truth.** The dmSDK names
`<stdint.h>`, `<stddef.h>`, `<string.h>`, `<stdio.h>`, `<stdlib.h>`, `<math.h>`,
`<assert.h>`, `<stdarg.h>`, `<stdbool.h>` and `<unistd.h>`. `-nostdlibinc`
removes the host's include paths and one `-isystem` puts the pinned sysroot in
their place, so those headers come from a digest and from nowhere else. Parsing
with no libc at all is worse than either host: `size_t` degrades to `int` and
the mangled name goes with it, silently.

wasi-sysroot is the pin because it is a **single host-independent archive** -
there is no per-host build to choose between, so the bytes are the same
everywhere by construction - it is Apache-2.0 with LLVM exceptions, and its
musl-derived headers are exactly what a freestanding parse needs. Only its
include tree is unpacked; nothing here is compiled, so its libraries would be
dead weight. It is not a claim about any target's ABI: it supplies the standard
type spellings the dmSDK headers name, and every ABI-bearing spelling that
differs per target comes from that target's own pass.

**The per-target passes get the same treatment.** They already existed, one per
distinct triple, to record what symbol each bundle target would emit. They used
to run with `-DDM_PLATFORM_OSX=1` whatever they were targeting, against the
deriving host's libc. They now run with exactly the primary parse's flags and
only the ABI moved, which is what lets a declaration join back to the primary
parse by its own identity.

**`platform` is replaced by `parseEnvironment`.** The inventory, the dmSDK IR
and the policy's `@shared` subtree now carry the triple, the sysroot digest and
the macros the environment is neutral of. A consumer can no longer read a host
label as a statement about which platform a policy is for.

# What this decision does not do

It does not answer which target gets which declaration. That is
`scripts/generate-dmsdk-target-conditionals.mjs`, which resolves every platform
conditional per bundle target from Defold's own `build_input.yml` defines over
the declared toolchain and architecture predefines, and reports a declaration as
live, absent or **unresolved** for each. At the pinned revision: 121 headers, 18
of them target-varying, 44 target-conditional declarations, 0 unresolved.

It also does not make every mangled name knowable. Six `dmGraphics::GetNative*`
functions return Objective-C `id`, which only Apple's SDK declares; their
Apple-target mangled names were previously recorded **because the deriving host
was a Mac**, and they are now absent for every target. Absent is the correct
answer - the symbol evidence pass reports it as unmeasured rather than as a
missing symbol - and it is the price of the parse no longer depending on who
ran it.

# Evidence

Byte identity across hosts, measured rather than argued. The committed inventory
was generated on macOS 15 with **Apple clang 21.0.0**. Running
`python3 scripts/import-defold-sdk.py --check` inside `ubuntu:24.04` with
**Ubuntu clang 18.1.3** against the same checkout reports
`dmSDK coverage inventory is current` - the byte-for-byte comparison is what
`--check` is. Two different operating systems and two different clang major
versions produce the same 2141 declarations, the same per-target mangled names
and the same diagnostics.

CI runs that comparison as `host-parity` in `.github/workflows/derivation.yml`:
Linux is the sole policy author; the same `--check` runs on `ubuntu-24.04`,
`macos-15`, and `windows-2025`. A host that cannot reproduce the committed
inventory fails there, with the diff, rather than producing a second policy
root nobody compares. Linux/macOS byte identity is observed evidence from the
run cited above. The Windows row is wired as an isolated parity witness and
remains unverified until its first successful CI run; its queue can delay a
verdict but can never author policy bytes.

Two smaller reproducibility defects were fixed in the same pass, both of which
had been putting machine-specific text into the committed inventory:

* The vectormath library was unpacked into a **per-run temporary directory**,
  and clang spells an unresolved include by where it was looking. That name
  reached the `diagnostics` array. It is now unpacked to a fixed path under the
  repository root, which the existing checkout-prefix rewrite removes.
* `-target` being optional meant "whatever this machine compiles for". It is now
  a required argument of `parse_header`.

The path-independence fix that preceded this one - stripping the checkout prefix
out of anonymous-record names and diagnostics, and failing closed if any
survives - is unchanged and still enforced.

# Consequences

* The nightly derivation runs on `ubuntu-24.04`. The macOS pin and its comment
  are gone.
* `pnpm check:sdk-inventory` needs the pinned sysroot. The importer fetches and
  digest-verifies it on demand into `upstream/dmsdk-parse-sysroot/`, which is
  ignored; `pnpm bootstrap:upstreams` prefetches it. A fetch that fails is a
  named failure, never a parse without it.
* The declaration count moved from 2140 to 2141. The one addition is
  `typedef void* id` in `graphics_native.h` - a declaration every non-Apple
  target really does get, and which the macOS-shaped parse could never see.
  `needs-policy` (1354), `direct-candidate` (23) and the 1361 runtime-pending
  bindings are unchanged, so no lowering decision moved.
