import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertNoRevisionLeak,
  buildIndexEntry,
  buildPolicy,
  buildPolicyRealizer,
  canonicalize,
  dmsdkNamespaceOfHeader,
  hashBytes,
  indexPath,
  normalizePaths,
  objectPath,
  POLICY_REALIZER_CAPABILITIES,
  POLICY_REALIZER_CAPABILITY_REGISTRY,
  policyPath,
  scriptNamespaceOfModulePath,
  scriptNamespaceOfTypeName,
  sealObject,
  serializeObject
} from "../packages/compiler/src/api-policy.mjs";
import {
  DMSDK_UNIVERSAL_STATIC_FRAME_CAPABILITY,
  DMSDK_UNIVERSAL_STATIC_FRAME_CAPACITY,
  DMSDK_UNIVERSAL_STATIC_FRAME_SCHEMA
} from "../packages/compiler/src/dmsdk-universal-static-frame.mjs";
import { buildToolchainPins, parseSdkPins } from "../packages/compiler/src/defold-toolchain-pins.mjs";
import { manifestUrl, missingPublishedEntries } from "../scripts/check-published-policy.mjs";
import { validateRebuiltHandshake } from "../scripts/check-policy-site-resolution.mjs";
import { buildShippedIndex, generatorRevision } from "../scripts/generate-api-policy.mjs";
import { apiPolicyGenerator } from "../scripts/lib/script-generator-pipeline.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const generated = path.join(repositoryRoot, "packages", "bindings", "generated");

const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));

