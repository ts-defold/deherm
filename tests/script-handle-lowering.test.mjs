import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assignRuntimeProfileEquivalence,
  generateScriptHandleLowering,
  inputPaths,
  loadInputs,
  outputPaths,
  renderArtifacts
} from "../scripts/generate-script-handle-lowering.mjs";

const root = new URL("../", import.meta.url);
const inputs = await loadInputs();
const generated = generateScriptHandleLowering(inputs);

function replaceJson(text, mutate) {
  const value = JSON.parse(text);
  mutate(value);
  return `${JSON.stringify(value, null, 2)}\n`;
}

function counts(rows, select) {
  const result = {};
  for (const row of rows) {
    const key = select(row);
    result[key] = (result[key] ?? 0) + 1;
  }
  return result;
}

test("selects all 407 borrowed-handle routes from shape and effect predicates", () => {
  assert.deepEqual(generated.coverage, {
    selectedRoutes: 407,
    descriptorRowsEmitted: 407,
    routerCandidates: 405,
    blocked: 2,
    adapterExecutableRoutes: 405,
    nativeAdapterHarnessRoutes: 405,
    defoldEngineVerifiedRoutes: 0,
    nativeDynamicHermesJsiVerifiedRoutes: 0,
    nativeStaticHermesExecutableRoutes: 0,
    html5BrowserExecutableRoutes: 0,
    runtimeUnavailable: 2,
    adapterExecutableRoutesByProfile: {
      "bullet-only": 201,
      "default-legacy-bullet": 313,
      "legacy-no-bullet": 182,
      "no-physics": 70,
      "v3-bullet": 380,
      "v3-no-bullet": 249
    }
  });
  assert.equal(new Set(generated.routes.map(({ id }) => id)).size, 407);
  assert.deepEqual(generated.operationClassCounts, {
    "checked-child-engine-object-invalidate": 2,
    "checked-handle-input-terminal": 367,
    "checked-handle-return-capture": 33,
    "checked-self-engine-object-invalidate": 5
  });
  assert.deepEqual(generated.contextCounts, {
    "explicit-physics-handle": 332,
    "game-object-instance": 5,
    "gui-scene": 55,
    "render-script-instance-and-graphics-context": 7,
    "runtime-global": 8
  });
  assert.equal(inputs.policy.includes("script:"), false, "policy must not contain a route allowlist");
});

test("keeps Lua registration profiles distinct from adapter-executable profiles", () => {
  assert.equal(generated.routes.some(({ id }) => id.startsWith("script:constant.")), false,
    "borrowed-handle lowering must remain a function-only surface");
  for (const id of ["script:b2d.body.get_world", "script:b2d.get_world"]) {
    const route = generated.routes.find((candidate) => candidate.id === id);
    assert.ok(route, `${id} route is generated`);
    assert.deepEqual(route.profiles.registration, [
      "default-legacy-bullet", "legacy-no-bullet", "v3-bullet", "v3-no-bullet"
    ]);
    assert.deepEqual(route.profiles.runtime, ["v3-bullet", "v3-no-bullet"]);
  }
  const defaultProfile = generated.runtimeProfiles.find(({ id }) => id === "default-legacy-bullet");
  assert.deepEqual(
    [defaultProfile.sourceRouteCount, defaultProfile.adapterExecutableRouteCount],
    [343, 313],
    "profile detection must use the registration surface while dispatch uses the adapter surface"
  );
});

test("descriptor selection is independent of compile/link/runtime evidence state", () => {
  const promoted = {
    ...inputs,
    projection: replaceJson(inputs.projection, (value) => {
      for (const row of value.rows) {
        if (row.loweringFamily === "borrowed-handle") row.evidence.accountingCategory = "executable-stable-id";
      }
    })
  };
  const regenerated = generateScriptHandleLowering(promoted);
  assert.equal(regenerated.coverage.selectedRoutes, 407);
  assert.deepEqual(regenerated.routes.map(({ id }) => id), generated.routes.map(({ id }) => id));
});

