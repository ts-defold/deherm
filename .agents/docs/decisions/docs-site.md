---
type: Architecture Decision
title: Publish a measured déherm documentation and marketing surface
description: Generate a developer-first product and quick-start site from measured release evidence and mount it beside the immutable policy store.
tags: [decision, docs, website, evidence, release]
status: accepted
generated: { by: codex/gpt-5, at: 2026-09-28T00:00:00-04:00 }
---

# Decision

The déherm website is a generated static product and quick-start surface, not a
second API or policy store. `scripts/build-docs-site.mjs` reads the versioned
site content under `docs/site/`, the checked release-size and Release benchmark
records, generated API inventories, and the TUI/VS Code visual evidence. It
writes an `index.html`, copied evidence images, and `metrics.json` into a
disposable output directory.

The policy publication workflow mounts this output at `docs/` below the existing
`deherm-policy-site` tree. The content-addressed policy URL layout remains
unchanged. The policy landing page links to the docs route, while docs links
back to source and the relevant OKF decisions. A docs build cannot rewrite a
policy object.

# Product hierarchy

The page answers how to use déherm before it discusses implementation or
evidence. Its order is: two copyable four-command quick starts, a real `.script.ts` component,
the TUI development loop, the VS Code/LSP/debug/profile experience, measured
release overhead and final bundle size, runtime targets, then examples. War
Battles is dogfood and a product proof, not the product's opening proposition.
Policy-object sizes, checkout totals, CI caches, all-host tool sums, and other
development-only footprints do not belong on the marketing page.

The new-project path is the CLI's real `create` contract: `pnpm dlx
@ts-defold/deherm create <directory>`, install the generated dependencies, then
run `pnpm dev`. The existing-project path installs the package beside the
authoritative `game.project`, runs `deherm generate`, and starts `deherm dev`.
The page must also name the editor seam: a `.script.ts` source generates the
matching `.script` proxy that is attached to a Defold game object. It must not
advertise aliases such as `deherm init` unless that command exists in the CLI.
The first-run instructions include the TUI's `p` native-play and `w` HTML5-play
keys so reaching an interactive game does not depend on hidden knowledge.

# Evidence contract

The page may report only values read from checked repository evidence. Size
claims come from fresh Bob `release` bundles recorded by
`scripts/record-release-size-evidence.mjs`: the complete War Battles arm64
macOS `.app`, the complete wasm-web deploy directory, their engine members,
and stock release-engine members from the same pinned Bob jar. The macOS delta
therefore measures the linked Hermes + déherm executable cost against Defold's
stock engine. The browser delta measures generated browser-host/Wasm engine
shell cost and states that HTML5 embeds no Hermes.

Crossing-cost claims come from `scripts/record-transport-benchmark.mjs`, which
accepts only `CMAKE_BUILD_TYPE=Release` with `DEHERM_PROFILE=OFF` and records
the benchmark output digest. The figures isolate generated framing over stub
providers; they are not the duration of the Defold operation behind the call.
The Lua figure also keeps its PUC Lua 5.1 versus shipping LuaJIT limitation
visible. TUI and VS Code screenshots are copied from checked evidence assets,
not reconstructed marketing mockups.

No benchmark number is inferred from a marketing target. New metrics require a
checked fixture or manifest input and a test in `tests/docs-site.test.mjs`.
Unavailable platform artifacts remain absent/null rather than being replaced
with estimates.

# Maintenance and release

`pnpm build:docs-site` builds the local site, `pnpm check:docs-evidence`
validates the two checked release records, and `pnpm test:docs-site` verifies
the product hierarchy, copied screenshots, evidence boundaries, and policy
link. The repository `pnpm check` includes both gates. Policy publication runs
the builder after the policy-site output is assembled. This keeps the docs
available on the same GitHub Pages publication without making website prose
part of the generator's clean-room inputs.
