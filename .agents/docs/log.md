# Defold Hermes knowledge log

## 2026-09-22 - Development artifact writes no longer rebuild their own engine

The public `deherm dev` session now excludes only its exact tool-owned native
artifact outputs from the project watcher: the installed Hermes archive and
receipt directory, `libhermesvm-config.h`, the generated runtime-variant
selector, and `.defignore`. Atomic replacement scratch files are also rejected
before batching. Authored extension sources and headers beneath
`defold_hermes/src` and `defold_hermes/include/defold_hermes` remain visible to
the watcher.

A fresh War Battles session against the pinned local Extender completed one
ttsc/bundle generation, one Bob engine build, one engine launch, one exact
fingerprint activation, and one native Hermes inspector connection. Ten seconds
of subsequent telemetry produced no second build. The authenticated live-state
endpoint remained available with current-schema rows for 37 instances; the
arena row exposed `players=8`, `botSkill=2`, and `mapSeed=0`. Focused watcher and
dev-loop tests pass 19/19. This is real packaged native runtime and watcher
evidence; macOS remained locked, so the same values have not yet been visually
recorded inside the VS Code CodeLens.

## 2026-09-22 - Fresh War Battles HTML5 proves WebGL rendering and keyboard input

The current War Battles project now builds as a fresh `wasm-web` bundle through
the pinned local Extender. Emscripten 4.0.6 initially rejected a debug library
object containing native functions and `BigInt` values; the generated web
runtime now keeps link-time-safe null slots and captures those pristine browser
intrinsics immediately before application evaluation. Focused web-runtime
generation and bridge tests pass, and release generation strips the debug path.

The rebuilt artifact has fingerprint
`2f8c022bee455ca3794ffa3e3f0a632f136c6a1b58484e029d0d1981096badb9`.
Its browser gate observed Defold 1.14.0, 315 generated Lua symbols, all required
tutorial markers and the eight-player arena with no page failure. A separate
CDP observation reported a live WebGL 2 / GLSL ES 3.00 SwiftShader context and
49 live component instances; real `D` key input changed both the framebuffer
and camera position. Locally inspected before/after screenshots show the
tutorial scene and then the populated arena. This is exact local software-WebGL
and input evidence, not hardware-GPU performance, audio, multiplayer, native
Hermes, leak or sanitizer evidence.

## 2026-09-22 - Policy consumers tolerate bounded publication propagation

The public policy index and its content-addressed objects can become visible at
slightly different moments while GitHub Pages deploys a new site. A real hosted
consumer run resolved the new index successfully and then received HTTP 503 for
one referenced object. The policy client now retries transport failures and
HTTP 408, 425, 429, and 5xx responses with a bounded exponential schedule of
250 ms through 8 s. Authoritative 4xx responses such as a missing exact revision
still fail immediately, and every successful response remains authenticated by
its content digest before entering the immutable cache. Focused tests prove a
transient object becomes usable after two 503 responses without weakening the
existing one-request 404 failure. This is client/network resilience evidence,
not evidence that the publication host provides atomic multi-object deployment.

## 2026-09-22 - Project-authored message evidence stays separate from Defold declarations

The generated project resource table now carries an optional versioned
`projectMessages` projection. A bounded scan of every project TypeScript source,
including ordinary modules imported by components, records direct
literal message ids sent through canonical `MsgApi.post` imports and separately
records `hashLiteral("#name")` constants actually compared with an `onMessage`
message-id parameter. Each evidence site retains source, line, column, role, and
constant name where applicable. Dynamic expressions remain silent, and local
lookalikes outside `@deherm/project` or `@ts-defold/deherm` do not enter the
projection.

The table's route metadata constrains consumers to `MsgApi.post` parameter 1;
message ids never enter protobuf-derived resource namespaces and are never a
closed-world diagnostic set. Focused tests prove sender/receiver separation,
deterministic output under reversed file order, canonical-package gating,
dynamic-expression silence, and no resource-name mixing. Adversarial lexical
fixtures additionally reject expression-bodied arrow parameter shadows,
destructured shadows, regex contents after `yield`, locally shadowed hash
constants, and comparisons under nested message-id parameters. The slash
classifier now distinguishes expression-ending division from expression-starting
regex contexts and skips an unresolved source rather than guessing. Receiver
evidence is further limited to the exported object/class component forms the
component generator recognizes; arbitrary `onMessage` members are ignored. This
includes `for await` control boundaries, function-hoisted `var` shadows, and
semicolonless canonical import coverage. This is generation and semantic-index
evidence only, not runtime message-delivery evidence.

## 2026-09-22 - Bounded live component state reaches the developer control plane

Native debugger builds and the HTML5 host now project the same versioned live
component snapshot: runtime/sequence identity, deterministic slot/generation
handles, component/schema/context identity, and a closed value union for the
first 32 declared properties. Both implementations inspect only own data
descriptors through pristine intrinsics, bound strings to 256 UTF-8 bytes, and
roll back whole instances at a 512 KiB frame boundary. Native sampling occurs
at the engine safe point no more than four times per second while the private
inspector is connected; release builds return no frame. Browser HMR preserves
live attachment identity and navigation/detach clears it.

The marker-bearing browser sources now live only as immutable CLI templates;
the checked-in and packed extension files are generated release variants. Bob's
artifact selector materializes the exact requested debug or release variant,
and a browser development launch always builds a fresh debug `wasm-web` bundle
before opening the page. Repeated debug/release transitions in the repository's
own Defold project leave those templates byte-identical.

The existing inspector bridge consumes the reserved native envelope before CDP
forwarding and polls browser telemetry and component state in one evaluation.
Connection epochs plus runtime/sequence ordering reject stale snapshots. The
dev model joins a row to generated TypeScript source only on an exact component
id and schema fingerprint, clears rows on disconnect/engine stop, redacts values
from normal session logs, and exposes the full state only through an
authenticated, no-CORS, ETagged loopback endpoint. The TUI Instances view now
renders those genuine rows and leaves aggregate counters as a separate waiting
fallback.

Adversarial review additionally found and closed late old-page exit callbacks,
overlapping browser polls, structured roots surviving scalar/deleted/accessor
replacement, mutable-global `BigInt` dependence, and same-tree template
mutation. Evidence is the 18-test browser bridge suite; focused CLI model, lifecycle,
loopback transport, endpoint, and TUI tests; release and ASan/UBSan native
inspector binaries; and the release component-runtime executable. Those prove
schema, own-data safety, lifecycle invalidation, bounds, CDP coexistence, and
compile-out behavior in their respective harnesses. Fourteen thin-extension
tests plus its TypeScript build prove descriptor validation, authenticated
ETag polling, exact source/schema filtering, stale clearing, bounded value
rendering, and that the VSIX remains a client. A fresh local-Extender build then
launched the packaged arm64-macOS War Battles engine through the public
`deherm dev` path. The authenticated state endpoint observed runtime id 1 at
sequence 176 with zero omitted instances/properties and exact current-schema
joins for arena, camera, UI, player, tank, pickup, and rocket attachments,
including genuine slot/generation identities and declared-property counts.
That is packaged-engine-to-control-plane evidence. The CodeLens behavior is
covered by its client tests, but this wave did not record the values visibly
rendered inside an actual VS Code window.

## 2026-09-22 - Installed Defold semantic LSP and thin VS Code client

The public npm artifact now carries `deherm language-server --stdio`, a bounded
LSP 3.17 server using the same Content-Length framing primitive as the existing
DAP. It reads the generated `resource-symbols.json` rather than reparsing Defold
resources or inventing another project authority. Open TypeScript documents
receive project resource, collection-instance, and component-address
completion inside literals, plus generated provenance hover and
go-to-definition back to the declaring Defold resource. Watched generated
state reloads without a server restart; missing state returns an actionable
request error and leaves the server alive. The server does not advertise
ordinary TypeScript checking, completion, TSDoc, refactors, or navigation, so
VS Code's built-in TypeScript service retains the ownership recorded by the
development-loop decision.

`editors/vscode` is now an isolated VSIX workspace rather than part of the npm
payload. Its thin client discovers every `game.project`, resolves only the
workspace-local `@ts-defold/deherm` CLI, starts one scoped semantic server per
project, and launches that same package's existing DAP for the contributed
`deherm` debug type. Multi-project workspaces fail closed on ambiguous debug
selection. The generated project setup merges the `ts-defold.deherm` and ttsc
recommendations without deleting user entries and creates a launch file only
when none exists.

Focused evidence is protocol and artifact evidence: six LSP protocol tests
cover completion/hover/definition, watched-index reload, missing-state recovery,
malformed/non-file inputs, in-flight shutdown, and clean shutdown; 31 CLI tests
cover context generation plus non-destructive VS Code setup; eight extension
tests cover POSIX/Windows local-package lookup, nested-project ownership,
multi-project selection, exact LSP/DAP argv and environment, manifest shape,
and packaging exclusions. The production extension bundle builds and the VSIX
packager emits a client-only artifact. This does not yet prove a live VS Code
Extension Host session, route-specific message/material semantic completion, or
the live Defold instance/property channel; those remain explicit next gates.

A read-only Fable adversarial review found two material defects before landing:
string document globs did not attach a nested Defold project, and an in-flight
semantic response could write after orderly LSP exit. The client now registers
TypeScript documents broadly but admits completion/hover/definition only to the
deepest owning `game.project`, with nested ownership covered as a pure test. The
server makes shutdown idempotent and suppresses late replies, with a controlled
in-flight-request test. The same hardening pass rejects cross-workspace debug
fallback, makes malformed generated state actionable, ignores non-file URIs,
type-checks the extension as part of its test command, and launches protocol
servers through the package-supported Node.js 22.13+ toolchain rather than the
editor's older embedded Electron runtime.

## 2026-09-22 - Browser DAP stops authored War Battles TypeScript

HTML5 now uses the browser's own CDP endpoint through the same public `deherm
debug` DAP command and composed authored source map as native Hermes. The
browser target publishes a project-owned inspector descriptor containing the
exact Chrome target WebSocket; Chrome target ids are dynamic, so discovery
authenticates that URL rather than assuming the native `deherm` id. Browser
breakpoints bind the `defold-hermes://app(?:.<generation>).js` URL family and
are reapplied when HMR parses a numbered generation. The browser descriptor is
removed only by the target session that created it.

The first real run found two preconditions rather than being promoted from unit
tests: the disposable `wasm-web` bundle had to be rebuilt through the pinned
local Extender, and strict-mode `var` did not publish the compiler fingerprint
out of the browser host's indirect `eval`. The compiler-owned banner now writes
the fingerprint through `globalThis`; a VM regression proves the exact strict
indirect-eval semantics while native bundle inspection remains unchanged.

A fresh Defold 1.14.0 War Battles Wasm bundle then loaded in headless Chrome,
accepted development fingerprint
`c0e306477ae2056fa9a61e76a805b4edc77d1055c6129b844c2e72cf855451db`,
rebound four live components, and passed the public DAP proof:
`arena.script.ts:284` verified and stopped, the top `update` frame mapped back
to that authored location, `dt` evaluated to a live number, and continue plus
disconnect completed. This is compiler, real Chrome, packaged Defold Wasm, HMR,
and DAP evidence. It is not a VS Code UI/LSP or visual-gameplay claim.

The requested external adversarial review returned CLEAR with no P0/P1. Its
one P2 was mechanically valid: Chrome can retain old-generation closures and
unrelated page scripts, but the adapter projected every generated location
through the newest game map. The adapter now tracks the newest matching bundle
script, chooses that script when Chrome returns several breakpoint locations,
and leaves old/foreign frames at their raw URLs. Three lifecycle hardening
points were also accepted: descriptor validation is inside page cleanup,
launch refuses a page that exits while its descriptor is being published, and
the live proof fails immediately on a real bundle rejection. Focused tests
cover old-generation and foreign frames plus both launch cleanup paths. The
review claim that the browser descriptor was unreachable was rejected: the
public `--inspector-session` option already selects it; the missing piece was
the explicit manual command in tooling documentation.

The shared `globalThis` fingerprint banner was then re-proven in native Hermes,
not inferred from Chrome: the current War Battles engine acknowledged the new
bundle, and two consecutive public DAP sessions again stopped at
`arena.script.ts:284`, evaluated live `dt`, resumed, and disconnected without
restarting the engine.

## 2026-09-22 - Authored TypeScript DAP reaches a resumable paused Hermes runtime

`deherm debug` now speaks bounded standard DAP over stdin/stdout and attaches to
the private installed dev-session descriptor. The adapter maps authored `.ts`
breakpoints and stack locations through the composed source map, presents
scopes, variables, watches and source content, carries conditional breakpoints
and exception policy, removes replaced CDP breakpoints, reapplies them after an
HMR `Debugger.scriptParsed`, and resumes a paused target before detach. The
source-map cache uses nanosecond mtime plus size, so a same-size incremental
rewrite does not depend on millisecond timestamp resolution.

The first native breakpoint proof found a real transport deadlock rather than
being promoted as a pass: Hermes paused inside `Runtime::init`, but both the
`Debugger.paused` notification and incoming `Debugger.resume` were waiting for
the extension's next frame pump. Pinned Hermes' `RuntimeTaskRunner` already
solves the runtime-access half by racing the integrator queue against an async
debugger interrupt. The runtime now delivers outbound protocol bytes to a
thread-safe callback immediately, while the production `InspectorClient` owns
a bounded background socket loop for command receive and message send; only
idle-runtime tasks remain on the engine safe-point pump. Disconnect requests a
best-effort resume and rebuilds the inspector agent at the next safe point.

Evidence is separated by layer. `tests/dap-adapter.test.mjs` proves framing,
authored source-map projection, exact CDP command selection, breakpoint
replacement/reapplication, stack/scopes/variables/evaluate, and paused detach
against a recording CDP client. `defold-hermes-runtime-inspector-test` compiles
and executes a real pinned-Hermes authored-bundle breakpoint, receives the
paused event, resumes through a command issued from another thread, then proves
evaluation, CPU profiling, heap streaming and close. The separate
`defold-hermes-inspector-client-test` drives the production threaded transport
through deterministic in-memory `dmSocket` functions and proves paused and
resume cross it while the engine thread is blocked. Extension syntax passes 61
native/debug-inspector and 58 HTML5 translation units. Both native debugger
tests also pass strict ASan+UBSan. That combined build initially exposed a
libc++ template-coalescing collision because Hermes and `InspectorClient` both
instantiated `std::deque<std::string>` with container annotations; transport
frames now have a distinct `OutboundFrame` type and own their partial-send
offset, so no sanitizer suppression is needed. This is not yet evidence
for an installed Defold breakpoint, `update`/native-callback breakpoints, HTML5
breakpoint parity, VS Code UI, or non-macOS runtime execution.

## 2026-09-22 - Installed profiler capture has native and transport proof

The native development bridge now publishes an atomic private inspector-session
descriptor rather than asking tools to scrape a TUI log for an ephemeral port.
The descriptor is loopback-only, identity-owned, and stale-session safe.
`deherm profile cpu` captures the pinned Hermes CDP `Profiler` result as a
standard `.cpuprofile`; `deherm profile heap` streams heap-snapshot chunks to a
temporary file and atomically publishes the result without retaining the heap
graph in Node memory. Profile capture refuses to evict an attached debugger
unless the operator explicitly passes `--replace-debugger`.

Focused loopback tests passed the exact CPU request sequence, artifact content,
ordered heap-chunk stream, private descriptor mode, and replacement-safe cleanup.
Review of the cleanup algorithm found that its original read-then-remove sequence
still had a time-of-check/time-of-use window. Cleanup now renames the descriptor
to a unique claim before validation and restores a mismatched or malformed claim
only when no newer canonical descriptor exists; the focused suite preserves both
replacement and malformed evidence and passes 11/11.
The pinned native Hermes runtime separately compiled and executed `Profiler.start`,
work under `Runtime.evaluate`, `Profiler.stop`, and a non-empty
`HeapProfiler.takeHeapSnapshot`. That native test exposed a reused-CMake-cache
defect: enabling the debugger did not update Hermes' previously cached memory
instrumentation flag. The checkout build now forces both flags together.

The public CLI then captured a five-node, 22-sample CPU profile and streamed
seven heap chunks into a valid 654,011-byte, 63,924-node snapshot from running
War Battles. The game was built through the pinned local Extender; the first
attempt without an explicit server reproduced the known public-service `r8Cmd`
schema mismatch, so the repository's private War Battles `dev` script now
selects its local server explicitly. This integrated evidence covers arm64
macOS, not every packaged target. The run also materialized the project's
`generated_runtime_variant.h` inside the checkout template; the policy check
caught discovery treating that per-project debug/release selector as a
revision-derived output. Revision-output classification now excludes it and a
focused test keeps future local dev runs from perturbing published policy roots.

War Battles had also been tracked as a symlink to the contributor checkout's
native-extension template. Selecting the debugger artifact for that project
therefore rewrote the checkout's canonical release archive. The CLI now installs
its managed package extension before the project-readiness inspection, and the
example consumes an ignored project-owned copy like an external npm consumer.
Running the public generation command from a project with no extension present
materialized that copy and the published policy surface; both checkout release
and debug archives retained their authenticated digests afterward.

## 2026-09-22 - Native Hermes CDP survives a real War Battles HMR swap

Development artifact installation now keeps both Hermes variants in the
content-addressed user cache but places exactly one selected archive under the
project's canonical library name. The install receipt binds the selected and
canonical members, target fingerprint, config header, installed digests, and
exact byte lengths. Repeated builds use that keyed size sentinel without
re-hashing the archive; explicit verification still hashes bytes. The release
template remains variant-neutral. This closes the concrete Extender
regression where recursively discovering both archives made link selection
order-dependent.

The debugger Hermes runtime owns `CDPDebugAPI` and `CDPAgent`, queues callbacks
from arbitrary Hermes threads, and pumps them at engine JavaScript safe points.
The extension carries a bounded loopback NDJSON client; the Node development
control plane projects it as standard `/json/list`, `/json/version`, and
`/devtools/page/deherm` WebSocket endpoints. Candidate HMR runtimes bind before
evaluation and rejected candidates restore the prior binding.

Evidence is separated by stage. `pnpm test:runtime-inspector` compiled and ran
the debugger-enabled runtime, accepted `Runtime.enable`, evaluated `6*7` as 42,
rejected a second session, and failed closed after detach. The focused Node
bridge test passed exact command/response forwarding. A pinned local Extender
then built and launched War Battles with the debugger archive; the engine
reported inspector connection and live telemetry, and a standard WebSocket CDP
client evaluated the active bundle fingerprint. After a watched TypeScript edit
activated the next runtime generation, the same WebSocket evaluated the new
runtime successfully; restoring the file activated the following generation.
The release runtime also built with no undefined CDP symbols. This proves native
CDP transport, evaluation, telemetry coexistence, and HMR rebinding on arm64
macOS. It does not yet prove authored-TypeScript breakpoints, DAP behavior,
profile export, VS Code UI, HTML5 breakpoint parity, or other native targets.

## 2026-09-22 - Installed developer-loop boundary corrected

The roadmap now records the already-shipped boundary explicitly: packed-package
project discovery/scaffolding, incremental watch/build/launch, native and HTML5
fingerprint-acknowledged HMR, live telemetry, keyboard/mouse log navigation,
OSC52/local clipboard copy, `.deherm/dev/session.log`, and `q` teardown are
complete. The incremental compiler also already writes source-content maps and
passes them into debug Hermes bytecode compilation. The remaining developer-
experience work begins at native Hermes CDP/DAP and profiler transport, the
editor-neutral language server, and its VS Code client. This correction is a
documentation boundary based on existing code and tests; it is not new runtime
evidence and does not reopen the completed policy/materializer or HMR
implementation seams.

## 2026-09-22 - Installed HMR review closure is fail-closed and packable

The post-wave adversarial review found no P0/P1 issue. Two P2 observations had
already been closed before the report arrived: component-schema change state is
sticky until its watcher batch consumes it, and Bob's compiled-resource digest
cache has a direct same-size/replaced-content test. The remaining profile
observation was valid: generated detection now reports more than one exact Lua
registration match as ambiguous, and generation rejects profiles with identical
registration vectors so a future Defold feature combination cannot silently
select the first runtime mask. All six current profiles remain distinct.

The packed `@ts-defold/deherm/component` subpath is now compiled by the npm smoke
without importing the deliberately absent revision-specific SDK tree. Stable
component property shapes use distinct `ComponentVector3`, `ComponentVector4`,
and `ComponentQuaternion` names; the policy-materialized SDK remains authority
for branded Defold values. The same smoke caught and closed a package-emitter
parity gap for the newly generated registration masks. Custom generated roots
are excluded from watch input, while only manifest-owned Lua proxies are ignored,
so hand-authored `.script` and `.gui_script` resources still schedule Bob. The
focused materializer, installed dev-loop, watcher, generator, type, and packed
consumer tests pass. The `.hbc` file remains a compiler artifact; only the
`.dehermc` resource is claimed as activated by the native extension.

## 2026-09-21 - Real War Battles HMR is single-shot and its state boundary is measured

The installed `deherm dev` path now distinguishes a TypeScript component body
edit from a Defold resource-schema edit. Generated Lua proxies contain only
Defold-relevant schema/lifecycle/property state; full source provenance remains
in the generated component manifest. The generator reports changed Defold
resources separately, so body-only `*.script.ts`/`*.gui.ts` edits compile and
activate one bundle without Bob while schema changes retain the slower Bob path.
Watcher exclusions now cover bytecode and `deherm.lock`, touched Bob outputs are
content-compared before reload, and the bundle plus compiler-only HBC artifact
are not posted again from Bob. The installed-package process fixture
proves body vs schema classification and suppression of duplicate bundle/HBC
resources. The root package again exports `@ts-defold/deherm/component`, and the
War Battles workspace `pnpm dev` command resolves its entry/watch roots from the
declared Defold project instead of duplicating `defold/defold`.

