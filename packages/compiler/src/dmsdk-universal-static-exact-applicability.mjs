import { createHash } from "node:crypto";

import { dmSdkUniversalStaticFrameCapability } from "./dmsdk-universal-static-frame.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function wireTag(value) {
  return typeof value === "string" && value.length ? value : "missing";
}

export function partitionDmSdkUniversalStaticExactVectors(
  vectors,
  capability = dmSdkUniversalStaticFrameCapability(),
) {
  if (!Array.isArray(vectors)) throw new Error("Static dmSDK exact vectors must be an array");
  if (!Number.isSafeInteger(capability?.argumentCapacity) || capability.argumentCapacity < 0) {
    throw new Error("Static dmSDK exact capability needs a non-negative integer argumentCapacity");
  }
  const argumentWireTags = new Set(capability.argumentWireTags ?? []);
  const resultWireTags = new Set(capability.resultWireTags ?? []);
  if (!argumentWireTags.size || !resultWireTags.size) {
    throw new Error("Static dmSDK exact capability needs explicit argument and result wire tags");
  }

  const rows = vectors.map((vector, vectorIndex) => {
    const blockers = [];
    const argumentCount = vector?.argumentCount;
    const wireArguments = Array.isArray(vector?.wireArguments) ? vector.wireArguments : [];
    if (!Number.isSafeInteger(argumentCount) || argumentCount < 0) {
      blockers.push("static-frame-arity-invalid");
    } else {
      if (argumentCount > capability.argumentCapacity) {
        blockers.push(`static-frame-arity-exceeds-capacity:${argumentCount}:${capability.argumentCapacity}`);
      }
      if (wireArguments.length !== argumentCount) {
        blockers.push(`static-frame-wire-argument-count-mismatch:${wireArguments.length}:${argumentCount}`);
      }
    }
    const argumentTags = wireArguments.map(({ tag } = {}) => wireTag(tag));
    for (const [slot, tag] of argumentTags.entries()) {
      if (!argumentWireTags.has(tag)) {
        blockers.push(`static-frame-argument-wire-tag-unsupported:${slot}:${tag}`);
      }
    }
    const resultTag = wireTag(vector?.result?.fakeReturn?.tag);
    if (!resultWireTags.has(resultTag)) {
      blockers.push(`static-frame-result-wire-tag-unsupported:${resultTag}`);
    }
    return {
      vectorIndex,
      declarationId: vector?.declarationId ?? null,
      numericId: vector?.numericId ?? null,
      vectorSha256: vector?.vectorSha256 ?? null,
      argumentCount: Number.isSafeInteger(argumentCount) ? argumentCount : null,
      argumentWireTags: argumentTags,
      resultWireTag: resultTag,
      disposition: blockers.length ? "blocked-capability" : "execute",
      blockers,
    };
  });
  const applicableVectorCount = rows.filter(({ disposition }) => disposition === "execute").length;
  const body = {
    schemaVersion: 1,
    source: "deherm-dmsdk-static-exact-applicability",
    capability: {
      id: capability.id,
      schema: capability.schema,
      argumentCapacity: capability.argumentCapacity,
      argumentWireTags: [...argumentWireTags],
      resultWireTags: [...resultWireTags],
    },
    vectorCount: rows.length,
    applicableVectorCount,
    blockedVectorCount: rows.length - applicableVectorCount,
    vectors: rows,
  };
  return Object.freeze({ ...body, partitionSha256: sha256(JSON.stringify(body)) });
}
