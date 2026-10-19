---
type: Architecture Decision
title: Continuous policy generation, engine evidence, and publication
description: One nightly policy workflow derives every tracked Defold revision, emits every mechanically representable API, records verification without gating publication, and publishes the accumulated policy store directly to the website.
tags: [decision, generator, policy, ci, conformance, pages]
status: accepted
generated: { by: codex/gpt-6, at: 2026-10-19T15:22:07Z }
sources:
  - resource: ../../../scripts/check-end-to-end.mjs
    title: Project-locked consumer build gate
  - resource: ../../../.github/workflows/end-to-end.yml
    title: Current-channel consumer matrix
  - id: generate-report
    resource: ./generate-report-never-gate.md
    title: Generate, report, open issues - a generator never refuses
    author: project:deherm
  - id: layered-cache
    resource: ./layered-api-policy-cache.md
    title: Layered API policy cache
    author: project:deherm
  - id: revision-derivation
    resource: ./revision-parametric-derivation.md
    title: Revision-parametric derivation
    author: project:deherm
  - id: policy-workflow
    resource: ../../../.github/workflows/policy.yml
    title: Policy publication workflow
    author: project:deherm
  - id: native-workflow
    resource: ../../../.github/workflows/native-artifacts.yml
    title: Native artifact workflow
    author: project:deherm
  - id: surface-identity
    resource: ../../../scripts/policy-surface-identity.mjs
    title: Policy surface handoff identity
    author: project:deherm
  - id: surface-install
    resource: ../../../scripts/policy-surface.mjs
    title: Policy surface archive installation
    author: project:deherm
  - id: bob-mirror
    resource: ../../../scripts/publish-defold-bob-mirror.mjs
    title: Content-verified Defold Bob mirror publisher
    author: project:deherm
  - id: site-parity
    resource: ../../../scripts/check-policy-site-parity.mjs
    title: Cross-host policy-site byte parity
    author: project:deherm
  - id: checkout-bytes
    resource: ../../../.gitattributes
    title: Canonical checkout newlines
    author: project:deherm
  - id: repository-bob
    resource: ../../../scripts/ensure-repository-bob.mjs
    title: Repository bootstrap using the installed CLI's verified Bob resolver
    author: project:deherm
  - id: fixture-inputs
    resource: ../../../scripts/ensure-defold-fixture.mjs
    title: Verified pinned contributor fixture inputs
    author: project:deherm
  - id: fixture-publisher
    resource: ../../../scripts/publish-defold-fixture-mirror.mjs
    title: Immutable pinned fixture mirror publisher
    author: project:deherm
  - id: github-queue
    resource: https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency
    title: Queueing multiple pending GitHub Actions runs
    author: team:github
  - id: defold-license
    resource: https://github.com/defold/defold/blob/dev/LICENSE.txt
    title: Defold License redistribution terms
    author: team:defold
---

# Outcome

Déherm continuously mirrors Defold's API policy. A new stable, beta, or alpha
engine revision must become resolvable by the CLI without waiting for a human to
merge a policy pull request.

The nightly is one top-level GitHub Actions workflow named `policy`. Its graph
shows discovery, generation, host parity, real-engine evidence, and website
publication together. The old `policy-revisions`, `derivation`, `conformance`,
and `policy-site` workflows are not separate products and must not appear as
four unrelated top-level runs.

# Authority

Defold is authoritative for the API present at a revision:

* a declaration added by Defold is added;
* a declaration removed by Defold is removed for that revision;
* Defold deprecation metadata is carried into generated TypeScript and TSDoc;
* déherm's reviewed policies provide lowering and ergonomic knowledge, but do
  not veto the upstream surface;
* verification evidence describes what déherm observed. It does not decide
  whether Defold's documented API is allowed to exist.

# Nightly graph

## Reliability plan for rolling Defold revisions

The full consumer matrix resolves the current stable channel once in its
planning job (manual runs can select beta or alpha), then shares that exact SHA
with scaffold, generation, artifact installation, and every Bob job. It uses
the ordinary `deherm bundle` command and the generated project's authenticated
lock, not repository-pinned Bob or native archives. Contributor fixtures remain
pinned independently: a valid historical SDK does not imply that Defold's
hosted Extender still retains it. Five targets in run 39274342444 rejected the
old fixture SHA as nonexistent while other workers still built it from cache.
Regression tests require one channel resolution, exact-SHA propagation, and
project-owned build inputs; a successful local plan is not a hosted build.
The replacement run 39276254615 passed every exercised compile/link/bundle
target against current stable, and local `pnpm check` passed. This does not
claim an interactive run on every device.

