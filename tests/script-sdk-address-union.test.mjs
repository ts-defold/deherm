import assert from "node:assert/strict";
import { test } from "node:test";

import { buildApiTrees, createTypeRenderer, generateTypes } from "../packages/compiler/src/sdk/script-sdk.mjs";

function fixture(rawType) {
  const model = {
    aliases: [],
    classes: [],
    enums: [],
    functions: [
      {
        modulePath: ["go"],
        jsName: "set",
        description: "",
        deprecated: null,
        generics: [],
        overloads: [],
        parameters: [{ rawName: "value", rawType, optional: false }],
        returns: [],
        returnDescriptions: [],
      },
    ],
  };
  return generateTypes(model, createTypeRenderer(model), buildApiTrees(model), new Map());
}

test("a pure string/hash/url parameter keeps the Defold address spelling", () => {
  assert.match(fixture("string|hash|url"), /\(value: DefoldAddress\): void/u);
});

test("a mixed property value keeps non-address alternatives", () => {
  const source = fixture("number|boolean|hash|string|url|vector3|vector4|quaternion|resource_data");
  assert.match(
    source,
    /\(value: number \| boolean \| DefoldHash \| string \| DefoldUrl \| Vector3 \| Vector4 \| Quaternion/u,
  );
  assert.doesNotMatch(source, /\(value: DefoldAddress\): void/u);
});