test("brands semantic handle kinds and separates adapter coverage from engine evidence", () => {
  assert.equal(generated.handleKindCount, 15);
  assert.equal(new Set(generated.handleKinds.map(({ id }) => id)).size, 15);
  assert.equal(new Set(generated.handleKinds.map(({ numericId }) => numericId)).size, 15);
  const knownKinds = new Set(generated.handleKinds.map(({ id }) => id));
  for (const route of generated.routes) {
    assert.ok(route.inputKinds.every((kind) => knownKinds.has(kind)));
    assert.ok(route.returnKinds.every((kind) => knownKinds.has(kind)));
    assert.equal(route.ownership.hostWrapper, "generation-checked-lua-registry-root");
    assert.equal(route.lifetime.loweringToken, "semantic-handle-kind-policy");
    assert.equal(route.callback.token, "none");
    assert.equal(route.variadic.token, "fixed-arity");
    assert.equal(route.recursive.token, "acyclic-value-shape");
    assert.equal(route.generation.descriptor, "emitted");
    assert.equal(route.evidence.defoldEngineBehavior, "unverified");
    assert.equal(route.evidence.nativeDynamicHermesJsi, "unverified");
    assert.equal(route.evidence.nativeStaticHermes, "unverified");
    assert.equal(route.evidence.html5BrowserHost, "unverified");
    assert.equal(route.evidence.allocationPerRoute, "unverified");
  }
  assert.deepEqual(generated.semanticPolicyHoles, {
    projectionLifetimePolicyUnresolved: 337,
    executableAdapterUnimplemented: 0,
    guiAttachmentUnavailable: 55,
    renderAttachmentUnavailable: 7,
    profileSymbolUnavailable: 2
  });
});

test("derives exact fail-closed runtime profile masks and handshakes", () => {
  assert.equal(generated.runtimeProfiles.length, 6);
  assert.deepEqual(generated.runtimeProfiles.map(({ id, adapterExecutableRouteCount }) => [id, adapterExecutableRouteCount]), [
    ["bullet-only", 201],
    ["default-legacy-bullet", 313],
    ["legacy-no-bullet", 182],
    ["no-physics", 70],
    ["v3-bullet", 380],
    ["v3-no-bullet", 249]
  ]);
  for (const profile of generated.runtimeProfiles) {
    assert.equal(profile.mask, 1 << profile.index);
    assert.match(profile.routeSetSha256, /^[0-9a-f]{64}$/);
    assert.equal(profile.catalogSha256, generated.inputEvidence.availabilityCatalogSha256);
    assert.equal(profile.defoldRevision, generated.defoldRevision);
    assert.equal(profile.schema, "deherm.script-route-capabilities/v1");
    assert.match(profile.adapterSurfaceSha256, /^[0-9a-f]{64}$/);
    assert.match(profile.registrationSurfaceSha256, /^[0-9a-f]{64}$/);
    assert.equal(generated.routes.filter((route) =>
      route.generation.router === "emitted" && (route.profiles.runtimeMask & profile.mask) !== 0).length,
    profile.adapterExecutableRouteCount);
  }
  assert.equal(new Set(generated.runtimeProfiles.map(({ adapterSurfaceSha256 }) => adapterSurfaceSha256)).size, 6);
  assert.equal(new Set(generated.runtimeProfiles.map(({ registrationSurfaceSha256 }) => registrationSurfaceSha256)).size, 6);
  const executableSymbols = generated.routes
    .filter(({ generation }) => generation.router === "emitted")
    .map(({ modulePath, member }) => `${modulePath.join(".")}.${member}`);
  assert.equal(new Set(executableSymbols).size, executableSymbols.length);
  for (const route of generated.routes) {
    const expectedRegistrationMask = generated.runtimeProfiles.reduce((mask, profile) =>
      mask | (route.profiles.registration.includes(profile.id) ? profile.mask : 0), 0);
    const expectedMask = generated.runtimeProfiles.reduce((mask, profile) =>
      mask | (route.profiles.runtime.includes(profile.id) ? profile.mask : 0), 0);
    assert.equal(route.profiles.registrationMask, expectedRegistrationMask);
    assert.equal(route.profiles.runtimeMask, expectedMask);
  }
  for (const id of ["script:b2d.get_world", "script:b2d.body.get_world"]) {
    const route = generated.routes.find((candidate) => candidate.id === id);
    const profile = generated.runtimeProfiles.find((candidate) => candidate.id === "default-legacy-bullet");
    assert.ok(route, `${id} route is generated`);
    assert.ok(profile, "default-legacy-bullet profile is generated");
    assert.notEqual(route.profiles.registrationMask & profile.mask, 0,
      `${id} is present in the source registration surface`);
    assert.equal(route.profiles.runtimeMask & profile.mask, 0,
      `${id} remains unavailable to the adapter because its lightuserdata world handle is not capturable`);
  }
});

