---
type: Architecture Decision
title: Materialize revision surfaces from policy plus the installed compiler
description: Defines the immutable compiler/runtime boundary, revision policy facts, project outputs, and the clean-machine reconstruction proof.
tags: [decision, generator, policy, compiler, sdk, distribution]
status: accepted
---

# Decision

`deherm policy` must do more than cache metadata. After authenticating a
revision's content-addressed objects it materializes the complete revision-keyed
surface consumed by `deherm generate`. A remote machine needs the npm package,
the published policy, and its own project/extensions. It does not need a Defold
source checkout, `ref-doc.zip`, or a previously generated SDK tree.

# Ownership boundary

| Installed npm package | Defold-revision policy | Project generation |
| --- | --- | --- |
| Parsers, schemas, naming rules, stable binding identity, type renderers, lowering algorithms, code emitters, runtime templates, arena/scratch/callback/handle implementations, CLI/cache logic | Script and dmSDK declarations/docs, registered routes, profile availability, source-backed semantic verdicts, deprecation/removal status, revision ABI/layout facts, lowering recipes | Extension IR, selected target/profile, reachability plan, component proxies, extension bindings, emitted SDK/glue and final bundle |

The boundary is algorithm versus result. “Generate a borrowed-handle table” is
package code. The handle kinds and routes at one Defold revision are policy
data. Generic arena code is package code. The contracts using that arena are
policy data. Generated TypeScript, C++, and JavaScript are outputs.

Pinned host compilers and native Hermes libraries are a separate distributable
class. They may ship with the npm package or release artifacts, but they are
toolchain artifacts rather than Defold API policy.

# Current executable cut

The authenticated `@compiler` subtree carries eleven semantic documents and an
SDK manifest. `packages/compiler/src/policy-surface-materializer.mjs` restores
the selected revision, regenerates the core script and dmSDK TypeScript files
from IR, verifies their policy SHA-256 values, writes the remaining support
files from explicitly labelled authenticated compatibility snapshots, and
records a revision-keyed `surface.json` descriptor.

The compatibility snapshots are migration debt, not a claim that generated
source belongs in the final policy schema. Each becomes package-side emitter
code as its generator is extracted. The mode is recorded per file so local
generation and authenticated materialization cannot be conflated.

# Proven properties

`tests/policy-surface-materializer.test.mjs` materializes into a fresh temporary
directory and compares all 28 SDK files byte-for-byte with the canonical tree.
Seven core files are locally rendered from IR. The test then repeats the same
operation and requires zero writes, proving keyed idempotence. The materializer
does not invoke a parser or read a Defold checkout.

The current compiler object is 21 MB and the complete policy is 29.26 MB. This
is an intentionally correctness-first compatibility cut. The 15 MB canonical
lowering plan is itself derived output and must next be rebuilt locally from
smaller policy recipes; support-source snapshots must likewise be replaced by
their package emitters. Those changes reduce transfer size without changing the
consumer contract.
