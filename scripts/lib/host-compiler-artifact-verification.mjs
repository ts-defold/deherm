import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Verify one freshly produced host tool against the exact record consumers
 * receive in packages/toolchains/host-compilers.json.
 *
 * Publication must not infer this from a successful build or from the release
 * asset's presence. The consumer authenticates both these bytes and this size,
 * so the producer has to prove the same contract before upload.
 */
export async function verifyPinnedHostToolFile({ manifest, host, tool, file }) {
  const record = manifest.hosts?.[host]?.tools?.[tool];
  if (!record) {
    throw new Error(`Host compiler manifest declares no ${tool} for ${host}`);
  }
  if (record.status !== "vendored") {
    throw new Error(`${host} ${tool} is ${record.status}, not a publishable vendored tool`);
  }
  if (!/^[a-f0-9]{64}$/u.test(record.sha256 ?? "")) {
    throw new Error(`${host} ${tool} has no valid pinned SHA-256`);
  }
  if (!Number.isSafeInteger(record.bytes) || record.bytes <= 0) {
    throw new Error(`${host} ${tool} has no valid pinned byte size`);
  }

  const absolute = path.resolve(file);
  const bytes = await readFile(absolute);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (bytes.byteLength !== record.bytes) {
    throw new Error(
      `${host} ${tool} is ${bytes.byteLength} bytes at ${absolute}; manifest expects ${record.bytes}`
    );
  }
  if (sha256 !== record.sha256) {
    throw new Error(
      `${host} ${tool} hashes ${sha256} at ${absolute}; manifest expects ${record.sha256}`
    );
  }
  return { host, tool, file: absolute, bytes: bytes.byteLength, sha256 };
}