A real local-Extender build and Defold `7f0f554` run loaded runtime profile
`default-legacy-bullet` from 315 generated Lua symbols, activated fingerprint
`5de1ceb3...`, auto-engaged eight players, and emitted live Hermes heap,
component, Lua-handle, and arena telemetry. Editing `SPARK_TICKS` and restoring
it produced only generations 2 and 3: each had one compiler build, one reload
signal, and one exact fingerprint-bound activation (`6334816a...`, then
`5de1ceb3...`) with no Bob build and no runtime error. This is real installed
compiler/native-engine HMR evidence, not an editor, remote-device, or HTML5
claim. It is also not state-preservation or leak certification: fresh Hermes
component state reran game initialization after each runtime swap, and observed
component counts rose 51 -> 95 -> 127 as War Battles spawned another arena
presentation. [Issue #120](https://github.com/ts-defold/deherm/issues/120)
tracks the required state migration, generation-owned teardown, and reload soak;
that measured boundary remains explicit work rather than being promoted to a
green memory claim.

## 2026-09-21 - Packed policy consumer executes a usage-specialized dmSDK twin

The packed npm smoke now resolves the external content-addressed policy,
materializes `dmMath::Clamp<int32_t>` from concrete usage facts, and compiles,
links, and executes both the production C-ABI wrapper and its generated exact
call twin. A minimal independent SDK header models the header seam supplied by
the Defold build host; this proves package/policy realization and the generated
bridge contract, not Defold implementation semantics. The same smoke verifies
every materialized SDK and revision-output file against its revision-abstracted
policy digest instead of pinning a brittle output count.

The current output inventory is 118 files: 12 package-rendered outputs and 106
authenticated compatibility sources. The two new dmHash state files plus prior
inventory growth made the old 116-file and 1,654,731-byte snapshot assertions
stale. Exact path equality with `discoverCompilerSurfaceOutputs()` remains the
authority; the compatibility-source debt is now 1,663,947 bytes.

The exact-call acceptance audit also found that policy CI executed the bounded
Static dmSDK unit but omitted the already-green 325-route Static script unit.
The policy graph now builds and runs both targets. Hosted green evidence remains
required before closing the exact-call ledger issue; the local script executable
reports `325-routes:all-static-emitted:typed-native:ok`.

## 2026-09-21 - Named-enum tail result validation

`liveupdate.remove_mount` now derives its accepted numeric result domain from
the pinned `dmLiveUpdate::Result` declaration and the `LIVEUPDATE_*` constants
actually exported by `script_liveupdate.cpp`. The generated value-tail
route carries compact offsets/counts in generated parallel tables and
rejects any numeric result outside that exact domain. The existing GUI/render
wrong-context probes already prove pre-Lua fail-closed behavior; the recording
Lua-adapter fixture is already discovered and byte-compared by clean-room
regeneration. The shared GUI-node handle type remains one lifecycle identity,
and the underlying fixed handle-pool test now proves duplicate releases are
rejected before drain.

The same adversarial pass found that Static exact verification did not require
a provider-recorded marker for zero-argument routes. The native executable now
requires a non-empty recorded context for every one of its 325 vectors, the
family audit cross-checks the route-derived census against the applicability
lane census, and cyclic shapes reach the explicit fail-closed cycle guard.

The dmHash review also removed revision-wave partition arithmetic and allocation
claims from the family report: the aggregate exact plan now owns the current
566/74/721 partition, while zero warmed C++ allocations remain runtime-test
evidence only. Update lengths above `INT32_MAX` fail before Defold's signed cast;
the generated corpus now verifies reverse-hash Init, cloned state, transported
UpdateBuffer bytes, and consumes every temporary registry slot. Dense IDs and
fake counters derive from the same code-unit-sorted entry set. Both generator
check modes use OS temporary directories, so interrupted multi-agent checks no
longer leave repository-root residue.

## 2026-09-21 - Generated dmSDK fast-path wave expands and ships

The borrowed-handle generator now admits 158 of 348 structurally compatible
routes (up from 80), with exact typed provider twins, pinned-header compilation,
ASan/UBSan execution, narrow-result rejection, and zero observed C++ allocations
across 100,000 warmed dispatches. The named-scalar sibling generates all 21
reviewed aliases and the bounded arena sibling generates five C-string calls;
both retain the universal recipe as their preferred fallback. The universal
catalog still contains all 1,361 declarations with zero omissions, while 224
candidate adapter routes were re-evaluated against the universal materializer.
Only 66 remain preferred (59 callable and seven provider-gated); 1,295 retain
the universal route, and the exact universal corpus expands to 566. The 158
borrowed provider boundaries remain generated and verified as additive lanes
instead of suppressing their working universal recipes.

The final adversarial pass closed two carrier edge cases in the generators:
borrowed dispatch now zeroes result storage before every fallible check and on
successful `void` calls, while arena C-string dispatch stages input before
clearing output so same-buffer and partial-overlap calls remain valid. Both
have executable sanitizer-backed regression vectors.

The expanded browser/Wasm exact harness executed all 566 universal vectors in
the live Emscripten heap under Chrome, with 1,154 balanced reverse-order
releases and a 240-byte peak live arena allocation.

The production runtime links the borrowed C ABI/JSI module and the
arena C ABI, and its public C header exposes those generated contracts. Focused
codegen is 97/97 green; clean-room regeneration reproduces its owned artifacts
byte-for-byte. The 915-route recording engine, 882-route Lua exact adapter, and
31-route native-POD driver all execute successfully. The real Wasm/Chrome lane
also executes 911 routes and 23 callbacks, and its provider now assigns every
returned owned handle a unique fixed-capacity identity and proves each is
released exactly once; the generated failure report includes the last contract
error. The fixed identity ledger is sized for the strongest native run (all
three transports in one process), and reserved borrowed seed identities are
excluded from the issued-result ledger; the focused native run finishes with
zero lifecycle violations and zero transport divergences.
These are exact bridge/provider proofs, not claims that all borrowed handles were
supplied by a packaged Defold engine.

## 2026-09-21 - OKF retrieval uses a bounded content-addressed graph

The repository's canonical OKF helper now maintains a disposable SQLite graph
under `.deherm/cache/`, keyed by document and referenced-source digests. Search,
outline, section, links, backlinks, and physically read-only SQL queries return
bounded summaries without loading generated policy bodies. Heading identities
use deterministic anchors, graph edges cover Markdown, frontmatter sources, and
mechanical ownership/generation/verification references, and concurrent readers
wait for refresh transactions. The CLI supports positional searches as well as
`--query`/`--limit` aliases and subcommand help.

## 2026-09-21 - GCC exact-call engine lane treats Defold headers as upstream

The Linux engine lane exposed two compile-only defects after the native
artifact matrix completed: GCC correctly rejected misleading one-line control
flow in the generated Lua exact-call twin, and `-pedantic -Werror` promoted
Defold's intentional zero-length trailing-array ABI declaration to an error
while the Clang-only suppression flag was ignored. The recording-engine
generator now emits unambiguous blocks and statements, and the pinned Defold
dlib include root is a CMake system include. Strict warnings remain enabled for
deherm sources; upstream ABI headers no longer inherit this repository's
warning-as-error policy.

## 2026-09-21 - Mutable publication pointers stay outside the immutable object cache

Online policy resolution now revalidates the per-revision index entry and
artifact mapping instead of treating their revision-keyed paths as immutable.
The content-addressed roots and compiler objects remain cache-first and are
reused by digest; explicit offline resolution consumes the last validated
pointer. Receipts are keyed by both revision and policy root, so a newer
generator can publish a more complete projection for an unchanged Defold
revision without overwriting the evidence for an earlier root. Focused coverage
replaces one revision pointer and proves that only its new content closure is
transferred.

The integration review also found that project-local realization trusted
lexical confinement while filesystem symlinks could redirect a generated write.
The materializer now enforces an explicit output boundary and rejects symlinks
in every existing destination component before directory creation and again
before reading or writing a file. The CLI binds project pins to the project root
and shared surfaces to the selected user cache root. The same review found the
lowering-recipe extractor absent from the policy generator fingerprint; it is
now an owned generator source, so changing recipe semantics rotates provenance.

## 2026-09-21 - Policy realization transfers lazily and pins project surfaces

* `deherm policy` now authenticates the exact revision index and root before
  transferring only `@compiler`, `@toolchain`, and compiler-manifest references;
  unrelated Lua namespace objects stay remote. Content-addressed policy objects
  are shared across revisions and projects, warm resolution works with
  `DEHERM_OFFLINE=1`, and corrupt cached bytes fail instead of falling back to
  the network or another revision.
* `deherm policy --project-cache` (or `--pin`) explicitly realizes into
  `<project>/.deherm/cache/surfaces/<revision>/` while policy evidence remains in
  the user cache. CLI and JSON output report cache hits, misses, writes, transfer
  bytes, and surface writes independently. Focused coverage exercises cold
  transfer, warm offline resolution, cross-project reuse, corruption rejection,
  and idempotent population.

## 2026-09-21 - Stable output templates and compact SDK facts replace 15 snapshots

The policy materializer now reconstructs three SDK support files from compact
manifest facts and 12 repository outputs from package-owned compiler emitters.
The SDK boundary moves from 13 rendered / 15 copied files to 16 rendered
(3,791,819 bytes) / 12 copied (78,435 bytes). The 114-output boundary moves
from 114 copied files (1,536,904 bytes) to 12 rendered (5,385 bytes) / 102 copied
(1,531,519 bytes). Eleven output recipes are invariant templates; the universal
dmSDK JSI header consumes only the authenticated recipe count. All outputs
remain byte-identical to the frozen source-pipeline evidence, a second pass is
write-free, and malformed SDK facts or source objects on local output recipes
fail closed. The remaining snapshots are explicitly treated as revision facts
until their semantic projections are extracted; unchanged bytes alone are not
used as evidence that an output is package-stable.

## 2026-09-21 - Lowering plans materialize from compact recipe facts

The policy compiler surface no longer authenticates copied
`defold-binding-lowering-plan.json` and sentinel documents. It authenticates a
2,560,034-byte schema/string-interned recipe-fact object; the package-owned
`binding-lowering-plan-recipe.mjs` emitter reconstructs the frozen
16,750,538-byte old-pipeline plan byte-for-byte and emits cache metadata keyed
by the emitter and exact lowering input identities. The replaced plan policy
object was 10,507,488 bytes, so this tranche removes 7,947,454 bytes (75.64%)
without moving Defold names, contracts, backend selections, or dispositions
into package code. Focused tests cover canonical policy serialization,
policy-only realization, old-pipeline equivalence, and keyed idempotence.

## 2026-09-21 - User caches follow native host conventions without destructive migration

The shared policy, realized-surface, toolchain, and native-artifact roots now
resolve beneath the same host-native cache home: `~/Library/Caches/deherm` on
macOS, `%LOCALAPPDATA%/deherm/cache` on Windows, and `~/.cache/deherm` on Linux.
`DEHERM_CACHE_HOME` and `XDG_CACHE_HOME/deherm` remain higher-priority explicit
overrides. When Windows does not expose `LOCALAPPDATA`, the deterministic
fallback is `~/AppData/Local/deherm/cache` rather than the roaming profile.

macOS and Windows resolution keeps the former `~/.cache/deherm` root as a
lower-priority, read-only compatibility layer. No implicit move or rewrite can
damage a valid cache, new writes always use the native root, and an explicit
override never consults the fallback. Cross-platform path tests inject platform,
home, and environment values rather than depending on the runner OS.

## 2026-09-21 - Browser exact calls cover every emitted script route

The generated browser exact-call driver now executes all 911 emitted script
routes in a real Emscripten module and headless Chrome: 888 direct-memory rows
and 23 callback-registry rows. The same generated route/shape/vector IR drives
the provider and caller. Exact stable IDs, arguments, results, observed handle
disposal, generic callback retain/invoke/release, registry reset, nested
reentrancy, and callback state cleanliness are checked without mocks.
Route-specific callback lifetime policies remain separate lifecycle evidence.
The two function-result routes
that the browser target does not emit remain explicit applicability blockers.

Expanding from the callback-only slice found a production transport defect.
The browser bridge placed roughly 193 KiB of family-wide wire scratch on every
Wasm call stack; an isolated module using Emscripten's default stack overwrote
static callback state. The generated host now lazily allocates one bounded
scratch arena for each reentrancy depth actually observed, reuses warmed slots,
and frees every slot on full bridge reset. Ordinary HMR reuses the bounded
pool. The test passes without increasing the default stack and requires both a
clean success record and a zero-status runtime-exit record.

Native artifact publication was independently blocked by Linux, Android, and
Windows builders copying `libhermesvm-config.h` from an incorrect nested build
path instead of CMake's actual build subtree. All builders now use
`<build>/lib/config`,
with cross-platform parity assertions. This changes the content-addressed
artifact fingerprint; CI evidence remains pending until the replacement
archives publish. The concurrent OKF cache also now waits up to five seconds
for SQLite writer/exclusive locks, with cross-process tests proving refresh and
read contention no longer fail spuriously.

Evidence: Chrome 153 and pinned Emscripten 4.0.6 reported
`DEHERM_SCRIPT_BROWSER_EXACT_OK routes=911 callbacks=23` on the default Wasm
stack. Focused recording, universal-value, web lifecycle, artifact-plan, and
OKF tests pass locally. This is exact generated bridge-contract evidence, not
semantic execution of every operation inside a packaged Defold game. Native
artifact CI and the full repository gate were not yet complete when this entry
was written.

## 2026-09-20 - Integrated API wave closes review defects and repository gate

The generated dmSDK exact-call corpus now executes 486/486 applicable vectors
through the rebuilt Static Hermes executable, the production JSI host function,
and the real Emscripten heap/direct-export browser lane. Project generation also
discovers local and dependency public extension headers automatically, retains
exact C symbol names, builds deterministic IR/TypeScript/glue/exact twins, and
passes the packed npm consumer smoke.

Independent adversarial review found two reproducible P2 defects outside the
binding corpus. The OKF graph could alias a duplicate heading with a literal
ordinal-suffixed heading; its anchor allocator now reserves every emitted anchor
globally and schema version 5 forces disposable indexes to rebuild. ZIP entry
filters normalized names without normalizing the returned entry map; discovery
and materialization now share canonical names and reject duplicate canonical
paths. A `./`-prefixed dependency fixture exercises the latter through project
generation.

Evidence: the focused post-review suite passed 62/62 tests; the Static Hermes
executable reported 486 runtime-executed, zero blocked, maximum arity 9, bounded
frame, argument tag mask `0x3e`, and result tag mask `0x3f`; the complete
`pnpm check` repository gate passed after both corrections. These exact-call
tests prove generated name/signature/order transport, not the semantic behavior
of every Defold engine operation.

## 2026-09-20 - dmSDK browser arena exact calls cover the ready corpus

The browser gate now uses a real Chrome runner that imports the production
generated JavaScript arena codec and drives all 486 universal-ready vectors
through the live Emscripten heap and common dispatcher. The wire-tag/arity
partition is 486 applicable and zero unsupported, while preserving structured
blockers for future gaps. Generated call/failure/result observations pass; 994
scratch allocations have 994 reverse-order releases with a 240-byte peak and
no mock memory, Embind, `ccall`, or `cwrap`.

## 2026-09-20 - Project discovery owns native extension exact-twin generation

`deherm generate` now feeds every discovered local and dependency-ZIP public C
header into the compiler-owned native-extension generator. Header and complete
public include-tree bytes join the project cache identity; outputs live under a
Defold-revision/project-generation key and include normalized IR, TypeScript,
production C++ glue, the exact-call
twin/driver, and a machine-readable report. Unsupported signatures, parse
failures, and prefix mismatches remain explicit blockers. `verify-generated`
checks both the index and the complete owned tree. The installed-package smoke
exercises this flow from a consumer project without the isolated header command;
this is generation and fake-callee exact-call evidence, not Defold extension
linkage or behavior evidence.

## 2026-09-20 - Static Hermes exact replay covers the complete current partition

The Static Hermes dmSDK exact runner now derives an applicability partition
from the canonical 486-vector universal-ready plan and the compiler-owned
32-cell/wire-tag frame capability. All 486 current vectors are applicable and
execute through the production bounded frame API in strict sound-typed output;
the native harness checks one recording-callee call, zero argument failures,
and all six result-cell fields for every vector. The generated evidence retains
every canonical row with an `execute` or `blocked-capability` disposition;
synthetic over-capacity and unknown-tag regressions prove future unsupported
rows receive machine-readable blockers instead of disappearing. This is Static
transport evidence, not Defold implementation or retained ownership evidence.

## 2026-09-20 - OKF retrieval becomes an incremental SQLite graph

The canonical Markdown bundle now has a disposable, digest-keyed SQLite
retrieval index under `.deherm/cache/`. It represents documents, headings,
declared sources, explicit links, and narrow owns/generates/verifies relations;
referenced generated JSON contributes only its path and digest. Search, outline,
section, and physically read-only SQL interfaces enforce result and content
bounds. A second refresh of the real 91-document bundle reparsed zero documents
and reused all 91. Tests cover incremental invalidation, graph edges,
metadata-only generated data, output limits, and rejection of SQL writes.
Adversarial review then reproduced byte-volume bypasses, stale-schema startup
failure, CRLF frontmatter loss, and an inaccurate Node floor. The tool now caps
cells, lines, queries, and complete responses by bytes; reduces BLOBs to bounded
metadata; rejects recursive SQL; recreates mismatched schemas before indexing;
normalizes Markdown newlines; and requires Node 22.13 or newer. Regression
fixtures reproduce every corrected failure.

## 2026-09-20 - Exact-call review corrections and artifact delivery close locally

Adversarial review found two evidence problems in the integrated wave and two
artifact-delivery gaps. The generated dmSDK verifier now executes all 59
production family routes through their linked dispatchers with ordered native
sentinels and result checks. Dynamic-Hermes JSI evidence is correctly limited
to the 33 scalar/enum routes whose modules ship; the fourteen staged-private
C-string routes are not claimed. JSI vectors check every decoded lane and the
returned type/value, and regeneration checks use a temporary tree rather than
repairing committed output. The complete focused exact-call set passed 44/44,
the dmSDK runtime-codegen suite passed 86/86, and clean-room regeneration
reproduced 108 artifacts for all 1,361 declarations.

An artifact-free package checkout now exercises the published `dehermc` binary
that customers download. Policy publication retains the previous fully
available artifact mapping until every asset for a replacement mapping exists;
native-artifact completion then requests a policy refresh. The focused
policy/package suite passed 49/49. The complete `pnpm check` gate passed after
these corrections. This proves generated state, exact bridge tests, package
resolution, and clean-room determinism; it does not promote unobserved
packaged-engine behavior.

Repository knowledge retrieval is now bounded: agents search document metadata
and headings, inspect an outline, and retrieve one capped section instead of
preloading the 90-document OKF bundle. Large generated policy and evidence
objects remain behind their owner summary commands.

## 2026-09-20 - Integrated exact-call and artifact wave passes the repository gate

The integrated compiler-artifact consumer, browser callback exact-call, dmSDK
generated-adapter exact-call, host-deterministic policy, and Apple artifact
staging changes pass `pnpm check`. The dmSDK clean room initially rejected the
three new exact-call outputs because its discovery rules lagged the generator's
ownership registry; discovery now recognizes the generated plan and both
generated fixtures. A blank clean room reproduces all 1,361 dmSDK declarations
across 108 byte-identical artifacts, including all 59 generated-adapter exact
vectors. This is deterministic generation and focused bridge execution
evidence; it does not promote unobserved packaged-engine routes to runtime
evidence. The generated script-family sanitizer gate also passed under
AddressSanitizer and UndefinedBehaviorSanitizer, including callback lifecycle,
the 882-route Lua adapter, and the 31-route native-POD complement.

## 2026-09-20 - dmSDK trait census assertion follows its generated authority

The complete dmSDK runtime-codegen suite exposed a stale hard-coded test count:
the owner generator and committed byte-identical binding-pattern artifact both
classify 867 declarations with the compositional `enum-handle` trait, while the
census assertion still expected 862. No generator or policy input changed in
this repair; the assertion now matches the already-current generated authority.

## 2026-09-20 - Browser callback routes have generated real-Wasm exact calls

The applicability catalog's 23 `browser-wasm-callback-registry` routes now own
lane-specific exact vectors generated from the same route, shape, contract, and
lifecycle IR as production. A real Emscripten module links the production
direct-memory universal bridge and the production callback registry; Chrome
observed all 23 stable IDs, ordered forward arguments/results, callback
arguments/results, retained dispatch, explicit native release, stale-token
finalization, capacity exhaustion, reset invalidation, and nested reentrancy.
The driver does not use Embind, `ccall`, `cwrap`, or mock memory. The real run
used Emscripten 4.0.6 at revision
`24fc909c0da13ef641d5ae75e89b5a97f25e37aa` and Chrome 153.0.8010.48; its
vector manifest SHA-256 was
`c3982c0d91c40b1de9d4f6a5dac42eb03b3aa8176dd0f2dd4f04ea8bf3442298`.

The run exposed and fixed a verifier lifetime bug: the provider retained a
registry context but stored the `ScriptCallback*` that lived in the decoder's
per-call scratch. It now copies the fixed callback record by value before
retaining the context. This is standalone exact JavaScript/Wasm bridge evidence,
not a claim that a packaged Defold HTML5 game exercised every route. The two
higher-order Lua closure-result routes remain the browser target's explicit
blockers.

## 2026-09-20 - Apple artifact staging follows Hermes' actual CMake tree

Native-artifacts run `35549652243` completed both release and debugger Hermes
builds for all four macOS/iOS rows, then each row failed while copying
`<build>/hermes/lib/config/libhermesvm-config.h`. The pinned Hermes root adds
`lib` directly and its library CMake file configures the header into
`<build>/lib/config`; there is no intermediate `hermes` directory. The Apple
packager now stages the header from that authoritative location. A focused test
ties our copy path to both upstream CMake declarations so a future Hermes layout
change fails with the source contract visible.

## 2026-09-20 - Policy source snapshots are host-byte deterministic

The Windows policy parity lane passed every importer and generator check, then
derived three absent objects, one differing object, and a stale manifest. Two
host-dependent inputs remained. The Linux surface archive omitted
`packages/abi/src/generated` even though the compiler-output registry declares
that directory revision-derived, so parity runners sealed the files from their
own checkout rather than Linux's exact generated tree. The policy also embedded
raw TypeScript/C++/JavaScript compatibility sources without normalizing Git
checkout newlines. The archive now transports and replaces the ABI directory,
and derivation canonicalizes every text snapshot to LF before revision
abstraction, hashing, and embedding. SDK snapshots are read through the supplied
source root rather than the process's checkout root. A focused hash test covers
LF, CRLF, and legacy-CR equivalence; the Windows workflow remains the cross-host
proof. Check failures now name exact missing or differing policy paths rather
than counts alone.

## 2026-09-20 - Package smoke consumes the compiler artifact customers receive

The packed-package smoke no longer invokes `build-dehermc.sh`. Its
pre-publication lane accepts the exact Linux archive produced by the artifact
job, stages that member into a fresh offline cache, and requires release
typechecking and the development compiler to execute the pinned path and
SHA-256. Every produced host binary is now compared against both the byte size
and digest in `host-compilers.json` before upload, so release completeness can
no longer mistake a correctly named but different binary for a valid row.

The post-publication end-to-end lane supplies no compiler path and starts with a
fresh cache. The installed CLI must download the content-addressed release
archive through its normal resolver, extract and authenticate it, cache it, and
execute it. Local execution passed both the supplied-archive lane and the clean
online-download lane with the Go fallback pointed at a nonexistent path. This
is installed compiler and delivery evidence, not Defold linkage or runtime
evidence; reproducible compilation remains a separate producer concern.

## 2026-09-20 - Exact-call applicability now follows production emission

The script recording engine no longer treats generic harness drivability as a
claim about what each target emits. A compact catalog derives four canonical
lane IDs per each of the 915 universal routes from the lowering plan and interns
their exact argument/result obligations into 406 vectors. The resulting target
partition is Dynamic Hermes 882 JSI/Lua-stack + 31 native-POD + two omitted,
Static Hermes 325 typed-native + 588 blocked + two omitted, browser/Wasm 888
direct-memory + 23 callback-registry + two blocked + two omitted, and Lua 911 +
two blocked + two omitted. A generated driver executed all 31 native-POD routes
through a real Hermes runtime and the production value-binding dispatcher. The
generic 915-route recorder and 882-route Lua adapter also remained green. This
is exact bridge evidence; the 23 browser callback-registry routes remain an
explicit next execution obligation.

dmSDK release reachability now preserves three distinct states instead of
treating every preferred adapter as unresolved. The complete 1,361-recipe
surface partitions into 486 universal-ready calls, 59 callable generated
adapters (45 named wrappers plus 14 C-string dispatcher IDs), and 816
specialization-required calls. The shared concrete-call plan authenticates and
materializes only callable reached adapter identities. It keeps 87 generated
provider boundaries blocked by their original policy and leaves 729 rows for
mechanical call-site specialization. Usage materialization also emits a
compiler-owned Dynamic Hermes/JSI runner and report beside its native sources;
the canonical 486 vectors execute through the real production JSI host
function. Family-owned adapters are retained and reported but are not falsely
counted as JSI exact vectors yet.

The policy engine job now builds and runs the generic recorder, Lua adapter,
native-POD driver, Lua bridge, Dynamic Hermes end-to-end executable, Static
special-call executable, and browser runtime tests. Local execution passed all
of those targets. This strengthens CI evidence without promoting it to Defold
implementation semantics or packaged-engine conformance.

## 2026-09-20 - End-to-end scaffolding uses the policy revision it verifies

Push run `35546616318` resolved the committed policy successfully, then failed
because its scaffold independently selected Defold's newer live stable SHA
`574678c7d44be490d874fbed2d0ae6211feec4d9` before the policy workflow had
published that revision. The end-to-end gate now passes its own exact
policy/artifact revision to `deherm create --defold-sdk`, so policy resolution,
scaffolding, generation, target artifacts, and Bob answer for one engine instead
of racing two authorities. The focused gate tests pass, and the corrected local
scaffold plus generation/type-check stages completed with zero failures against
`7f0f554f41f9dce1e0ddff99bf08200657d1ee05`. This is consumer generation and
type-check evidence, not Bob linkage or runtime evidence.

## 2026-09-20 - The npm package is revision-neutral and target archives are fetched

The accepted policy/materializer ownership boundary is now enforced against the
real `npm pack --dry-run --json` inventory. The measured tarball is 491,849
packed bytes / 2,032,591 unpacked bytes across 184 files and contains no policy
store, fixed generated SDK/ABI surface, or platform `.a`/`.lib` archive. The
installed-package smoke materialized 17 compiler documents, 28 SDK outputs, and
114 revision outputs from an external authenticated policy fixture, scaffolded
a project, reconciled the browser Static-Hermes lane, type-checked it, and ran
the dev compiler. That is generation/compile evidence, not native linkage or
runtime evidence.

Native Hermes libraries remain GitHub Release assets indexed by Defold bundle
target. Each native archive now carries its release library, debug library, and
the `libhermesvm-config.h` generated by that same release build. A generated
project carries the authenticated target matrix and release mapping; the first
native build downloads only the selected target into the platform-native
per-user cache, copies its declared members into the Defold extension, and
records tag, fingerprint, and every member hash. Subsequent projects reuse that
cache. The package prepack gate now checks the revision boundary and explicitly
refuses both native libraries and the target-specific config header.

Target-cache reuse now requires its own receipt naming the exact release tag,
input fingerprint, asset, target, member list, archive digest, and member
digests; every cached member is rehashed before reuse. A missing or mismatched
receipt forces a staged online replacement and fails closed offline, so a
partial or corrupted cache cannot be blessed merely because the expected
filenames exist. This proves post-download cache integrity. Independent
first-download authenticity remains a separate publication claim and is not
inferred from a self-recorded cache receipt.

The same correction now covers host executables. The old optional
`@ts-defold/deherm-compilers-*` package manifests and resolver path were removed;
`hermesc`, `shermes`, and `dehermc` resolve from content-addressed GitHub release
archives in the platform-native user cache. Repository staging remains a
development override, and `DEHERM_TOOL_CACHE` remains the explicit CI/offline
override.

The source checkout and published package now have separate TypeScript
resolution seams. Repository examples map `@ts-defold/deherm` to the checked-out
materialized SDK so the full generated surface remains type-checked; the npm
export still resolves to the revision-neutral package entry. This prevents
monorepo dogfooding from forcing one Defold revision back into the tarball.

The same distribution boundary is now enforced while running directly from a
checkout. Managed-extension installation filters target `.a`/`.lib`/shared
library/debug-symbol outputs, artifact receipts, and the generated
`libhermesvm-config.h` before hashing or copying the extension; the portable web
host source remains eligible. A focused fixture placed fake native artifacts in
a source extension and proved none reached the generated project while the web
adapter did. The compiler root also exports only the pure lowering function;
repository input loading now requires an explicit authenticated/materialized
root and is not part of the public compiler barrel. After regenerating policy
root `0a4d01692191125173e56af85557b7cd9c10c22cd793e0ee8ec60f5618f59314`,
the complete `pnpm check` passed with these review fixes included; focused
copy-boundary, package-smoke, lowering-plan, and cache tests also passed. Native
linkage/runtime evidence is not claimed by those tests.

## 2026-09-20 - The generated script corpus now reaches the real Lua adapter

The recording-engine owner now emits a real-Lua companion that registers all
915 exact nested module/member paths as route-indexed C closures and drives the
real `ScriptAdapter::api()` directly. Across the generated six-profile runtime
union it executes 882 Lua-backed Dynamic-Hermes routes with exact argument and
result checks, one provider call per route, restored Lua stack/current instance,
and a machine-readable missing-member failure probe. The canonical emitted
partition is explicit: 882 Lua-stack exact routes plus 31 native-POD routes
whose exact twin remains the next obligation; the other two routes are canonical
source/profile omissions. GUI and render instances are captured only by the
native fixture—product `*.gui.ts`/`*.render.ts` proxy providers remain honestly
unimplemented. The value-tail owner now carries all 26 routes: the pinned
`gui.set_texture_data` implementation's fourth argument is a string domain via
`luaL_checkstring`, while `liveupdate.remove_mount` returns its
`dmLiveUpdate::Result` through `lua_pushinteger`; tests prevent either codec from
silently widening. This is exact adapter/bridge evidence, not packaged-engine
semantic evidence.

ASan/UBSan initially exposed that the older captured-Lua router fixture drove
all 26 value-tail routes under one game-object context. The fixture now pushes
the generated game-object, GUI, or render context around each dispatch and
always pops it before asserting the result. The complete generated-family
sanitizer suite passes, including all 26 value-tail routes, the 405-route
six-profile handle union, protected error/reentrancy/lifetime cases, and zero
warmed C++ allocations. The generated 882-route real-Lua companion also builds
and passes under ASan/UBSan with its stack and instance restoration checks.

Adversarial review then found that the harness-only capability bit had become
the generated product dispatch gate for 55 GUI and seven render handle routes.
The product `ScriptAdapter` now requires the exact active component context
before entering those routes, and the generated router treats game-object, GUI,
and render calls alike as protected captured-instance scopes. Wrong-context
GUI/render handle and value-tail calls are rejected before their Lua provider
runs. The generated exact fixture uses distinct instance identities for all
three contexts, derives each result-handle carrier from the actual selected
adapter family, and checks semantic, GUI-node, and generic nested-userdata
carriers instead of accepting any handle-shaped result. The SDK value-tail
artifact now retains both `requiredContext` and its fixture-only accounting
disposition; the typed-native report also hashes the C ABI header whose enum
ordering it consumes. The three remaining, independently verified transport
debts are explicitly tracked rather than hidden in the success count: nested
semantic handle branding in [#111](https://github.com/ts-defold/deherm/issues/111),
byte-exact binary Lua strings in [#112](https://github.com/ts-defold/deherm/issues/112),
and allocator-failure protection for pre-call Lua pushes in
[#110](https://github.com/ts-defold/deherm/issues/110).

## 2026-09-20 - The ready dmSDK exact corpus became a generated artifact

The 486 declaration-only universal-ready calls now come from one compiler-owned
helper that verifies the catalog content hash and authenticated release-call
symbol index, filters readiness mechanically, and orders vectors by numeric
recipe ID. The universal generator commits the resulting exact plan plus its
production and recording-fake C++ sources; clean-room regeneration owns and
reproduces all three byte-for-byte. The plan records the ordered declaration
identities and vector hashes, both source hashes, provider manifest, catalog
identity, and symbol-index identity. The focused native census compiles the
committed production source and executes the committed verification driver for
all 486 vectors. This makes the corpus reusable by later JSI, Static Hermes,
and browser transport runners. The same authenticated corpus now runs through
real Hermes/JSI, a Shermes-compiled Static Hermes client, and real Emscripten
Wasm in Chrome. The browser run exposed Defold's WebGPU aliases changing from
native integers to browser-supplied pointer handles; the projection generator
now classifies every platform-supplied replacement as a target-dependent
opaque handle and uses the allocation-free compile-time pointer/integer codec.
This is exact bridge and carrier evidence against recording fake callees, not
Defold implementation-semantic evidence.

The policy workflow's Linux engine lane also installs `libgl-dev`; the pinned
SDK's `graphics_native.h` requires `GL/glx.h` even for the generated headless
exact-call census. Reproducing that census in a Linux container exposed Xlib's
global `Font` typedef colliding with Defold's own opaque `Font` when all 486
ready calls share one generated translation unit. The materializer now primes
GLX's include guard with only the Xlib typedef renamed, removes Xlib's `None`
macro after its declarations so it cannot corrupt Hermes enum members in the
same translation unit, then includes Defold's authoritative headers normally.
The canonical 486-call test compiles and runs 13/13 tests in the Linux
container, while a focused assertion proves non-native-graphics
materializations do not acquire GLX. This is generated bridge
compile/runtime evidence against recording callees, not engine-semantic
evidence. Host-parity now carries the regenerated target-conditional report
that was stale after the preceding SDK import change.

## 2026-09-20 - Host parity installs the exact SDK support input

The source-typed dmSDK importer resolves generated DDF and platform support
types from the digest-pinned Defold SDK for the same revision. The policy host
parity matrix previously bootstrapped only the source checkout and ref-doc
archive, so its importer check could not reproduce the canonical derivation.
Linux CI exposed the missing input immediately after the exact type-support
wave landed. Every Linux, macOS, and Windows parity row now caches the SDK
archive by `DEFOLD_SDK_SHA256` and bootstraps `defold-sdk` before checking the
generated bytes. This changes no policy content; it makes the parity job supply
the authoritative input the generator already requires.

## 2026-09-20 - Complete source types unlock the 486-call dmSDK exact census

* **The importer no longer treats Clang recovery as API truth**: public source
  headers are parsed with the checksum-pinned SDK support headers for the same
  Defold revision. The policy retains a compact 91-declaration transitive type
  closure rather than the SDK source archive. Nested enums, DDF types, receiver
  owners, constructor definitions, and per-bundle alias spellings now survive
  mechanically into projection; the projected value algebra has zero unknown
  constructors and the generated TypeScript surface has zero unresolved type
  names.

* **Every declaration-only ready dmSDK call now runs its generated twin**: 486
  of 1,361 recipes are universal-ready and 875 require usage specialization.
  One generated census compiles production and exact providers against the
  pinned SDK, links ABI-compatible recording callees, and executes all 486
  vectors. It checks preconditions, receiver and ordered argument values, one
  exact callee hit, and fake-result encoding. Target-dependent Vulkan handles
  use compile-time pointer-or-integer packing, complete pointer fixtures use
  the pointee's real alignment, and incomplete/void pointees avoid invalid
  alignment expressions. Focused projection, materializer, reachability, and
  Static Hermes emitted-C tests pass 42/42. The Static Hermes vmath lane uses
  its canonical sound-typed parser because the pinned optional `ts2flow`
  transform leaves return annotations on `extern_c` function expressions;
  genuinely TypeScript-only application units still use `-parse-ts`. This is
  generated compile/link/exact-call evidence, not Defold implementation
  semantics or cross-target execution evidence. The resealed policy root is
  `fa4afc60b314`; its policy-only reconstruction matches the frozen old-pipeline
  fixture with 13 locally rendered files / 3,784,443 bytes and 15 named
  compatibility snapshots / 77,499 bytes.

## 2026-09-20 - dmSDK record requirements follow transport depth

* **Opaque pointer and handle identities no longer pretend to copy their
  pointee records**: the universal recipe generator now requires
  `record-layout` only when a record crosses the ABI by value. Records nested
  below pointers, references, handles, callbacks, or opaque identities retain
  their pointer-lifetime, nullability, bounds, and address checks but no longer
  require a layout acknowledgement for memory the bridge never reads or
  copies. Across the pinned 1,361-recipe catalog this raises declaration-only
  universal-ready materialization from 59 to 320 and reduces generated
  specialization from 1,302 to 1,041, exactly 261 newly materializable calls.
  Eleven recipes still carry a genuine by-value record requirement. The
  generated catalog, compiler module, browser/native catalog identities, and
  exact-call fixture were regenerated by their owner; the focused native
  compile/link/run suite passes. The policy-only materializer still reproduces
  its frozen source-pipeline golden: thirteen compiler-rendered SDK files now
  total 3,748,718 bytes and the fifteen compatibility snapshots remain 78,171
  bytes. This is generator and recording-fake evidence,
  not proof of Defold implementation semantics for those 261 engine calls.

## 2026-09-20 - Packed builds consume precompiled dehermc

* **The installed release and development paths no longer compile the Go
  transform host on the user's machine**: release checking runs the generated
  suffix-context TypeScript projects and then invokes authenticated `dehermc
  check`; the development compiler invokes `dehermc transform` and supplies its
  typed-source envelope to esbuild. The packed-package smoke test stages an
  exact current-host binary in an isolated cache, forces offline resolution,
  and requires both paths to report its path and SHA-256. Five deterministic
  host binaries cross-compiled successfully; two independent darwin-arm64
  builds matched SHA-256
  `fe728acf4d85d10156571fea44dd1f4aa6f87393305e62fbeb7ceceb8612dac5`.
  The dehermc artifact fingerprint now covers every Go source in the compiler
  tree and the package version stamped by the build script. An initial package
  smoke failure was reproduced as disk exhaustion caused by retained multi-GB
  scratch projects; deterministic test cleanup removed those directories and
  the offline packed test then passed. The first-use resolver also now passes
  the complete family's pinned member digests into cache installation: a
  present-but-corrupt member forces a staged refresh, an authenticated repair
  is reused without another download, and a corrupt replacement is rejected
  before it can overwrite the existing cache. This is compiler resolution,
  transformation, and packaged-tool evidence, not Defold linkage or gameplay
  evidence.

* **The host-tool publication race is now represented as ordering, not
  failure**: the first push containing a new `dehermc` fingerprint started the
  cheap end-to-end consumer proof before `tools-3f8fdf0e9ace` existed, so its
  host-tool stage failed during the expected publication window. Push runs now
  exercise both current Linux host assets when present and otherwise defer only
  that stage. The native-artifacts summary remains the authority: it verifies
  every immutable row, then dispatches a non-push end-to-end run that requires
  the host tools and cannot defer them.

## 2026-09-20 - dmSDK reachability is checker-derived

* **Authored calls now select exact recipes without a handwritten manifest**:
  the dmSDK generator emits content-addressed overload markers, a deterministic
  project index covers all 1,361 recipes across 1,335 checker-distinct TypeScript overload
  shapes, and ttsc publishes exact declaration IDs, numeric recipe IDs, symbols,
  and call sites. A fixture `callDmSdk("dmGraphics::Finalize")` selects recipe
  503 and feeds the existing materializer, which emits both the production
  wrapper and its generated exact-call twin. Twenty-one TypeScript shapes collapse
  multiple native declarations; release compilation reports those sites rather
  than guessing, while the generated canonical-ID selector keeps every recipe
  accessible. Focused generator, checker, CLI-default, type, and materializer
  tests pass; an executable generated-facade test also proves that the exact
  selector preserves both the canonical declaration identity and native symbol
  at the bridge. A deliberate runtime/index mismatch and a nonliteral exact ID
  both fail closed. The generated call index classifies all 1,361 recipes: 59
  are universal-ready and 1,302 need generated specialization. The latter
  includes 45 existing native wrappers that still need a generated bridge route
  and 103 provider-boundary/private candidates that lack a production provider;
  neither is overstated as release-executable. Release checking names these at
  their TypeScript call sites. It also recognizes the generated callable type
  behind `.call`, `.apply`, other invoked function properties, and
  `Reflect.apply`; those indirect sites fail closed rather than disappearing
  behind a standard-library call signature. Materialization refuses incomplete
  checker manifests or a usage/index identity mismatch. Both the script-route and dmSDK
  checker indexes now derive from the project's policy-materialized revision,
  not the package seed. `typecheck --release` first runs the suffix-context
  projects, so release reachability cannot accidentally authorize GUI/render
  APIs in the wrong Defold script kind. The packed package executes that release
  command from a freshly scaffolded project. A later path-sensitive record
  transport rule reduced that specialization set to 1,041; the counts in this
  historical wave describe the state measured when it landed. Typed generation
  of the remaining usage specializations is the next wave rather than evidence claimed here. This is
  generation and fake-callee exact-call evidence, not real
  Defold implementation behavior or cross-target linkage evidence.

## 2026-09-20 - Cross-platform policy and Bob delivery are green

* **The Windows ICU change is now integrated evidence, not a manifest
  inference**: end-to-end run
  [`35516412770`](https://github.com/ts-defold/deherm/actions/runs/35516412770)
  completed green for local clean-package generation, extension headers, and
  every Bob row: arm64/armv7/x86_64 Android, arm64 device/simulator iOS,
  arm64/x86_64 macOS, x86_64 Windows, arm64/x86_64 Linux, and wasm-web. The
  Windows row proves Defold's final link consumes the system ICU import
  libraries from the extension manifest. This run proves those exact published
  archives can build the extension; it does not independently prove gameplay.

* **The ordered policy graph is also terminal green**: run
  [`35516395101`](https://github.com/ts-defold/deherm/actions/runs/35516395101)
  discovered revisions, generated the complete store, compiled/linked/ran in
  Defold, reproduced Linux canonical bytes on Windows and macOS, published the
  website, then resolved the published policy into a clean generated project.
  Provenance run
  [`35516395090`](https://github.com/ts-defold/deherm/actions/runs/35516395090)
  separately accepted the signed human-authored history. Issue #97 remains open
  until its broader fingerprint/cache/download/consumer acceptance is
  reconciled after the preceding exact-call and policy-realization waves.

## 2026-09-20 - Scalar Lua calls resolve sparse IDs once

* **The repeated lookup claim was reproduced and removed without changing the
  ABI**: a warmed scalar call searched the same 90-entry stable-ID table in the
  adapter, `isBound`, and `dispatch`; the first call also searched in `bind`.
  One shared binary search now resolves the adapter's sparse FNV ID once and
  bounds-checked dense-index methods carry it through binding and dispatch.
  Independent selectors for the earlier adapter families remain unchanged.
  The named methods remain portable when `size_t == uint32_t` on 32-bit targets.
  Comparable release runs improved from 261.6 to 259.9 ns/call. Controls put the
  remaining lookup at 4.4 ns and the complete adapter/dense-Dispatcher gap at
  51.3 ns, which does not isolate defensive validation. Therefore validation,
  family ordering, and the constexpr sorted table stay unchanged; no hash table
  was introduced. Focused runtime and ASan/UBSan tests pass with zero warmed Lua
  allocator calls and zero C++ allocations. These are host-harness performance,
  allocation, and sanitizer observations, not packaged-engine/device evidence.

## 2026-09-20 - Windows system ICU is linked at the Defold extension boundary

* **The post-CRT Windows failure was a missing final-link dependency, not a
  contaminated archive**: the successful `windows (0)` artifact log first
  found Linux ICU headers while configuring the native host tools, but the
  Windows target probe could not find a target `ICU_LIBRARY`, selected Hermes'
  `Using Windows 10 built-in ICU` fallback, defined `USE_WIN10_ICU`, and
  compiled `PlatformUnicodeICU.cpp` through `external/icu_decls`. Direct COFF
  inspection agrees: the published target object imports the unversioned ICU C
  ABI. The subsequent Bob link contained neither `-licuuc` nor `-licuin` and
  failed on exactly those imports. The Windows extension manifest now supplies
  both Windows SDK import libraries, matching upstream Hermes and Microsoft's
  documented legacy system-ICU contract. A focused manifest test protects the
  final-link dependency. This is static and build-log evidence; the next
  Windows Bob run remains the integration proof.

## 2026-09-20 - Windows archives now match Defold's static CRT contract

* **The duplicate ZIP object was real but not the only Windows incompatibility**:
  corrected release `libs-f8d8d7e4c0ad` contains neither `zip.c.obj` nor an
  unresolved `zip_*` symbol in either library, and Extender advanced to the
  next link check. It then rejected Hermes' `RuntimeLibrary=MD_DynamicRelease`
  against Defold Bullet's `MT_StaticRelease`. The Windows cross toolchain and
  native fallback now select CMake `MultiThreaded` (`/MT`) before targets are
  created. Packaging enumerates the emitted COFF directives, requires the sole
  runtime value to be `MT_StaticRelease`, requires `libcmt.lib`, and rejects
  `msvcrt.lib` before publication. The next fingerprinted Windows asset and Bob
  link remain the publication and integration proof.

## 2026-09-20 - Published Windows archive inspection rejected a false green

* **The release bytes overruled the packaging job**: after
  `libs-18b534020b9a` reported a green Windows build, the published
  `hermes-x86_64-win32.tar.gz` was downloaded and its COFF table enumerated;
  `zip.c.obj` was still present. The run is therefore not accepted as Windows
  link evidence.

* **The reproduced cause was shell pipeline semantics, not the member name**:
  `set -o pipefail` combined with `llvm-ar t | grep -q` let the early match close
  the pipe, made `llvm-ar` exit on SIGPIPE, and turned the successful match into
  a false condition. The packagers now capture and validate the complete member
  and symbol tables before acting. The regression fixture emits more than a pipe
  buffer after `zip.c.obj`, so the former false-negative path is exercised.
  The corrected recipe rotates the native family to `libs-f8d8d7e4c0ad`; only
  direct inspection plus the subsequent Windows Bob link may accept it.

## 2026-09-20 - Push smoke no longer races target artifact publication

* **The end-to-end workflow now matches its documented split**: its Bob and
  header jobs already skipped `push`, but the local push lane still requested
  `target-archives`, so changing the workflow during a native fingerprint build
  produced a predictable red run. Pushes now prove the published policy, host
  tools, scaffold, and generation only. Scheduled, manual, and native-artifact-
  dispatched runs additionally pull every target archive and execute Bob.

## 2026-09-20 - Policy engine evidence waits for its exact native input

* **The policy/native-artifact race is now explicit and bounded**: run
  `35510063943` generated, reproduced, published, and resolved the policy store,
  but its engine-evidence job requested `libs-0a6894a8e8e1` before the concurrent
  artifact workflow had published `hermes-x86_64-linux.tar.gz`. The engine lane
  now polls the exact tag/asset for at most 45 minutes before pulling; it never
  substitutes an older archive, and timeout remains a red infrastructure
  failure. This is orchestration evidence, not a replacement for the subsequent
  Bob compile/link/runtime result.

## 2026-09-20 - Native archive ABI guards corrected before republishing

* **Windows duplicate-symbol packaging now follows the archiver actually in
  use**: the real published COFF archive names the conflicting member
  `zip.c.obj`, but inspection of LLVM's `llvm-lib` option table proved that it
  does not implement MSVC's `/REMOVE`. The Extender-image path now merges with
  `llvm-lib`, deletes with `llvm-ar`, and verifies the member is absent; native
  Visual Studio builds retain `lib.exe /REMOVE` plus a `/LIST` verification.
  Mocked argument/operation tests cover both paths. This is packaging evidence;
  the next Windows Bob link remains the end-to-end proof.

* **Linux compatibility is now asserted on the bytes, not inferred from the
  Docker base alone**: both produced archives run through `nm -u` and fail the
  build if they import `__isoc23_*` or `arc4random`, in addition to retaining
  the Ubuntu 22.04/glibc 2.35 build floor. The artifact recipe change rotates
  the native family to `libs-18b534020b9a`.

* **Retryable end-to-end prerequisites are retained for seven days**: the
  pinned public-header artifact now survives GitHub's failed-job rerun window
  instead of disappearing after one day. It is still an ephemeral workflow
  prerequisite, not a release-distribution mechanism.

## 2026-09-20 - Generated native exact-call drivers for dmSDK and extensions

* **Concrete dmSDK usages now bring their own executable native proof**: the
  materializer derives deterministic wire cells, ABI-compatible recording fake
  callees, fake results, a driver, and reset/call/failure observation functions
  from the same resolved recipe that emits production code. Direct, template,
  constructor, member, destructor, boolean, float, enum, C-string, scalar and
  pointer handle, reference, and callback shapes compile and run. Record values
  and unspecified enum results fail closed. This is native C-ABI exact-call
  evidence, not Defold semantics or cross-transport ownership evidence.

* **The C11 extension lane now has stable identities and ships its twin**:
  module/signature hashes replace line-number IDs; moving declarations without
  changing their ABI preserves identity. The CLI emits production glue, exact
  glue, a runnable fake driver, and the content-addressed report. The default
  check and policy engine job compile and execute both the dmSDK and extension
  twins. Automatic project-header integration, `.script_api` installation,
  C++/multi-header parsing, and record/pointer/callback ownership remain named
  follow-on work.

* **The adversarial pass converted green-test blind spots into generator
  invariants**: narrow integer fixtures are bounded before native casts; the
  production callback symbol is type-declared and the exact twin maps that same
  expression to its generated typed fixture; C varargs are cataloged behind a
  typed-facade blocker; repeated compatible prototypes deduplicate before true
  numeric-collision checks; verification reports hash both emitted sources, the
  driver, and its fake definitions; and every generated failure returns a fixed
  nonzero process status while printing its stage, vector, and ID. A 157-route
  executable regression fails at vector 156 with status 1, closing the former
  POSIX `256 -> 0` false success.

* **Browser-target dmSDK exact calls now execute in a real Emscripten module**:
  a wasm32-specific gate materializes four source-derived dmSDK vectors, compiles
  the generated exact provider and universal dispatcher with pinned Emscripten
  4.0.6, serves the emitted HTML/JavaScript/Wasm artifacts on loopback, and
  observes the manifest-bound success marker in headless Chrome. The report
  names the exact vector and artifact hashes and declares `mockMemory: false`.
  Missing Emscripten activation or Chrome fails with machine-readable
  prerequisites rather than falling back to the existing Node mock-memory
  adapter tests. This is real-browser wasm32 C-ABI evidence; the production
  JavaScript browser arena remains a separate transport gate.

* **Dynamic and Static Hermes replay generator-owned dmSDK vectors**: the
  Dynamic runner uses a real packaged Hermes runtime and the production JSI
  host function for five non-callback vector families. The Static runner emits
  strict C from sound TypeScript and crosses a generated four-deep bounded
  frame for all 486 vectors in the current compiler-owned capacity/tag
  applicability partition.
  Both assert exact native call counts and argument observations. Dynamic JSI
  asserts decoded result signatures; Static asserts all six result-cell fields
  and C-string address identity. The package owns a 32-cell frame capability;
  each policy carries a recipe-derived maximum, currently fifteen, and an
  incompatible future catalog fails with an explicit package-upgrade error.
  Dynamic callbacks remain unsupported until the production JSI
  encoder owns a callback representation; retained ownership semantics remain
  outside both claims.

* **The real-browser gate rejects runtime failures without favicon flakiness**:
  the Emscripten HTML shell receives an inline favicon before hashing and
  launch. This prevents Chrome's optional `/favicon.ico` request from creating
  an unrelated 404 while preserving strict rejection of actual page, Wasm, and
  console failures.

* **The real-Hermes exact runner names its source-header prerequisites**: the
  first clean Linux policy run correctly refused a host-dependent compile that
  had found `jsi/jsi.h` through the local machine's environment. The runner now
  passes the pinned Hermes `API` and `API/jsi` roots explicitly alongside the
  packaged `libhermes.a`. Missing headers therefore fail as a reproducible
  bootstrap defect instead of being hidden by a developer workstation.

## 2026-09-20 - Bound policy-site handshakes to the resolved revision

* **The clean consumer now validates each published revision against its own
  policy facts**: the nightly stable/beta/alpha run rebuilt each policy
  handshake correctly, then compared all three to the checkout's last-generated
  profile and failed when alpha did not equal stable. The site-resolution smoke
  now reconstructs and checks revision-independent fields against that
  revision's `@profiles` subtree, binds only `defoldRevision` and
  `catalogSha256` at resolution, and rejects malformed or undeclared binding
  fields. A two-revision regression proves distinct profile facts remain
  distinct instead of being compared through checkout state. This is policy
  reconstruction evidence; the next scheduled/dispatch run remains the CI
  proof for the full multi-channel graph.

## 2026-09-20 - Closed the 915 + 8 + 3 generated script-call partition

* **Compiler intrinsics and specialized timers now have generated verification
  contracts**: a compiler-owned emitter exact-set joins the route accounting,
  component property capability, public module schema, and cached Lua schema.
  It emits a content-bound eleven-vector report plus C constants. All eight
  property routes compile through the real TypeScript AST/proxy generator and
  match exact Lua declarations. Timer delay/cancel/trigger execute a generated
  lifecycle scenario with exact argument/result and callback ownership
  assertions through cached Lua, Dynamic Hermes/JSI, and browser/Wasm host
  glue. The sound-typed Static Hermes C unit separately proves exact symbol,
  ordered ABI values/results, and callback-handle field transport; it does not
  claim callback ownership. The warmed Lua bridge still performs zero Lua
  allocations on its primitive and callback hot paths. This is bridge-contract
  evidence, not a claim about every Defold gameplay context.

## 2026-09-20 - Generated exact-call twins became materializer output

* **Exact-call twins are now a materializer output, and the script recorder no longer hides target-capable rows**: each concrete dmSDK usage produces a production wrapper plus a second provider whose uniquely named ABI-compatible fake callee receives the same resolved receiver and ordered decoded native arguments. Its JSON vector is hash-bound to the catalog and records symbol, invocation kind, resolved native types, slots, shapes, preconditions, requirements, wrapper-source hashes, result shape, and wrapper identities. The native harness includes the generated verification translation unit so the compiler checks its fake definitions, then executes the twin across direct functions, a function-template specialization, placement construction, a member call, and explicit destruction, asserting receiver identity, argument values, dispatch ID, and encoded result. The installed CLI stages the production source and `.verify.cpp`/`.verify.json` members before publishing the content-binding manifest last; `--check` validates the four-file set together. In parallel, the generated script recording engine now drives all 915 universal rows through Dynamic Hermes/JSI: generated provider-only seed routes mint genuine HostObjects for the two input-only handle kinds, callback inputs use real JSI function descriptors, and callback results use a bounded static descriptor. Direct-memory and typed-native each drive 890 rows; their only 25 exclusions are explicit callback target partitions, while URL and Matrix4 static-frame calls now execute. Hash and URL probes carry nonzero upper 32-bit sentinels through all three transports and render exact unsigned 64-bit values. Evidence remains the generated bridge contract, not Defold implementation semantics.

## 2026-09-20 - Closed the source-name correction through the real engine

* **The documented/runtime spelling mismatch is now structural**: the generated
  public route remains `script:sys.set_render_enable`, while scalar and
  universal Lua dispatch resolve the source-registered
  `sys.set_render_enabled`. The scalar native census registers only the source
  spelling, exercises all 90 scalar rows, and observes zero Lua allocator or
  C++ allocations after warmup. The 915-row portable universal C ABI also
  passes recursive/reentrant, cycle, pool-exhaustion, and idempotent-release
  probes with zero warm C++ allocations; its Static Hermes provider compiles
  through the pinned frontend. These are exact bridge-contract results, not a
  claim that every Defold gameplay context ran.

* **The rotated engine evidence was recorded rather than copied forward**: a
  freshly built arm64-macOS Defold 1.14.0 bundle loaded the dynamic Hermes
  bytecode and completed the current scalar/value probe set with clean final
  lifecycle markers. The evidence registry now pins that exact log digest and
  probe-set fingerprint. It runtime-verifies 32 instrumented route scenarios;
  the remaining routes retain their generated CI verification lanes without a
  false live-engine claim.

* **Review findings changed code and evidence wording**: the scalar remap bypass,
  executable-but-unusable macOS Java stub, unpinned/stale public-header staging,
  double-dot typed-native profile name, and signature-header-only provenance
  check were reproduced and fixed. The source-pipeline SDK fixture is now
  described as a frozen regression golden because it shares some emitters with
  policy realization; it is not presented as an implementation-independent
  oracle. Every one of the 211 pre-wave commits verifies cryptographically
  against the confined human signer file.

## 2026-09-20 - Separated human Git authorship from agent provenance

* **Git contribution identity is human-only while OKF provenance remains
  useful**: every Git commit must use Justin Walsh's configured identity and
  SSH signature, and AI attribution trailers are forbidden. Agent/model names
  remain permitted in `.agents/docs` `generated.by` metadata because those
  fields tell later agents which tool produced a knowledge artifact; they are
  explicitly not authorship, ownership, copyright, or contributor claims. A
  repository check and push workflow enforce the Git boundary.

## 2026-09-20 - Closed the focused package and reconstruction failures

* **The three focused failures now have owned fixes instead of bypasses**: the
  dmSDK JSI compile probe uses Hermes' real `API/jsi` public include root; the
  npm prepack path stages pinned Hermes/JSI public headers independently of the
  local archive build and still requires the published native archive; and the
  frozen source-pipeline SDK golden has an explicit check/update command.
  Its normal mode is read-only, while `--update` captures only the
  checkout-backed source-pipeline tree, its Defold revision, and aggregate
  digest. All eleven focused dmSDK, materializer, package, scaffold, typecheck,
  and one-shot development tests pass. This proves packaging and reconstruction
  byte-regression coverage; shared emitters mean it is not an
  implementation-independent equivalence proof or additional engine-runtime
  evidence.

## 2026-09-20 - Joined package header staging to the native end-to-end matrix

* **The scheduled Bob matrix now assembles the same pinned public-header input
  as npm prepack**: the failing run compiled the raw Git extension tree, where
  `include/hermes` and `include/jsi` are intentionally ignored, and every native
  target failed before linking on `jsi/jsi.h`. A single prerequisite job now
  checks out the pinned Hermes revision, runs the package-owned header stager,
  and shares that exact header tree with every target job. This closes the
  checkout/package assembly mismatch; it does not by itself prove any target
  ABI until the full hosted Extender matrix passes.

* **The next real target-specific failure is owned by the Windows archive
  recipe**: after header staging, hosted Extender compiled every extension
  source and reached the final `x86_64-win32` link, where `hermes.lib(zip.c.obj)`
  collided with Defold's authoritative `zip.lib(zip.c.obj)`. The MSVC packager
  now removes that unused compiler-side archive member, matching the existing
  POSIX packaging rule, and protects both `/OUT:` and `/REMOVE:` from MSYS2 path
  rewriting. This is recipe evidence until the fingerprinted Windows archive is
  rebuilt, published, and linked by hosted Extender.

* **Both Linux archives had inherited the builder's newer glibc instead of the
  target's compatibility floor**: hosted Extender compiled the complete
  extension, then rejected `__isoc23_strtol`, `__isoc23_strtoul`,
  `__isoc23_strtoll`, `__isoc23_fscanf`, and `arc4random` references from the
  Ubuntu 24.04-built Hermes/ICU archive. `Dockerfile.linux` now builds inside
  Ubuntu 22.04 (glibc 2.35), matching the existing Linux host-tool floor. A
  focused test pins that base. This is recipe evidence until both rebuilt Linux
  target archives pass the hosted Extender link.

## 2026-09-20 - GitHub issues are the external roadmap ledger

* **Every execution wave now owns issue reconciliation**: the existing open
  issues are mapped to roadmap waves, duplicates are consolidated, evidence is
  posted as work lands, and issues close only when their stated acceptance
  criteria are actually satisfied. Completed issues do not remain open as
  reminders, while broad issues are not closed from a representative proof.

## 2026-09-20 - Locked generated verification and the ordered goal

* **The verification boundary and backlog are now canonical**: déherm verifies
  its generated bridge contract, while Defold is authoritative for
  implementation/game semantics. The completion matrix and handoff no longer
  require bespoke live-engine scenarios per API. Every concrete emitted call
  instead receives a same-IR verification twin for exact identity,
  symbol/signature, ABI layout, argument/result ordering, bounds, and lifetime;
  native headless and Playwright remain integration sentinels. The ordered goal
  now runs from closing the dirty verification wave through exact-call
  completion, policy-only realization, cross-platform delivery, installed
  tooling, public ergonomics, War Battles, and reserved frontiers.

## 2026-09-20

* **The universal dmSDK materializer now emits same-recipe production and exact-call twins for every one of the 486 universal-ready declarations**: the generated driver executes compile-time-selected direct, template, constructor, member, destructor, scalar, enum, C-string, handle, reference, callback-identity, and pointer/length span shapes through the common production dispatcher, checking stable selection, receiver/argument carriers and order, call count, and result encoding. Generic by-value records remain emitted as catalog recipes but materialization fails closed until a typed size/alignment/lifetime provider exists. Ownership is recorded only as a declared contract, and the exact fake explicitly does not claim Defold-library linkage, implementation semantics, or runtime ownership lifecycle evidence. The 86-test dmSDK runtime-codegen suite, 1,361-declaration clean-room regeneration, full repository check, and a corrected adversarial review all pass.

* **API verification now ends at the bridge contract instead of requiring a fantasy all-world engine**: every one of the 926 documented Lua routes must retain generated machinery in exactly one lane (915 universal runtime dispatch entries, eight component-property compile-time intrinsics, and three specialized timer bridges), and every one of the 1,361 runtime dmSDK declarations must retain a materializable universal recipe with silent omission forbidden. CI's null/recording proof checks stable-ID selection, exact ABI layout, ordered arguments, result decoding, bounds, and lifetime behavior; Defold remains authoritative for gameplay semantics. Missing GUI/render/audio/physics fixtures are a private harness queue and no longer create `unverified` API annotations or issues. Positive source/runtime contradictions remain `suspect`. The mechanically reconcilable mismatch now follows the engine: documented `sys.set_render_enable` dispatches through registered `sys.set_render_enabled` while retaining documentation provenance. Playwright HTML5/Wasm and native headless runs remain integration sentinels, not 926 separate permission gates.

* **Two more support snapshots became compiler emitters, and scaffolding stopped consulting an output for revision truth**: `@deherm/compiler` now reconstructs `script/browser-target-support.ts` and `dmsdk/scalar.ts` from already-authenticated semantic documents. Both match the frozen source-pipeline golden byte-for-byte (567 and 6,007 bytes), moving the materialized SDK to thirteen locally rendered files / 3,434,005 bytes after the source-authoritative route correction and reducing compatibility debt to fifteen named files / 78,171 bytes. The current resealed policy root is `c17e74a7f2fa`, with 83 objects and 28.29 MB of referenced objects; the 10.21 MB lowering plan remains the dominant derived input. Separately, a new project scaffold now takes its offline default Defold revision from the packaged policy index instead of the generated script IR, and a focused index-only fixture proves the IR can be absent. The frozen golden catches accidental byte drift but shares some emitters with the materializer; it is not implementation-independent or new runtime evidence.

* **Four large SDK snapshots became compiler-owned emitters**: `@deherm/compiler` now renders script handle metadata, script universal-value metadata, dmSDK universal metadata, and the browser dmSDK arena directly from three authenticated semantic documents already present in the policy. Old-pipeline equivalence remains byte-for-byte. The local-emitter share moved from seven files / 2,513,290 bytes to eleven files / 3,427,496 bytes; snapshot debt fell from 21 files / 998,951 bytes to 17 files / 84,745 bytes without adding policy inputs. The policy now has 85 subtrees, 28.29 MB, root `9149470ec631`, and an 11,727-byte compiler manifest. The 10.21 MB lowering plan remains the dominant derived object: its existing generator requires 11.10 MB of declared inputs, so invoking it unchanged would substitute a larger derived-input bundle rather than produce the compact recipe boundary the decision requires.

* **The npm version is compatibility machinery, not a Defold version**: root semver selects scaffold dependency ranges and keys generator provenance/freshness; policy `producerPackageVersion` is audit provenance only; `minimumPackageVersion` plus exact `requiredCapabilities` gates whether the installed generic realizer can consume a policy. All are currently `0.0.0`, so capability names carry the useful compatibility signal until a real release baseline is chosen. An npm payload audit also found the migration is incomplete: broad package globs still ship duplicate revision-derived generated SDK/binding/native files. Those must move behind materialized project surfaces; changing the package version cannot make pinned Defold facts generic.

## 2026-09-19

* **Captured Lua errors can cross the generated router again**: `CapturedLuaRouter::dispatchUnsafe()` was emitted as `noexcept`, so an ordinary LuaJIT error raised while decoding or dispatching a captured route invoked `std::terminate` before the surrounding `lua_cpcall` could recover it. The handle-lowering generator now emits an unwind-capable internal dispatcher while keeping the public capture boundary explicit. The exact ten contracts that previously exited with signal 6 (`0139`, `0152`, `0154`, `0161`-`0166`, and `0171`) each reached tick 3 with exit code 0 after regeneration, and the aggregate focused run recorded zero failures. This is targeted real-engine evidence for the former fault set, not yet a claim that every generated route has run in every engine/profile combination.

* **Compiler-owned policy realization and explicit manifests**: Moved the policy schema, materializer, identifier policy, and script/dmSDK SDK emitters behind `@deherm/compiler`; CLI consumption no longer reaches through `@deherm/generator`. Replaced the 21,790,909-byte monolithic `@compiler` object with an 11,853-byte versioned manifest referencing twelve content-addressed compiler documents and 21 content-addressed compatibility sources. Manifest validation now rejects unsafe output paths, missing or mismatched objects, stale recipes, undeclared inputs, and non-canonical revision-sensitive snapshot digests. Materialized outputs are checked against an immutable old-pipeline hash fixture rather than the tree used to derive the policy; it records seven locally rendered files (2,513,290 bytes) and names the 21 remaining snapshots (998,951 bytes). This is an ownership and sharing improvement, not yet a total-size claim: the complete policy remains 29.29 MB because the 10.21 MB lowering plan and compatibility sources are still referenced migration debt.

* **Policy realizer boundary**: Defined the npm package as version-stable generic realization machinery and the revision policy as the owner of every Defold-derived name, namespace, semantic type, declaration, ABI fact, and recipe selection. Added an index-and-root compatibility contract with a minimum package version plus monotonic required capabilities, so normal Defold releases publish policy without requiring npm releases while genuinely new generator constructs prompt an early package upgrade.

* **Published policy can now materialize the complete revision surface locally**: a new authenticated `@compiler` subtree supplies eleven semantic documents and an SDK manifest to the installed compiler. `deherm policy` materializes the revision-keyed cache automatically; core script and dmSDK TypeScript is regenerated from IR and hash-checked, all 28 SDK outputs reproduce byte-for-byte in a fresh directory, and an unchanged second pass writes nothing. Remaining support emitters are explicitly labelled compatibility snapshots rather than misreported as local generation. The correctness-first policy is currently 29.26 MB, dominated by a 15 MB derived lowering plan; extracting that plan and the remaining support emitters behind package code is the next size/architecture pass.

* **Linux engine startup no longer exhausts small Defold pthread stacks with static TLS**: the linked amd64 driver carried `0x5c490` bytes of static TLS, of which the generated four-frame universal scratch pool contributed `0x5bd20`. glibc counted that storage against Defold's 135,168-byte AsyncLoad stack and `pthread_create` returned `EINVAL`. The generator now leaves only a lazy owner in TLS and allocates the same bounded, reentrant pool on first use; warmed calls remain allocation-free. Linked TLS fell to `0x770`, after which the Linux driver initialized Defold and Hermes and emitted real route observations. The qemu run was bounded after crossing the failed boundary, so this is not a claim of full Linux conformance.

* **The first real all-target consumer matrix was pointed at the wrong Extender deployment**: the pinned engine channel is `dev`, whose SDK `build.yml` already references the new `r8Cmd` platform property, while `https://build.defold.com` still runs the production schema and rejected every target with `Unable to find property 'r8Cmd' on PlatformConfig`. The end-to-end gate now derives its default service from `DEFOLD_REF` (`stable` uses production; `dev`, `alpha`, and `beta` use staging), while an explicit CLI/workflow override remains available. The gate also includes Extender's complete per-target `log.txt` in the failure and uploads that file from every matrix row, so a future server/compiler rejection is evidence rather than an opaque Bob exit. The channel mapping is locally verified; the remote staging matrix remains the build proof.

* **The first all-target Bob consumer run reached the generated project and exposed three pre-compile seams**: Defold resolves `/input/game.input_binding` as its project default even when a scaffold has no explicit `[input]` section, so the zero-config project now materialises that empty resource; Bob's public macOS platform names are `arm64-macos`/`x86_64-macos` while Extender and release archives use `arm64-osx`/`x86_64-osx`, so `generate-defold-bundle-targets.mjs` now derives both names from the pinned engine's `Platform.java` and `bob.sh` uses each only at its owning boundary; and the project-artifact verifier incorrectly accepted only binary `vendored` rows even though `wasm-web` deliberately ships a `vendored-source` browser-host library. The source lane now verifies the copied project byte-for-byte against the installed package source. These are scaffold/identity/verification fixes, not claims that the subsequent Extender compilation is green; the full remote Bob matrix remains the evidence for that.

* **A published policy is not yet a locally generatable surface**: `deherm policy` authenticates and caches declarations, types, registration evidence, route profiles, resources and toolchain pins, but `deherm generate` still resolves ten pre-materialised IR/lowering files plus a generated SDK tree. That is an implementation gap, not a requirement to publish generated source bundles. The intended boundary remains policy data plus the installed generator plus project-local extension inputs producing all TypeScript/native/browser outputs on the user's machine. The policy must therefore carry the remaining per-route lowering programs, ABI/frame/ownership/bounds recipes, dmSDK thunk recipes and generator-schema identity, and the CLI must reconstruct its revision-keyed surface from those authenticated objects. Generated TypeScript, C++ and JavaScript are outputs and do not belong in the policy store.

* **GitHub began forcing the native-artifact Docker setup action off its declared Node 20 runtime**: every Linux, Windows-container, and Android row emitted a deprecation annotation for `docker/setup-buildx-action@v3`. The action's current v4 release declares Node 24 and preserves the inputs this workflow uses, so all three rows now use `@v4`; this changes CI orchestration, not the content-addressed target recipe, and therefore does not rotate already built native archives.

* **The Extender-image Windows build mixed two incompatible intrinsic-header families**: the cross toolchain named Defold's MSVC and Windows SDK include roots but omitted the first entry in Defold's authoritative win32 `systemIncludes`: `${CLANG_RESOURCE_DIR}/include`. Compilation reached Hermes' profiler headers after an MSVC standard header had selected MSVC's `immintrin.h`, then Hermes' explicit `x86intrin.h` resolved to Clang's resource directory. Clang 20 consequently redeclared four MSVC intrinsics as `constexpr` and its FMA4 header could not see the vector typedefs its own `immintrin.h` normally establishes. This was not evidence that Clang 20 and MSVC 14.51 are incompatible; MSVC's published compatibility table names Clang 20 for 14.51. `windows-msvc.cmake` now requires `CLANG_RESOURCE_DIR` and mirrors Defold's complete include order, with Clang's resource headers first. The structural test asserts both the root and its order, while the container build remains the compile evidence.

* **The Linux Hermes archive carried ICU references but not the static ICU objects that satisfy them**: Hermes was configured with `HERMES_USE_STATIC_ICU=ON`, which links ICU when building an executable but cannot make `libhermesvm_a.a` absorb another archive. The native artifact packager merged Hermes, JSI, and Boost only, so a clean Linux consumer reached its final link and failed on versioned `ucol_*`, `uloc_*`, `udat_*`, `u_str*`, and `unorm2_*` symbols. `package-posix.sh` now accepts explicit static runtime dependencies, validates each path, and merges them into the single archive Extender force-loads. The Linux release recipe supplies its architecture-native `libicui18n.a`, `libicuuc.a`, and `libicudata.a` to both release and debugger variants. A focused archive-member test proves an explicit runtime dependency survives the real MRI merge; changing either recipe rotates the native-artifact fingerprint, so repaired archives cannot overwrite the old content-addressed release.

* **Bob's consumer gate rebuilt the wrong host package after scaffolding**: the end-to-end matrix correctly downloaded and digest-verified each target archive, scaffolded the project, and copied the managed extension into it, but `scripts/bob.sh` then ran `package:defold`. That command builds the repository's host-native Hermes runner and the arm64-macOS spike package; on Linux every target therefore failed before Bob with “Pinned Hermes source is missing,” and even on a prepared Mac the newly packaged repository tree could not alter the project copy Bob was about to upload. The wrapper now invokes `scripts/check-project-native-artifact.mjs`, a narrow command over the existing consumer verifier. It checks the archive inside the generated project's extension against the shipped target manifest and leaves the immutable scaffolded upload tree intact before Bob resolves the native extension; unrelated host compilers and local Hermes source are not prerequisites.

* **One of four suspect routes was our parser, not Defold**: `go.set_parent()` executed successfully in the real engine, but the registration parser still called its first slot required and made the headless harness expect an under-supplied-call error. `dmScript::ResolveURL(lua_State*, int index, ...)` explicitly defaults an absent slot; a same-arity `const char*` overload addresses no Lua slot, but the helper index counted it as a competing stack helper and hid the body-derived presence contract outside `script_msg.cpp`. Equal-arity ambiguity now counts only overloads that can actually address a stack slot. The generated gate fell from 38 parameter corrections to 10, `go.set_parent` is optional and real-engine `executed`, and the three remaining suspects are authoritative source contradictions: two documented Box2D user-data entries are commented out and `sys.set_render_enable` is registered as `set_render_enabled`. The refreshed engine run is 37 observed, 0 mismatched, 3 blocked and 45 unreachable contracts. Its stream reader now frames stdout and stderr independently by complete line; previously a simultaneous engine error could splice into a partial evidence marker and create a bogus `undefined:undefined` property. Route verification now refuses stale runtime reports whose exact plan digest, inputs, target, profile or revision changed, preserves eight concrete runtime-producer blockers, marks 87 missing generated-test shapes `unproven`, embeds deterministic annotations and stable issue lookups for all 90 suspect/unproven routes, and the nightly creates, reopens or updates those exact issues without conflating profile/context gaps with API defects.

* **A fingerprinted release was a family-level cache but not a row-level cache**: the plan skipped a family only when every expected asset existed, so one failed Android ABI caused every successful Linux, Apple, Windows and Android row under the same target fingerprint to rebuild and upload again. `scripts/plan-native-artifact-builds.mjs` now derives the exact executor matrix from the published-asset catalog and subtracts assets already present under each content-addressed tag. Empty, complete and one-row-missing fixtures prove every asset schedules exactly once, no completed row is rebuilt, and the partial case schedules only its missing ABI. The workflow's global non-cancelling concurrency group remains intentionally repository-wide because two branches may compute the same tag; a queued second run replans after the first and becomes a no-op. The uploader rechecks the asset at the mutation boundary, removed `--clobber`, and treats an in-flight winner as authoritative, so content-addressed rows are immutable rather than "last writer wins". Docker target builds now use content-validated BuildKit GHA caches scoped per bundle target. The first remote run exposed one GitHub-specific defect the local planner could not: all six full JSON matrix job outputs were discarded by Actions' "may contain secret" heuristic, and the expensive lanes stopped on `fromJSON('')`. The planner now sends only integer slot arrays across the job boundary and resolves each slot back to the canonical row after checkout, keeping arbitrary public target strings out of the heuristic without duplicating the build catalog in YAML. In the same pass, Linux became the sole policy author while macOS and Windows are isolated byte-parity witnesses, and Android runtime construction explicitly suppresses Hermes' default fbjni `ThreadScope` finalizer wrapper with `ThreadRunner{}`. That source defect is closed; Android archive, Extender link, APK and GC execution remain separate unverified gates.

* **The policy a user consumes was a function of the machine that derived it, and the nightly was pinned to macOS to keep that out of sight**: `scripts/import-defold-sdk.py` parsed the dmSDK with the host `clang++`, no `-target`, `-DDM_PLATFORM_OSX=1` written into the command, and `"platform": "arm64-macos"` written into the output whatever it had actually parsed - a label that travelled all the way into `@shared` of every published policy. Measured rather than supposed: the same parse on Ubuntu 24.04 and on macOS 15 disagreed about **79 of the 121** public dmSDK headers, starting with `dmDDF::OPTION_OFFSET_POINTERS` typed `const uint32_t` on one host and `const int` on the other, because `<stdint.h>` resolved on one and clang recovered silently on the other. The parse is now **declared**: a `declarationParse` block in `packages/bindings/overrides/dmsdk-target-macros.json` names the triple, and `upstream.lock` pins the C library headers it resolves against. The triple is `wasm32-unknown-unknown` - the one real clang triple that predefines none of `__APPLE__`, `__linux__`, `_WIN32`, `ANDROID` or `__EMSCRIPTEN__` - so **no platform branch is taken** and `graphics_native.h`'s four mutually exclusive platform includes (`<objc/objc.h>`, `<Windows.h>`, `<GL/glx.h>`, the Android EGL set) all fall to the `typedef void*` the header supplies beside each one. No machine has all four SDKs; none is needed. The neutrality is asked of the compiler (`clang++ -dM -E`) and the derivation refuses if any macro in the declared `neutralOf` list turns out to be predefined, because a clang release that started predefining one would otherwise silently change which branch every conditional takes. `-nostdlibinc` plus one `-isystem` puts a digest-pinned wasi-sysroot where the host's libc was: a single host-independent archive, Apache-2.0, headers only, and not a claim about any target's ABI. **Proven, not asserted**: the committed inventory was generated on macOS 15 with Apple clang 21.0.0, and `python3 scripts/import-defold-sdk.py --check` inside `ubuntu:24.04` with Ubuntu clang 18.1.3 reports `dmSDK coverage inventory is current` - `--check` regenerates and compares byte for byte, so two operating systems and two clang major versions produce the same 2141 declarations, the same per-target mangled names and the same diagnostics. `.github/workflows/derivation.yml` runs that comparison as a two-host matrix through to `generate-api-policy.mjs --check`, which is the policy root itself; `policy-revisions.yml` now runs on `ubuntu-24.04` and its macOS pin is gone. Three smaller defects fell out of the same pass. The vectormath library was unpacked to a **per-run temporary directory** whose random name clang then printed into the committed diagnostics; it is now a fixed path the checkout-prefix rewrite removes. The per-target mangling passes ran with `-DDM_PLATFORM_OSX=1` whatever they targeted and against the host's libc, which is why `dmStrlCpy` had a mangled name for the five Apple targets and none for Linux, Android or web. And musl spells `uint64_t` once, for one ABI, so every LP64 target was looked up as `...Ey` in archives that define `...Em` - `dmDDF::GetDescriptorFromHash` was reported **absent from four targets it is present in**, and 221 declarations sat in `target-subset` that belong in `all-targets-all-variants`. Each standard integer type is now typedef'd from clang's own `__UINT64_TYPE__`-style predefine for the target being parsed, with musl's `__DEFINED_*` guards making the sysroot defer; false absences gone. Separately, `generate-dmsdk-symbol-evidence.mjs` passed an `input` option to `execFile`, which has none, so the demangler waited forever for an end of input that never came and that pass hung on every run; it also invoked `xcrun`, which exists on no operating system but macOS. Both fixed, and the 16 declarations the demangler path exists to find are now reported as `signature-mismatch` instead of as absences. The declaration count moved 2140 -> 2141: `typedef void* id`, a declaration every non-Apple target really does get and which a macOS-shaped parse could never see. `needs-policy` (1354), `direct-candidate` (23) and the 1361 runtime-pending bindings are unchanged, so no lowering decision moved; the ABI-shape census moved 881 -> 880 because six `dmGraphics::GetNative*` functions stopped returning Apple's `id`.

* **Nothing asked whether a user could take what we publish and build a game with it**: every check here verifies one stage against its own inputs - the generators that their artifact is current, the artifact matrix that a library is where the manifest says, the policy site that a revision resolves - and all of them passed while the question a user asks went unasked. `scripts/check-end-to-end.mjs` asks it once, per Defold bundle target, in the order a user meets the stages: resolve a published policy through its own layout (including the tampered-object control), download the published host tools and per-target Hermes archives and verify every digest, `deherm create` a project from nothing, generate and type check it, and have Bob build it. The `bob` stage is also the compile check - Extender compiles the generated bindings and the extension with that target's real toolchain, and a separate compile step would be compiling with something else - and it defaults to **`https://build.defold.com`**, because `scripts/bob.sh`'s `localhost:9010` is this repository's own Extender and no user has one. **A target is declined, never skipped**: the reason is read from the manifest that already decided it, so `wasm_pthread-web` declines with its own `web-pthread-browser-host-unproven` blocker text and `x86-osx` with the glossary's "the pinned Defold sources keep the platform key only so old manifests parse", and a bundle target that appears in Defold's derived list and not in the artifact manifest is a **failure** rather than a row nobody printed. `tests/end-to-end-gate.test.mjs` is the part that runs everywhere: it checks the ledger covers all 13 declared targets, that every decline names a reason, and that a target Defold adds breaks the gate on the day it is added. 11 of 13 exercised. `.github/workflows/end-to-end.yml` runs the cheap half on push and the per-target Bob matrix nightly, one job per target so a failure is named in the job list; `scripts/bob.sh` no longer looks for java only in Homebrew's openjdk@25, which is not where a Linux runner keeps it.

* **The nightly that derives a policy for a new Defold revision had never succeeded, and the reason was that the generated surface has one address rather than one per revision**: every generator writes fixed repository paths, so `policy-revisions.yml` repinned `upstream.lock` in place and regenerated over the top - a scheduled job mutating the artifact `pnpm check` verifies - and three lines in, `generate-script-sdk.mjs` refused because `script-borrowed-handle-classification.json` still named the pinned revision. `scripts/derive-revision.mjs` now materialises the checkout into a scratch workspace, repins and regenerates **there**, and fingerprints every path the chain can write before and after to prove the checkout did not move; `--adopt` is a separate step that fingerprints first and refuses a blocked derivation, so adopting cannot launder an in-place write into a commit. The control: deriving the **pinned** revision in a workspace reproduces the committed surface byte for byte, 0 of 487 generated files differing. Moving the chain out of the workflow found a defect nothing could have caught inline - the engine slice omitted `packages/`, so CI parsed the dmSDK without Defold's vectormath archive and a CI derivation and a local derivation of the *same* revision produced different policy roots. Three generators were also taking the revision they **emit** from a reviewed override rather than from a derived input; `generate-lua-registration-surface.mjs` stamped its whole report with whatever `lua-registration-surface-targets.json` said and compared it against nothing. The drift assertions are kept and sharpened rather than relaxed: the emitted revision now comes from the imported IR or the lock, the reviewed file goes through one shared rule that refuses exactly as before for ordinary generation, and a *declared* derivation may carry a review only opt-in, only for the one revision named in its environment, and only with the carry recorded to a ledger the run reports. Every substantive check still runs against the revision being derived, which is strictly stronger than a string compare because it reads that revision's bytes. Finally, `reviewed-evidence.mjs` audits **all** reviewed claims up front instead of stopping at the first - 125 claims over 72 pinned Defold sources, discovered by shape rather than by a list - and separates a source that does not exist at the revision from one whose content moved but whose reviewed anchors all survived. The verdict for Defold 1.13.1 from the current `dev` pin is now a complete answer instead of an assertion failure, and the answer is **not derivable**: 110 of 125 claims fail, 15 because the file is absent, and the whole `bullet3d` backend exists on `dev` and not on stable. The structural blocker is fixed; the remaining one is a real engine difference that needs real review.

* **An artifact tag was a fingerprint of the files we happened to list, and the policy index had no way to name an artifact at all**: both manager scripts hashed `upstream.lock` in its entirety, which made every published byte a function of every pin in it. Measured, not theorised - changing **only** `DEFOLD_REV` rotated the host-tool tag from `7a3536af` to `35787eb7` and the target tag from `d37e4040` to `6fb21b2c`, so the nightly repin `policy-revisions.yml` performs would have rebuilt and republished all 25 artifacts for zero byte change and churned digests users had already pinned. `scripts/lib/artifact-releases.mjs` now declares the three families and hashes the lock **keys** each consumes and the **fields** of a generated manifest that decide its codegen: `hermes-host` takes `HERMES_URL`/`HERMES_REV` and `build-host-compilers.sh`; `dehermc` takes the ttsc version, `go.mod`, its Go sources and its build script, and reads `upstream.lock` not at all; `native-artifacts` takes the Hermes pin, the per-target recipe, and **only** the `sdk` and `targets` fields of `defold-bundle-targets.json`, because that file also carries `defoldRevision` and `sourceSha256` and hashing it whole would have put the coupling straight back. A consumed key the lock does not carry is a hard error and a key declared twice is refused, since a stable tag over an incomplete or ambiguous input set is the one failure content addressing exists to prevent. The old single `host-tools-<fp>` tag became `hermes-host-<fp>` and `dehermc-<fp>`: the two share no input, and one tag meant a Go transform edit republished ten unchanged LLVM compilers while a Hermes repin republished five unchanged Go binaries. `manage-host-compilers.mjs fingerprint`/`expected-assets` now take a family, `pull` fetches both by URL with no `gh`, and `native-artifacts.yml` skips each family on its own assets. The real engine coupling survives and is asserted in both directions on a temporary checkout: an `sdk` pin edit moves the target archives, a `defoldRevision` edit does not, a Hermes repin moves the two Hermes families and not `dehermc`, and a Defold repin moves nothing. Two input-set defects surfaced on the way: `build-windows.sh` - the lane that actually produces `hermes.lib` when no Defold registry credential is configured - was not hashed at all, and `build-host-compilers.sh` was hashed into the target archives although no target lane runs it (every cross build builds its own host compilers inline through `-DIMPORT_HOST_COMPILERS`). **Comments are still hashed**, so a prose-only edit to a Dockerfile republishes identical bytes; that is waste in the safe direction, and stripping them would mean parsing five languages correctly enough to bet artifact identity on it. Second half: `v1/index/<defold-sha>.json` carried `policyRoot` and `generator` and nothing else, so two content-addressed systems - the policy store and the artifact releases - had no point of contact, and a user who had just resolved "I am on Defold X" still learned which `libhermes.a` to fetch from a constant in someone's code. The entry now also carries the three tags, each family's asset names and an `indexedBy` of `bundleTarget` or `host` - the distinction a consumer gets wrong first - and the served index gains a `base.releaseAsset` template built from the same expression `packages/cli/src/release-assets.mjs` downloads from, so the index path and the `pull` path cannot reach two different URLs. `check-policy-site-resolution.mjs` resolves one archive and one host compiler over the served index, asserts both equal what the vendoring code builds, and requires a retired target to **refuse** rather than produce a plausible 404. The honest caveat is recorded in the decision: the artifact block is the one part of an entry that is not a function of the engine revision, so "written once, never rewritten" is now a claim about an entry's sha-to-root half, which is what its trust argument actually rested on.

## 2026-09-18

* **The policy the layered-cache decision describes now exists, and its shape is the part that had to be right first**: everything it needs was already generated and nothing assembled it. `scripts/generate-api-policy.mjs` derives one Defold revision's policy as **55 content-addressed subtrees - 52 namespaces plus `@shared`, `@profiles` and `@toolchain`, 6.19 MB** - under root `27f0c00d84e5` for `7f0f554f41f9`. The root hashes its subtrees rather than being a hash over a blob, because a single-file policy shares nothing between revisions and would force an explicit delta format later to recover what structure gives for free: a fixture whose `gui` routes change moves `gui` and the root, leaves **every** other subtree hash equal, and contributes exactly one new object. Two refusals make that property true rather than aspirational. **No policy object may carry the Defold revision** - `assertNoRevisionLeak` refuses the derivation otherwise, and it caught a real leak on its first run, since each profile's `runtimeHandshake` carries `defoldRevision` and `catalogSha256`; both are stripped and reconstituted at resolution time from the revision the consumer already resolved, which is checked by rebuilding `default-legacy-bullet`'s handshake from the policy alone and comparing every field. **Only engine targets belong in an engine policy** - folding in `extension-defold-xmath` and `extension-defold-astar` would make the engine's policy a function of which extensions this checkout happened to have. Defold's toolchain pins are read from `build_tools/sdk.py` and carried under **Defold's own symbol names** (28 of them, including the `PACKAGES_*` compositions), because renaming a pin into our vocabulary is the first step towards owning it; a symbol that moves, or a right-hand side the reader does not understand, is a hard failure. The reconciliation the task asked for: `upstream.lock` does not spell it `EMSCRIPTEN_VERSION` - it carries **`EMSDK_VERSION=4.0.6`**, the same restatement under another name - and the generator now refuses to derive a policy when either spelling disagrees with `EMSCRIPTEN_VERSION_STR`. At this revision they agree, and the agreement is recorded rather than assumed. The site is emitted at `<base>/v1/{index,policy,object}/…` beneath one owned prefix, with the base carried **in the shipped index** and refused outright when it would resolve to a root-level segment; the end-to-end check publishes under a deliberately *different* base than the configured one, resolves sha -> index -> policy -> objects over HTTP, verifies all 55 objects against their own paths, and then serves a tampered object at a valid path and requires the resolution to fail. A clean-store regeneration is byte-identical (57 files written on the first run, 0 on the second). `policy-site.yml` verifies, emits, resolves and deploys with `actions/deploy-pages` and derives nothing, so it builds from a clean checkout with no Defold source, no clang and no network. `policy-revisions.yml` reads `d.defold.com/<channel>/info.json` daily: a channel whose sha is already indexed publishes **nothing**, and a new sha is repinned with the digest the immutable archive served, derived, and opened as a pull request rather than pushed. **Declared, not hidden**: `import-defold-sdk.py` parses with the host `clang++` and labels its output `arm64-macos` unconditionally, so two hosts can derive two different policies for one revision - the scheduled job runs on arm64 macOS to match the label and its PR says to compare roots, but the generator still needs to pin its own toolchain the way this policy pins Defold's.

* **A typed-native unit was being uploaded to a runtime that has no Hermes, and the fix is a projection rule rather than a deleted directory**: `defold_hermes_typed_native/` declared a name and no platform gating, so Bob uploaded one project's `shermes -emit-c` output for *every* target, and a `wasm-web` build failed to link on undefined `_sh_ljs_create_environment`, `_sh_model_s22_p8_rel` and `_sh_check_native_stack_overflow`. The unit is a **transport of the `hermes` runtime** - `staticHermesCAbi` carries `runtimeId: hermes` in the canonical plan, and its emitted C calls entry points only `libhermes.a` defines - while `browserWasmHost` carries `runtimeId: browser` and embeds no Hermes at all, so a Static Hermes unit is not a slower choice there but a meaningless one. An `ext.manifest` cannot express this: Extender compiles every `src/` file of every extension it is handed, and the manifest's contexts merge across the whole build. The decision therefore lives where the upload set is decided. `packages/cli/src/typed-native.mjs` answers the runtime question from **pinned data that must agree** - the bundle-target table generated from Extender's own `build_input.yml` says `group: web`, the native-artifact manifest says `builder: browser-host`, and a disagreement between them is a data defect that throws - and an unknown platform fails closed rather than being guessed. The assembler now takes `--target`, refuses a browser-runtime target with the machine-readable code `typed-native-requires-hermes-runtime` and exit 3, and a `--reconcile` mode applies the answer to the project before Bob walks it by maintaining one `.defignore` entry, which is the mechanism Bob's own extension discovery honours (`ProjectResourceWalker.walkResources` -> `getExtensionFolders`). Both `scripts/bob.sh` and the dev session's builder call it in both directions, so a unit a native build paid for is **hidden** from a web build and revealed again by the next Hermes build; nothing expensive is deleted. Each generated source also carries `#if defined(__EMSCRIPTEN__) ... #error "deherm typed-native-requires-hermes-runtime"`, so anything bypassing the gate gets one named compile error instead of a pile of undefined symbols at link time. Verified both ways on this host: an `arm64-macos` build links `libdefold_hermes_typed_native_71.a`, the engine logs `DEHERM_EVENT typed-native-unit-registered` and `static-units-evaluated count=1`, and the game runs; a `wasm-web` build now links and bundles, with **zero** `typed_native` compile lines in the Extender log.

* **HTML5 is a first-class dev target, and it acknowledges the same fingerprint the native engine does**: `deherm dev` launches the packaged `wasm-web` build on `w` (or `--web` for a non-interactive run) beside the native engine - two projections of one session, each with its own generation, telemetry and row in the Targets view. The transports differ and the acknowledgement does not. A browser page exposes no Defold engine service, so nothing can post it a resource reload; instead the session serves the bundle on a scoped loopback port, drives a dedicated headless Chrome profile over CDP, and pushes each built bundle into the page through `globalThis.__defoldHermesDevV1.activate`. That entry point runs the **native transaction in the native order**: evaluate the candidate, require that it registered a lifecycle or a component registry *and* carries its own 64-hex fingerprint (the running one is cleared first, so the host cannot acknowledge a bundle it never ran), run the candidate's `init`, and only then finalize the outgoing generation - so a candidate that throws leaves the running generation active. Live component attachments are rebound by id through the pool's existing `reload`, which keeps the engine-side Lua proxies, their `self` tables and their component ids across the swap and runs the new `onReload`; a component whose registered schema fingerprint changed is **refused** rather than rebound, because a property-schema change is a project build. Both outcomes log the same `DEHERM_EVENT bundle-activated|bundle-rejected fingerprint=... initial=false` line the extension logs, so one parser serves both targets. Telemetry is measured or named, never imitated: live component instances, live callback roots and both capacities are real counters; `performance.memory` travels under its own `jsHeap*` names with `hermesHeapAvailable` false; and the Hermes heap, the Lua handle registry, the value bridge's arena high-water mark and - for a component-only bundle, which never receives the host's application `update` - the frame delta each come back with the reason no number exists. Four further gaps are declared rather than discovered: no typed-native transport, no engine-service reload, no wasm relink inside the session, and **no visual verification of any kind**. `pnpm test:html5:war-battles-hot-reload` runs the shipped CLI in JSON event mode, records the fingerprint the page is already running, edits one TypeScript source, and requires the page to acknowledge the exact *new* fingerprint as a non-initial activation - a rebuild that changes nothing reproduces the running fingerprint and cannot satisfy it. Evidence: `examples/war-battles-online/evidence/browser-hot-reload-wasm-web.json`. The packaged-runtime gate and the development target now share one implementation of the loopback server, the CDP client, the Chrome profile and the teardown (`packages/cli/src/dev/browser-host.mjs`), and the extension's stale "browser-host activation is not implemented" branch has been corrected to name the transport that does activate.

* **`deherm generate` no longer ships one Defold revision's types to every project**: the CLI read a pre-generated IR pinned to `7f0f554` out of the npm package and copied it into the user's project, and the only version handling refused a mismatch the user had *typed themselves* via `--defold-sdk`. Nothing read the project. A user on any other Defold revision received `7f0f554` signatures that compiled and were wrong, which is the one failure a generator may not have: a defect in a generated file is one project, a defect in a generator is every project that runs it. The revision is now **resolved before anything version-specific is read**, from seven independent observations ranked by whether each witnesses the engine in use now, is a claim the project makes about itself, or records something that already happened - and collected rather than short-circuited, because a silent precedence win between two contradictory claims is the same failure in a quieter form. Two disagreeing current claims are a blocker naming both; a stale one is a warning naming both; `--defold-sdk` overrides and says what it overrode. Three refusals are load-bearing: **a `deherm.lock` without a recorded resolution is ignored**, because trusting it launders the old assumption through a file that looks like a decision; **an unresolvable revision is a blocker that lists every source it checked and deliberately does not name the packaged SHA**, since offering it is how a user pastes it into `--defold-sdk` without knowing whether it is theirs; and **a revision with no generated surface is refused rather than served another revision's**. Detection found real project evidence nobody was reading: Extender writes the absolute `sdk/<sha>/defoldsdk` path of every compile into the build log it returns, so a project that has built its extensions once already carries a first-hand record of the engine it was compiled against. Layer 0 of the policy cache is now revision-keyed across package, user cache and project cache, and the generation key is a Merkle root whose `engineRoot` and `nativeRoot` move independently - an engine upgrade leaves every extension subtree valid and vendoring an extension leaves the engine surface valid. **Still open**: producing a surface for a revision this package did not ship. The generator pipeline is wired to repo-root paths and `upstream.lock`, so an unshipped revision is a precise blocker rather than a download.

* **The handle lane could not see a constructor, because a table-shaped parameter outranks a handle**: the headless harness produced a live `b2Joint` through `b2d.joint.create_distance` and all **82 handle-lowered `b2Joint` consumers refused it** with `handle argument codec mismatch`; 21 were exercised and every one refused a handle a real engine had just made. The cause was not a missing row. A route's *lowering family* is a single-winner precedence, and `table` is checked before `handle`, so every constructor taking a definition record - `b2d.joint.create_*`, `bullet3d.constraint.create_*`, `buffer.create` - lands in the table family. Partitioning the borrowed-handle census on that family therefore covered only routes whose **arguments** are handle-shaped, which is to say accessors, and hid every constructor: the primary way a program obtains a handle at all. The census is now admitted on a second structural basis, `declared-handle-result` - the route's single declared result **is** a reviewed handle kind, every non-absent member resolving to the same one - and each row records which basis admitted it. That is a value-shape rule, not a name pattern and not a route list, and it refuses the two shapes that only look like producers: `go.get` returns a union of scalars that merely *admits* `resource_data`, and `b2d.body.get_joints` returns a *sequence* of handles, which is a table. **415 -> 437 routes, 33 -> 55 producers.** The second half is representation: a handle-lowered consumer accepts exactly one thing, a generation-checked semantic handle rooted in the shared registry, so the **universal-value transport now produces it too** - each operation carries the dense `resultSemanticKind` of its declared result, in the same numbering `SemanticHandleKind` uses, derived by both generators from the pinned classification through one shared `scripts/lib/semantic-handle-kinds.mjs`. Nothing was added to the handle-lowering table; its consumers accept what the constructor produces because both transports now produce the same identity, and the plan's cross-transport agreement is recorded on that fact rather than on table membership. Against the live engine **all 21 refusals are gone**: 10 became `result-arity:observed` and 11 became honest engine-semantics exceptions - `b2d.joint.get_joint_angle can only be used with revolute joints.` - which is evidence about the route where there was only evidence about the transport.

* **`no-handle-producer-chain` is gone, and getting there found a positional-argument bug**: it was 3 contracts and 37 `btTypedConstraint` routes, because every `bullet3d.constraint.create_*` takes a required parameter record the harness could not inhabit. Three structural rules removed it, none naming a route: a declared record is inhabited from its **required fields only**, bounded at three levels; a Defold value type the pinned layout report models is inhabited by **the engine's own constructor**, discovered as the route with no required parameter whose single declared result is that value type *and* whose conformance case needs no context beyond the ambient engine - which is exactly what keeps `go.get_position`, whose shape also fits, from silently reading the surrounding game object instead of `vmath.vector3`; and an optional parameter sitting **before** a required one is a hole a positional Lua call still has to fill, so the minimum-arity call passes an explicit nil there and only the tail after the last required parameter may be truncated. The third rule was a real defect the engine named for us: dropping the hole shifted every later argument left, and `bullet3d.constraint.create_cone_twist` received its parameter record where it expected `body_b` and answered `Expected user type bullet3d_collision_object`.

* **A handle kind's representation belongs to the backend, not to the kind**: the classification called `box2d-world` `lua-rooted-userdata` from the **v3** sources, while Box2D v2's `PushWorld` pushes a *light* userdata with no metatable, no generation and no identity to capture - so the runtime guard was refusing by inspecting the value rather than by knowing. A kind now declares the feature its stated representation came from plus one exception per feature that implements it differently, each with its own pinned source and hash; the handle-lowering generator joins that against the availability model's feature-to-profile map and emits `capturableProfileMask` per kind. `box2d-world` is a rooted identity in `v3-bullet` and `v3-no-bullet` and nowhere else, both transports refuse by declaration, and the transcript now says `semantic handle kind is not a rooted identity in the active runtime profile`.

* **Headless conformance, same engine, same driver**: **37 observed, 0 mismatched, 0 engine faults, 3 blocked, 45 unreachable** of 85 contracts, against 31/0/0/3/48 before; **171 routes exercised across 40 fixtures in 189 exercises** against 129 across 34; `result-arity:observed` **82 -> 123**, `handle-provenance:observed` **90 -> 157**. The three blocked contracts are the same honest `buffer-data`/`buffer-stream` blockers as before - `resource.get_buffer` needs a compiled `.bufferc` the harness cannot supply.

* **Working the Lua-registration blocker queue down, and the moment the verifier stopped being a report**: the first run of `scripts/generate-lua-registration-surface.mjs` left **391 blockers over 302 of the 867 matched routes** and only **259 routes agreeing on every parameter, arity and result** - the honest number behind "926 routes supported". Five general parsing rules, no per-route or per-module knowledge, took that to **152 blockers over 110 routes and 316 agreeing**, and emptied the `undecided` bucket (48 -> **0**) entirely. (1) A file-scope function-like macro invocation *is* a function definition and is expanded in place, because `BIT_OP(bit_band, &=)`, `GET_CAMERA_DATA_PROPERTY_FN(FarZ, lua_pushnumber)` and `LUAGETSETV3(Position, PROPERTY_POSITION)` are how 48 registered symbols exist at all; the same pass found that `##` was being read as stringification, so `LuaGet##name` had been expanding to the literal `LuaGet#"Position"`. (2) A called helper name is an overload *set* resolved by the number of arguments the call supplies - the engine overloads `GuiScriptInstance_Check(lua_State*, int)` against `GuiScriptInstance_Check(lua_State*)`, and only the first addresses an argument while the second reads the running instance out of the registry; resolving both to the two-argument form had made 135 ordinary calls look like undecidable stack indices. Arity resolution also fixed the scoping heuristic it replaced: two definitions of a name with *different* argument counts are overloads, not two file-static helpers, so `dmScript::GetComponentFromLua` stopped being invisible outside its own translation unit. (3) `LUA_REGISTRYINDEX`, `LUA_GLOBALSINDEX`, `LUA_ENVIRONINDEX` and `lua_upvalueindex(n)` are pseudo-indices, not argument positions. (4) Additive arithmetic over integer literals in an index expression is folded. (5) A helper addresses *every* integer parameter its body shows stack evidence for, not just the first, because `CheckJointDefBodies(L, 1, 2, &a, &b, &world)` reads two argument positions in one call. What is left refuses honestly: 45 indices computed at runtime, 43 non-literal return expressions (`_G.unpack` and `_G.select` really are variadic in their results), 23 argument positions no recognised accessor reads, 21 documented modules with no registration array anywhere.

* **The largest disagreement family was two opposite defects wearing one label, and one of them was the parser's**: 348 parameter slots disagreed on optionality, and the report said only "declared X, derived Y". Splitting it by *what the C body does* found that the parser was manufacturing a third of them. Box2D's `CheckMaxResults` opens `if (lua_isnoneornil(L, index)) return 0;` and only then calls `luaL_checkinteger`, so the check sits on the else-path and the slot is optional - the helper model let the check win, which would have emitted a **required parameter for a slot the engine defaults**, in every project that ran the generator. Presence now dominates, including when the test is written arithmetically (`lua_gettop(L) == instance_arg` in `ResolveInstance`). The mirror error was there too: `dmScript::CheckHashOrString` reads its slot with `ToHash`, `lua_type` and `lua_tolstring` - all non-raising - and then runs `luaL_typerror(L, index, ...)` on the fall-through, so an argument-raising call at the body's own statement level now makes a slot required however it was read on the way there. Declaration-derived and body-derived families are combined rather than replaced, and the direction is chosen so the unsound failure cannot happen: the body scan is a *lower* bound, so a `required` from either side wins, because over-requiring is visible at compile time and under-requiring is not. The surviving rows now name whose defect each is: **`documentation-permits-refused-call` (37)** - declared optional, refused unconditionally by the body, a defect in the declaration *and* in any signature that follows it, with `sound.set_gain` documenting `@param [gain]` above an unconditional `luaL_checknumber(L, 2)`; **`engine-tolerates-omission` (88)** - declared required, read with a non-raising accessor, which is **not** a signature defect, because the documentation is the narrower contract and emitting it rejects no call the engine accepts; **`branch-dependent-requirement` (67)** - the check sits inside a branch and proves nothing, so it is a refusal rather than a finding. Parameter slots disagreeing: 348 -> **206**, and a route whose body recorded an undecidable index no longer claims an arity verdict at all.

* **The verifier is now a gate**: it emits a second, deliberately small artifact, `packages/bindings/generated/defold-lua-registration-gate.json`, and `scripts/generate-script-projection-ir.mjs` reads it as a declared authority the way it already reads the canonical lowering plan. Only findings backed by **positive** evidence in C source may act - a registration array that registers the same C function under another name, a registration entry commented out, a body that refuses an omission the declaration calls optional. "The parser found no registration" is *absence* of evidence with innocent explanations (a Lua-side luasocket module, a `go.property` declaration token, an excluded build variant) and never gates; nor does anything the two mutually exclusive Box2D builds do not both witness, so each finding carries one evidence row per engine target. Finding the first category needed one more structural reading: Defold writes `/*# ... @name module.member */` directly above the implementing C function, and that annotation and the registration array in the same translation unit are two independent claims about the same symbol. Attributing an annotation only when whitespace, a storage class and a return type separate it from the definition matches **435 routes across the pinned engine with zero spurious mismatches** and finds exactly one real one: `sys.set_render_enable` is documented, `sys.set_render_enabled` is what is registered. In the projection IR the 38 findings become **888 routes `registration-verified`, 37 `registration-corrected`** - a declared-optional parameter overridden to required, carrying `optionalityCorrectedBy: "lua-registration-gate"` so the override is visible rather than folded silently into the declaration - **and 1 `registration-blocked`** with the semantic hole `registration:registered-under-a-different-name`. Applying a correction is itself checked: the gate names the slot by index *and* by declared name, and the projection throws if the script IR disagrees with either. Static evidence only: `require-parameter` says the C body refuses a missing argument, not that the engine behaves as documented once it has one.

* **Three projections, one shared shape, and a silent wrong value the third one was hiding**: War Battles now has three first-class runtime records rather than three unrelated JSON files. `examples/war-battles-online/integration/projections.mjs` declares the set - `native-arm64-macos`, `browser-wasm-web`, `native-arm64-macos-typed-native-transport` - each by the four parameters that select a projection (runtime, per-route transport, reachable set, profile), what its evidence observed, and what it explicitly does not claim; each evidence document embeds that declaration verbatim, and `pnpm check:war-battles-projections` refuses a set in which a declared projection has no evidence, so a projection nobody ran is a named failure instead of a silence. Re-recording the native record against the current tree is what found the defect: with the assembled typed-native extension linked, the demonstration rocket span `war-battles:rocket-init:0.00:0.00` and expired, and `rocket-hit`/`score:100` never appeared; without it, the same source produced `1.00:0.00` and the hit. **The typed-native encoder was silently losing a `Map`.** `factory.create("#rocketfactory", position, undefined, new Map([["dir", aim]]))` sends its property table as a `Map`, which the JSI encoder handles explicitly (`kTableMap`, walking `Map.entries()`), while the generated Static Hermes bridge fell through to `for (const key in value)` - a `Map` has no enumerable own properties, so it encoded an **empty record** and the spawned component kept its property default. Not a declined value: a wrong one, arriving with no diagnostic, on exactly the transport whose whole justification is that a primitive resolves to the same observable behaviour however it is projected. `scripts/generate-typed-native-bridge.mjs` now emits the `Map` case as `DehermStaticMap` (table kind 3, the same kind the JSI encoder tags) with a matching decoder, and - structurally, rather than by listing the shapes it knows - declines any remaining object whose prototype is neither `Object.prototype` nor null, so a `Set` or a class instance falls back to the JSI bridge instead of being enumerated into nothing. Observed on a packaged arm64-macOS engine: **14 routes on `typed-native`** including `factory.create`, **exactly the two `value-type:node` routes (`gui.get_node`, `gui.set_text`) on `jsi`**, zero failures and zero dropped spans, against a control build of the same project with the extension removed that puts all **16 on `jsi`** and registers no static unit. The transport census is now recorded by `integration/check-typed-native-transport.mjs --run <with-typed-native|control>` rather than by hand, and it reads the `finalize` census - the complete fold taken after every component `final()` has made its last call - instead of a periodic prefix.

* **The shipped `DEHERM_PROFILE` default is a decision the build system now enforces**: `generated_build_config.h` is materialised by the typed-native assembler, so a `--profile` run leaves the instrumented header in the working tree and nothing about its shape says which of the two it is - the delivered binary was the instrumented one. The shipped default is telemetry **off**, and `pnpm check:profile-shipped-default` re-renders the skeleton from the assembler's own renderer and refuses any other committed content, naming the command that restores it; it also refuses an assembled extension manifest that records `profile: true`. Checking against the renderer rather than against a copy of the text is what keeps the gate and the generator from drifting apart. The switch is worth what it costs: with it off, `libdefold_hermes_68.a` links 6,928,080 bytes against 7,179,288 with it on.

* **The `@system/exit` shutdown probe now addresses one engine instead of one port**: SIGTERM and SIGINT tear the process down without running a single component `final()`, so the engine service is the only way to exercise teardown - and Defold sets `SO_REUSEADDR`/`SO_REUSEPORT` on every listening socket, so two engines on the default port both bind it and the kernel hands a connection to whichever it likes. That is how a teardown census went UNOBSERVED: a stray `dmengine` absorbed the exit post while the engine under observation kept running. Two mechanisms replace it, both required. The engine under observation is started with `DM_SERVICE_PORT=dynamic` and its port is read back out of *that child's own* transcript rather than assumed; and before anything is posted the listeners on that port are enumerated, with the set required to be exactly that process - a second listener names both pids and fails, and a census that cannot be taken (no `lsof`) is not allowed to pass as a census that found one listener. `examples/war-battles-online/integration/graceful-shutdown.mjs` owns all of it, including the pinned `system_ddf.Exit` encoding. The packaged runtime gate now terminates this way rather than by signal, so `war-battles:player-final` - emitted after a `msg.post` from `final()` returns - is part of the native projection's own evidence, and the September teardown fix has a standing regression guard rather than a one-off transcript. A failed graceful shutdown is never downgraded to a signal: a signal would produce a transcript that looks clean while proving nothing.

* **The native runtime gate now requires the whole tutorial loop, not its first frames**: its marker set was written before the tutorial port and the camera, so it could pass on an engine that never fired, never collided and never scrolled. It now requires the same behaviour the browser gate requires - camera initialisation and world bounds, GUI initialisation, player initialisation, the factory-spawned rocket, the Box2D collision, the score, the sprite-animation completion callback, and the clamped player walk - which is what makes the native and browser projections comparable rather than merely adjacent. The gate also sets the executable bit Bob's `build` step leaves off its linked engine (its `bundle` step sets it), because the mode is not part of an artifact's identity and a fresh `resolve build` should be runnable.

* **The headless conformance harness now builds the world a contract needs, and found four things by doing it**: the instrument could reach 15 of 82 script contracts because it could only synthesize scalars, so the 402 routes of the physics handle algebra - `b2Body`, `b2World`, `b2Joint`, `btRigidBody`, `btCollisionObject`, `btDiscreteDynamicsWorld` - were unreachable by construction. Two structural mechanisms replaced that: a **fixture profile** declares the components its generated collection carries, the engine configuration the driver passes for that case (opaque `key=value` tokens in the case manifest, exactly as Defold's own `test_engine.cpp` selects a backend with `--config=physics.type=3D`), and the contexts it therefore supplies; and **handle provenance** derives, per profile, a producer chain for every borrowed handle kind, where a producer is any route whose single declared result is that kind and a chain is a bounded fixpoint over the parameters it can itself satisfy. A handle kind is admissible in a profile only when every pinned Defold source the classification cites for it lies under that profile's backend directory, so 2D and 3D algebra cannot mix in one engine instance. `box2d-joint` is reached at depth two - `b2d.get_body` at two distinct component addresses feeds `b2d.joint.create_distance` - which is why the physics collection carries a second collision object: each occurrence of one handle kind in one call takes its own ordinal and an ordinal selects an address. Result: **31 observed, 0 mismatched, 0 engine faults, 3 blocked, 48 unreachable**, with **129 routes exercised across 34 fixtures** against 27 across 16, and 90 `handle-provenance:observed` records where a producer route really did yield a live engine object. `unsynthesizable-parameter-type` fell from 402 routes to 8. Three things also became *more* honest rather than larger: the plan is now built against the runtime profile the linked engine actually presents (`default-legacy-bullet`, Box2D **v2** plus Bullet) and the check asserts the profile déherm reports in the transcript matches, so 49 routes that were being called and refused by déherm's own availability gate - and recorded as observed target exceptions - are now the explicit blocker `route-unavailable-in-runtime-profile`; `context-fixture-missing` no longer reads as "write a fixture", because for `gui-scene` (103 routes) and `render-script` (12) no fixture is sufficient - `AttachLuaInstance` calls `dmScript::CheckGOInstance`, so a `.gui_script` instance cannot attach the runtime at all, and the plan records that obstacle with its source evidence in `unsuppliedContexts`; and a destructive route is admitted only when its contract has no safe route, exercised exactly once, with the repetition-based properties recorded `not-applicable` instead of manufacturing a mismatch. **Four findings only a live engine produced.** (1) `b2d.get_world` segfaults from a collection with no collision object: `CompCollisionObjectBox2DNewWorld` sets the component world to `0x0` when `m_MaxComponentInstances == 0` and `B2D_GetWorld` dereferences it, while `Bullet3D_GetWorld` in the same revision holds exactly the null guard it lacks - an upstream asymmetry, resolved here structurally by placing a contract that returns a `borrowed-engine-world` handle in a fixture that owns that world. (2) With the fault gone, déherm fails closed instead, because Box2D v2's `PushWorld` pushes a **light** userdata: `CapturedLuaRouter::read` gated on `lua_isuserdata`, which accepts light userdata, while the registry requires `LUA_TUSERDATA`, so the capture always failed and blamed *capacity* - the generated router now separates the three causes and refuses by name, and the classification's `lua-rooted-userdata` representation for `box2d-world` is revealed as v3-specific. (3) No handle-lowered consumer accepts a `box2d-joint` the engine produced: `b2d.joint.create_distance` is in neither the borrowed-handle classification nor the handle-lowering table, so its result crosses on the universal-value transport and all 82 handle-lowered `b2Joint` consumers reject it with `handle argument codec mismatch` - the classification's producer partition covers only accessor-shaped names, and every handle-returning `create_*` falls outside it. The plan now records that disagreement per profile as `agreement: producer-outside-handle-lowering`. (4) `b2d.fixture.get_aabb` aborts in `b2Fixture::GetAABB` when called before the first physics step, because `Fixture_GetAABB` range-checks `child_index` against the shape's child count while the assertion is against `m_proxyCount`, which is zero until the broad phase has the fixture; contracts now run from the déherm application's second `update` rather than `init`, which is both the fix and the confirmation. Also, for the world-space addressing lane: the harness now synthesizes optional parameters as an additive second arity, passes real component addresses for `url`-typed parameters, uses one-based inhabitants for index parameters, and its per-contract exercise cap is 16.

* **War Battles runs on the typed-native transport in a packaged engine, mixed with JSI in one Hermes runtime**: `shermes -typed -strict -O -emit-c` output is now assembled into a project-local Defold extension (`scripts/assemble-typed-native-extension.mjs`), uploaded by Bob and compiled by the pinned local Extender, and evaluated into the same runtime as the bytecode bundle before it loads (`Runtime::evaluateStaticUnits`). The AOT unit installs itself over `__defoldScriptBridgeV1`, so the transport choice is a compiled native decision per call: it claims **320 of the plan's 325 `staticHermesCAbi` routes** (five variadic ones decline) and delegates every other route, and any argument it cannot soundly marshal, to the JSI bridge it captured. In a packaged arm64-macOS debug bundle of War Battles, the drained telemetry ring reports **13 distinct routes crossing on `typed-native`** - `go.get_position`, `go.set_position`, `go.set_rotation`, `go.delete`, `vmath.vector3`, `vmath.length`, `vmath.normalize`, `vmath.quat_rotation_z`, `msg.post`, `factory.create`, `camera.get_cameras`, `camera.get_orthographic_zoom`, `sys.get_config_number` - and exactly the two `value-type:node` routes, `gui.get_node` and `gui.set_text`, still crossing on `jsi`, with zero failed crossings and zero dropped spans. A control build of the same project with the assembled extension removed puts all sixteen on `jsi` and registers no unit, so the transport split is the assembly rather than the instrument. Three C-only constructs in the emitted output are adapted structurally and assertively (tentative array definitions, implicit `void*` conversion, allocation casts) because Extender merges `ext.manifest` contexts across a build and compiles everything as C++; `NDEBUG` is matched to the packaged `libhermes.a` by reading its own model symbol. Evidence: `examples/war-battles-online/evidence/packaged-typed-native-transport-arm64-macos.json`. This is packaged-engine transport evidence, not conformance, allocation, or benchmark evidence.
* **War Battles plays in a browser, and the three things stopping it were all stale gates rather than missing transports**: the port is a component-only bundle, so on HTML5 it hit `registerUnavailableLuaApi` and every script failed at `init` before the bundle was ever read. Fixing that exposed the second gate - the browser bootstrap demanded `__defoldAppV1` and rejected a registry-only bundle, which `runtime.cpp` has always accepted - and then the third: the SDK threw for **77 value routes and 24 fixed-tuple routes** whose only sin was that their *specialized native* lane is native-only. `callScriptApi` dispatches one stable ID through one bridge, and in the browser that bridge is the generated universal direct-memory provider, which the canonical plan already marks `emit` for all 911 of them. Those two gates now carry no route; the one that remains is machine-derived from the universal generator's own callback ledger and blocks exactly `socket.newtry` and `socket.protect`. The new `component_web_backend.cpp` implements the same `BackendApi` the Hermes backend does - current-instance context, bounded adapter context, Lua `self`/property/argument encoding - but encodes into the **generated universal wire format** and hands it to a browser provider that mirrors `runtime.cpp`'s slot pool, so no second value codec exists to drift. A fresh `wasm-web` bundle then ran in headless Chrome and emitted the tutorial's whole demonstration chain from browser JavaScript into the Wasm engine log: `ui-init`, `player-init`, `player-fire`, a factory-spawned `rocket-init`, a Box2D `rocket-hit`, `score:100`, a sprite-animation `rocket-explosion-done` returning through the callback trampoline, and eleven camera samples reaching the `x` and `xy` clamps. The bundle fingerprint the browser reported matched the source resource exactly. **No pixel was inspected and none is claimed** - the evidence is the marker transcript, CDP page state, and the absence of page errors, recorded in `examples/war-battles-online/evidence/browser-runtime-wasm-web.json` and reproducible with `pnpm test:html5:war-battles`, which owns and tears down its own loopback port, Chrome profile, and server.

* **Release reachability is now a symbol set the checker resolved, not a boolean the bundler guessed**: `scripts/build.mjs` set `dynamicAccess` on the Defold API the moment *any* file under the generated script SDK was retained, with an empty symbol list - which the release planner reads as "retain everything". Every real game imports the SDK, so every release build tree-shook **zero of 913** emittable routes, and module granularity could not have done better: `gui.getNode` and `gui.newPieNode` are members of one object. The ttsc plugin now resolves reachability where it already resolves `DefoldHash` literals and resource names - a property access resolves to a symbol, the symbol to a `PropertySignature` in the generated `script/types.ts`, and the member path is rebuilt by walking that declaration's parents so a nested Lua module such as `B2dApi.body.applyForce` answers too. A derived script route symbol index joins those 926 member paths to canonical route IDs and 32-bit stable IDs, and a test checks all 926 against the independently generated `modules.ts`. **War Battles resolves 24 routes; the runtime-smoke entrypoint resolves 33** - where the bundler retains 125 for the same entrypoint because it keeps whole namespace objects, and the old planner retained 913. That one set drives the emission plan (33 of 2,287 units, 29 of 504 marshalling programs), the generated family C++ sources, the route registry, `sources.cmake`, the target gates, and a newly pruned typed-native lane whose `shermes -emit-c` output is asserted to contain no pruned `extern_c` symbol - proven non-vacuous by emitting the complete lane and finding those same symbols there. The module graph became the **cross-check**: the bundle is re-read for the `callScriptApi(<stableId>)` integers it actually emitted, every resolved route must appear among them, every retained namespace must be claimed by a resolved route, and a disagreement fails the build and the emission plan rather than picking a winner. Computed access - `gui[name]` - is detected from the object's *type*, named by file/line/column, and must be declared with `dynamicApiAccess` before a release will retain the surface for it. **Development is untouched and deliberately the inverse**: Bob still compiles the whole of `defold/defold_hermes/src/`, `DEHERM_CANONICAL_RELEASE_DIR` is still empty unless release generation sets it, and the development profile records a dynamic site instead of raising on it - reachability is computed on every rebuild only so the operator console can say "release would retain 24/926 Defold routes across 7 namespaces; development links all of them".

* **The 53,472 bytes the typed-native transport zeroed on every call, and the policy gap that let it**: `deherm_script_universal_dispatch` cost **725 ns with a stub backend that does nothing** - 180x the `c-abi-native` transport and more than twice the complete Lua bridge - and none of it was codecs. The generated dispatcher value-initialized one fixed per-call frame for all 915 routes: 32 + 4 `ScriptValue`, two 256-entry `ScriptTableEntry` arrays, a `ScriptMatrix4Arena` and a 32-slot `ScriptUrlArena`, which is 53,472 bytes of stack zeroed per dispatch whether the route could address a byte of it or not. That frame was allocation-free by the memory policy's own definition - stack-resident, bounded, never the heap - so the policy had nothing to say about it; `decisions/memory-and-hot-path-policy.md` now governs per-call *initialization* as well as allocation, requires frame scratch to be sized from the dispatched route's contract rather than the family maximum, requires unreadable value-shape constructors to *widen* the frame rather than narrow it, protects initialization that a bound, a generation counter or a fail-closed release path depends on, and adds a verification gate that a family report the per-route frame footprint and measure both its smallest and its largest frame, because a single family-wide call time hides exactly this defect. The generator now walks each route's parameters and returns separately - including inside union variants - and answers three structural questions: can this half carry a table, and can either half reach a `matrix4` or a `url`. It interns the distinct answers into **89 frame profiles over 915 routes**, emits one `runContractFrame<...>` stub per profile against a single shared dispatcher body, a dense `uint8` route-to-profile table, and the same four capacities on the `Operation` descriptor the dispatcher already validates against; a generator test parses both emitted files and asserts they are still the same numbers, since a frame narrower than its descriptor would refuse calls the descriptor accepts. Nothing is hand-written per route and `dynamic`, `record-ref`, `named` and callback shapes keep the full frame, so an unrecognized constructor costs memory instead of losing a bound. **607 of 915 routes now need no table scratch, no Matrix4 arena and no URL arena at all**; the median route's frame is 96 bytes and the mean 7,209 against the previous flat 53,472. Measured on an Apple M4 at load average 2-4, Release, before and after binaries interleaved three runs each, best-of-9 x 100,000 calls after 20,000 warm-up: `profiler.dump_frame` 733 -> **43**, `b2d.joint.get_body_b` 746 -> **55**, `bullet3d.rigid_body.apply_impulse` 736 -> **55**, `physics.wakeup` 742 -> **65**, `physics.destroy_joint` 750 -> **68**, `gui.set` 745 -> **422**, `resource.create_sound_data` 739 -> **414**, and `physics.raycast` 761 -> 742 because it genuinely takes a table and returns one. Ten shapes fit `ns = 49.4 + 0.01344 x frame bytes` with R^2 = 0.9998 - about 49 ns of real dispatch plus 13.4 ps per byte zeroed, ~74 GB/s of L1 stores - and extrapolating that fit to the old frame predicts 768 ns against a measured 733-773, so the diagnosis and the fix are the same model. The remaining zeroing was measured rather than assumed and only half of it is dead: the decoder's own argument and input-table scratch is provably written before read, but `ScriptValue` and `ScriptTableEntry` carry default member initializers, so every form that begins their lifetime also zeroes them and the alternatives are precisely what the family's ASan/UBSan gate exists to reject; the backend-filled result and output-table scratch stays zeroed because that is what makes a partially written result graph decode as absent rather than as garbage. The next lever is fewer retained bytes, not a zeroing trick - `ScriptCallFrame::urlArena` is typed `ScriptUrlArena<32>*` and `ScriptMatrix4Arena::kCapacity` is 16 in hand-written ABI, and the 256-entry table bound is a policy number because the IR states no per-route element count. No behavior moved: the recording engine still drives 915 routes over three transports with 0 violations and 0 transport divergences, the reentrancy/cycle/exhaustion/stale-handle/warm-zero-allocation gates pass in Release and under ASan+UBSan, `c-abi-native` and `lua-stack` are unchanged in the same runs, and the telemetry still compiles out. Host-harness evidence over a stub backend; no figure here has been observed inside a running Defold engine.

* **The bundle Bob archives is now bound to the TypeScript it came from**: Bob copies whatever `/deherm/app.dehermc` is on disk into the archive as a `custom_resources` entry and relates it to nothing, so a project whose bundler has not run since the last edit shipped old code in silence - the same class of fault as the stale `game.arcd` that `--archive` was added for, and one a build server that only ever runs Bob cannot notice. Every bundle already published `__DEFOLD_HERMES_BUILD_FINGERPRINT__`, a SHA-256 of its own program text that the runtime echoes on activation; nothing used it to answer the question *is this the program these sources describe*. `packages/compiler/src/bundle-freshness.mjs` defines that relation and `deherm.lock` now carries it under `buildArtifacts`: the artifact's content hash, its published fingerprint, the build settings that produced it, and the SHA-256 of every file the bundler read - all 31 of them for `examples/war-battles-online`, type-only modules the bundler discarded included, because a discarded import can still change the emitted program through a ttsc transform. `deherm verify-bundle` recomputes the binding from the working tree and `deherm verify-generated` reports it, so generated state and the artifact Bob consumes are covered by one command. Recomputation is a hash comparison over the recorded inputs and never a compile - 136 ms for the example, node startup included - which is what lets `scripts/bob.sh` run it before every Bob invocation and the dev loop rewrite it after every rebuild. A newly reachable source file cannot hide from a fixed input set, because reaching it required editing a file already in that set. The states that need different answers are reported differently: sources changed after the build, the artifact is not the recorded one, the artifact disagrees with its own fingerprint, nothing binds it, or it is absent; the first three are errors everywhere, the last two are reports by default and errors before Bob, where an artifact nobody can relate to a source tree is as unacceptable as one that provably disagrees with it. Editing `MUZZLE_OFFSET` in the example without rebuilding produced `expected fingerprint (deherm.lock): 4afe2acc…` against `fingerprint of current sources: 9b5d323c…` and named the one file that differed; rebuilding produced exactly the predicted `9b5d323c…` and the check went green. `--recompute` is the opt-in exact answer and also *clears* a conservative failure: an appended unused export changes the source digest but tree-shakes away, and re-bundling proves the artifact on disk is still the program those sources compile to. Neither supported workflow is forced - a committed bundle travels with its binding in the lock, a build machine that runs déherm rewrites the binding before Bob reads it, and nothing here needs the network. The same record shape, kind `generated-sources`, covers the `shermes -emit-c` output that a release build assembles into the extension's `src/`; that emitter is separate work, but it will inherit the freshness relation rather than invent one.

* **A verifier that reads the C registration instead of the documentation, and the 926-route surface it contradicts**: `.script_api` files and reference docs are declarations; the ground truth is the Lua C API registration and how each C function body uses the Lua stack. `scripts/generate-lua-registration-surface.mjs` and the parser in `scripts/lib/lua-c-registration.mjs` now derive a target's *registered* surface from its own C/C++ sources - an extension root, a Bob dependency archive read in place with `fflate`, or the pinned engine tree - and diff it against the declared surface. Nothing in the lane names a route or a module: namespaces come from an abstract Lua stack machine over `luaL_register`/`lua_newtable`/`lua_setfield`/`lua_getfield`, so `b2d.chain` and `bullet3d.collision_object` fall out of the C rather than being written down; registration split across translation units is followed through the call graph with the callee inheriting a copy of the caller's stack, which is what keeps the generic `dmScript::RegisterUserType` from desynchronising every namespace above it; entries generated by function-like macros such as gui's `REGGETSET(Position, position)` are expanded, including `#` stringification and C's adjacent-string-literal concatenation; and a commented-out array entry is recorded as evidence of *absence*. Arity, per-parameter types and optionality come from `luaL_check*` (required), `luaL_opt*` (optional) and `lua_to*`/`lua_is*`/`lua_isnoneornil` (present-or-not), with the helper vocabulary enumerated from the pinned dmSDK headers and then extended by reading the target's own helpers to a fixed point - Box2D's private `CheckBody` resolves to the user type `b2Body` because that is the name it was registered under, and astar's `get_map(lua_State* L, int nArg)` resolves to an optional number because its body calls `luaL_optinteger` on that slot. Which integer parameter is a stack index is decided by the body, never by its name. On the pinned engine with Box2D v3: **924 routes registered, 926 documented, 867 matched, 61 documented but unregistered, 57 registered but undocumented, and 391 blockers over 302 routes** for everything the C parse could not decide; only 259 of the 867 matched routes agree on every parameter, arity and result, which is the honest number behind "926 routes supported". The v2 backend is its own target and shows the complement: 836 registered, 135 documented but unregistered. The findings are real: `sys.set_render_enable` is documented under that name in `script_engine.cpp` while the array in the same file registers `set_render_enabled`, so the documented spelling is not callable; the fourteen `b2d.shape.*` routes and the two commented-out `b2d.body.*_user_data` entries the route-availability generator found are reproduced independently; `sprite.set_scale`, `profiler.get_lua_ref_count` and `sys.set_debugger_lightweight_hook` are registered with no documentation; and the seven `resource.*` rows reported unregistered are independently corroborated as `declaration-token` by the repository's own borrowed-handle classification. Run against the upstream sources of the two ingested extensions at their pinned revisions, it rediscovers the `.script_api` defects from C alone - `astar.use_zero`'s missing `type: function` sits next to the registration that contradicts it, all nine `map_id[optional]` markers are confirmed optional by `luaL_optinteger`, and eight of astar's nineteen registered functions turn out to be undocumented - and finds two the declarations hid: `astar.use_zero`'s documented-required first argument is read with `lua_toboolean`, so calling it with no arguments silently toggles to `false`, and `xmath.matrix4_scale` accepts a four-argument `(m, x, y, z)` form that its description mentions only in prose. The lane fails closed throughout: an undecidable C construct is a blocker with a code, a location and a reason; a declared type with no mapping rule and a derived type outside the Lua vocabulary are both `undecided` with the unmapped token named, so agreement and "could not tell" are never mixed; branch-dependent arity is reported undecided rather than as a false disagreement; and the two fixture extension targets, which vendor interface description and no native source, report `status: "unverifiable"` rather than letting an unchecked declaration read as agreement. This is generation and static-analysis evidence only - nothing here was compiled, linked, or run.

* **Addressed game-object transforms, and the two descriptors that were counting coverage they did not have**: `go.get_position`, `go.set_position` and `go.set_rotation` declared `String`, `Hash` and `Url` call shapes and implemented only the current-instance one, so a TypeScript component could not read or write another game object's transform and the War Battles camera had to consume a `msg.post("/camera#follow", "player_at", {x, y})` report from the player instead of sampling it. They are now one route with two lowerings, selected by argument count inside the generated value-binding dispatcher: no address keeps the direct native path through `game_object::resolveCurrent`, which validates the borrowed instance's generation, collection and identifier before any engine pointer read; an address goes through the same generated captured-Lua invoker the 70 URL/address routes already use, keeping a string a Lua string, a hash a Lua hash and a url a pushed `dmMessage::URL`. Restating that resolution natively would have duplicated semantics that depend on the *calling* instance's collection and socket, so Defold's own `ResolveInstance` still performs the `lua_gettop(L) == instance_arg` gate, `dmScript::ResolveURL(L, instance_arg, &receiver, 0x0)`, the same-collection socket check, `GetInstanceFromIdentifier` and the `Instance %s not found` refusal - each pinned as a generator source anchor, so a change upstream fails generation rather than silently changing behaviour. The setters' NaN guard runs before the address branch, so both forms refuse the same inputs at the same boundary. `msg.url(String)` failed its own universal descriptor for a separate and more general reason: `selectUniversalRoutes` derived a route's accepted arity from its primary parameter list alone, and `msg.url`'s one- and three-argument forms live only in the pinned IR's overload tokens, so the descriptor declared `0..0` and refused every argument before a backend saw it. Arity is now the union of the primary list and every declared overload, which also corrects `render.render_target`, `vmath.matrix4`, `vmath.matrix4_scale`, `vmath.quat`, `vmath.vector3` and `vmath.vector4`. Evidence is a packaged arm64-macOS engine at Defold `7f0f554` built through the local Extender, with the probe lane extended rather than hand-authored: probe arguments can now be literal address hashes and constructed URLs, a `void` expectation covers a no-result call whose effect a later probe reads back, and a `raises` expectation asserts the negative half of a contract. Against a second game object in the bootstrap collection, all nine addressed shapes execute - `go.get_position` and `go.set_position` in string, hash and url form, `go.set_rotation` in all three - the string and hash writes are read back by value from TypeScript, the url write and the rotation write are witnessed from plain Lua outside the TypeScript boundary, and `go.get_position("/deherm_no_such_instance")` fails closed into TypeScript instead of returning a default transform. The native probe-report invariant was one probe per binding, which is wrong for a route with several implemented call shapes; it now requires the dispositions to cover every binding rather than to equal it. The War Battles camera has not been switched back to direct sampling in this change, so its message workaround is now a choice rather than a limit.

* **Real third-party extension ingestion, and the four silent projection defects it killed**: Two published Defold extensions now ingest end to end from nothing but their own `.script_api` - [xMath](https://github.com/thejustinwalsh/defold-xmath) at `f1f27eff87d66e11521aff310e0522ac6cd7c5d6` (37 members, all projected) and [defold-astar](https://github.com/selimanac/defold-astar) at `1471c5445b0c0376bd23c377e8ef8d84e52b43bf` (16 members, 15 projected). A fixture under `tests/fixtures/defold-extension-ingestion/` resolves both the way Bob does, packing each into a dependency archive whose name reproduces Bob's own `sha1hex(url)-base64url(etag)` cache key, keeping the upstream GitHub top-level directory, and verifying every vendored file against a pinned sha256 before packing; only `ext.manifest` and `.script_api` are vendored, and `extensions.lock.json` lists what was deliberately left out. Executing it confirmed all four defects the ecosystem survey predicted and fixed them: YAML sequence unions (`type: [vector3, vector4]`) are alternations rather than `any` - Defold's own editor joins that sequence with `|`, which settles the question; named Defold value types resolve against `defold-value-layouts.json` instead of rendering `unknown`, with the transparent set *derived* from that generated file so an unprojected transparent type throws at load; nested fields spelled `members:` are read with the editor's own `(or parameters members)` precedence; and, the one that mattered, none of it degrades silently any more. An unprojectable shape is now a `{ kind: "unprojectable", code }` IR node whose member is `disposition: "blocked"`, emitted as `readonly name: never` with a `/** blocked: site=code */` comment and a throwing `never` getter so it cannot reach the bridge at runtime either; `bindings.ir.json` enumerates every blocker with a stable `script:<module>.<member>#<site>` id, `manifest.json` carries the coverage, and `deherm generate` prints the histogram. Ingestion then found three defects nobody predicted, all of them properties of how the ecosystem actually writes these files: `astar.use_zero` declares `parameters:` but no `type: function` and was silently becoming a *value* typed `unknown` - it is now the single blocker in either extension, and `type: function` upstream fixes it; nine of astar's eleven functions spell optionality as a trailing `map_id[optional]` name marker, which is neither `optional: true` nor the editor's leading-bracket form, and was being mangled into `mapIdOptional` while staying required - it is now decoded with the spelling recorded as `nameSpelling` in the IR, while any other bracketed marker blocks; and `DIRECTION_FOUR` was camel-casing to `dIRECTIONFOUR`, a lossy transform that could collide, so SCREAMING_SNAKE members keep their exact spelling as the core SDK already does. A one-entry `returns:` sequence is now one return value rather than a 1-tuple. Separately, discovery no longer answers silence when a resolved dependency ships no `ext.manifest`: it keeps the archive's full entry listing while decompressing only extension files, so Druid-shaped Lua-only libraries - 43 of the 61 most-starred portal assets - are reported by archive, file count, and Lua-module count in the inventory, `deherm extensions`, and `deherm doctor`. defold-astar's licence is unresolved and recorded as three separate facts rather than collapsed: no LICENSE file in the tree and a 404 from GitHub's licence API, an asset-portal claim of "MIT License", and vendored zlib-licensed MicroPather; asking the author to add a LICENSE file would resolve it. This is generation evidence only - both extensions' declarations type-check together with an authored consumer script, and a `@ts-expect-error` proves the blocked member is uncallable - but neither extension has been built by Extender, linked, run, or adopted into War Battles.
* **A scrolling world, a following camera, an explicit scale policy, and the teardown defect that blocked `final`**: `msg.post` from a component's `final()` failed with `Structured Lua call has no captured Defold instance` because `dmEngine::Delete` dispatches `EXTENSION_EVENT_ID_ENGINE_DELETE` *before* it releases the main collection and runs `DeleteCollections`, and the extension's handler detached the captured Lua script instances there; every component `final` afterwards had nothing to bind against. `OnEventExtension` now finalizes only the bootstrap attachment - whose game-object instance the collection teardown is about to free, so it genuinely must happen at that event - and defers `DetachCapturedLuaInstances` to `FinalizeExtension`, which the engine runs after `DeleteCollections` while the Lua state is still alive. Reproduced and then confirmed gone on a packaged arm64-macOS engine driven to a real graceful shutdown by `POST /post/@system/exit` against the engine service, which is the only way to reach `final` without a keyboard.

  On top of that, War Battles moved off its single fixed screen. `main/tutorial-world.tilemap` is 120x90 tiles (1920x1440 px), three screens wide and four tall, generated from a fixed seed by `examples/war-battles-online/tools/generate-world-tilemap.mjs` out of the art the tutorial already ships - the same four ground tiles at their measured frequencies and the same 4x2 prop at its measured density - with the authored 51x49 map copied in verbatim at tile offset 34,20 and `level.go` repositioned so the player spawn, the first tank, and the demonstration shot keep the world coordinates they had. The scale policy is deliberate and integer at every step: the reference display stays 1280x720, and a built-in `camera` component with `orthographic_projection`, `ORTHO_MODE_FIXED` and `orthographic_zoom = 2` yields exactly 640x360 world units of view, because the engine builds the frustum as `window_width / display_scale / zoom`; one world pixel is two logical and four physical pixels on a 2x display whether `high_dpi` is on or off. The rejected alternatives are recorded with it: the tutorial's stretch projection is what made 16 px art read small, lowering `display.width`/`height` would shrink the *window* because Defold's display size is both, and `use_fixed_fit_projection` picks a non-integer zoom for any window that is not an exact multiple. `main/camera.script.ts` reads `orthographic_zoom` back off the active render camera and divides the reference display size by it, so the clamp rectangle cannot drift from the projection; it smooths toward the target exponentially, adds velocity-derived look-ahead capped at 56 px and eased back to zero at rest, clamps inside the world rectangle shrunk by the half view, collapses an axis narrower than the view to its centre, and snaps the view origin to whole world pixels. No third-party extension and no hand-rolled view matrix: Defold 1.14's built-in render script already binds an enabled camera component through `camera.get_cameras()`/`render.set_camera` and draws the `gui` predicate through its own screen-space projection, so the score node needed no change at all.

  The stage exercised the camera and render-context routes it was meant to and found the gap it was meant to find. `camera.get_cameras()` and `camera.get_orthographic_zoom(url)` both execute from a game-object component and report `cameras=1`, `zoom=2.00`. World-space addressing does not: `go.get_position`, `go.set_position` and `go.set_rotation` each declare `String`, `Hash` and `Url` call shapes in `defold-script-value-bindings.json` and list only the current-instance shape as implemented, `msg.url(String)` fails its universal descriptor, and `msg.post` implements only `[String, String]` and `[String, String, Table]` of its eighteen declared shapes. A component still cannot read or write another game object's transform. The camera therefore consumes a `msg.post("/camera#follow", "player_at", {x, y})` report from the player rather than sampling it, which is the shape of the gap, not a fix for it. One unrelated blocker was fixed to get here: the `hash-literal` ttsc plugin reported a content hash but no realpath for an explicitly configured `resourceSymbols` file, so `@ttsc/unplugin` refused every transform generation with `host/realpath-proof-missing` and no War Battles bundle could be built at all.

  Engine stdout on a 16-second packaged run, zero `ERROR` and zero `WARNING` lines: `camera-init:zoom=2.00:view=640x360:cameras=1`, `camera-bounds:x=[8.0,1288.0]:y=[-172.0,908.0]`, the untouched tutorial chain (`rocket-init`, `player-fire`, `rocket-hit`, `score:100`, `rocket-explosion-done`), then the view tracking east through 560 -> 759 -> 947 -> 1125 with 44-53 px of look-ahead before pinning at `clamped=x`, turning north and pinning at `clamped=xy` on 908, and the player stopping on its own bounds at `1592.0:1072.0`. Pixel output is not claimed: nothing in this environment can take a screenshot, and no key event was injected, so `on_input` remains unclaimed for this port.

* **Measured binding-transport overhead**: The project had no measured figure for what the Lua bridge costs, so one was built rather than estimated. `DEHERM_PROFILE` is a CMake option, OFF by default, that turns on generated timing spans at every binding transport boundary; it mirrors Defold's `DM_PROFILE` discipline (`profile.h:112`) but is deliberately independent of `NDEBUG`, because Defold's profiler is unconditionally null in a release build and therefore cannot measure a shipping configuration. Nothing is instrumented by hand: `generate-script-handle-lowering.mjs`, `generate-dmsdk-borrowed-handle-bindings.mjs` and `generate-script-universal-value-bindings.mjs` each emit one uniform span at their dispatcher plus per-route identity and interned contract-shape tables, all inside `#if DEHERM_PROFILE_ENABLED`, so cost is attributable per route, per contract shape and per transport across 407 lua-stack routes over 151 shapes, 82 c-abi-native bindings over 15, and 915 typed-native operations over 45. Samples land in a preallocated 8,192-record single-producer ring of the telemetry decision's exact 32-byte layout under a new `transport span` kind whose `value_a` carries elapsed nanoseconds; a full ring increments `dropped` and never allocates, verified at 10,191,817 drops with no failure. Spans also reach `DM_PROFILE_DYN` wherever a profiler exists to receive them. Compile-out is proved, not asserted: `pnpm test:profile-compile-out` builds the same target twice and reads both artifacts with `nm -C` and `strings`, requiring eleven telemetry markers absent with the switch off and present with it on so the proof cannot pass vacuously (522,696 vs 624,296 bytes). The measurement, on Apple M4 / macOS 26.5.2 / clang 21 / Release, 20k warm-up then best-of-9 x 100k calls, one route per arity shape: the generated lua-stack transport costs **284-292 ns per call over calling the identical Lua function directly**. That decomposes into ~212 ns of `lua_cpcall` - the pinned Lua 5.1 sources compile as C with `LUA_ANSI`, so `LUAI_TRY` is `setjmp` (`luaconf.h:624`), which saves the signal mask on macOS - and **72-80 ns that deherm actually owns**: validation, the profile gate, codecs, scratch marks and stack restoration. `c-abi-native` measured 4.0 ns over a stub provider. Instrumentation itself costs 26-31 ns per span. The run also surfaced a defect nobody had measured: the `typed-native` extern_c C ABI costs **725 ns per call with a backend that does nothing**, because the generated dispatcher value-initialises 53,472 bytes of fixed per-call frame scratch every call - allocation-free by the memory policy's definition, but not cheap, and the policy says nothing about zeroing 52 KiB of stack per dispatch. Boundaries: host-harness figures over stub providers against the pinned Lua 5.1 build, not LuaJIT as the engine ships; the JSI leg is not included, these figures start at the C ABI; and no figure here has been observed inside a running Defold engine. The record format is shaped for the headless in-process harness to consume.
* **Runtime log harvesting into a deduplicated bug pool**: `deherm dev` already wrote every engine, Bob, and dev-loop line to `<project>/.deherm/dev/session.log` and nothing read it; the log is truncated at the start of every session and the packaged transcript survived only as a SHA-256 digest. `REJECTED_DIAGNOSTICS` moved out of the War Battles packaged harness into `packages/cli/src/dev/runtime-diagnostics.mjs`, so the packaged gate, the development loop, and a new harvester share one definition of what counts as a defect; the gate keeps its declaration-order whole-transcript scan while per-line classification walks a specificity order, because `error-severity` matches almost every line once something has already failed. The harvester groups an opening diagnostic with its stack frames, keys entries by a signature normalized free of timestamps, pids, ports, generations, digests, absolute directory prefixes, and line/column offsets, resolves the authored `file:line` a trace names rather than the generated bundle offset, caps stored occurrences per signature while keeping true counts, and pools an unrecognised ERROR line as `unclassified` rather than dropping it. Re-harvesting is idempotent. `deherm bugs` prints the pool, `deherm dev` appends to it as it runs, and the packaged harness harvests its transcript on success and failure without changing the gate outcome. Against the recorded 2026-09-18 session the pool yields four signatures including both defects found by hand: `msg.post` from a component's `final()` failing with `Structured Lua call has no captured Defold instance` at `main/player.script:32`, and a repeated `build-failed` whose recorded trigger is `["README.md", "README.md.tmp.<pid>.<digest>"]`. That second one is fixed here: `createWatchPathFilter` now drops every atomic-write scratch name and the dev session filters documentation-only batches out before requesting a TypeScript or Defold build, so prose edits and already-renamed temp files can no longer inflict a build failure. The pool is behavioural evidence about déherm during runs - not conformance evidence, and no completion-matrix row may be promoted from it.
* **Compile-time Defold resource names**: A literal name passed to a binding is now resolved against the project's own resources instead of failing as a black screen in a packaged engine. Nothing in the lane is an allowlist. The declaration schema is derived from pinned upstream sources: bob's `@ProtoParams(srcClass)`/`@BuilderParams(inExts)` pairs bind an extension to the message its text resources parse as, and a declaration site is a repeated sub-message field whose element carries an identity string field - a non-`(resource)`, non-`(runtime_only)` string named `id` or `name`, or the element's only string field, which is how `key_trigger { action: "fire" }` is recognized without naming input bindings anywhere. Sites sharing a trailing CamelCase word merge, so `components`/`embedded_components` and `instances`/`embedded_instances`/`collection_instances` are single addressable spaces; a site reached through another declaration site is nested and never becomes a namespace, which is what keeps `components[].properties[]` out of the table so `go.set(url, "position")` is never judged against declared script properties. That yields 30 namespaces over 18 resource kinds with zero blockers. A new `resourceNamespace` field on the binding IR's name-shaped parameters is derived from the pinned documentation the same way: the value shape says name or address, the documented noun selects the namespace kind - the parameter identifier alone suffices, prose only when it also pairs the kind with an identity word, which separates `gui.get_node`'s "id of the node" from `gui.new_text_node`'s "node text" - and the module's own resource or a sibling address parameter selects the resource. A namespace a declaring route can extend at runtime is excluded by the API's own evidence: `gui.new_texture` introduces a texture id, so `gui:texture` is open and `gui.set_texture` resolves nothing. 24 parameters resolve, 92 are addresses, 139 carry explicit unresolved reasons. `deherm generate` now writes `.deherm/generated/resource-symbols.json` - declared names with source lines, game-object component bindings, collection instances, and each component's attachment, found by the single resource referencing its proxy path - and the ttsc plugin resolves literals against it in the same checker position that lowers hash literals. `gui.getNode` resolves against the one `.gui` scene whose `script` names the component's proxy; `msg.post("#c")` within the owning game object and `"/i"` within its collection; a sprite animation against the atlas bound to the addressed component. The fail-open boundary is the design, not a caveat: no table, no attachment, no literal, a socket-qualified or bare relative address, or an addressed component with no single bound resource all produce silence, and a fixture whose names are computed, templated, or read from state compiles untouched. Findings still ride the linked-plugin apply channel rather than `ast.Diagnostic` values, no language-service completion exists yet, and the two new generators are `--check`-deterministic but not yet in the script clean-room graph.
* **Declarative operator console**: Rebuilt `deherm dev`'s TUI from 492 lines of static `ui.text` in a fixed grid into TSX components over `@rezi-ui/jsx`, loaded through an esbuild module hook so the published package keeps its single-step install. Every panel now wraps one focusable Rezi widget, which makes the focus ring, Tab/Shift-Tab traversal, click-to-focus, wheel scrolling, table row selection, and the draggable edit-loop/targets divider the framework's rather than hand-written. Overlays sit on a real layer stack and `Escape` pops exactly one. `keymap.mjs` is the single source of truth: the footer, the fuzzy command palette, and the `?` help overlay are projections of the same table that registers the bindings, and a key the runtime routes rather than the console is declared with its router instead of a handler, so help cannot advertise a binding that does not exist. Rezi's chord trie holds one binding per sequence and falls through when a `when` guard rejects, so panel-scoped keys like `up` scroll the log panel only while it holds focus and otherwise reach the focused table's row navigation. The five keys that previously fell through to `${intent.type} panel is staged but not implemented` are gone: Targets is a table of generation, fingerprint, phase, and telemetry with drill-in; Generations is the build timeline with bytes, module delta, duration, and activation outcome; the palette and help are generated from the keymap. Log and table selection copy over OSC 52 through the backend's raw-write marker so copy works across SSH, with a local `pbcopy`/`clip`/`wl-copy`/`xclip` fallback and no success reported unless a transport accepted it; log selection is the one deliberately imperative view, because `LogsConsole` has no selection model, and it keeps windowing in a `VirtualList` while hand-writing only the caret arithmetic and highlighted rows. Instances deliberately ships a "requires runtime instance channel" empty state rather than inferred rows: the engine's 1 Hz `DEHERM_EVENT telemetry` carries counts, never identities, and adding identities is a protocol change owned elsewhere. Fixed a real defect found on the way: `formatBytes` chose its unit from the signed value, so a megabyte-scale bundle shrink printed as a raw byte count. Evidence is deterministic renderer and lifecycle tests at 80x24, 120x30, and 150x48 plus a seeded fuzz over the selection caret; no PTY run was recorded, so mouse reporting, OSC 52 acceptance, and divider dragging remain unobserved on a real terminal.
* **Headless in-process Defold conformance**: Binding conformance now has a real-engine instrument. `native/headless_conformance_driver.cpp` links the déherm extension against the pinned Defold SDK archives with the null graphics/sound/hid/platform backends that Bob's `headless` variant selects, owns `main` and `dmExportedSymbols`, and steps `dmEngineCreate`/`dmEngineUpdate`/`dmEngineDestroy` per case with its own tick budget - the pattern Defold's own `engine/src/test/test_engine.cpp` uses, with each case selected by `--config=bootstrap.main_collection=...` and each verdict returned through `sys.exit` and `dmEngineGetResult`. Everything above the driver is generated from the pinned IR by `scripts/generate-headless-conformance.mjs`: the canonical lowering plan's 926 script routes intern to 82 contracts, and the generator emits one minimal collection, game object, collection proxy and Lua fixture plus one TypeScript module per *contract*, never per route. Three properties are selected by the contract record itself - `result-arity` always, `scratch-reuse` when the scratch token is `caller-owned-bounded-reentrant-scratch`, and `error-model` when the error token is `status-return-and-target-exception`. Against Defold `7f0f554` on arm64 macOS the harness observed 15 contracts, faulted on 1, mismatched on 0, and recorded 66 as unreachable with machine-readable blockers; 27 routes ran, yielding 13 `result-arity:observed`, 13 `result-arity:observed-as-target-exception`, 26 `scratch-reuse:observed` and 16 `error-model:observed`. A refused synthesized argument is recorded as a target exception, which is evidence the error model holds rather than a conformance failure. The run found a genuine engine defect that no host harness could: `script:b2d.get_world` segfaults inside `dmGameSystem::B2D_GetWorld` when reached from a collection with no physics world through the generated captured-Lua handle router, and the driver resumes its remaining cases after the fault rather than losing them. The unreachable set is itself the deliverable: 34 contracts/402 routes need a physics handle fixture (`b2Body`, `b2World`, `b2Joint`, `b2Shape`, `b2Chain`, `btRigidBody`, `btCollisionObject`, `btTypedConstraint`, `btDiscreteDynamicsWorld`), 19 contracts/124 routes need a GUI scene, render script, window or network fixture, 10 contracts are destructive under the shared execution policy, and 5 need multi-result shape modelling. This is runtime evidence only; it promotes no generation, compilation or linkage claim, and claims nothing for a contract recorded as unreachable, blocked or faulted. The `*.script.ts` / `*.gui.ts` component-proxy transport remains a separate, unclaimed lane.
* **War Battles is the tutorial again, and two component-provider defects fell out of it**: `examples/war-battles-online/defold` no longer draws its game as 264 GUI box nodes over a hidden tilemap. It is now a port of the Defold War Battles tutorial built from ordinary game objects - a tilemap level, a player with a sprite and a rocket factory, `rocket.go`/`tank.go` with kinematic collision groups `rockets`/`tanks`, and one GUI score text node - authored as `main/player.script.ts`, `main/rocket.script.ts`, and `main/ui.gui.ts`. The presentation mockup is retained unbuilt under `defold/reference/`. Attaching the first real game-object component to a packaged engine exposed two defects in the native provider, both fixed: `component_hermes_backend.cpp` read editor properties with `lua_rawget` even though Defold hands a component a userdata `self` whose metatable resolves declared properties, which missed every property and crashed LuaJIT; and generated current-instance thunks (`go.get_position`, `go.set_position`, `go.set_rotation`) resolved against a game-object context that only the legacy bootstrap attachment ever pushed, so every such call from a component failed closed with `No active game-object context`. `active_game_object_context.hpp` now carries an installable `CurrentInstanceApi`, `extension.cpp` installs a resolver that borrows the game object Defold is currently dispatching, and the component backend publishes it for the duration of a game-object dispatch. A pinned-Extender arm64-macOS engine then ran the whole tutorial loop with no rejected diagnostic: GUI node resolution, `go.get_position`, `factory.create` carrying a typed `dir` vector3 into the spawned component, `collision_response` across the two groups, `go.delete` of the reported `other_id`, a cross-context `add_score` message, the once-forward explosion and its `animation_done`, and 179.9 px of `go.set_position` movement across frames. No screenshot was taken, so pixel output is not claimed; no key event was injected, so `on_input` is not claimed for this port.

* **Transparent Defold value records on the typed-native transport**: The Static Hermes transport no longer rejects every route that mentions a Defold value. A new generator derives the fixed layouts of `vector3`, `vector4`, `quaternion`, `matrix4`, `hash`, and `url` from the pinned dmSDK headers - tuple arity, `Always size of 4 float32`, `Implemented as 4 x Vector4`, `Column major`, the `dmhash_t` typedef chain, and the four 64-bit `dmMessage::URL` fields - and classifies the thirteen remaining engine-owned value names as opaque with machine-readable reasons; an unclassified name fails generation. The typed frame gained caller-owned input float and URL arenas, generated `push_matrix4`/`push_url` entry points, bounds-checked element and URL-lane readers, and `DehermStaticMatrix4`/`DehermStaticUrl` on the sound-typed side, all sized from the layout report rather than literals. The canonical plan's typed-native gate became structural - no Lua closure, no retained Lua/engine handle, and every Defold value type transparent - which grew `runtimes.hermes.typedNativeShare` from 138 to 325 of the 913 routes the runtime reaches; blocked routes now carry exact `shape-kind:` and `value-type:` blockers. Thirteen of the fifteen War Battles APIs are now typed-native, `gui.get_node`/`gui.set_text` remaining blocked on `value-type:node`. `defold-hermes-static-runner` compiles, links, and round-trips a column-major Matrix4, a four-lane URL, an exact `dmhash_t`, and a float32 Vector3 with exact checksums; this is transport harness evidence only, not packaged Defold conformance for the 325 routes.
* **Generated script recording engine**: Added a generated null/observer Defold that replaces the engine under the real `ScriptBridgeApi` seam. One generator emits an interned route/shape/contract table, a provider that asserts each incoming call against its declared contract and synthesises a declared-shape result, a driver that replays every route through the real binding stack, a JavaScript driver for the JSI transport, and a contract-derived expected trace; there is no hand-authored per-route code. All 915 callable routes run over three transports - 865 on `jsi` through a real Hermes runtime and the real generated JSI bridge, 890 on `direct-memory` through the exported universal wire, 861 on `typed-native` through the Static Hermes frame - with zero contract violations, zero expectation divergences, and zero cross-transport divergences. `lua-stack` is declared undrivable because Lua sits below the recorded seam. Every skip carries a machine-readable reason: 23 callback-argument routes, two blocked closure-result routes, 25 `jsi` routes with no recorded handle source (the generated handle fixpoint reaches 14 of 15 kinds), and 29 `typed-native` routes blocked by the Static frame's missing URL/Matrix4 argument pushes. The first run found that two empty result tables sharing the scratch cursor alias to one address and are rejected by the universal encoder's pointer-identity cycle rule; the provider now claims a slot per table. Trace records are keyed by the canonical lowering plan's interned contract index so a later real-engine differential can diff per contract. This is contract-agreement evidence inside deherm only - explicitly not Defold engine conformance, and no completion-matrix row may be promoted from it.
* **Idiomatic Defold global namespace**: The deterministic script SDK projection now publishes Defold's raw global Lua functions as `defold.hash`, `defold.hashToHex`, and `defold.pprint` instead of the source-file-derived `builtins` namespace. Raw Lua module paths, stable IDs, runtime lookups, and historical evidence retain `builtins`; generated public types, modules, probes, package smoke consumers, and War Battles fixtures use `defold`. Generation fails on projected root collisions, and no pre-release compatibility alias is retained.
* **Fingerprint-bound HMR acknowledgement**: The development bundle's exact SHA-256 now crosses the runtime boundary. A native candidate reports a structured activation event only after evaluation, initialization, and atomic commit; rejection has a distinct event. The CLI parses engine output, joins the fingerprint to the exact compiler generation, ignores superseded acknowledgements, and keeps the TUI in `awaiting-activation` after transport HTTP 200. The target panel shows compiler generation, Defold resource generation, Hermes runtime id, and fingerprint prefix. Reducer/parser/controller/TUI tests and all native/HTML5 extension syntax checks pass; a fresh packaged War Battles HMR run remains the runtime observation gate.
* **Class-authored TypeScript components**: Added `component(Class)` beside the existing `defineComponent({...})` form. The TypeScript 7 AST generator validates context-specific base classes, zero-argument construction, static literal editor properties, and prototype lifecycle methods, then lowers both forms into the identical manifest, specialization, registry, Lua proxy, and native runtime ABI. The SDK creates one class instance per attachment, copies editor properties before `init`, binds lifecycle `this`, stores the instance non-enumerably, and retains its fields while hot reload rebinds new prototype methods. Focused generated, type-check, executable adapter/HMR, registry-bundle, War fixture, and project freshness checks pass; packaged-engine class authoring remains a separate observation gate.
* **Variable results and rooted Lua closures**: Generated universal operations now carry minimum/maximum Lua result arity derived from trailing optional returns. Dynamic Hermes roots returned Lua functions as owning JSI host functions and proves `socket.newtry`, `socket.protect`, callback multi-results, tagged protected errors, finalizer capture, context restoration, and teardown under the real Hermes/Lua and sanitizer harnesses. Native/browser SDK tuple boundaries pad omitted trailing results, while browser, raw Lua-stack transport, and Static Hermes retain the exact `higher-order-lua-closure-result-transport-unavailable` blocker for the two closure-return routes.
* **Sound-typed Static Hermes universal frame**: Replaced the raw pointer-only universal declaration with a generated strict typed value model and a reentrant fixed-capacity native frame materializer. The Static Hermes runner executes a recursive scalar/string/array/record/hash-handle/vector graph end to end. The canonical plan emits 138 routes whose complete recursive shapes exclude callbacks, handles, and Defold values; broader handle/Defold-value routes remain gated even though representative native frame codecs pass. The warmed native path remains allocation-free. Separating Static scratch bounds from the portable ABI reduced its configurable default TLS reserve from eight 64-KiB-string frames (1,522,176 bytes) to four 16-KiB-string frames (367,872 bytes), with bounded exhaustion and reentrancy still tested.
* **Cross-target release-family emission**: Updated the keyed release emitter and its gates to consume the newly authorized Static Hermes and browser/Wasm rows instead of preserving their obsolete zero-route expectation. Reachable family registries, target gates, and CMake source lists now compile for Dynamic Hermes, Static Hermes, and browser/Wasm; packaged Static/HTML5 dead-code retention remains a separate link-and-artifact proof.
* **Universal script composition and browser callback provider**: Removed the accounting/projection/universal generation cycle by extracting one dependency-free selector, so a blank clean room regenerates all 926 routes in a single forward pass. All 915 callable non-intrinsic routes retain a bounded recursive fallback, specialized lanes compose as at most one preferred overlay, and competing specialized lanes now fail closed even when a fallback exists. At this checkpoint Dynamic Hermes, Lua, and the HTML5 direct-memory provider emitted the same 911 profile-available routes. A fixed-capacity generational browser trampoline promoted the 23 lifecycle-ledger routes that are retained engine callbacks; native and JavaScript harnesses cover direct memory, nested invocation, errors, stale tokens, cleanup, and zero warmed C++ allocations. The later variable-result/rooted-closure entry above promotes `socket.newtry`/`socket.protect` on Dynamic Hermes only; browser and raw Lua-stack transport remain at 911. Packaged HTML5 execution of the wider provider remains an explicit gate. The separate Static Hermes entry records the generated typed value marshaller and its narrower 138-route promotion.
* **Callback teardown and borrowed-handle hardening**: Dynamic callback roots now invalidate their JSI functions before Hermes destruction, so retained Lua closures fail closed and collect safely afterward. Callback userdata arguments use a fixed borrowed-root ledger with deterministic success/error cleanup; browser wrappers are non-owning, Wasm token parts normalize to u32, and Lua dispatch checks the generated registry-eligibility ledger. The browser trampoline resolves Matrix4/URL arguments and results through the caller's arenas, rewinds result allocations after consumption, and proves full descriptor-pool exhaustion/reuse without warmed C++ allocation. Shared structured-table lowering rejects non-finite numeric keys before unprotected `lua_settable`, and PUC Lua stack capacity is checked before universal calls.
* **Universal dmSDK recipes**: Generated deterministic usage-materialization recipes for all 1,361 dmSDK runtime declarations across direct functions, templates, constructors, members, and destructors. All declarations have C ABI, Dynamic Hermes, Static Hermes, browser direct-memory, and TypeScript projections; 148 prefer specialized lanes and 1,213 retain the generic materializer. A mixed pinned-header selection compiles, links, executes, and completes 100,000 warmed calls with zero observed C++ allocations, without claiming that every engine symbol has linked or run.
* **Project dmSDK materialization**: Added `deherm materialize-dmsdk`, which consumes a versioned usage document and writes a deterministic usage-pruned native provider plus a hash-bound report. Its check mode detects stale generated outputs; the project manifest now ships the complete script/dmSDK universal catalogs and reports target lowering matrices instead of the obsolete pre-universal implemented/pending counts.
* **Private Lua bridge namespace**: Moved bootstrap and generated component-proxy calls from the public-looking `defold_hermes` global to `_deherm_`. The private module name is generated into the native capability contract and shared by bootstrap registration, component-provider installation, proxy manifests, tests, and examples; `deherm` remains reserved for a future intentional Lua compatibility API.
* **Workspace/public package identity split**: Renamed every private pnpm workspace package to `@deherm/*`, retained `@ts-defold/deherm` as the single npm-facing artifact, mapped internal identities to canonical raw sources in the root TypeScript configuration, and reserved `@deherm/project` for the generated context-filtered consumer SDK.
* **Caller-owned dmSDK scalar outputs**: Mechanically partitioned all 79 `scratch-out-parameters` declarations without symbol allowlists, generated seven scalar/enum output adapters across C ABI, Dynamic Hermes, Static Hermes, browser direct memory, and TypeScript, and retained row-local blockers for the other 72. Pinned headers compile every promoted signature; fake-provider ASan/UBSan, failure-zeroing, reentrancy, and 100,000-call warmed tests pass with zero observed generated-glue allocations. Real dmSDK linkage, browser exports, and packaged-engine execution remain explicitly unverified.
* **Context-typed TypeScript resources**: Added one generated suffix/context contract for `*.script.ts`→`.script`, `*.gui.ts`→`.gui_script`, `*.render.ts`→`.render_script`, and ordinary shared `*.ts`. The proxy generator records context/lifecycle/teardown metadata, reconciles only ownership-matching stale proxies, rejects unsafe overwrites and suffix collisions, validates GUI/render callback tables against pinned Defold source, and rejects render-only `final`/`onInput` hooks that Defold never calls. Project generation projects all 926 script routes into four context-filtered SDK entrypoints and TypeScript project references; `deherm typecheck` compiles all four and negative fixtures reject GUI/render/cross-suffix and raw-SDK alias bypasses. The remaining 347 unresolved context contracts are explicitly provisional. A generated native capability gate now installs all six proxy Lua names and deterministically rejects them, with zero executable methods claimed until component registration, pooled instances, reentrant context selection, property codecs, and bounded message/input codecs exist.
* **Profile-safe borrowed-handle router**: Generated all 407 selected handle descriptors with a 343-route adapter union partitioned by six exact source-derived engine profiles (8–318 executable routes per profile). Runtime initialization now validates the full schema/revision/profile/capability/count/route-set/catalog handshake before Lua lookup; there is no default profile. Lua 5.1 protected trampolines cover traversal, instance changes, calls, conversion/rooting, and restoration, with seven injected-error recovery stages, sanitizer coverage, and warmed allocation checks. Dynamic-Hermes host objects expose readonly generational identity, semantic kind, enumeration, and idempotent disposal. Evidence remains zero for packaged-engine, promoted JSI, Static-Hermes, and browser execution.
* **Private dmSDK C-string/value staging**: Mechanically selected 20 declarations, generated 14 exact C-string/value candidate adapters, and recorded six semantic blockers for restricted string domains, borrowed reverse-hash lifetime, and profiler logical context. The candidates remain private, unregistered, and unlinked from production while compile, Release, sanitizer, overlap, fixed-width ABI, range, clean-room, and canonical-plan-join tests validate the staging path without claiming public runtime support.
* **Canonical cross-target lowering plan**: Added one data-oriented compiler plan for all 2,287 API units and all 11,435 TypeScript, dynamic-Hermes, Static-Hermes, Lua-stack, and browser/Wasm dispositions. Repeated effect contracts, marshalling programs, and token/blocker sets are interned without collapsing dmSDK's composite ownership/lifetime/thread data; identity-selected semantic policies are forbidden. A separate final-build planner now tree-shakes exact reachable/profile-compatible units without regenerating the API catalog when game code changes and is joined to real bundler usage by `build:release-plan`. Content-keyed ensure skips unchanged multi-megabyte output reads and writes, while read-only repository and project verification commands recompute the plan and validate it against declared inputs, installed package authority, generated manifest, and lock.
* **Unified binding projection**: Added deterministic compositional projection IR for all 926 script routes and all 1,361 dmSDK runtime declarations, with generation kept separate from compile/link/runtime evidence. Source-derived profile parsing now infers legacy/v3 and Bullet availability from Defold manifests, covers all 455 routes in the audited registration groups, and proves two documented v3 functions are commented out of Lua registration. Every dmSDK declaration is mechanically projected with zero gaps; executable lowering is tracked separately as 45 generated adapters, 96 policy-gated adapters, and 1,220 pending lowerings. Isolated clean-room regeneration owns 67 script plus 61 dmSDK artifacts.
* **Bounded dmSDK buffer hashes**: Generated exact byte-span C ABIs and dispatch for `dmHashBuffer32`/`dmHashBuffer64`, including embedded-NUL behavior, packaged-library parity, C11 headers, invalid-bound rejection, and 100,000 warmed calls with zero observed C++ `operator new`; the arena ledger is now 12/79 generated and 67 explicitly blocked, with 1,316 dmSDK declarations remaining.
* **Borrowed-handle semantic correction**: Split two child-index destruction routes from five self-underlying invalidators and generated `hostHandleEffect: preserve` for both. Defold keeps userdata observable so parent bodies remain usable and `is_valid` can report false after self destruction. The 206 Box2D rows are also recorded as a v2/v3 documentation union requiring app-manifest/profile-aware generation before executable promotion.
* **Fixed-record runtime canary**: Installed generated captured-Lua and JSI decoding for `image.get_astc_header`, `b2d.get_version`, and `bullet3d.get_version` with caller-owned table/string scratch, exact field schemas, malformed-result rejection, and zero warmed C++ allocations. They remain outside central executable accounting until the schema/accounting dependency cycle is removed and dynamic-Hermes E2E is observed.
* **Captured-Lua route promotion**: Installed 16 generated game-object-context value-tail and eight finite overload routes in the shared adapter, proved every executable descriptor through pinned Lua 5.1, reentrancy/stale/exhaustion behavior, dynamic Hermes JSI calls, sanitizers, and a successful local Bob/Extender bundle; accounting is now 286 executable, three separate-module, and 637 pending routes. Adversarial review reproduced that four GUI and four render calls require different Defold instance kinds; generation now records those contexts and dispatch fails closed before the backend.
* **Lua-table generator ledger**: Partitioned all 148 pending Lua-table routes into three exact flat-record candidates and 145 deterministic blockers, then source-pinned the copied-value and opaque/nested blocker buckets.
* **Bounded dmSDK spans**: Added four fixed digests, two strict Base64 calls, two ASTC probes, and two XTEA calls with capacity/bounds checks, packaged-SDK behavior gates, C-ABI regressions, and clean-room ownership; 1,318 dmSDK declarations remain without generated adapters.
* **Generator ownership and adapter integration**: Central registries now drive both script and dmSDK lowering pipelines. A clean room reconstructs 49 script artifacts for all 926 routes and 27 dmSDK artifacts for all 1,361 runtime declarations from pinned inputs, rejecting unowned generated files and comparing every output byte-for-byte. The generated JSI installer and SDK barrel now expose 26 scalar plus seven enum-value dmSDK adapters; the host runner links explicit test-only stubs, while extension syntax compiles the real wrappers against the packaged SDK. This is compilation/linkage evidence, not packaged-engine observation.
* **URL and callback transport foundations**: Promoted 70 URL/address routes to generated dynamic-Hermes transport using exact four-lane `dmMessage::URL` storage, explicit JS branding, context-preserving string/hash shorthand, a reentrant fixed-capacity arena, and real Lua 5.1 adapter tests with zero warmed C++ allocations. Separately generated source-pinned lifecycle metadata for all 25 callback routes: 23 fit the fixed-capacity owner/thread/generation registry and two higher-order closures remain blocked. No callback route is counted executable before its engine adapter and payload codec exist.
* **Evidence-boundary hardening**: Reproduced that standalone accounting accepted semantically tampered URL rows and that dynamic-value generation accepted stale classifier revision/hash metadata. Accounting now regenerates canonical URL semantics from pinned inputs before promotion; the dynamic generator validates revisions, hashes, counts, unique identities, and source metadata. Generated inventory documents no longer embed mutable runtime counts and instead point to SHA-bound accounting ledgers.
* **Generated ambiguity tails**: The initial shape-only partition classified 24 of the remaining 26 Defold-value routes as captured-Lua candidates and two as codec blockers. A later exact-instance audit narrowed that executable set to 16 and generated eight GUI/render context blockers. The 20-route overload-dispatch tail partitions into eight finite `vmath` call-shape candidates and 12 structured/handle/context blockers. Both produce bounded static dispatch tables and fail closed without an injected backend. The dmSDK named-scalar tranche was also reviewed: all 21 declarations require engine, thread/TLS, or profiler-property provenance capabilities and therefore export no callable surface.
* **Generated fixed tuples and Matrix4**: Added generated lowering for 24 fixed multi-result routes and 14 Matrix4 `vmath` routes. Tuple lowering validates exact Lua stack-delta arity, positional codecs, nil positions, borrowed userdata, and copy-before-stack-restore; eight routes are publicly reachable while 16 Bullet routes remain blocked on generated handle producers. Matrix4 uses an aligned 16-float column-major frame arena with generation/index validation, nested rewind, deterministic exhaustion, and no heap fallback. Native pinned-Lua, direct math, zero-warmed-allocation, ASan/UBSan, and extension syntax proofs pass. Accounting is now 192 generated stable-ID routes, three separate timer routes, and 731 pending; only the prior 32-route packaged-engine observation remains runtime-verified.
* **Static Hermes generated script slice**: Generated strict/sound Static Hermes wrappers for three scalar-result `vmath` routes and seven concrete shapes through the same stable-ID value dispatcher. Successful calls compile, link, and execute through Static Hermes with 30,000 representative native calls and zero observed C++ `new` calls. Structured aggregate returns remain explicitly excluded until generated out-storage/arena wrappers are available.
* **Exact URL codec foundation**: Added a deterministic classifier for all 70 pending URL/address routes and 73 URL-bearing parameters plus a fixed-capacity `ScriptUrlArena`. The codec retains the pinned 32-byte `dmMessage::URL` layout—socket, reserved, path, and fragment—without JavaScript-number narrowing, rejects stale/cross-runtime/cross-arena tokens, preserves string/hash shorthand for Defold context resolution, and measures zero warmed allocations. Routes remain planned until JSI, Static Hermes, browser, Lua push/copy, and packaged-engine probe routing are generated.
* **Generated fixed-POD vmath family**: Added one source-pinned selector for 11 pure `vmath` routes and 14 exact call shapes using the existing inline Number/Vector3/Vector4/Quaternion ABI. The generator preserves the two real semantic exceptions—`euler_to_quat` accepts only a vector or exactly three numbers, and `project` rejects a zero-length target—plus Defold NaN rejection, float32 narrowing, and no implicit normalization. Stable-ID lookup now uses allocation-free binary search instead of a growing linear scan. Native focused tests use Defold's exact pinned trig lookup table; packaged Defold already supplies that symbol. A fresh arm64 macOS Defold 1.14.0 bundle executed assertion-bearing probes for all 11 new routes through dynamic Hermes; a repository-confined transcript and SHA-bound observation now verify 32 total instrumented routes. HTML5 structured-value codecs remain fail-closed.
* **Generated pending-family ledgers**: Added deterministic, source-validated classifiers for all 415 pending borrowed-handle routes and all 185 pending Lua-table/fixed-tuple routes. Handles partition exactly into 367 checked consumers, 33 producers, seven invalidators, and eight declaration-only resource tokens, with 17 pinned Defold source hashes and ownership/context policies. Tables and tuples partition into 81 mechanically generatable fixed records/tuples and 104 routes requiring explicit bounds, ownership, binary, tagged-union, sequence, map, or recursive schemas. These are implementation queues, not executable or runtime evidence.
* **Expanded clean-room regeneration**: The isolated generator gate now reconstructs 28 byte-identical artifacts for all 926 script routes, including the handle and table/tuple ledgers. Current accounting is 154 generated stable-ID routes, three separate timer routes, and 769 pending. The SHA-bound runtime observation is part of the pinned evidence input; the current aggregate input fingerprint is `0f36efab748ae9ab047f7ad68046b379387ff05f0af48f25f0c7485780e08a23`.
* **Generated GUI setter family**: One source-pinned family selector now derives 39 `gui.set_*` routes and 55 call shapes from the canonical IR plus Defold's GUI registration table; `gui.set_text` remains the single explicit Lua 5.1 `%.14g` semantic exception. Script accounting is now 143 generated stable-ID routes, three separate timer routes, and 780 pending. Every one of the 53 value routes has a deterministic probe disposition, while the 39 new setters remain planned-only with no target-evidence promotion.
* **Initial clean-room script regeneration**: Added a temporary-tree gate that copies only pinned generator inputs and exact cited Defold evidence, regenerates the full 926-route script surface, rejects unexpected generated artifacts, validates inventory-to-IR-to-SDK stable IDs and accounting, and initially byte-compared 25 committed outputs. Later entries record the expanded artifact set and current fingerprint.
* **Post-generator target proofs**: A fresh native local-Extender bundle compiled, linked, executed dynamic Hermes, ran all currently instrumented scalar/value calls, finalized, and exited zero. A fresh wasm-web bundle executed in headless Chrome with the browser host, scalar calls, exact 64-bit hash, and update lifecycle; bundle fingerprint `f7000de0a6cdc4ce92c425d49ceca1954abd79ac906963b81b3de21b33deaf35` matched native and web packaged resources. A verifier regression that confused planned-only scenarios with emitted probes was reproduced, fixed with an exhaustive disposition validator, and covered by negative tests.
* **Structured bridge sanitizer gate**: Added a repository-owned Debug harness for Defold's host-supplied logging symbol and a reproducible `test:script-value-sanitize` command. Fresh macOS ASan/UBSan execution passed the generated structured-value and flat-C-ABI tests, including reentrant context restoration, stale-handle rejection, bounded transfer, exact hashes, and zero warmed C++ allocations. Apple's ASan reports LeakSanitizer as unsupported, so full leak evidence remains a separate Linux/device and ownership-counter gate.
* **Fresh HTML5 target proof**: Served the newly bundled game on scoped loopback ports and reran the checked-in CDP verifier in dedicated headless Chrome. It exited zero with `engineStarted`, browser-host registration, the generated script bridge, `DmSdkScalar`/`ExampleMath`/`Timer`, a 640×427 canvas, `init:browser`, `module:42`, update, scalar probes, and exact 64-bit hash execution. Bundle fingerprint `ccb2463eefcfe05fc8ebb083e57b37e4af1e60662a77d538deadd980c0aaf715` matched the source and Bob-staged `.dehermc`; probe fingerprint `30e0fc542abf0832c1c44defec7483412b4ff8076177de1a981ec1347dbc0c11` matched the executed probe set. The initial restricted-sandbox run failed only with loopback `EPERM`; the approved identical run passed. Scoped Chrome/server processes and profile were removed. Structured value, address, message, factory-property, and GUI-node codecs remain guarded and unpromoted.
* **Evidence-integrity hardening**: Adversarial review found and local inspection reproduced that value probes could select declared-but-unimplemented overloads and runtime observations were not bound to the current probe-set fingerprint. Probe generation now requires `implementedCallShapes`; runtime promotion requires the current input marker, exact-line or explicitly declared prefix semantics, repository-confined SHA-bound artifacts, deterministic code-point ordering, and non-empty compile/link evidence.
* **Lifecycle safety**: Pinned engine shutdown ordering proved that extension finalization previously ran after Defold freed collections. The bootstrap now has explicit Lua detach, engine-delete pre-collection finalization, generation invalidation, single-attachment enforcement, and a clean-exit evidence mode. TypeScript updates are driven by the bootstrap script's engine-supplied `dt` inside the active game-object scope instead of extension wall-clock time.
* **Browser bridge hardening**: Mirrored the native 16-frame reentrancy bound for the Emscripten stack bridge, removed BigInt literal syntax from the linked library for older parsers, expanded HTML5 syntax checks to generated value/registry units under `-fno-exceptions -fno-rtti`, and retained explicit target-status work for non-hash Defold value codecs.
* **Five-route source boundary**: Verified from pinned Defold sources that `msg.post`, `factory.create`, and `go.delete` have public dmSDK terminal paths, while exact `gui.get_node` and `gui.set_text` require a generated Lua fallback or upstream public GUI APIs. The War Battles harness records 16 fail-closed semantic assertions and promotes none until a real packaged-engine run observes them.

## 2026-09-17

* **Generated vmath Wave 1**: Added source-pinned deterministic generation for five fixed-layout `vmath` routes, caller-owned float32 POD ABI cells, branded TypeScript values, exact native/Hermes tests, zero C++ allocations across 500,000 native dispatches, and assertion-bearing real-engine probes for all five routes in the packaged Defold 1.14.0 application; Static Hermes and browser value codecs remain open.
* **Generated hash Wave 2**: Added the pinned `builtins.hash` route with an exact uint64 POD payload and branded JavaScript `bigint`, native/browser codecs, a 500,000-cycle proof that generated dispatch requests no C++ allocations after prewarming, Hermes JSI execution, and an assertion-bearing packaged Defold probe. Defold debug engines intentionally allocate once when `dmHashBuffer64` registers each previously unseen short string for reverse lookup, matching Lua `hash()`; the War Battles executable gap fell from 9 to 8 bindings.
* **GO context wave specification**: Added a source-validated machine-readable generator/proof matrix for `go.get_position`, `go.set_position`, and `go.set_rotation`; it requires a reentrant per-component context stack, shared string/hash/URL resolver, generational async re-resolution, and 13 parity/safety/allocation scenarios before any executable claim.
* **GO current-instance proof**: Generated and executed the current-instance forms of `go.get_position`, `go.set_position`, and `go.set_rotation` through dynamic Hermes and the packaged Defold 1.14.0 engine. A fixed-capacity thread-local context stack restores nested A→B→A dispatch, rejects stale attachment generations before engine-pointer reads, and performs 500,000 warmed cycles across all nine structured routes with zero generated C++ allocations; addressed string/hash/URL forms remain pending.
* **Declarative operation generator**: Replaced per-binding-ID C++ selection with six finite, source-pinned operation templates for the nine current value/handle/GO routes. Exact template parameters, IR-derived shapes/results, scoped Defold source anchors, hash implementation evidence, and scalar/value numeric-ID collision checks fail closed.
* **Exact API accounting**: Added a deterministic partition of all 926 script APIs: 99 generated stable-ID routes, three separate timer-module routes, and 824 pending routes with structured lowering reasons. A separate matrix gives every executable route a scenario while keeping planned, instrumented, and target-observed evidence distinct.
* **Telemetry protocol decision**: Selected generated protobuf/DDF batches as the native/browser/capture schema, fed by bounded fixed-size producer rings so engine hot paths do not allocate or serialize.
* **Hot reload control plane**: Reproduced Defold's editor-to-engine DDF resource-reload path, remote build-provider behavior, Lua script state semantics, and debug-only constraints; designed a typed bundle resource, transactional Hermes generation swap, editor/direct/browser transports, and a headless-first `deherm dev` controller with a staged Rezi operator console.
* **Native reload rejection/recovery**: A real Defold debug engine now rejects a generation-2 bundle that throws at the start of `init()`, executes another generation-1 update without finalizing it, and subsequently activates and updates valid generation 3. The probe also found and fixed a candidate-runtime/JSError destruction-order crash; rollback of candidate-created native side effects and long-run leak limits remain open.
* **First real Defold API proof**: Bundled and launched the pinned arm64 engine, observed generated stable-ID calls from Hermes through the live Lua state for `bit.tohex` and `sys.get_config_string`, and observed the first TypeScript update callback. The initial apparent bridge failure was a stale `game.arcd`; local Bob builds now always refresh archives and a bounded runtime harness rejects stale evidence.
* **War Battles source map**: Verified that Defold's editor pin is an intentionally empty tutorial starter, selected the current licensed Defold revision plus the completed TSDefold project as separate source authorities, recorded the byte-identical 304-file asset set, inventoried the exact API/message/property demand, and identified `.script.ts`, spawned-property, and `.gui_script.ts` proxy gates before gameplay is ported.
* **Sound Static Hermes runtime**: Compiled and linked a strict typed C ABI unit plus a `-parse-ts -typed -strict` TypeScript lifecycle unit, then executed `init`, `update`, `onMessage`, and `final` through `IHermes::evaluateSHUnit`; retained ordinary untyped AOT only as an explicit compatibility artifact.
* **Static Hermes TypeScript draft PR**: Reproduced that TS2Flow converts function-declaration return types but leaves TypeScript annotations on function expressions, arrows, and class methods; opened draft [`facebook/hermes#2188`](https://github.com/facebook/hermes/pull/2188) with the two-visitor fix and official regression coverage, while leaving generic types and separate TypedLib concerns out of scope. Meta import checks pass; the maintainer CLA remains required.
* **Polyfill contract**: Added a machine-readable React-Native-style compatibility matrix for Hermes intrinsics, Defold-backed host APIs, browser providers, build transforms, optional features, and rejected dynamic/Node facilities; strict releases fail on untyped or missing reachable providers.
* **Universal Lua value registry**: Added fixed-capacity generational roots for long-lived Lua tables, functions, userdata, Defold values, and instances, with bounded deferred release, exact stack restoration, sanitizer coverage, and zero warmed lookup/release allocator calls; hot math values remain outside the registry.
* **Generated execution frontier**: All 926 script wrappers target a stable-ID bridge; 99 routes are executable through generated scalar/value/handle/GO adapters, three timer operations use a separate module, and 824 remain pending with machine-readable reasons. Target behavior stays explicitly unproven until observed.
* **TypeScript components**: Chose authored `*.script.ts` files with generated sibling `.script` proxies as the first attach-to-game-object backend, with pooled generational TypeScript instances and batched lifecycle dispatch; reserved a contract-compatible native component after parity is proven.
* **War Battles product gate**: Sequenced a faithful all-TypeScript War Battles port after full generated API execution, followed by a data-oriented 32-player authoritative multiplayer expansion with richer tanks, weapons, upgrades, effects, UI, bots, and soak-test gates.
* **HTML5 runtime proof**: Pinned and bootstrapped Emscripten 4.0.6, built the `wasm-web` custom engine through local Extender, ran it in headless Chrome with software WebGL, and observed `init:browser`, `module:42`, the TypeScript update lifecycle, 12 scalar Defold APIs, and exact `builtins.hash("my_hash")` across the real flat C ABI/Wasm bridge.
* **HTML5 profiles**: Documented the browser-host default and an opt-in Static Hermes extension profile that emits an exported C unit and links it with Defold into one Wasm module, gated by workload benchmarks and compatibility.
* **Local Extender proof**: Pinned Extender at `2a17252`, generated the installed Xcode 26.5/clang 21 environment, and made `bob:local:build`/`bob:local:bundle` one-command standalone macOS workflows without Google Cloud authentication.
* **Defold runtime proof**: Linked `_defold_hermes`, bundled JavaScript with `custom_resources`, launched the arm64 app, and observed the embedded-Hermes transcript `init:hermes` and `module:42`.
* **Archive hygiene**: Removed Hermes's unreferenced compiler-side `zip.c.o` from the Defold-facing archive under a fail-closed reference check; the rebuilt custom engine links without duplicate `zip_*` symbols and retains the runtime transcript.
* **Executable API audit**: Separated complete generated declarations from runtime truth: Lua-shaped SDK 0/926 wired (three timer operations proven through a separate module) and dmSDK 0/1361 TypeScript-callable (26 generated scalar thunks, 25 host behavior-tested).
* **Generator contract**: Made zero-agent, zero-per-symbol-edit generation a product gate; all ambiguity overlays must be versioned, source-validated data and fresh Defold revisions must regenerate from one CLI command.
* **React GUI frontier**: Recommended a real React mutation renderer over a pooled shadow tree and dense commit buffer, Yoga first with Clay/Preact measured alternatives, and mandatory Static Hermes/browser/device conformance before adoption.
* **Extension SDK frontier**: Reserved a post-core-API strict-TypeScript authoring flow that AOT-compiles extension logic with Static Hermes and generates the Defold bootstrap, C ABI, Lua/TypeScript metadata, and browser projection; selected a data-oriented ECS as the proving project.
* **Memory policy**: Assigned allocations to runtime, rooted-object, dispatch, stack, or compile-time lifetimes; required bounded pools, no-fallback arenas, dense hot tables, observable budgets, and scoped sanitizer/allocation evidence.
* **Semantic translation**: Defined provenance-preserving per-position tokens for source names, TypeScript synonyms, overloads, generics, ABI layouts, target lowering, and conformance; recorded reproduced and rejected adversarial-review claims.
* **Math language frontier**: Reserved checker-aware `"use math"` regions and a backend-neutral math IR for `vmath`, xMath, Static Hermes, and TypeGPU, with matching ttsc and VS Code behavior required before implementation.
* **API ground truth**: Selected the exact Defold engine SHA as the version key; matching ref-doc artifacts, packaged dmSDK headers, and resolved project extensions are hashed and may be reused from editor/Bob caches without mixing versions.
* **Generated script SDK**: Generated compiling camelCase TypeScript modules, rich TSDoc, overloads, types, and per-symbol IR for all 926 public script functions and 410 declared types; runtime implementation coverage remains a separate gate.
* **Generated dmSDK SDK**: Expanded the Clang importer to retain record fields, access, and enum values; generated a raw typed surface and ABI-strategy ledger for all 2,140 discovered declarations while explicitly hiding non-public entries.
* **VS Code ownership**: Chose VS Code as the only TypeScript editor; the planned LSP adds Defold project semantics and the DAP combines Hermes CDP with live engine-instance introspection and inline values.
* **Typed addressing**: Added template-literal Defold address types for fragments, absolute paths, socket-qualified paths, and shorthands; bare relative ids now require an explicit branded constructor instead of accepting arbitrary strings.
* **API examples**: Added a binding cookbook with a per-symbol state machine and worked scalar, current-instance, callback, URL/hash, engine-handle, and third-party-extension designs for API review.
* **Developer runtime**: Chose a Babel-free ttsc transform pipeline, transactional runtime-generation hot reload, and a shared VS Code/CDP debugger-profiler direction for native Hermes and HTML5.
* **Project IR**: Normalized extension `.script_api` declarations into stable symbol/type/lowering IR; both generated declarations and executable camelCase TypeScript SDK modules now consume it.
* **Editor setup**: Project generation now creates a TypeScript 7 configuration and non-destructive VS Code recommendations/settings, preserving any existing root project/editor files.
* **Project CLI**: Added an npm-installable `defold-hermes` binary with project discovery, extension inventory, project diagnostics, and deterministic TypeScript generation from extension `.script_api` metadata.
* **Extension inputs**: Discover local and Bob-resolved native extensions, public headers, `src`/`commonsrc` implementation files, and native-schema gaps; sanitize credentials and signed parameters from recorded dependency URLs.
* **Package verification**: Packed the package, installed it into a clean npm project, invoked its installed binary against the sample project, and upgraded the archive/YAML parsers to releases with zero reported advisories. The package and CLI were subsequently named `@ts-defold/deherm` and `deherm`.
* **Bob integration**: Reached the public Extender service with a valid extension payload; the build stopped before our compiler invocation because the pinned Defold dev SDK's `r8Cmd` platform schema is newer than the deployed service. A matching local Extender or stable cloud-compatible SDK pin is required for that final boundary.
* **Bob tooling**: Pinned and checksum-verified Bob 1.14.0 at the exact Defold revision, added a local toolchain doctor, and added explicit build/bundle commands guarded by consent before uploading native-extension inputs to a build server.
* **Review hardening**: Corrected browser timer trigger/elapsed parity, bounded and generation-isolated the HTML5 callback pool, removed callback-dispatch handle allocations, made native/browser finalization release roots after exceptions, and generated rollback for partially acquired multi-callback bindings.
* **Developer workflow**: Documented the current source, bytecode, browser, release-planning, and extension-packaging commands; separated them from the future public CLI and identified pinned Bob build/launch as the next tooling boundary.
* **TypeGPU**: Designed a build-time-only TypeGPU shader lane that emits Defold-owned shader/material assets and typed bindings while retaining Bob, glslang, SPIR-V reflection, and target cross-compilation as the authority.
* **Lua callbacks**: Generated the complete `timer.delay` callback path across Hermes JSI, the C ABI, cached Lua thunks, and deterministic one-shot/repeating release, backed by fixed-capacity callback and timer pools.
* **Lua performance**: Measured one million cached primitive calls at roughly 0.18–0.21 microseconds/call and 100,000 callback dispatches at roughly 0.39–0.43 microseconds/call with zero steady-state Lua allocator calls on local arm64 macOS release builds.
* **Sanitizers**: Ran the Lua bridge unit/benchmark and Hermes-to-Lua callback executable under AddressSanitizer plus UndefinedBehaviorSanitizer with no findings.
* **Lua backend**: Added cached generated `timer.cancel`/`timer.trigger` stack thunks, a gameplay-free instance bootstrap, fixed-capacity SoA generational handles, a no-fallback scratch arena, deferred release queueing, stack/error checks, and a pinned Defold Lua benchmark harness.
* **Profiles**: Made `dev`, `device-dev`, and `release` explicit: source-evaluated dynamic Hermes, host-produced bytecode, and reachable-only Static Hermes AOT respectively; native compilation is outside the edit loop.
* **Bytecode**: Added a matched-host `hermesc` device-development path and a lifecycle test that runs `.hbc` in the same precompiled dynamic runtime.
* **Tree shaking**: Added per-function generated ESM inputs, per-entrypoint symbol manifests derived from actual esbuild retention, conservative dynamic-registry detection, and usage-filtered binding generation.
* **Upstreaming**: Established evidence, reduction, regression-test, scope, and verification gates for Static Hermes and Defold PRs; no compiler defect has been found in the scalar `extern_c` slice.
* **Toolchain**: Pinned TypeScript 7.0.2 and matching `ttsc`/`@ttsc/unplugin` 0.30.4; routed the esbuild bundle through the TypeScript-Go plugin pass.
* **Architecture**: Adopted a hybrid model: TS-to-Lua for Defold script components, Hermes/browser for JavaScript modules, and generated bindings between them.
* **FFI**: Moved the typed module proof behind an `extern "C"` function used by native JSI and referenced by the Defold HTML5 Emscripten library.
* **Codegen**: Added a checked module schema that generates matching TypeScript and C ABI declarations.
* **Shaders**: Added Defold's GLSL/SPIR-V asset pipeline as a separate GPU lane in the architecture diagram.
* **Delivery**: Chose a Defold library/native extension as the shippable form; reserved a fork for first-class editor/resource/debugger integration.
* **Research**: Documented Defold's C# NativeAOT precedent and Hermes/Static Hermes Emscripten options.
* **Verification**: Built and ran the shared TypeScript bundle in embedded Hermes and in a real browser; both completed the same lifecycle transcript.
* **Modules**: Added a TurboModule/Nitro-shaped typed registry proof with a direct Hermes JSI host function and browser counterpart.
* **Packaging**: Produced an arm64 macOS combined Hermes archive and staged the extension headers; syntax-checked the Defold extension for macOS and HTML5.
* **Tooling**: Added an OKF structural check to the standard type-check command.
* **Initialization**: Created the OKF v0.2 bundle.
* **Research**: Recorded that the proposed `tmikov/hermes-preview` repository is not yet public and selected Meta `static_h` as the baseline.
* **Decision**: Proposed Hermes for native targets and the existing browser JavaScript VM for HTML5.
* **Plan**: Defined a contract-first native/browser vertical slice and deferred first-class Defold script components.
* **Compile-time Defold hash literals**: Added checker-bound `hashLiteral("#name")` authoring that the actual ttsc program-plugin host lowers to exact padded uint64 bigint constants. Pinned native `dmHashString64`/`dmHashBufferNoReverse64` probes validate ASCII and Unicode vectors; War Battles dogfoods nine action constants and its real incremental esbuild bundle contains no runtime hash call. Dynamic Hermes bytecode and sound-typed Static Hermes constant compilation pass, while automatic Static universal-handle materialization remains explicitly open.
* **Universal dmSDK completion path**: Added a generator-owned recipe, fixed caller-owned C ABI dispatch path, TypeScript stable-ID API, Dynamic Hermes registration metadata, Static Hermes extern-C declaration, and Embind-free browser/Wasm metadata for all 1,361 runtime declarations with zero silent omissions. The user-project compiler can now materialize reachable direct functions, methods, constructors, destructors, and template specializations from usage plus explicit semantic/type inputs. Clean-room regeneration passes, the common dispatcher builds into the native runtime, and a mixed generated `dmEndian`/`dmMath::Clamp<int32_t>`/`dmArray<uint32_t>` selection compiles, links, and runs against pinned headers. This is a complete generation path, not a claim that all 1,361 engine implementations have been linked or behavior-tested.
* **Reproducible dehermc artifacts**: `toolchains/go/build-dehermc.sh` now selects the host-matched Go binary shipped by the pinned `ttsc` package instead of a floating `go` from `PATH`. The packed-install smoke exposed the mismatch when Go 1.26.5 and the package's Go 1.26.8 produced different bytes from identical source. All five host digests are rebuilt from the package-pinned toolchain; the content-addressed release tag therefore describes the same bytes local smoke and CI publish.
* **Arbitrary extension C ABI lane**: Added an npm/CLI-exposed Clang JSON-AST generator that turns public C11 extension headers into deterministic IR, TypeScript, and 24-byte universal-cell C++ dispatch. Scalar, enum, and C-string free-function routes compile/link/run; records and unsafe pointers are cataloged with exact blockers. Added a generated browser dmSDK arena adapter with wasm32 bounds, catalog identity, UTF-8 scratch, exact bigint tags, and balanced release evidence.
* **Policy delivery is one automatic pipeline, not four workflows or a review queue**: `.github/workflows/policy.yml` is the single visible graph for channel discovery, Linux derivation, Linux/macOS/Windows byte parity, real-engine compile/link/runtime evidence, and publication. Nightly stable/beta/alpha policies accumulate in the content-addressed store and publish directly to `deherm-policy-site`; a policy PR is not a checkpoint. Defold's declarations are authoritative, reviewed lowering knowledge is advisory, conservative/default transports preserve usability, and moved reviews or unproven routes become reports and deterministic issues rather than suppressing unrelated APIs. Pull requests run the same evidence graph but cannot publish. The accepted contract is recorded in `decisions/continuous-policy-publication.md`.
* **Clean-runner Hermes header closure**: Policy run `35508523084` proved the Dynamic Hermes exact-call runner still depended on a local include-path accident after the JSI header fix: pinned `API/hermes/hermes.h` reaches `public/hermes/Public/HermesExport.h`. The test now declares all three pinned roots (`API`, `API/jsi`, and `public`) explicitly; required packaged-Hermes compilation, linking, and execution pass locally. Linux policy evidence remains pending until the follow-up pushed run is green.
* **Cross-target dmSDK and project-extension realization wave**: The canonical 486 universal-ready dmSDK vectors now run through native C ABI, real Hermes/production JSI, sound-typed Static Hermes, and the production browser JavaScript arena. Static reports planned/applicable/runtime-executed separately (`486/486/486`, zero blocked), maximum exercised arity nine, argument tag mask `0x3e`, and result tag mask `0x3f`. The real pinned Emscripten/Chrome lane runs with memory growth enabled, observes 486 calls, balances 994 reverse-order releases against 994 allocations with a 240-byte peak, and refuses evidence whose runtime counts disagree with its generated applicability partition. That gate exposed a real generator defect: C-string exact fixtures populated their address but left `auxiliary` zero. The materializer now emits the UTF-8 byte length, the browser preflight checks length and content without pretending host/wasm pointer identity is stable, and the rerun passed all 486 calls. The shared browser arena emitter now constructs its `DataView` only after any nested allocation; a forced `WebAssembly.Memory.grow` test proves the old buffer can detach without corrupting encoding. `deherm generate` also consumes every discovered local/dependency-ZIP public C header automatically, accepts exact unprefixed symbols such as `XMathDot`, retains transitive enum/record facts without leaking helper functions, passes every exact include root, and emits atomically staged revision/project-keyed IR, TypeScript, production glue, exact twins, drivers, and reports. Clang/generator/include-tree identity participates in the cache key; missing tools, drift, confinement, unsafe/bounded ZIP failures, missing sentinels, and stale owned files fail explicitly. The packed npm consumer generated extension glue from this path successfully. This remains bridge and generated-call evidence, not execution of all Defold implementations or support for the 875 dmSDK recipes still requiring call-site specialization.

## 2026-09-21

* **Installed dev-loop and contributor-cache closure**: The real War Battles `deherm dev` path exposed joined defects after cross-platform CI went green. Automatic native-extension discovery tried to re-bind déherm's own 117 runtime/typed-native implementation headers and exhausted Clang's AST output buffer; those two reserved infrastructure extensions are now reported as ignored rather than projected as user APIs. Lower-level session consumers retain component bundling when project API IR is absent, delete any stale optional symbol indexes, and emit one explicit warning that resource/route/dmSDK compile-time indexes require `deherm generate`. Descriptor-backed cache surfaces now require and authenticate their toolchain sibling as well as their artifact sibling; online public `create`/`generate`/`dev` refresh the mutable artifact mapping before selecting a surface, while explicit offline runs reuse an authenticated materialized copy. A cached generated project is reused only while its toolchain, artifact mapping, surface layer, Merkle roots, and input digests remain current. The public run also exposed a generated Static Hermes translation unit entering the normal ttsc bundle check; generated configs now keep that fixed `.deherm` `shermes -typed` staging source out of dynamic and authored TypeScript projects even with a custom generator output root. War Battles generated from the authenticated user cache with native artifact tag `libs-52a1faec5d17`, compiled its real ttsc/esbuild/Hermes-bytecode bundle using a project-relative entry, rebuilt its Static Hermes unit through the public CLI, and passed `verify-generated`; the packed npm consumer smoke independently realized the policy plus mutable artifacts sibling and completed installed `generate`, typecheck, one-shot dev, native-header projection, entry-only project discovery, and custom-output index refresh. This is development-loop, generated-state, and exact bundle evidence, not a claim that the game was visually played in this wave.

* **Revision-derived Bob platform resolution**: The manually dispatched full end-to-end matrix exposed a shared pre-Bob failure across all eleven exercised targets: `scripts/resolve-defold-platform.mjs` imported a public resolver that had never been implemented. The CLI now resolves Bob and Extender identities from the generated project's authenticated target matrix, the wrapper passes that project explicitly, and focused tests cover both macOS spellings plus an unknown-target refusal. Hosted run `35673621299` proved all eleven rows crossed that seam; `wasm-web` then built, while all ten native rows consistently exposed the next harness defect before Extender: the repository fallback correctly carried no mutable artifact mapping. Each Bob row now materializes the live published policy first so generation consumes the same authenticated surface and sibling artifact document as an installed npm client. Follow-up hosted run `35674434017` completed the local and extension-header gates and all eleven Bob targets: arm64/x86_64 macOS, arm64 iOS and simulator, arm64/x86_64 Linux, x86_64 Windows, armv7/arm64/x86_64 Android, and HTML5/Wasm. This closes the cross-platform clean-consumer delivery seam; it does not claim live gameplay behavior for the generated game.

* **dmSDK hash-state lifecycle wave**: Added a structural, revision- and archive-evidence-gated generator for all ten `dmHash{Init,Clone,UpdateBuffer,Final,Release}{32,64}` declarations. It emits a fixed-capacity-per-width, generation-tagged opaque-handle registry; stale, foreign, exhausted, double-consumed, malformed, and irrelevant uniform-dispatch arguments fail closed without raw pointer exposure. The generated exact twin compiles and runs under ASan/UBSan and observes zero C++ allocations across 100,000 warmed iterations. This is exact bridge/native ABI evidence, not packaged-engine implementation semantics. The aggregate dmSDK recipe partition is now 566 universal-ready, 74 callable generated-adapter, and 721 specialization-required; the arena ledger is 14 prior-wave, five C-string arena, and 60 explicitly blocked declarations with zero overlap/unaccounted rows.

* **Static script exact-call wave**: Generator-owned sound-typed Static Hermes callers now execute 127 `defold-value` script routes through the production universal frame and native adapter, moving Static exact coverage to 130/328 and the cross-target exact matrix to 1,960/2,158. Constructors and result predicates consume the interned canonical vector tokens; target/lane ownership, arity, frame capacities, required Matrix4/URL arenas, and release policy fail closed before a vector counts. Verification-only value inspectors are emitted only into the build-directory runner and do not enlarge the production Static transport. The 127-vector executable also passes a repeatable ASan/UBSan build and run. This is compiler/link/runtime evidence for generated call identity, argument/result shape, and transport behavior; it is not a claim that every Defold engine implementation was behavior-tested in a live game.
* **dmSDK bounded C-string adapters**: Promoted five declarations across four structural recipes into allocation-bounded generated adapters while retaining universal fallbacks for all declarations. At that wave's close, the 1,361-declaration partition was 566 universal-ready, 64 callable generated-adapter, and 731 specialization-required. Exact generation now rejects any production/report adapter-identity disagreement and hashes all nine family reports instead of correcting a stale production route. Arena admission consumes revision-matched all-target symbol evidence; both exact drivers verify native result, visible output length, NUL-inclusive required length, and zeroed state on native failure. Native exact vectors pass 64/64, ASan/UBSan passes, and 100,000 warmed adapter calls request zero C++ allocations; those results do not promote the remaining specialization-required declarations to adapter-executed evidence.
* **Source/linkage contradiction handling**: `ProfilePropertyAddBool` remains in the public TypeScript and universal recipe surface, but its optimized named-scalar adapter is machine-blocked because the pinned headers declare it while shipped symbol evidence reports no linked implementation. The generator now requires revision-matched symbol evidence for that adapter family, and issue [#117](https://github.com/ts-defold/deherm/issues/117) tracks the upstream contradiction instead of suppressing the API or failing unrelated policy publication.
* **Integrated runtime and CI closure**: The Static Hermes lifecycle build now uses the direct sound `-typed` frontend; its universal probe chooses a generated frame with the required bounded table/Matrix4/URL capacity. Runtime-smoke TypeScript inherits the root revision-derived SDK aliases. The end-to-end extension-header job installs the pinned pnpm dependency graph before staging Hermes headers. Local `pnpm check` and `pnpm test:static-hermes` pass; the CI workflow changes remain unproven on a fresh hosted runner until the pushed workflow completes.
* **Bounded OKF metadata retrieval**: Extended the existing disposable SQLite knowledge index with top-level structured frontmatter metadata and a bounded `knowledge:metadata` command. The source Markdown remains authoritative; schema changes rebuild the cache, cells and responses are size-limited, and truncation backs up to a complete UTF-8 code-point boundary before adding its ellipsis. The 15-test graph suite covers metadata, sections, outlines, and read-only SQL with two-, three-, and four-byte text. Nested YAML and full Markdown AST semantics remain intentionally outside this deterministic projection.
* **External adversarial review closure**: A read-only external review of the complete working-tree wave reported zero P0/P1/P2 findings plus three P3 observations. Independent reproduction accepted two latent hardening points: bounded OKF metadata now rejects truncated-key collisions, and named-scalar generation retains every distinct symbol/structural blocker with symbol availability first. Focused OKF and named-scalar suites pass, and the generator's `--check` confirms the present one-blocker census is byte-identical. The dense-ID observation was evaluated and rejected as a change: these are revision-keyed internal dispatch ordinals regenerated atomically with their consumers, while sparse identity hashes would add hot-path lookup cost without a demonstrated mismatch.

## 2026-09-22 - Authored debugger maps reach the live War Battles engine

The developer compiler previously handed esbuild printer-only transformed
TypeScript. The transform was correct, but its printer removed comments and
blank lines without emitting an input source map, so `player.script.ts:173`
was advertised as generated line 4284 instead of the executable statement at
4259. Hermes accepted that location and reported a verified breakpoint, but the
engine could never hit the intended statement. Dev bundling now invokes the
shipped `dehermc build` emitter with source maps after the same linked ttsc
transforms, normalizes each one-source map at the original module path, and
lets esbuild compose it into the bundle map. The real compiler regression maps
the authored statement to its exact generated JavaScript statement.

A current local-Extender engine then passed the public stdin/stdout DAP proof
against War Battles: `arena.script.ts:284` was verified, the real Hermes runtime
emitted `stopped(reason=breakpoint)`, the top `update` frame mapped to the same
authored line, evaluating `dt` returned a live number, and continue plus
disconnect completed in two consecutive debugger processes. The first rerun
exposed that the Node bridge had kept a one-frontend Hermes CDP agent alive
after WebSocket detach; the second agent accepted breakpoints but never
interrupted the runtime. Frontend detach now closes the private engine stream,
which exercises the native resume/reset/reconnect path, and both sessions pass.
`pnpm --filter @deherm/example-war-battles-online
runtime:debug` reproduces that observation while a dev session is running.
This is mapped compiler, native packaged-engine, and DAP runtime evidence. It
does not establish HTML5 breakpoint parity, editor/LSP integration, or a
debugger memory-soak claim.

## 2026-09-22 - Generated route semantics reach the language server

The language server now joins a literal to the generated SDK route and exact
argument position before offering project symbols. Attached resources,
literal-addressed component resources, and component/collection addresses use
the same generated scope metadata as the checker; dynamic sibling addresses
widen only to their classified namespaces. Completion, hover, and definition
share that candidate set. Canonical named, local, and namespace aliases are
recognized, while an unrelated import that happens to expose a Defold-shaped
name is rejected. The optional static project-message projection is consumed
only at its declared `MsgApi.post` argument and remains suggestion/navigation
evidence rather than a build rule. Focused language-server tests pass across
all three scopes, duplicate declarations, aliases, CRLF/UTF-16 positions, and
exact definition locations. This is deterministic language-service evidence;
it is not a TypeScript type-checker proof or a live VS Code UI observation.

## 2026-09-22 - War Battles HTML5 is visually and interactively playable

The current War Battles project regenerated through the public CLI, passed its
four TypeScript context checks and 32-player deterministic simulation suite,
and bundled for `wasm-web` through pinned Bob plus local Extender. The existing
browser runtime gate observed the tutorial fire/collision/score sequence,
camera clamps, eight registered TypeScript components, and offline arena
engagement. A new companion playability gate sent real Chrome keyboard events:
`W` interrupted the idle tutorial and engaged the arena in under 100 ms across
the recorded reruns. The gate
then dispatched weapon-three and fire events while the live match rendered;
only the first event has an in-game observation today.

The browser reported a live, non-lost WebGL 2 context using WebGL GLSL ES 3.00
through ANGLE/SwiftShader. Chrome's canvas-clipped composed frame contained
4,000/4,000 visible and non-black sampled pixels across more than 60 coarse
colour buckets; the roughly 65 KB PNG at
`build/evidence/war-battles-html5.png` was inspected and shows the arena,
HUD, walls, tank, terrain and projectile. Directly copying the WebGL default
framebuffer after presentation produced cleared pixels, which is permitted when
`preserveDrawingBuffer` is false, so the durable gate analyzes the compositor
screenshot rather than misclassifying that expected buffer lifecycle as a
black game. This proves the local packaged HTML5 input/render path under
software WebGL; it does not prove every hardware GPU or browser.

The checked JavaScript bundle-size source census also stopped counting the
generated `defold_hermes` and optional `defold_hermes_typed_native` installation
trees. Their target-dependent presence had made the authored-game evidence vary
with local build state. Bundle artifacts remain measured exactly; only the
source census boundary was corrected.