test("policy host parity materializes every authoritative generator input", async () => {
  const workflow = await readFile(path.join(repositoryRoot, ".github/workflows/policy.yml"), "utf8");
  const bootstrap = await readFile(path.join(repositoryRoot, "scripts/bootstrap-upstreams.sh"), "utf8");
  const bobBootstrap = await readFile(path.join(repositoryRoot, "scripts/bootstrap-bob.sh"), "utf8");
  const checksumHelper = await readFile(path.join(repositoryRoot, "scripts/lib/sha256.sh"), "utf8");
  const importers = await Promise.all([
    "scripts/import-defold-sdk.py",
    "scripts/import-defold-script-api.py"
  ].map(async (relative) => [relative, await readFile(path.join(repositoryRoot, relative), "utf8")]));
  const parity = workflow.slice(
    workflow.indexOf("  host-parity:"),
    workflow.indexOf("  engine-conformance:")
  );
  const engine = workflow.slice(
    workflow.indexOf("  engine-conformance:"),
    workflow.indexOf("  publish-site:")
  );
  const publish = workflow.slice(workflow.indexOf("  publish-site:"));

  assert.match(parity, /bootstrap-upstreams\.sh defold ref-doc/u);
  assert.match(engine, /bootstrap-upstreams\.sh defold hermes extender ref-doc defold-sdk/u);
  assert.match(engine, /key: defold-sdk-\$\{\{ steps\.defold-sdk\.outputs\.digest \}\}/u);
  assert.match(checksumHelper, /deherm_require_node[\s\S]*command -v node/u);
  assert.match(checksumHelper, /createHash\("sha256"\)/u);
  for (const script of [bootstrap, bobBootstrap]) {
    assert.match(script, /source "\$repo_root\/scripts\/lib\/sha256\.sh"/u);
    assert.doesNotMatch(script, /\bshasum\b|createHash\("sha256"\)/u);
  }
  for (const [relative, importer] of importers) {
    for (const line of importer.split("\n").filter((candidate) => /\.(?:read|write)_text\(/u.test(candidate))) {
      assert.match(line, /encoding="utf-8"/u, `${relative}: platform-default text codec in: ${line.trim()}`);
    }
  }
  assert.match(publish, /needs: \[derive, host-parity\]/u);
  assert.match(publish, /needs\.host-parity\.result == 'success'/u);
  assert.match(workflow, /manage-native-artifacts\.mjs pull --target x86_64-linux/u);
  assert.doesNotMatch(workflow, /pnpm artifacts:pull/u);
  assert.match(engine, /pnpm check:exact-call-materializers/u);
  assert.match(engine, /DEHERM_REQUIRE_PACKAGED_HERMES: '1'/u);
  assert.ok(
    engine.indexOf("manage-native-artifacts.mjs pull --target x86_64-linux") <
      engine.indexOf("pnpm check:exact-call-materializers"),
    "the JSI exact-call gate must run after the packaged Hermes archive is installed"
  );
  assert.match(engine, /defold-hermes-static-dmsdk-exact-test/u);
  assert.match(engine, /bash scripts\/bootstrap-emsdk\.sh/u);
  assert.match(engine, /pnpm test:dmsdk-browser-exact-call/u);
  assert.match(engine, /continue-on-error: true/u);
  assert.match(engine, /Enforce engine-lane infrastructure health[\s\S]*steps\.engine\.outcome != 'success'[\s\S]*exit 1/u);
  assert.match(workflow, /consumer-smoke:[\s\S]*needs: \[derive, publish-site\]/u);
  assert.match(workflow, /check-published-policy\.mjs/u);
});

test("published smoke waits for the exact derived entries at the configured site", () => {
  const expected = {
    base: { url: "https://example.test/deherm/", pathPrefix: "policies", layoutVersion: "v1" },
    entries: [{ defoldRevision: "a", policyRoot: "root-a", generator: "gen-a" }]
  };
  assert.equal(manifestUrl(expected), "https://example.test/deherm/policies/v1/index/manifest.json");
  assert.deepEqual(missingPublishedEntries(expected, { entries: [] }), expected.entries);
  assert.deepEqual(missingPublishedEntries(expected, {
    entries: [{ defoldRevision: "a", policyRoot: "root-a", generator: "gen-a" }]
  }), []);
  assert.deepEqual(missingPublishedEntries(expected, {
    entries: [{ defoldRevision: "a", policyRoot: "wrong", generator: "gen-a" }]
  }), expected.entries);
});

test("policy handshakes bind each resolved revision to its own profile facts", () => {
  const profilesFor = (routeCount) => ({
    catalogRecipe: {
      profileOrder: ["default-legacy-bullet"],
      profileFields: ["features", "capabilityBits", "routeSetSha256"]
    },
    profiles: {
      "default-legacy-bullet": {
        boundAtResolution: ["defoldRevision", "catalogSha256"],
        features: ["core"],
        runtimeHandshake: {
          schema: "deherm.script-route-capabilities/v1",
          profileId: "default-legacy-bullet",
          capabilityBits: 1,
          routeCount,
          routeSetSha256: String(routeCount).padStart(64, "0")
        }
      }
    }
  });
  const stable = validateRebuiltHandshake({
    profiles: profilesFor(26),
    revision: "a".repeat(40),
    profileId: "default-legacy-bullet"
  });
  const alpha = validateRebuiltHandshake({
    profiles: profilesFor(27),
    revision: "b".repeat(40),
    profileId: "default-legacy-bullet"
  });
  assert.equal(stable.defoldRevision, "a".repeat(40));
  assert.equal(stable.routeCount, 26);
  assert.equal(alpha.defoldRevision, "b".repeat(40));
  assert.equal(alpha.routeCount, 27);
  assert.notEqual(stable.catalogSha256, alpha.catalogSha256);
});

// A deliberately tiny stand-in for the generated state, so the structural
// properties are tested against inputs a reader can hold in their head rather
// than against six megabytes of real surface. The real surface is exercised by
// `scripts/check-policy-site-resolution.mjs`.
function fixture(overrides = {}) {
  return {
    scriptIr: {
      defoldRevision: "a".repeat(40),
      functions: [
        { id: "script:gui.get_node", modulePath: ["gui"], rawName: "gui.get_node", parameters: [] },
        { id: "script:go.set_position", modulePath: ["go"], rawName: "go.set_position", parameters: [] }
      ],
      types: [
        { name: "defold_api.gui", fields: [] },
        { name: "defold_enum.go.PLAYBACK", fields: [] },
        { name: "hash", fields: [] }
      ],
      unresolvedTypes: [],
      ...overrides.scriptIr
    },
    dmsdkIr: {
      defoldRevision: "a".repeat(40),
      parseEnvironment: { triple: "wasm32-unknown-unknown", platformNeutralOf: ["__APPLE__"], sysroot: "s", sysrootSha256: "b".repeat(64) },
      declarations: [
        { id: "dmsdk:dmGui::X", name: "dmGui::X", header: "upstream/defold/engine/gui/src/dmsdk/gui/gui.h", kind: "record" },
        { id: "dmsdk:dmGameObject::Y", name: "dmGameObject::Y", header: "upstream/defold/engine/gameobject/src/dmsdk/gameobject/gameobject.h", kind: "record" }
      ],
      opaqueTypes: [],
      unresolvedTypes: [],
      ...overrides.dmsdkIr
    },
    registrationSurface: {
      contract: { groundTruth: "c" },
      targets: {
        "defold-engine": {
          id: "defold-engine",
          kind: "engine-tree",
          status: "verified",
          inputs: { root: "upstream/defold/engine", variantExclusions: [] },
          summary: { registeredRoutes: 2 },
          blockerHistogram: {},
          namespaces: { gui: { declared: true }, go: { declared: true }, "<globals>": { declared: false } },
          registrationEntryPoints: [],
          routes: [
            { name: "gui.get_node", module: "gui", cFunction: "GuiGetNode" },
            { name: "go.set_position", module: "go", cFunction: "GoSetPosition" }
          ],
          declaredButUnregistered: [],
          registeredButUndeclared: [],
          registeredConstants: [{ name: "_G", module: "", member: "_G" }],
          commentedOutRegistrations: [],
          blockers: [{ code: "ambiguous-registration-callee", path: "engine/x.cpp", line: 1 }],
          diagnostics: [],
          policyNotes: []
        },
        "extension-thing": { id: "extension-thing", kind: "extension-root", status: "unverifiable", routes: [] }
      },
      ...overrides.registrationSurface
    },
    routeProfiles: {
      defoldRevision: "a".repeat(40),
      handshakeContract: { schema: "s" },
      registrationAudit: [],
      manifestAudit: [],
      handleFeatures: {},
      handleProfiles: {},
      features: { core: { capabilityBit: 1, documentedRoutes: [{ id: "script:gui.get_node", stableId: 1, rawName: "gui.get_node" }] } },
      profiles: {
        only: {
          manifest: "m",
          manifestSha256: "d",
          features: ["core"],
          availableRoutes: [{ id: "script:gui.get_node", stableId: 1, rawName: "gui.get_node" }],
          unavailableRoutes: [{ id: "script:go.set_position", stableId: 2, rawName: "go.set_position" }],
          runtimeHandshake: {
            schema: "s",
            profileId: "only",
            defoldRevision: "a".repeat(40),
            capabilityBits: 1,
            routeCount: 1,
            routeSetSha256: "r",
            catalogSha256: "c"
          }
        }
      },
      ...overrides.routeProfiles
    },
    resourceSchema: { derivation: [], resources: [], blockers: [], ...overrides.resourceSchema },
    toolchain: { source: "sdk.py", pins: { EMSCRIPTEN_VERSION_STR: "4.0.6" }, platformKeys: [], ...overrides.toolchain },
    compilerSurface: overrides.compilerSurface,
    generator: overrides.generator ?? "sha256:fixture",
    repositoryRoot: "/checkout"
  };
}

test("canonical serialization depends on content, not key order", () => {
  assert.equal(serializeObject({ b: 1, a: [{ d: 2, c: 3 }] }), serializeObject({ a: [{ c: 3, d: 2 }], b: 1 }));
  assert.deepEqual(Object.keys(canonicalize({ z: 1, a: 2 })), ["a", "z"]);
  const sealed = sealObject({ a: 1 });
  assert.equal(sealed.hash, createHash("sha256").update(sealed.bytes, "utf8").digest("hex"));
});

test("generator identity is independent of checkout newline encoding", async (t) => {
  const lf = await mkdtemp(path.join(tmpdir(), "deherm-generator-lf-"));
  const crlf = await mkdtemp(path.join(tmpdir(), "deherm-generator-crlf-"));
  t.after(async () => Promise.all([
    rm(lf, { recursive: true, force: true }),
    rm(crlf, { recursive: true, force: true })
  ]));
  const sources = ["one.mjs", "two.json"];
  const texts = ["export const one = 1;\n", "{\n  \"two\": 2\n}\n"];
  await Promise.all(sources.flatMap((source, index) => [
    writeFile(path.join(lf, source), texts[index]),
    writeFile(path.join(crlf, source), texts[index].replace(/\n/g, "\r\n"))
  ]));
  assert.equal(
    await generatorRevision({ sourceRoot: lf, sources }),
    await generatorRevision({ sourceRoot: crlf, sources })
  );
});

test("namespace assignment follows the engine's own grouping", () => {
  assert.equal(scriptNamespaceOfModulePath(["b2d", "body"]), "b2d");
  assert.equal(scriptNamespaceOfModulePath("gui"), "gui");
  const modules = new Set(["gui", "go", "b2d"]);
  assert.equal(scriptNamespaceOfTypeName("defold_api.gui", modules), "gui");
  assert.equal(scriptNamespaceOfTypeName("defold_enum.go.PLAYBACK", modules), "go");
  assert.equal(scriptNamespaceOfTypeName("message.go.acquire_input_focus", modules), "go");
  assert.equal(scriptNamespaceOfTypeName("b2d.aabb", modules), "b2d");
  // No module owns these, and inventing one would create a namespace two
  // revisions could not share.
  assert.equal(scriptNamespaceOfTypeName("hash", modules), "@shared");
  assert.equal(scriptNamespaceOfTypeName("on_input.action", modules), "@shared");
  assert.equal(dmsdkNamespaceOfHeader("upstream/defold/engine/gui/src/dmsdk/gui/gui.h"), "gui");
  assert.equal(dmsdkNamespaceOfHeader("engine/x/src/private/x.h"), null);
});

test("absolute checkout paths are normalized out of policy content", () => {
  assert.equal(normalizePaths("/checkout/engine/x.h", "/checkout"), "engine/x.h");
  assert.deepEqual(normalizePaths({ a: ["/checkout/y"] }, "/checkout/"), { a: ["y"] });
});

test("deriving the same inputs twice produces identical hashes", () => {
  const first = buildPolicy(fixture());
  const second = buildPolicy(fixture());
  assert.equal(first.rootHash, second.rootHash);
  assert.deepEqual([...first.objects.keys()].sort(), [...second.objects.keys()].sort());
  for (const [hash, bytes] of first.objects) assert.equal(second.objects.get(hash), bytes);
  // Every object is addressed by the hash of its own bytes.
  for (const [hash, bytes] of first.objects) assert.equal(hashBytes(bytes), hash);
  assert.equal(hashBytes(first.rootBytes), first.rootHash);
});

test("policy roots carry only the realization capabilities their payload uses", () => {
  const compilerSurface = {
    documents: {},
    sdk: {
      "script/types.ts": { mode: "render-and-verify" },
      "dmsdk/types.ts": { mode: "render-and-verify" },
      "script/value-target-support.ts": { mode: "authenticated-compatibility-source" }
    },
    realizationRecipes: {
      documents: {},
      sdk: {
        "script/types.ts": "sdk.script.types.render.v1",
        "dmsdk/types.ts": "sdk.dmsdk.types.render.v1",
        "script/value-target-support.ts": "sdk.compatibility-source.copy.v1"
      }
    }
  };
  const policy = buildPolicy(fixture({ compilerSurface }));
  assert.deepEqual(policy.root.realizer, {
    minimumPackageVersion: "0.0.0",
    requiredCapabilities: [
      "policy.compiler-surface.references.v1",
      "policy.content-addressed-graph.v1",
      "sdk.compatibility-source.copy.v1",
      "sdk.dmsdk.types.render.v1",
      "sdk.script.types.render.v1"
    ]
  });
  assert.deepEqual(buildPolicyRealizer({ compilerSurface: undefined }), {
    minimumPackageVersion: "0.0.0",
    requiredCapabilities: ["policy.content-addressed-graph.v1"]
  });
  const introduced = Object.fromEntries(POLICY_REALIZER_CAPABILITIES.map((capability) => [
    capability,
    { introducedInVersion: capability === "sdk.script.types.render.v1" ? "2.4.0" : "1.3.0" }
  ]));
  assert.equal(
    buildPolicyRealizer({ compilerSurface, capabilityRegistry: introduced }).minimumPackageVersion,
    "2.4.0",
    "the floor is the newest capability actually required, not the producer package version"
  );
});

test("dmSDK universal policies require the package-owned bounded Static Hermes frame", () => {
  const compilerSurface = {
    documents: {
      "defold-dmsdk-universal-bindings.json": {}
    },
    sdk: {},
    realizationRecipes: {
      documents: {
        "defold-dmsdk-universal-bindings.json": "policy.compiler-document.dmsdk-universal.v1"
      },
      sdk: {}
    }
  };
  assert.deepEqual(buildPolicyRealizer({ compilerSurface }), {
    minimumPackageVersion: "0.0.0",
    requiredCapabilities: [
      DMSDK_UNIVERSAL_STATIC_FRAME_CAPABILITY,
      "policy.compiler-document.dmsdk-universal.v1",
      "policy.compiler-surface.references.v1",
      "policy.content-addressed-graph.v1"
    ]
  });
  assert.deepEqual(POLICY_REALIZER_CAPABILITY_REGISTRY[DMSDK_UNIVERSAL_STATIC_FRAME_CAPABILITY], {
    introducedInVersion: "0.0.0",
    schema: DMSDK_UNIVERSAL_STATIC_FRAME_SCHEMA,
    argumentCapacity: DMSDK_UNIVERSAL_STATIC_FRAME_CAPACITY
  });
});

test("index entries and the shipped index preserve the root realization contract", () => {
  const policy = buildPolicy(fixture());
  const entry = buildIndexEntry({
    defoldRevision: "a".repeat(40),
    policyRoot: policy.rootHash,
    generator: policy.root.generator,
    realizer: policy.root.realizer
  });
  assert.deepEqual(entry.realizer, policy.root.realizer);
  const shipped = buildShippedIndex({
    site: {
      baseUrl: "https://example.test/deherm",
      pathPrefix: "policies",
      layoutVersion: "v1",
      channels: ["stable"],
      channelInfoUrl: "https://example.test/{channel}/info.json"
    },
    entries: [entry]
  });
  assert.deepEqual(shipped.entries[0].realizer, policy.root.realizer);
});

test("two inputs differing in one namespace share every other subtree", () => {
  const base = buildPolicy(fixture());
  const moved = fixture();
  moved.scriptIr = {
    ...moved.scriptIr,
    functions: moved.scriptIr.functions.map((fn) =>
      fn.modulePath[0] === "gui" ? { ...fn, parameters: [{ rawName: "node", optional: true }] } : fn)
  };
  const changed = buildPolicy(moved);

  assert.notEqual(base.rootHash, changed.rootHash, "the root must move when a subtree moves");
  assert.notEqual(base.subtrees.gui, changed.subtrees.gui, "gui's subtree must move");
  const shared = Object.keys(base.subtrees).filter((key) => key !== "gui");
  assert.ok(shared.length > 3, "the fixture must have other subtrees to share");
  for (const key of shared) {
    assert.equal(base.subtrees[key], changed.subtrees[key], `${key} must be shared between the two revisions`);
  }
  // Storage is additive: the second revision contributes exactly the objects
  // that actually moved.
  const added = [...changed.objects.keys()].filter((hash) => !base.objects.has(hash));
  assert.deepEqual(added, [changed.subtrees.gui]);
});

test("a generator revision change moves the root but no subtree", () => {
  const base = buildPolicy(fixture());
  const newer = buildPolicy(fixture({ generator: "sha256:newer" }));
  assert.notEqual(base.rootHash, newer.rootHash);
  assert.deepEqual(base.subtrees, newer.subtrees);
});

test("no policy object may carry the Defold revision", () => {
  const revision = "a".repeat(40);
  const policy = buildPolicy(fixture());
  assert.doesNotThrow(() => assertNoRevisionLeak({ rootBytes: policy.rootBytes, objects: policy.objects, revision }));

  // The guard has to be able to fail, or it proves nothing. The runtime
  // handshake is the input that actually carried a revision.
  const leaky = fixture();
  leaky.routeProfiles.profiles.only.manifest = `manifest-for-${revision}`;
  const bad = buildPolicy(leaky);
  assert.throws(
    () => assertNoRevisionLeak({ rootBytes: bad.rootBytes, objects: bad.objects, revision }),
    /carries the Defold revision/
  );
});

test("SDK manifest snapshots must hash revision-abstracted bytes", () => {
  const revision = "a".repeat(40);
  const compilerSurface = {
    documents: {},
    sdk: {
      "script/example.ts": {
        mode: "authenticated-compatibility-source",
        source: `export const revision = ${JSON.stringify(revision)};\n`,
        sha256: hashBytes(`export const revision = ${JSON.stringify(revision)};\n`),
        inputs: []
      }
    },
    realizationRecipes: {
      documents: {},
      sdk: { "script/example.ts": "sdk.compatibility-source.copy.v1" }
    }
  };
  assert.throws(
    () => buildPolicy(fixture({ compilerSurface })),
    /digest is not over revision-abstracted source bytes/
  );
});

test("the runtime handshake's revision-keyed fields are stripped and reconstructible", () => {
  const policy = buildPolicy(fixture());
  const profiles = JSON.parse(policy.objects.get(policy.subtrees["@profiles"]));
  assert.equal(profiles.profiles.only.runtimeHandshake.defoldRevision, undefined);
  assert.equal(profiles.profiles.only.runtimeHandshake.catalogSha256, undefined);
  assert.deepEqual(profiles.profiles.only.boundAtResolution, ["defoldRevision", "catalogSha256"]);
  assert.deepEqual(profiles.catalogRecipe.profileFields, ["features", "capabilityBits", "routeSetSha256"]);
  assert.deepEqual(profiles.catalogRecipe.profileOrder, ["only"]);
});

test("only engine targets belong in a Defold revision's policy", () => {
  const policy = buildPolicy(fixture());
  const shared = JSON.parse(policy.objects.get(policy.subtrees["@shared"]));
  assert.deepEqual(Object.keys(shared.registration), ["defold-engine"]);
  // Refusals are the load-bearing part: they are what stops a later generation
  // from guessing.
  assert.equal(shared.registration["defold-engine"].blockers.length, 1);
  // `<globals>` is a parser marker, not a namespace, and must not become a key.
  assert.equal("<globals>" in policy.subtrees, false);
});

test("a dmSDK declaration outside dmsdk/<namespace>/ fails closed", () => {
  const bad = fixture();
  bad.dmsdkIr.declarations = [{ id: "dmsdk:X", name: "X", header: "engine/x/src/private/x.h" }];
  assert.throws(() => buildPolicy(bad), /carry no dmsdk\/<namespace>\/ header/);
});

test("path templates carry the schema version and never a root-level segment", () => {
  assert.equal(indexPath("v1", "abc"), "v1/index/abc.json");
  assert.equal(policyPath("v1", "abc"), "v1/policy/abc.json");
  assert.equal(objectPath("v1", "abc"), "v1/object/abc.json");
  for (const value of [indexPath("v1", "a"), policyPath("v1", "a"), objectPath("v1", "a")]) {
    assert.equal(value.startsWith("/"), false);
    assert.equal(value.split("/")[0], "v1");
  }
});

// ── Defold's own toolchain pins ─────────────────────────────────────────────

test("sdk.py pins are read verbatim, including its derived compositions", () => {
  const source = [
    "import os",
    "DYNAMO_HOME=os.environ.get('DYNAMO_HOME', 'x')",
    'VERSION_XCODE="26.5" # comment',
    'VERSION_MACOSX="26.5"',
    "ANDROID_TARGET_API_LEVEL = 36",
    'ANDROID_PACKAGE = "android-%s" % ANDROID_TARGET_API_LEVEL',
    'EMSCRIPTEN_VERSION_STR  =  "4.0.6"',
    'PACKAGES_EMSCRIPTEN_SDK = f"emsdk-{EMSCRIPTEN_VERSION_STR}"',
    'PACKAGES_MACOS_SDK="MacOSX%s.sdk" % VERSION_MACOSX',
    "    LOCAL_ONLY='no'"
  ].join("\n");
  const { bound, refusals } = parseSdkPins(source);
  assert.equal(bound.VERSION_XCODE, "26.5");
  assert.equal(bound.ANDROID_PACKAGE, "android-36");
  assert.equal(bound.PACKAGES_EMSCRIPTEN_SDK, "emsdk-4.0.6");
  assert.equal(bound.PACKAGES_MACOS_SDK, "MacOSX26.5.sdk");
  assert.equal(bound.LOCAL_ONLY, undefined, "an indented assignment is a local, not a pin");
  assert.ok(refusals.some((row) => row.symbol === "DYNAMO_HOME"));
});

test("sdk.py pin parsing is independent of checkout newline encoding", () => {
  const source = [
    'VERSION_XCODE="26.5" # comment',
    'ANDROID_NDK_API_VERSION="19" # Android 4.4',
    'PACKAGES_XCODE_TOOLCHAIN="XcodeDefault%s.xctoolchain" % VERSION_XCODE'
  ].join("\r\n");
  const { bound, refusals } = parseSdkPins(source);
  assert.deepEqual(refusals, []);
  assert.deepEqual(bound, {
    VERSION_XCODE: "26.5",
    ANDROID_NDK_API_VERSION: "19",
    PACKAGES_XCODE_TOOLCHAIN: "XcodeDefault26.5.xctoolchain"
  });
});

test("a pin that moves out of sdk.py is a hard failure, not a silent omission", () => {
  assert.throws(
    () => buildToolchainPins({ sdkSource: 'VERSION_XCODE="26.5"', buildInputPlatforms: [] }),
    /no longer declares/
  );
});

test("the real sdk.py yields every pin the decision names", async () => {
  const sdkSource = await readFile(path.join(repositoryRoot, "upstream/defold/build_tools/sdk.py"), "utf8");
  const toolchain = buildToolchainPins({ sdkSource, buildInputPlatforms: ["x86_64-linux", "common"] });
  for (const symbol of [
    "VERSION_IPHONEOS_MIN", "VERSION_MACOSX_MIN", "ANDROID_NDK_VERSION", "ANDROID_NDK_API_VERSION",
    "ANDROID_TARGET_API_LEVEL", "ANDROID_BUILD_TOOLS_VERSION", "VERSION_LINUX_CLANG", "VERSION_WINDOWS_SDK",
    "VERSION_WINDOWS_MSVC", "VISUAL_STUDIO_VERSION", "EMSCRIPTEN_VERSION_STR"
  ]) {
    assert.match(toolchain.pins[symbol], /\S/, `${symbol} must be read from Defold's own declaration`);
  }
  assert.equal(toolchain.source, "upstream/defold/build_tools/sdk.py");
});

// ── The committed store ─────────────────────────────────────────────────────

test("the ownership registry declares this lane's sources, inputs and artifacts", () => {
  for (const list of [apiPolicyGenerator.sources, apiPolicyGenerator.pinnedInputs, apiPolicyGenerator.artifacts]) {
    assert.equal(new Set(list).size, list.length);
    for (const value of list) {
      assert.equal(value.startsWith("/"), false);
      assert.equal(value.split("/").includes(".."), false);
    }
  }
  for (const step of apiPolicyGenerator.steps) assert.ok(apiPolicyGenerator.sources.includes(step.script));
  for (const artifact of apiPolicyGenerator.artifacts) {
    assert.equal(apiPolicyGenerator.sources.includes(artifact), false);
    assert.equal(apiPolicyGenerator.pinnedInputs.includes(artifact), false);
  }
});

test("the shipped index and the committed store agree", async () => {
  const index = await readJson(path.join(generated, "defold-policy-index.json"));
  const manifest = await readJson(path.join(generated, "defold-api-policy.json"));
  assert.equal(index.kind, "deherm.policy.index");
  assert.ok(index.entries.length >= 1);

  // The base is data. Nothing may be published at a root-level segment.
  const url = new URL(index.base.url);
  const segments = [...url.pathname.split("/"), ...String(index.base.pathPrefix ?? "").split("/")].filter(Boolean);
  assert.ok(segments.length >= 1, "the published base must sit beneath one owned segment");
  assert.match(index.base.layoutVersion, /^v\d+$/);
  for (const template of [index.base.index, index.base.policy, index.base.object]) {
    assert.equal(template.split("/")[0], index.base.layoutVersion);
  }

  const entry = index.entries.find((row) => row.defoldRevision === manifest.defoldRevision);
  assert.equal(entry.policyRoot, manifest.policyRoot);
  assert.equal(entry.generator, manifest.generator);

  const store = path.join(generated, "policy");
  const rootBytes = await readFile(path.join(store, policyPath(index.base.layoutVersion, entry.policyRoot)), "utf8");
  assert.equal(hashBytes(rootBytes), entry.policyRoot);
  const policyRoot = JSON.parse(rootBytes);
  assert.equal(policyRoot.kind, "deherm.policy.root");
  assert.equal(policyRoot.hash, "sha256");
  assert.equal(Object.keys(policyRoot.subtrees).length, manifest.counts.subtrees);
  for (const [namespace, hash] of Object.entries(policyRoot.subtrees)) {
    const bytes = await readFile(path.join(store, objectPath(index.base.layoutVersion, hash)), "utf8");
    assert.equal(hashBytes(bytes), hash, `${namespace} does not hash to its own path`);
  }
  // The revision lives in the index and nowhere else.
  assert.equal(rootBytes.includes(manifest.defoldRevision), false);
});

test("a base with no owned path segment is refused", async () => {
  const { readSiteConfig } = await import("../scripts/generate-api-policy.mjs");
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const directory = await mkdtemp(path.join(tmpdir(), "deherm-policy-site-config-"));

  const write = async (config) => {
    const file = path.join(directory, "policy-site.json");
    await writeFile(file, JSON.stringify(config));
    return file;
  };
  // A top-level /v1/index/ would collide with whatever the shared organisation
  // domain routes now or later, so it is refused rather than published.
  await assert.rejects(
    readSiteConfig(await write({ baseUrl: "https://example.org", pathPrefix: "", layoutVersion: "v1" })),
    /no owned path segment/
  );
  await assert.rejects(
    readSiteConfig(await write({ baseUrl: "https://example.org/", pathPrefix: "/", layoutVersion: "v1" })),
    /no owned path segment/
  );
  // An org-site repository removes the repository-name prefix; `pathPrefix` is
  // what restores an owned segment without a code change.
  const viaPrefix = await readSiteConfig(await write({ baseUrl: "https://example.org", pathPrefix: "deherm", layoutVersion: "v1" }));
  assert.deepEqual(viaPrefix.ownedSegments, ["deherm"]);
  const viaRepositoryName = await readSiteConfig(await write({ baseUrl: "https://example.org/deherm", pathPrefix: "", layoutVersion: "v1" }));
  assert.deepEqual(viaRepositoryName.ownedSegments, ["deherm"]);
  await assert.rejects(
    readSiteConfig(await write({ baseUrl: "https://example.org/deherm", pathPrefix: "", layoutVersion: "1" })),
    /layoutVersion/
  );
});

// ── Channel tracking ────────────────────────────────────────────────────────

test("a channel whose sha is already indexed derives nothing", async () => {
  const { planChannels } = await import("../scripts/track-defold-channels.mjs");
  const known = "b".repeat(40);
  const fresh = "c".repeat(40);
  const responses = {
    "https://example.test/stable/info.json": { version: "1.0.0", sha1: known },
    "https://example.test/beta/info.json": { version: "1.1.0", sha1: fresh },
    // Two channels resolving to one sha must contribute one derivation, not two.
    "https://example.test/alpha/info.json": { version: "1.1.0", sha1: fresh }
  };
  const fetchImpl = async (url) => ({ ok: url in responses, status: 404, json: async () => responses[url] });
  const plan = await planChannels({
    site: { channels: ["stable", "beta", "alpha"], channelInfoUrl: "https://example.test/{channel}/info.json" },
    index: { entries: [{ defoldRevision: known, policyRoot: "r", generator: "g" }] },
    fetchImpl
  });
  assert.deepEqual(plan.covered.map((row) => row.channel), ["stable"]);
  assert.deepEqual(plan.derive.map((row) => row.sha1), [fresh]);
});

test("an unreachable channel is an error, never an empty plan", async () => {
  const { planChannels } = await import("../scripts/track-defold-channels.mjs");
  const site = { channels: ["stable"], channelInfoUrl: "https://example.test/{channel}/info.json" };
  const index = { entries: [] };
  await assert.rejects(
    planChannels({ site, index, fetchImpl: async () => ({ ok: false, status: 503 }) }),
    /HTTP 503/
  );
  await assert.rejects(
    planChannels({ site, index, fetchImpl: async () => ({ ok: true, json: async () => ({ sha1: "not-a-sha" }) }) }),
    /not a Defold revision/
  );
});

test("channel planning can use the accumulated published manifest instead of the packaged index", async () => {
  const { planChannels } = await import("../scripts/track-defold-channels.mjs");
  const directory = await mkdtemp(path.join(tmpdir(), "deherm-published-index-"));
  const indexPath = path.join(directory, "manifest.json");
  const revision = "f".repeat(40);
  await writeFile(indexPath, JSON.stringify({ entries: [{ defoldRevision: revision, policyRoot: "root" }] }));
  const plan = await planChannels({
    site: { channels: ["stable"], channelInfoUrl: "https://example.test/{channel}/info.json" },
    indexPath,
    fetchImpl: async () => ({ ok: true, json: async () => ({ sha1: revision, version: "1.0.0" }) })
  });
  assert.deepEqual(plan.derive, []);
  assert.equal(plan.covered[0].policyRoot, "root");
});

test("pinning a revision records the digest the archive actually served", async () => {
  const { pinRevision } = await import("../scripts/track-defold-channels.mjs");
  const revision = "d".repeat(40);
  const bodies = { "ref-doc.zip": "REFDOC", "bob.jar": "BOB" };
  const fetchImpl = async (url) => ({
    ok: true,
    arrayBuffer: async () => Buffer.from(url.endsWith("bob.jar") ? bodies["bob.jar"] : bodies["ref-doc.zip"])
  });
  const lock = [
    "DEFOLD_REV=" + "e".repeat(40),
    "DEFOLD_REF_DOC_URL=old",
    "DEFOLD_REF_DOC_SHA256=old",
    "DEFOLD_BOB_URL=old",
    "DEFOLD_BOB_SHA256=old",
    "HERMES_REV=keepme"
  ].join("\n");
  const { updated, replacements } = await pinRevision(revision, { fetchImpl, lock });
  assert.equal(replacements.DEFOLD_REV, revision);
  assert.equal(replacements.DEFOLD_REF_DOC_SHA256, createHash("sha256").update("REFDOC").digest("hex"));
  assert.equal(replacements.DEFOLD_BOB_SHA256, createHash("sha256").update("BOB").digest("hex"));
  assert.match(updated, /^HERMES_REV=keepme$/m, "pins that are a separate decision must not move");
  await assert.rejects(pinRevision("nope", { fetchImpl, lock }), /Not a Defold revision/);
});