The revision-discovery path is the same on push, pull request, schedule, and
ordinary manual dispatch. Only an explicit revision replaces discovery and an
artifact-only refresh skips it. This makes an unindexed channel revision visible
to code-review CI, rather than waiting for the next nightly. Push and pull
request also rederive the latest indexed alpha as a canary. It is marked as a
re-probe, not a newly generated revision: it cannot dispatch a new native
artifact build by itself. This keeps the current-release parser, exact-call,
and headless-link path exercised after generator or harness edits even when
the website already holds that Defold SHA.

The Linux derivation and engine jobs install the same policy-native toolchain.
Their installer preflights the executables and syntax-compiles a translation
unit including GLX, because the generated dmSDK exact-call provider may include
`GL/glx.h`. The exact-call compile keeps signature and other warning errors
fatal, but an upstream deprecation annotation is carried as metadata and may
warn without vetoing the route. Regression tests compile a deprecated call and
a wrong-arity call under the actual flags.

The real-engine headless driver must not freeze `engineLibs` or
`dmExportedSymbols` at an earlier Defold revision. At CMake configure time it
reads the selected SDK's `extender/build.yml` and `headless.appmanifest`, applies
the harness's null-backend substitutions, and emits its private CMake library
list and C++ symbol unit into the build directory. A missing referenced archive
remains a link-configuration failure; a source-added library or removed symbol
changes the next projection automatically. A mutation test covers those
add/remove cases, and the pinned SDK driver must compile and link. This is
runtime-harness configuration, not package policy or generated API surface.

Derivation continues through all discovered revisions, retains usable prior
policies, and publishes that coherent accumulated store. A separate required
`derivation-completeness` job reports any missing planned revision as red; the
published consumer independently checks the planned SHA list. A failure issue
must identify the exact stage and compiler diagnostic rather than an opaque
`unknown-derivation-stage`. These signals do not manufacture a shared policy
or hide an otherwise usable older revision.

This plan does not promise that arbitrary future C++ source changes will parse
without generator work. It does make missing CI prerequisites, deprecated API
annotations, and schedule-only discovery permanent regression cases. Hosted
fresh-revision derivation remains the acceptance test for a newly observed
Defold SHA; local static tests alone are not that evidence.

```text
discover stable / beta / alpha revisions
                  |
                  v
derive each missing revision on Linux, accumulating one policy store
                  |
        +---------+-------------------+
        |                             |
        v                             v
reproduce canonical bytes       compile, link, and execute
on Linux/macOS/Windows          generated routes in real Defold
        |                             +----> record evidence/issues
        v
publish every usable policy to deherm-policy-site; request Pages build
        |
        v
resolve the public site, verify content hashes, scaffold a clean project,
generate its SDK, and typecheck every TypeScript script context
```

Publication waits for Linux, macOS, and Windows to reproduce the canonical
policy-site bytes from the exact derived store. Linux source derivation is the
authority for the new Defold revision; other hosts run the package-owned policy
materializer, rebuild the validation site without source archives, and compare
its path-and-content digest with Linux's site digest. Re-fetching the checkout's
older pinned `ref-doc.zip` on parity hosts was neither evidence about the new
revision nor durable: Defold can retire an intermediate archive while the
policy remains usable. Host parity is an internal-coherence condition on our
own projection, not a review gate on Defold's API, so publishing before it completes
would expose bytes we have not yet shown are platform-independent. Real-engine
execution remains additive evidence: it runs in parallel, reports and opens or
updates issues, but does not withhold a coherent policy. The workflow never
waits for a review PR. Pull requests remain useful for generator code changes,
not as a checkpoint for mechanically derived engine revisions.

Git checkouts use LF for text on every host. Artifact release fingerprints hash
the actual recipe bytes; allowing Windows `autocrlf` to rewrite those inputs
would manufacture different release tags for the same repository revision.
The newline policy fixes the input boundary without weakening byte integrity.
A temporary Git checkout test enables `autocrlf`, reproduces the divergent
fingerprints without attributes, then verifies all family and target-recipe
fingerprints under the repository attributes.[^checkout-bytes]

The engine step is allowed to continue long enough to upload reports and update
issues after a failure, but an infrastructure, compile, link, or harness failure
still makes the engine job red at its final enforcement step. An unexecuted or
unproven API route is evidence and does not fail the job; failure to run the
evidence machinery itself is a CI failure. This prevents a green wrapper from
masking a compiler or engine-launch defect.

