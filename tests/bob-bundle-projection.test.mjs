import assert from "node:assert/strict";
import test from "node:test";

import { RELEASE_BUNDLE_RESOURCE, bobBundleProjection } from "../packages/cli/src/bob-bundle-projection.mjs";

const resource = "/deherm/app.dehermc";

test("native release archives optimized Hermes bytecode only", () => {
  assert.deepEqual(bobBundleProjection({ resource, runtimeId: "hermes", variant: "release" }), {
    representation: "hermes-bytecode",
    resource: RELEASE_BUNDLE_RESOURCE,
    include: [RELEASE_BUNDLE_RESOURCE],
    ignore: [resource, `${resource}.hbc`, `${resource}.map`],
  });
});

test("Static Hermes release archives no dynamic application", () => {
  assert.deepEqual(
    bobBundleProjection({ resource, runtimeId: "hermes", variant: "release", applicationMode: "static" }),
    {
      representation: "static-application",
      resource: null,
      include: [],
      ignore: [resource, `${resource}.hbc`, `${resource}.map`, RELEASE_BUNDLE_RESOURCE],
    },
  );
});

test("Static Hermes debug also archives no dynamic application", () => {
  assert.equal(
    bobBundleProjection({ resource, runtimeId: "hermes", variant: "debug", applicationMode: "static" }).representation,
    "static-application",
  );
});

test("browser release archives JavaScript only and no source map", () => {
  assert.deepEqual(bobBundleProjection({ resource, runtimeId: "browser", variant: "release" }), {
    representation: "javascript",
    resource,
    include: [resource],
    ignore: [`${resource}.hbc`, `${resource}.map`, RELEASE_BUNDLE_RESOURCE],
  });
});

test("debug archives authored JavaScript but not compiler sidecars", () => {
  assert.deepEqual(bobBundleProjection({ resource, runtimeId: "hermes", variant: "debug" }), {
    representation: "javascript",
    resource,
    include: [resource],
    ignore: [`${resource}.hbc`, `${resource}.map`, RELEASE_BUNDLE_RESOURCE],
  });
});

test("unknown variants and modes fail closed", () => {
  assert.throws(
    () => bobBundleProjection({ resource, runtimeId: "hermes", variant: "profile" }),
    /Unknown Bob variant/u,
  );
  assert.throws(
    () => bobBundleProjection({ resource, runtimeId: "hermes", variant: "release", applicationMode: "jit" }),
    /Unknown application mode/u,
  );
  assert.throws(
    () => bobBundleProjection({ resource, runtimeId: "browser", variant: "release", applicationMode: "static" }),
    /requires the Hermes runtime/u,
  );
  assert.throws(
    () => bobBundleProjection({ resource: "/deherm/app.js", runtimeId: "hermes", variant: "release" }),
    /must end in \.dehermc/u,
  );
});

test("a custom application resource receives a sibling release resource", () => {
  assert.equal(
    bobBundleProjection({ resource: "/runtime/game.dehermc", runtimeId: "hermes", variant: "release" }).resource,
    "/runtime/game.release.dehermc",
  );
});
