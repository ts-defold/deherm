---
type: Risk Register
title: Defold Hermes risks and unknowns
description: Prioritized technical uncertainties for the proof of concept.
tags: [risks, spike, defold, hermes]
status: draft
generated: { by: codex/gpt-5, at: 2026-09-17T00:00:00-04:00 }
---

# Highest priority

| Risk | Why it matters | Spike evidence required |
|---|---|---|
| Hermes static-link packaging | Defold build servers need per-platform artifacts and correct transitive libraries. | arm64 macOS is proven; add x86_64, iOS, Android, Windows, and Linux artifacts. |
| JSI/native lifetime safety | Unrooted values, thread changes, or callbacks during teardown can crash. | Engine-thread-only lifecycle test plus explicit runtime ownership. |
| TypeScript versus Static Hermes dialect | Arbitrary TypeScript syntax and npm output may not be valid/optimizable Static Hermes input. | Test the actual bundle; keep regular Hermes as baseline. |
| Defold resource packaging | The runtime must reliably find bundle/bytecode on all platforms. | Load one packaged resource in an actual sample project. |
| HTML5 readiness/reentrancy | Page JS and Wasm startup/update can race or recursively call each other. | Explicit ready state and queued-message browser test. |
| Generated module ABI | Turbo/Nitro-inspired codegen must not accidentally inherit React Native lifecycle or ABI assumptions. | Define a Defold-owned schema/installer ABI and generate one non-trivial module on two native targets. |
| Hybrid source drift | Shared TypeScript may accidentally rely on Lua-only or JS-only semantics. | Separate target configs, ban illegal cross-zone imports, and run parity tests for shared modules. |
| ttsc Lua backend | The public transform path currently returns TypeScript for downstream bundlers rather than arbitrary Lua artifacts. | Prototype a driver/backend or bridge the existing TSDefold emitter while retaining one diagnostic graph. |

# Important follow-ups

* Binary size and startup/memory overhead by platform.
* Exception stacks and source-map quality in Hermes.
* Hermes/browser language and built-in API differences.
* Hot reload and live-update invalidation.
* Promise/microtask pumping relative to Defold frames.
* Mobile platform static libraries, C++ ABI, and symbol visibility.
* Licensing and notices for distributed Hermes binaries.
* Whether extension-only APIs are sufficient or engine headers must be made public.
* Defold frame delta currently comes from the extension update callback's
  monotonic elapsed time; collection time scaling and pause semantics are not
  yet modeled.