The engine lane consumes the exact content-addressed Linux Hermes archive named
by its checkout. Native artifact publication is a separate workflow, so a push
that changes that fingerprint can start both graphs concurrently. The engine
lane therefore waits up to 45 minutes for that exact release row before pulling
it. A bounded wait removes the publication race without accepting an older
archive; timeout remains an infrastructure failure and is reconciled through the
same evidence issue.

Defold's intermediate Bob archives are not a durable distribution guarantee.
The revision workspace retains the exact Bob bytes already fetched while
pinning its SHA-256. On writable main runs, derivation publishes them to an
immutable `defold-bob-<revision>` GitHub release before the new policy can
advance. The publisher verifies the workspace lock digest, uploaded asset
digests and sizes, and a license/notice set copied from that same Defold source
revision before making the release public. An interrupted draft can be resumed;
a published asset whose digest differs is never overwritten. PRs cannot publish
mirror releases. A mirror failure makes the derivation job red, so a newly
published policy does not claim a fallback that was never established.[^bob-mirror]
After publication, the job downloads the public URL without GitHub credentials
and checks its complete SHA-256. A release lacking that verified-download
receipt retries the clean download on the next run; an already checked release
reuses its asset metadata without downloading the large JAR on every canary.
The Defold License permits redistribution subject to its terms, which is why
the mirror carries Defold's license and tool notices alongside Bob.[^defold-license]

The installed CLI tries the policy's original Defold URL first, then the
release URL for that exact revision. Both sources must match the policy's
Bob SHA-256 before any bytes enter the project cache. The mirror is an
availability source, never an authority that can change a pinned toolchain.
Repository and CI bootstrap call that same resolver, storing its verified JAR
in `build/tooling/bob.jar`; they must not maintain a separate source-only curl
path. Both a selected policy and a pinned fixture therefore retain the same
mirror behavior.[^repository-bob]
Older indexed revisions are not retroactively mirrored by this main-run path;
they need a bounded backfill while their source archives remain available.
The contributor baseline also pins `ref-doc.zip` and `defoldsdk.zip`. These are
test inputs rather than consumer dependencies. Their bootstrap validates warm
cache bytes, then tries the pinned Defold URL and an exact-revision
`defold-fixtures-<revision>` mirror, accepting only the lock's SHA-256. Downloads
stream to a temporary file before replacement. Fixture mirrors use the same
immutable draft/upload/public-download verification contract as Bob and carry
the same source-revision licenses. An intentional baseline update can publish
these archives with `scripts/publish-defold-fixture-mirror.mjs`; ordinary
nightlies do not mirror every SDK archive.[^fixture-inputs][^fixture-publisher]

The War Battles Action smoke keeps its checked-in `7f0f554` game/evidence
fixture intact but passes an exact, published and mirrored Defold SHA to the
reusable workflow. That workflow regenerates from the selected policy in its
plan and each target job before building. This is a fixed consumer regression
probe, not the moving alpha canary; the policy graph above owns current-channel
coverage. A revision override is opt-in for other consumers and cannot silently
change their project pins.

The consumer smoke is deliberately after publication and resolves
`https://ts-defold.dev/deherm`; the local relocation/tamper test is not accepted
as evidence that Pages deployed the new bytes. It waits for the public manifest
to name the exact derived roots, verifies every fetched object against its
content-addressed path, and then dogfoods the installed CLI's scaffold,
generation, and typechecking flow. Full Bob builds remain downstream of the
native-artifact workflow, because policy objects are allowed to publish before
a new platform archive fingerprint finishes building. The mutable artifact
document is different: publication advances it only when every row for all
three fingerprinted families exists. While a new fingerprint is still
building, the site publishes the new policy objects but retains its previous
complete artifact mapping, so a deterministic URL never enters the public
index while it still returns 404. The artifact workflow dispatches both the
all-target gate and a policy-site refresh after its exact completeness proof.
That artifact-triggered policy refresh dispatches the full end-to-end Bob matrix
only after the public consumer smoke resolves the advanced hash-bound mapping.
Dispatching policy refresh and end-to-end as siblings is forbidden: it races
Pages publication and turns an expected deployment window into a false consumer
failure.

The artifact callback sets `artifact_refresh_only=true`. It hydrates and checks
the accumulated store but deliberately derives no channel revision: release
availability changed, Defold source did not. Nightly and ordinary manual runs
retain channel discovery. This keeps an artifact retry proportional to the
mutable mapping it advances instead of repeating three source derivations.

