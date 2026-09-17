---
type: Architecture Decision
title: Use Hermes natively and the existing browser VM on HTML5
description: Native targets embed Hermes; HTML5 executes the same contract in the browser rather than embedding Hermes in Wasm.
tags: [decision, hermes, wasm, html5]
status: draft
generated: { by: codex/gpt-5, at: 2026-09-17T00:00:00-04:00 }
sources:
  - id: proposal
    resource: https://x.com/tmikov/status/2095911349020700856
    title: Tzvetan Mikov Hermes preview proposal
    author: human:tmikov
  - id: hermes-static
    resource: https://github.com/facebook/hermes/tree/static_h
    title: Hermes static_h branch
    author: team:meta-hermes
  - id: defold-html5
    resource: https://defold.com/manuals/html5/
    title: Defold HTML5 platform manual
    author: team:defold
---

# Status

Proposed; validate in the spike before marking stable.

# Decision

Use a two-adapter design behind one TypeScript contract:

* Native Defold targets embed Hermes and begin with bundled JavaScript or Hermes
  bytecode.
* HTML5 runs the same bundle in the page's JavaScript engine and calls Defold
  through an Emscripten bridge.
* Static Hermes is evaluated as an optimization lane after the regular Hermes
  integration works; it does not define the public API.

# Rationale

Embedding Hermes natively proves the desired real-JavaScript-engine path.
Hermes also gives the project one no-JIT native engine strategy across iOS,
Android, and desktop; bytecode and Static Hermes AOT remain build-time options.
Embedding it again inside browser Wasm would duplicate a VM, enlarge downloads,
complicate debugging, and discard browser-native capabilities. Keeping the
contract above the runtime preserves parity while letting each platform use its
natural execution environment.

TypeScript is a source language whose types normally disappear before runtime.
The pinned Hermes branch includes `hermes --transform-ts` for erasable
TypeScript and a separate typed Static Hermes lane that translates a supported
TypeScript subset through Flow. Neither implies compatibility with the entire
TypeScript language and npm ecosystem. A normal TypeScript bundle is therefore
the compatibility baseline; direct stripping and AOT remain measured
enhancements.

# Consequences

* Runtime semantics can differ between Hermes and modern browsers, so a parity
  suite and a documented language baseline are mandatory.
* Browser code can use async platform features; the shared engine contract must
  specify which calls are synchronous and how async messages are queued.
* Native builds carry Hermes size and platform-library maintenance.
* Source maps and stable bundle URLs are required for useful cross-runtime
  diagnostics.

# Revisit when

* Hermes Wasm provides a unique sandboxing or determinism benefit worth the VM
  duplication.
* Static Hermes accepts the project's emitted code with clear performance or
  size wins.
* Defold adopts a browser bridge that changes the ownership model.
