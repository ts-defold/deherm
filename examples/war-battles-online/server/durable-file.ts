/** Minimal Deno file surface needed for an atomic, crash-durable replacement. */
export interface DurableFileHandle {
  sync(): Promise<void>;
  close(): void;
}

export interface DurableFileRuntime {
  writeFile(path: string, data: Uint8Array, options?: { mode?: number }): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  open(path: string, options: { read?: boolean; write?: boolean }): Promise<DurableFileHandle>;
}

/**
 * Writes, fsyncs, renames, then fsyncs the containing directory. The temporary
 * file sync is mandatory. Directory sync is skipped only on hosts that report
 * the operation itself as unsupported; all other failures remain fail-closed.
 */
export async function replaceDurably(
  runtime: DurableFileRuntime,
  temporaryPath: string,
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  await runtime.writeFile(temporaryPath, new Uint8Array(bytes), { mode: 0o600 });
  // `mode` only applies when a file is created. An interrupted previous write
  // may have left the sibling temp file behind, so enforce privacy every time.
  await runtime.chmod(temporaryPath, 0o600);
  await syncPath(runtime, temporaryPath, { read: true, write: true }, false);
  await runtime.rename(temporaryPath, path);
  await syncPath(runtime, parentDirectory(path), { read: true }, true);
}

async function syncPath(
  runtime: DurableFileRuntime,
  path: string,
  options: { read?: boolean; write?: boolean },
  allowUnsupported: boolean,
): Promise<void> {
  let handle: DurableFileHandle | undefined;
  try {
    handle = await runtime.open(path, options);
    await handle.sync();
  } catch (error: unknown) {
    if (!allowUnsupported || !isUnsupportedDirectorySync(error)) throw error;
  } finally {
    handle?.close();
  }
}

function parentDirectory(path: string): string {
  const trimmed = path.replace(/[\\/]+$/u, "");
  const separator = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (separator < 0) return ".";
  return separator === 0 ? trimmed.slice(0, 1) : trimmed.slice(0, separator);
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { name?: unknown; code?: unknown };
  return candidate.name === "NotSupported"
    || candidate.code === "EINVAL"
    || candidate.code === "ENOTSUP"
    || candidate.code === "EOPNOTSUPP";
}