All policy writers use one concurrency group with `queue: max` and no
cancellation. GitHub's default single pending slot allows a later artifact
callback to cancel a pending push validation; `cancel-in-progress: false`
alone does not prevent that. The queued mode retains pending source and
mapping runs in order while continuing to allow only one active writer.
GitHub supports up to 100 queued runs per group.[^github-queue]

The policy plan runs the package-owned release preflight before derivation. The
derived policy-surface artifact carries a separate identity document naming
the producer commit, policy run ID, and SHA-256 of the exact archive. A
cross-workflow native-artifact dispatch supplies that commit and run ID; every
native-artifact checkout uses the producer commit, and the plan verifies the
identity before extracting the target list. An advanced `main` therefore
cannot silently pair an older policy surface with newer artifact recipe code.
The archive identity protects the handoff, not the authenticity of public
release assets; those retain their independent integrity-sidecar checks.
Each host extracts the archive from its checkout as the process working
directory and then compares the installed policy index with the archive's own
index bytes. Merely finding pre-existing generated directories is not an
installation proof, particularly on Windows where a tar `-C` path can be
interpreted differently from a process cwd.
Local mutation and mismatch tests cover this contract. Installation and final
site-byte parity remain separate checks.[^policy-workflow][^native-workflow][^surface-identity]

The derivation job also builds a disposable site to exercise the site emitter
before host-parity and publication. That build uses `--validation-only`: its
package-derived artifact rows prove that every emitted revision pointer binds a
well-formed artifact document, but they are not availability evidence and the
tree is never published. The publication job cannot use that mode; it still
requires either publisher-authenticated integrity sidecars for the current
mapping or the last complete mapping from the published site. Keeping those two
inputs explicit prevents an artifact race from turning a public revision entry
into a pointer with no `artifactsSha256`.

The published-policy consumer also compares the planner's exact revision SHAs
with the derived index before accepting a run. A failed revision can leave the
older, valid site available, but it cannot make the nightly green merely because
the consumer verified only entries that happened to be emitted. This is a
pipeline-completeness check, not a per-route semantic gate: a universal route
that compiled and passed its generated contract remains publishable while a
missing optimization recipe is reported separately.

# Per-revision algorithm

For each revision not already in the website index:

1. Pin the immutable Defold source, reference documentation, Bob archive, and
   their observed digests in a scratch workspace.
2. Parse the script API, Lua registration surface, resource schema, public
   dmSDK headers, target conditions, and extension inputs.
3. Project every discovered unit through the canonical IR.
4. Emit the best available implementation for every unit. Specialized fast
   paths are preferred; the universal/default transport is the fallback.
5. Emit types, TSDoc, runtime descriptors, native/Static-Hermes/browser glue,
   compile probes, and runtime probes from the same unit.
6. In that revision's scratch workspace, materialize the policy twice, compare
   it byte-for-byte with the independently generated SDK and output tree, then
   compile the generated TypeScript SDK and C/C++ exact-call twins. This check
   runs before adoption, for **each** discovered revision; a later revision
   cannot stand in for an earlier one in a multi-revision wave. It proves the
   package's realization and compile contracts, not every game-context runtime
   behavior.
7. Exercise generated probes in a real Defold engine wherever the harness can
   construct the required context.
8. Record evidence, update issues for contradictions or missing generator
   capabilities, and publish the usable policy regardless of those evidence
   gaps.

The sealing boundary is route-granular. A source-derived route or declaration
that cannot be classified is retained as a machine-readable blocker in the
shared policy data; it does not discard the other namespaces and routes that
were derived successfully. The policy remains deterministic because every
source declaration is either emitted in its derived namespace or named exactly
once by a blocker, while the materializer continues to realize only the
authenticated usable surface.

The derivation is keyed by exact inputs. An already indexed revision is a no-op.
Content-addressed subtrees shared with older revisions are not rewritten.

# Status model

Status is additive evidence, not an allow-list:

* `supported`: Defold declares/registers the API and déherm emitted it.
* `executed`: the generated route additionally compiled, linked, and satisfied
  its generated assertions in a real engine.
* `suspect`: déherm observed a contradiction, such as a documented name that is
  not registered or a runtime assertion that failed.
* `upstream-unavailable`: Defold source explicitly disables a documented
  registration. Source is authoritative, so the route is not emitted and no
  déherm issue is opened.
* `unproven`: déherm emitted the route but could not yet construct a meaningful
  runtime test context. This is evidence metadata only.