test("collapses observationally equivalent revision profiles conservatively", () => {
  const profiles = [
    { id: "alpha", mask: 1, adapterSurfaceSha256: "same" },
    { id: "beta", mask: 2, adapterSurfaceSha256: "same" },
    { id: "stable", mask: 4, adapterSurfaceSha256: "other" }
  ];
  const kinds = [
    { id: "shared", capturableProfileMask: 7, capturableProfiles: ["alpha", "beta", "stable"] },
    { id: "alpha-only", capturableProfileMask: 5, capturableProfiles: ["alpha", "stable"] }
  ];

  const groups = assignRuntimeProfileEquivalence(profiles, kinds);

  assert.deepEqual(groups, [{
    adapterSurfaceSha256: "same",
    canonicalProfileId: "alpha",
    equivalentProfileIds: ["alpha", "beta"],
    equivalentProfileMask: 3,
    conservativelyUnavailableHandleKinds: ["alpha-only"],
    proof: "identical-generated-router-availability-vector",
    alert: "named-runtime-profiles-observationally-equivalent"
  }]);
  assert.equal(profiles[0].detectionCanonicalProfileId, "alpha");
  assert.equal(profiles[1].detectionCanonicalProfileId, "alpha");
  assert.equal(kinds[0].capturableProfileMask, 7);
  assert.equal(kinds[1].capturableProfileMask, 4);
  assert.deepEqual(kinds[1].capturableProfiles, ["stable"]);
});

test("assigns honest per-target dispositions", () => {
  assert.deepEqual(counts(generated.routes, ({ targets }) => targets.nativeDynamicHermes), {
    "captured-lua-router-harness-proven-jsi-unverified": 343,
    "profile-symbol-unavailable": 2,
    "gui-script-attachment-unavailable": 55,
    "render-script-attachment-unavailable": 7
  });
  assert.deepEqual(counts(generated.routes, ({ targets }) => targets.nativeStaticHermes), {
    "static-ffi-unimplemented": 343,
    "profile-symbol-unavailable": 2,
    "gui-script-attachment-unavailable": 55,
    "render-script-attachment-unavailable": 7
  });
  assert.deepEqual(counts(generated.routes, ({ targets }) => targets.html5BrowserHost), {
    "browser-host-unimplemented": 343,
    "profile-symbol-unavailable": 2,
    "gui-script-attachment-unavailable": 55,
    "render-script-attachment-unavailable": 7
  });
});

test("publishes source-suffix attachment providers without route wrappers", () => {
  assert.deepEqual(generated.attachmentProviders, {
    "*.ts": { proxyExtension: null, context: "runtime-global", state: "context-free" },
    "*.script.ts": { proxyExtension: ".script", context: "game-object-instance", state: "generated-proxy-provider" },
    "*.gui.ts": { proxyExtension: ".gui_script", context: "gui-scene", state: "provider-required-unimplemented" },
    "*.render.ts": { proxyExtension: ".render_script", context: "render-script-instance-and-graphics-context", state: "provider-required-unimplemented" }
  });
  assert.deepEqual(generated.nativeAdapterHarnessContexts, {
    gameObject: "captured-and-selected",
    gui: "captured-and-selected-test-fixture-only",
    render: "captured-and-selected-test-fixture-only"
  });
});

