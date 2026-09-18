---
type: Research Note
title: Defold C# extension precedent
description: How Defold's experimental C# support maps source files to NativeAOT static libraries and generated dmSDK bindings.
tags: [research, defold, csharp, nativeaot]
status: verified
generated: { by: codex/gpt-5, at: 2026-09-17T00:00:00-04:00 }
sources:
  - id: extensions
    resource: https://defold.com/manuals/extensions/
    title: Defold native extensions
    author: team:defold
  - id: example
    resource: https://github.com/defold/example-languages
    title: Defold native-extension language examples
    author: team:defold
  - id: defold-source
    resource: https://github.com/defold/defold
    title: Defold engine source
    author: team:defold
---

# What Defold implemented

C# is an in-tree experiment for native libraries and Lua interop, not a shipped
replacement for Defold script components. The checked-in build configuration
currently returns before enabling C# tool discovery, and the concrete runtime
exercise is an engine unit test. That test builds C# with NativeAOT, exports a C
entry point, receives a `lua_State*`, and registers `csfuncs.add`/`mul` back into
Lua. Normal `.script`, `.gui_script`, and `.render_script` lifecycle execution
therefore still belongs to Lua.

The implemented toolchain pieces are:

1. Generates C# dmSDK declarations from annotated C headers.
2. Builds a `.csproj` targeting .NET 9 with `PublishAot=true`,
   `NativeLib=static`, trimming, and unsafe code enabled.
3. Maps each Defold target to a .NET runtime identifier.
4. Runs `dotnet publish` to produce a platform static library.
5. Links that archive and required NativeAOT runtime archives into the custom
   engine.
6. Uses C ABI entry points/PInvoke between generated C# bindings and Defold.

This is valuable prior art for build/link mechanics and header generation. It
is not evidence that Defold already has a general foreign-language script
component protocol we can reuse.

# What to copy

* Generate the language SDK from an authoritative native/API schema.
* Produce ordinary platform libraries the extension linker can consume.
* Make unsupported platforms explicit instead of silently degrading.
* Distribute as a normal Defold library dependency.

# What differs for Hermes

We intend TypeScript to own game logic, not merely to publish functions into
Lua. The extension must therefore register a Defold component/resource type or
provide a generated bootstrap component that drives TypeScript lifecycle,
message, input, reload, property, and serialization semantics.

Dynamic Hermes uses generated JSI during development. Static Hermes modules
call the generated C ABI directly. HTML5 uses the browser VM and raw Wasm
exports. Unlike the C# experiment, the game-facing compatibility target is the
entire Lua-shaped script API in addition to raw dmSDK.