* `unoptimized`: déherm emitted the universal route because the revision did
  not match a known specialization recipe. This opens or updates optimization
  work; it is never a publication gate.

`suspect`, `unproven`, and `unoptimized` entries remain usable. `unproven` is
internal evidence metadata only: it does not annotate the public SDK and does
not open a route issue. Positive source/runtime contradictions that déherm can
act on open `suspect` issues, while specialization withdrawals open grouped
`unoptimized` issues. Explicit upstream disablement remains policy evidence,
not a déherm work item.
Repeated nightlies update existing issues instead of opening duplicates.

Optimization withdrawals are grouped by reviewed recipe input. One Defold
refactor that affects many routes updates one `policy optimization: <family>`
issue; it does not create per-route support-gap spam. The issue states that the
universal routes were published and lists the affected revision, route ids, and
withdrawal reasons. A later complete derivation that no longer withdraws the
family closes the generated issue. A partially failed multi-revision wave may
update observed opportunities but cannot close an existing optimization issue.

A derivation-stage or CI-host failure is not an `unproven` API. The Linux
deriver preflights the cross-target LLVM archive tools before reading the SDK;
missing tools fail once with their real name instead of making every archive
appear unreadable. Failures shared by several tracked revisions are grouped
into one stage-scoped issue listing those revisions. After a complete tracked
channel run no longer reproduces that stage, the workflow closes the generated
issue and any superseded per-revision issue automatically. Route-level
`suspect` issues remain separate because those carry an actual positive
contradiction tied to API identity. Mere absence of bespoke runtime evidence
remains in the harness report and never creates an issue.

The deterministic link is a title-keyed repository issue lookup embedded in
the route-verification artifact. The engine-evidence job materializes that
contract: it lists the existing route-verification issues once, creates every
missing `suspect` issue, reopens a matching closed issue if the contradiction
recurs, and edits its generated body only when the evidence changed. Profile,
context, destructive-effect, absent bespoke execution and runtime-producer
blockers remain harness notes and do not open route issues.

# Failure policy

A new or changed Defold API is not a failed nightly. A missing review, moved
source hash, changed census, unavailable fixture, unexercised route, or absent
specialization is report data.

Reviewed specializations match semantic operations, not Defold's incidental
C++ spelling. A recipe may require that a Lua entry point resolves an instance
and calls a particular engine operation, but it must not pin local variable
names, ownership-field paths, or the exact argument list used by one revision.
If a revision preserves the public Lua contract while refactoring those
internals, the recipe follows the semantic callees. If the semantic operation
itself can no longer be established, only that specialization is withdrawn and
the route uses its universal transport; source-anchor drift must never bypass
that fallback and abort the revision.

An unclassifiable route is likewise report data when the source-derived pipeline
can identify it. Its blocker is published beside the usable routes for that
revision, and the route is not guessed or silently omitted. A failure that
prevents the pipeline from establishing this complete emitted-or-blocked
partition remains a derivation failure and cannot produce a partial policy.

The workflow may be red only when it cannot safely publish a coherent store at
all: malformed authoritative input, corrupt content-addressed output, an index
that does not resolve its objects, or CI infrastructure preventing publication.
Even then, all policies derived before the fault and all diagnostic artifacts
must remain available; one problematic route never suppresses unrelated APIs.

# Publication and consumption

The nightly commits nothing to `main`. It publishes the accumulated immutable
objects and mutable per-revision index to the `deherm-policy-site` branch, then
requests the GitHub Pages build. This is automatic and guarded only to the
canonical `ts-defold/deherm` repository.

`deherm policy` resolves the exact Defold SHA from the project, then consumes
the website index and verifies every fetched object against its content hash.
The npm package contains the revision-independent realizer and policy-site
locator, not a pinned revision surface. Authenticated revision objects are read
from the content-addressed user cache when present and fetched from the website
otherwise; the website is the continuously updated catalogue for every tracked
engine.

# Pull-request behavior

A pull request that changes the generator runs the same visible policy graph
against its checkout, including host parity and real-engine conformance, but it
cannot publish the website. Merging generator code changes affects future
nightlies; publishing newly discovered Defold revisions itself is automatic.

The real-engine job installs the selected revision's generated policy surface.
Its invariant tests must run against that selected surface. A committed
headless plan or runtime report is a fixture for its own pinned revision only:
byte-for-byte fixture checks are skipped when the selected revision differs,
while the selected revision still generates its own plan and must compile,
link, and execute in the engine. A pinned report must never be compared to a
fresh revision's plan or promoted as evidence for that revision.