test("publishes exact-vector profile detection without mutable project authority", async () => {
  assert.deepEqual(generated.runtimeProfileDetection, {
    authority: "generated-lua-registration-surface",
    strategy: "exact-function-presence-vector",
    routeCount: 405,
    lookup: "protected-raw-table-traversal-no-metamethods",
    initialization: "lazy-first-bootstrap-attach",
    nativeLuaHarness: "six-exact-profiles-and-negative-vectors-covered",
    packagedDefoldEngine: "unverified",
    nativeDynamicHermesJsi: "unverified",
    nativeStaticHermes: "unverified",
    html5BrowserHost: "unverified"
  });
  const extension = await readFile(new URL("../defold/defold_hermes/src/extension.cpp", import.meta.url), "utf8");
  const project = await readFile(new URL("../defold/game.project", import.meta.url), "utf8");
  assert.match(extension, /detectRuntimeProfile\(/);
  assert.ok(extension.indexOf("EnsureScriptBridgeReady(state)") < extension.indexOf("gLuaBridge->captureInstance(1)"));
  for (const key of ["profile_schema", "profile_id", "profile_defold_revision", "profile_capability_bits", "profile_route_count", "profile_route_set_sha256", "profile_catalog_sha256"]) {
    assert.equal(extension.includes(`defold_hermes.${key}`), false);
    assert.equal(project.includes(`${key} =`), false);
  }
});

test("generation is order-independent, provenance-pinned, and byte deterministic", async () => {
  const reordered = {
    ...inputs,
    projection: replaceJson(inputs.projection, (value) => value.rows.reverse()),
    classification: replaceJson(inputs.classification, (value) => value.rows.reverse())
  };
  const reorderedGenerated = generateScriptHandleLowering(reordered);
  assert.deepEqual(reorderedGenerated.routes, generated.routes);
  assert.deepEqual(reorderedGenerated.argumentCodecs, generated.argumentCodecs);
  assert.deepEqual(reorderedGenerated.resultCodecs, generated.resultCodecs);
  assert.deepEqual(Object.keys(generated.inputEvidence.hashes), Object.keys(inputPaths));
  assert.ok(Object.values(generated.inputEvidence.hashes).every((hash) => /^[0-9a-f]{64}$/.test(hash)));

  const artifacts = renderArtifacts(generated);
  for (const [name, relativePath] of Object.entries(outputPaths)) {
    assert.equal(artifacts[name].includes("\0"), false, `${name} contains a literal NUL byte`);
    assert.equal(await readFile(new URL(relativePath, root), "utf8"), artifacts[name]);
  }
  execFileSync(process.execPath, ["scripts/generate-script-handle-lowering.mjs", "--check"], {
    cwd: root,
    stdio: "pipe"
  });
});

test("protected Lua dispatch permits LuaJIT errors to reach lua_cpcall", () => {
  const { header, source } = renderArtifacts(generated);
  assert.match(header, /bool dispatchUnsafe\(DispatchContext& context\);/);
  assert.doesNotMatch(header, /bool dispatchUnsafe\(DispatchContext& context\) noexcept;/);
  assert.match(source, /bool CapturedLuaRouter::dispatchUnsafe\(DispatchContext& context\) \{/);
  assert.doesNotMatch(source, /bool CapturedLuaRouter::dispatchUnsafe\(DispatchContext& context\) noexcept/);
  assert.match(source, /lua_cpcall\(state_,ProtectedDispatch,&dispatchContext\)/);
});

test("regeneration is locale-independent and uses code-unit ordering", async () => {
  const generatorSource = await readFile(new URL("../scripts/generate-script-handle-lowering.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(generatorSource, /localeCompare/);
  for (const locale of ["C", "en_US.UTF-8", "tr_TR.UTF-8"]) {
    execFileSync(process.execPath, ["scripts/generate-script-handle-lowering.mjs", "--check"], {
      cwd: root,
      env: { ...process.env, LC_ALL: locale, LANG: locale },
      stdio: "pipe"
    });
  }
});

test("rejects shape, semantic-kind, availability, and pinned-revision drift", () => {
  const shapeDrift = {
    ...inputs,
    projection: replaceJson(inputs.projection, (value) => {
      const row = value.rows.find(({ id }) => id === generated.routes[0].id);
      row.signature.parameters[0].value = { kind: "sequence", element: row.signature.parameters[0].value };
    })
  };
  assert.throws(() => generateScriptHandleLowering(shapeDrift), /algebraic handle route census expected/);

  const kindDrift = {
    ...inputs,
    classification: replaceJson(inputs.classification, (value) => {
      value.rows.find(({ id }) => id === generated.routes[0].id).inputHandleKinds = [];
    })
  };
  assert.throws(() => generateScriptHandleLowering(kindDrift), /semantic handle kinds drifted/);

  const invalidationDrift = {
    ...inputs,
    classification: replaceJson(inputs.classification, (value) => {
      value.rows.find(({ operationClass }) => operationClass === "checked-self-engine-object-invalidate")
        .invalidatedIdentity = null;
    })
  };
  assert.throws(() => generateScriptHandleLowering(invalidationDrift), /invalidation semantics drifted/);

  const availabilityDrift = {
    ...inputs,
    availability: replaceJson(inputs.availability, (value) => { value.catalogSha256 = "0".repeat(64); })
  };
  assert.throws(() => generateScriptHandleLowering(availabilityDrift), /stale availability catalog/);

  const handshakeDrift = {
    ...inputs,
    availability: replaceJson(inputs.availability, (value) => {
      value.profiles["default-legacy-bullet"].runtimeHandshake.routeSetSha256 = "0".repeat(64);
    })
  };
  assert.throws(() => generateScriptHandleLowering(handshakeDrift), /capability handshake/);

  const revisionDrift = {
    ...inputs,
    classification: replaceJson(inputs.classification, (value) => { value.defoldRevision = "0".repeat(40); })
  };
  assert.throws(() => generateScriptHandleLowering(revisionDrift), /pinned Defold revision/);
});

test("generated C++ descriptors and generic router compile warning-clean", () => {
  execFileSync(process.env.CXX || "clang++", [
    "-std=c++17", "-Wall", "-Wextra", "-Werror", "-Wno-zero-length-array", "-pedantic", "-fsyntax-only",
    "-Idefold/defold_hermes/include",
    `-Iupstream/extender/server/app/sdk/${generated.defoldRevision}/defoldsdk/sdk/include`,
    "-Iupstream/defold/engine/dlib/src",
    "-Iupstream/defold/engine/lua/src",
    outputPaths.source
  ], { cwd: root, stdio: "pipe" });
});
