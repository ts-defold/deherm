---
type: Architecture Decision
title: Deliver as a Defold library and native extension before considering a fork
description: The runtime, web bridge, build integration, and bindings fit Defold's extension system; first-class script resources do not.
tags: [decision, distribution, native-extension, fork]
status: proposed
generated: { by: codex/gpt-5, at: 2026-09-17T00:00:00-04:00 }
sources:
  - id: extensions
    resource: https://defold.com/manuals/extensions/
    title: Defold native extensions
    author: team:defold
  - id: editor-scripts
    resource: https://defold.com/manuals/editor-scripts/
    title: Defold editor scripts
    author: team:defold
  - id: libraries
    resource: https://defold.com/manuals/libraries/
    title: Defold library projects
    author: team:defold
---

# Decision

Ship the first product as a versioned Defold library dependency containing:

* a native extension and per-platform Hermes static libraries;
* the HTML5 extension JavaScript library;
* TypeScript SDK declarations and generated module bindings;
* a CLI/build package that creates Lua and JavaScript resources;
* an optional editor hook for the local build loop.

No Defold engine fork is required for that surface. Native extensions are
compiled into each project's custom engine by Defold's build service, and
library projects are the normal distribution mechanism.

# Automation boundary

An editor script can run the TypeScript build before local editor builds and
bundles. Defold documents that editor lifecycle hooks do not run under Bob, so
CI must invoke the TypeScript build command explicitly before `bob build` or
`bob bundle`. The generated bundle/Lua files then enter Defold as resources.

# When a fork becomes justified

A fork or upstream engine/editor change is required only for deep first-class
integration: a new TypeScript component resource type, graph-aware `.ts`
dependencies owned by Bob, TypeScript breakpoints in Defold's debugger,
engine-native hot reload, or replacing Lua as the built-in script VM.

Those features are optional product milestones, not prerequisites for shipping
the extension-based hybrid runtime.
