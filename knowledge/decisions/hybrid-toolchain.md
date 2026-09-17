---
type: Architecture Decision
title: Use a hybrid TypeScript-to-Lua and TypeScript-to-JavaScript toolchain
description: Keep Defold scripts on Lua while adding Hermes/browser modules behind generated bindings.
tags: [decision, typescript, ttsc, lua, hermes]
status: proposed
generated: { by: codex/gpt-5, at: 2026-09-17T00:00:00-04:00 }
sources:
  - id: ttsc
    resource: https://ttsc.dev/docs/ttsc/
    title: TTSC compiler documentation
    author: team:ttsc
  - id: ttsc-unplugin
    resource: https://ttsc.dev/docs/setup/unplugin/
    title: TTSC bundler adapters
    author: team:ttsc
  - id: ts-defold
    resource: https://github.com/ts-defold
    title: TS-DEFOLD organization
    author: team:ts-defold
---

# Decision

Use one TypeScript authoring experience with two explicit runtime targets:

* Defold script components transpose to Lua through the TSDefold-style lane.
* JavaScript modules bundle once and execute in Hermes natively or the page's
  JavaScript engine on HTML5.
* Runtime-neutral packages may be shared, but target-specific globals are not.
* Defold/JS calls use generated, versioned bindings rather than sharing VM
  implementation details.

# Compiler and bundler

Pin TypeScript 7 and `ttsc` together. `ttsc check` owns diagnostics. The
matching `@ttsc/unplugin` esbuild adapter runs the same TypeScript-Go plugin pass
inside the JavaScript bundler; esbuild then resolves the module graph, removes
types, emits one IIFE bundle, and writes source maps.

The bundler also emits a per-entrypoint Defold symbol manifest from generated
function inputs that survive tree shaking. `ttsc` will eventually contribute
non-syntactic edges such as callbacks and compiler intrinsics. This manifest is
the contract between whole-program TypeScript analysis and reachable-only
native generation; it is not inferred from runtime telemetry.

The spike pins TypeScript 7.0.2 and matching `ttsc`/`@ttsc/unplugin` 0.30.4.
This is wired and verified.

# Lua backend boundary

The public `ttsc` transform stage returns transformed TypeScript, while its
normal build stage emits JavaScript/declarations. A production Lua target
therefore needs a real backend/driver integration, or a temporary adapter to
the existing TSDefold emitter, not a text post-process over JavaScript.

That backend is a follow-up spike. It should consume the checker-resolved graph,
write Defold-correct `.script`/`.gui_script`/`.render_script`/`.lua` artifacts,
and report diagnostics through the same `ttsc` stream.

# Source zones

```text
src/shared/**   no Lua or JS host globals
src/lua/**      Defold script lifecycle and Lua-compatible libraries
src/js/**       Hermes/browser modules and npm libraries
src/bindings/** generated declarations and adapters
```

Cross-zone imports are checked. A JS module may not reach a Lua-only API and a
Lua script may not import a browser/JSI-only package.
