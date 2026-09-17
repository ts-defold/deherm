---
type: Architecture Decision
title: Ship a deterministic API compiler, not hand-authored bindings
description: Define Deherm as a local CLI that resolves Defold inputs and generates every API projection without an LLM or per-symbol source edits.
tags: [decision, generator, cli, bindings, reproducibility, sdk, no-llm]
status: accepted
generated: { by: codex/gpt-5, at: 2026-09-17T17:55:00-04:00 }
---

# Product contract

Deherm is a tool, not a set of bindings hand-maintained by an agent. A user
points the CLI at a Defold project and version; the tool discovers the matching
SDK, reference docs, engine evidence, and project extensions, then emits the
complete TypeScript/native/browser binding package.

```sh
npx @ts-defold/deherm generate --project .
```

No LLM, network model, or human code generation is part of that command. An
agent may help develop, audit, and improve the compiler. Its output cannot be a
required build input and cannot substitute for a deterministic rule.

# Inputs and pipeline

The generator resolves and content-addresses:

1. the Defold revision selected by `game.project`, Bob, or an explicit CLI
   option;
2. its packaged dmSDK, generated reference documentation, and matching engine
   source evidence;
3. local and resolved dependency extensions, `.script_api` files, public
   headers, manifests, and native source metadata;
4. a versioned semantic overlay containing only reviewed ambiguities that
   cannot be derived mechanically.

Those inputs compile into one canonical semantic IR. Target backends then emit
TypeScript/TSDoc, ttsc metadata, dynamic-Hermes JSI, Static Hermes `extern_c`, C
ABI wrappers, Lua compatibility thunks, HTML5/browser adapters, editor/LSP
data, tests, link manifests, and a per-symbol conformance ledger.

The semantic overlay is data, not handwritten glue. Every entry names a stable
symbol, the exact source claim it resolves, the Defold revision/range, and a
content hash or structural predicate. Generation fails if its evidence moves,
disappears, or no longer matches. Dead overlays and conflicting rules are
errors.

# What may be handwritten

The compiler contains a finite set of reviewed lowering templates: scalars,
values, tables, handles, callbacks, spans, records, out-parameters, overloads,
platform gates, and lifecycle capabilities. Codec and runtime implementations
for those families are normal compiler/runtime code.

The compiler must not contain a growing list of wrappers, source files, or
tests hand-selected for individual Defold functions. Current scalar-specific
module maps and symbol evidence are spike scaffolding used to discover the
templates. They must become AST/source-derived routing plus overlay data before
the affected family is called product-ready.

# Zero-edit generation gate

A backend family is product-ready only when a clean fixture can:

1. select a fresh supported Defold revision;
2. delete every generated artifact;
3. run one documented CLI command;
4. reproduce all artifacts byte-for-byte without source edits;
5. compile/link every supported target projection or record a precise blocker;
6. run generated conformance tests and update no handwritten symbol list; and
7. repeat offline from a verified local cache.

Adding, removing, or moving an ordinary Defold API declaration may change the
generated IR and artifacts; it may not require editing generator source. A
new semantic shape may require one new general lowering rule. A genuinely
ambiguous declaration may require one reviewed overlay entry. Both cases must
be visible in the generation report.

# Honest current boundary

The repository already generates the full type surfaces, pattern ledgers, and
descriptor tables mechanically. The first scalar execution slices still
contain hand-authored family policy, source routing, representative tests, and
one semantic override. They are validated template spikes, not evidence that
the one-command API compiler is finished.
