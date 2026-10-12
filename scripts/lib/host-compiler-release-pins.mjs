import path from "node:path";

import { releaseIntegrityAssetName, validateReleaseIntegrity } from "../../packages/cli/src/release-integrity.mjs";
import { verifyReleaseAssetBytes } from "../../packages/cli/src/release-assets.mjs";

function isAvailabilityFailure(error) {
  if (error instanceof TypeError) return true;
  const message = String(error?.message ?? error);
  return /fetch failed|network|timed out|timeout|responded (429|5\d\d)\b|ENOTFOUND|ECONNRESET|ECONNREFUSED/u.test(
    message,
  );
}

async function fetchSidecar(url, { fetchAsset, retryDelaysMs, waitImpl }) {
  let lastError;
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    let response;
    try {
      response = await fetchAsset(url);
    } catch (error) {
      lastError = error;
      if (!isAvailabilityFailure(error) || attempt === retryDelaysMs.length) throw error;
      await waitImpl(retryDelaysMs[attempt]);
      continue;
    }
    if (response.ok) return response;
    lastError = new Error(`${url} responded ${response.status} ${response.statusText}`);
    if ((response.status !== 429 && response.status < 500) || attempt === retryDelaysMs.length) throw lastError;
    await waitImpl(retryDelaysMs[attempt]);
  }
  throw lastError;
}

/** Compare every vendored host-tool pin with its immutable published sidecar. */
export async function verifyHostCompilerReleasePins({
  manifest,
  releases,
  releaseTags,
  resolveAsset,
  fetchAsset,
  retryDelaysMs = [250, 500, 1_000],
  waitImpl = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  const checked = [];
  for (const release of releases) {
    const { family, tag, fingerprint, row } = release;
    const label = `${family}/${row.host}`;
    const pinnedFamily = releaseTags.families?.[family];
    if (!pinnedFamily || pinnedFamily.tag !== tag || pinnedFamily.fingerprint !== fingerprint) {
      throw new Error(`${label}: release-tags.json identity does not match ${tag} (${fingerprint})`);
    }
    if (pinnedFamily.assets?.[row.host] !== row.asset) {
      throw new Error(
        `${label}: release-tags.json names ${pinnedFamily.assets?.[row.host] ?? "no asset"}, expected ${row.asset}`,
      );
    }
    const pinnedMembers = pinnedFamily.contents?.[row.host];
    if (
      !Array.isArray(pinnedMembers) ||
      JSON.stringify([...pinnedMembers].sort()) !== JSON.stringify([...row.files].sort())
    ) {
      throw new Error(`${label}: release-tags.json member list does not match ${row.asset} (${row.files.join(", ")})`);
    }

    const sidecarName = releaseIntegrityAssetName(row.asset);
    const pinnedSidecar = pinnedFamily.integrity?.[row.host];
    if (pinnedSidecar?.asset !== sidecarName || !/^[a-f0-9]{64}$/u.test(pinnedSidecar.sha256 ?? "")) {
      throw new Error(`${label}: release-tags.json has no publisher digest for ${sidecarName}`);
    }

    let metadata;
    let bytes;
    try {
      metadata = await resolveAsset({ tag, asset: sidecarName });
      const response = await fetchSidecar(metadata.url, { fetchAsset, retryDelaysMs, waitImpl });
      bytes = Buffer.from(await response.arrayBuffer());
      verifyReleaseAssetBytes(bytes, metadata, sidecarName);
    } catch (error) {
      const kind = isAvailabilityFailure(error) ? "GitHub availability failure" : "cannot authenticate published";
      throw new Error(`${label}: ${kind} ${sidecarName}: ${error.message}`, { cause: error });
    }
    if (metadata.sha256 !== pinnedSidecar.sha256) {
      throw new Error(`${label}: GitHub publisher digest for ${sidecarName} differs from release-tags.json`);
    }

    let document;
    try {
      document = validateReleaseIntegrity(JSON.parse(bytes.toString("utf8")), {
        family,
        tag,
        fingerprint,
        asset: row.asset,
        members: row.files,
      });
    } catch (error) {
      throw new Error(`${label}: ${sidecarName}: ${error.message}`, { cause: error });
    }
    if (!tag.endsWith(document.fingerprint.slice(0, 12))) {
      throw new Error(`${label}: ${sidecarName} fingerprint does not address release ${tag}`);
    }
    if (
      document.archive.sha256 !== pinnedSidecar.archiveSha256 ||
      document.archive.bytes !== pinnedSidecar.archiveBytes
    ) {
      throw new Error(`${label}: ${sidecarName} archive digest differs from release-tags.json`);
    }

    const hostRecord = manifest.hosts?.[row.host];
    if (!hostRecord) throw new Error(`${label}: host-compilers.json has no host record`);
    for (const tool of row.tools) {
      const record = hostRecord.tools?.[tool];
      if (record?.status !== "vendored") {
        throw new Error(`${label}/${tool}: expected status vendored, observed ${record?.status ?? "missing"}`);
      }
      if (!/^[a-f0-9]{64}$/u.test(record.sha256 ?? "") || !Number.isSafeInteger(record.bytes) || record.bytes < 1) {
        throw new Error(`${label}/${tool}: host-compilers.json has an invalid SHA-256 or byte size`);
      }
      const memberName = path.posix.basename(record.file ?? "");
      const member = document.members.find((candidate) => candidate.name === memberName);
      if (!member) throw new Error(`${label}/${tool}: ${row.asset} sidecar has no member ${memberName}`);
      if (record.sha256 !== member.sha256 || record.bytes !== member.bytes) {
        throw new Error(
          `${label}/${tool}: host-compilers.json pins ${record.sha256} (${record.bytes} bytes), ` +
            `but ${row.asset} publishes ${member.sha256} (${member.bytes} bytes)`,
        );
      }
      checked.push(`${row.host}/${tool}`);
    }
  }
  return checked;
}
