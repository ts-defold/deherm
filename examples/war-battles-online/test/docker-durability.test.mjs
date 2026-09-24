import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { replaceDurably } from "../server/durable-file.ts";

const exampleRoot = resolve(import.meta.dirname, "..");
const dockerRoot = join(exampleRoot, "docker");

test("Docker deployment owns durable resume state and readiness", async () => {
  const [compose, dockerfile, entrypoint, initVolumes, docs, packageJson, worldFile, durableFile] = await Promise.all([
    readFile(join(dockerRoot, "compose.yaml"), "utf8"),
    readFile(join(dockerRoot, "Dockerfile"), "utf8"),
    readFile(join(dockerRoot, "entrypoint.sh"), "utf8"),
    readFile(join(dockerRoot, "init-volumes.sh"), "utf8"),
    readFile(join(dockerRoot, "README.md"), "utf8"),
    readFile(join(exampleRoot, "package.json"), "utf8"),
    readFile(join(exampleRoot, "server/durable-world-file.ts"), "utf8"),
    readFile(join(exampleRoot, "server/durable-file.ts"), "utf8"),
  ]);

  assert.match(compose, /war-battles-local-state:\s*\/srv\/war-battles-online\/server\/state/u);
  assert.match(compose, /war-battles-local-cert:\s*\/srv\/war-battles-online\/server\/certs/u);
  assert.match(compose, /restart:\s*unless-stopped/u);
  assert.match(compose, /127\.0\.0\.1:\$\{WAR_BATTLES_HEALTH_PORT:-8080\}:8080\/tcp/u);
  assert.match(dockerfile, /HEALTHCHECK[\s\S]*readyz/u);
  assert.match(dockerfile, /USER 10001:10001/u);
  assert.match(compose, /war-battles-init:/u);
  assert.match(compose, /condition:\s*service_completed_successfully/u);
  assert.doesNotMatch(initVolumes, /chown\s+-R/u);
  assert.match(initVolumes, /refusing symbolic link in War Battles volume/u);
  assert.match(initVolumes, /\*\.key\|\*\.hex\|\*\.bin\|\*\.tmp\) chmod 0600/u);
  for (const owned of [
    "localhost.crt",
    "localhost.key",
    "fingerprint.txt",
    "resume-key.hex",
    "sessions.bin",
    "world.bin",
  ]) {
    assert.match(initVolumes, new RegExp(owned.replace(".", "\\."), "u"));
  }
  assert.match(entrypoint, /ensure-resume-key\.sh/u);
  assert.match(entrypoint, /--allow-env/u);
  assert.match(entrypoint, /--resume-key-file \.\/server\/state\/resume-key\.hex/u);
  assert.match(entrypoint, /--session-state \.\/server\/state\/sessions\.bin/u);
  assert.match(entrypoint, /--world-checkpoint \.\/server\/state\/world\.bin/u);
  assert.match(worldFile, /replaceDurably\(Deno, this\.temporaryPath, this\.path, bytes\)/u);
  assert.match(durableFile, /await handle\.sync\(\)/u);
  assert.match(durableFile, /await runtime\.rename\(temporaryPath, path\)/u);
  assert.match(docs, /not evidence for WebTransport or datagrams/u);
  assert.match(docs, /Production still needs/u);
  assert.match(packageJson, /runtime:websocket:docker/u);

  // When Compose is available, validate the rendered model as well as the
  // source contract. `config` is a read-only operation and needs no daemon.
  const composeBinary = (() => {
    try {
      execFileSync("docker", ["compose", "version"], { stdio: "ignore" });
      return ["docker", "compose"];
    } catch {
      return ["docker-compose"];
    }
  })();
  try {
    const rendered = JSON.parse(
      execFileSync(
        composeBinary[0],
        [...composeBinary.slice(1), "-f", join(dockerRoot, "compose.yaml"), "config", "--format", "json"],
        { encoding: "utf8" },
      ),
    );
    const service = rendered.services?.["war-battles"];
    assert.ok(service, "Compose must define the war-battles service");
    const mounts = new Map((service.volumes ?? []).map((volume) => [volume.target, volume.source]));
    assert.match(mounts.get("/srv/war-battles-online/server/state") ?? "", /war-battles-local-state$/u);
    assert.match(mounts.get("/srv/war-battles-online/server/certs") ?? "", /war-battles-local-cert$/u);
    assert.equal(service.restart, "unless-stopped");
    assert.equal(service.user, "10001:10001");
    assert.ok(rendered.services?.["war-battles-init"], "Compose must define its bounded volume migrator");
  } catch (error) {
    // A checkout without Compose still gets the source-level deterministic
    // assertions above; the runtime gate reports the missing tool separately.
    if (error?.code !== "ENOENT") throw error;
  }
});

test("durable replacement syncs file bytes and rename metadata in order", async () => {
  const events = [];
  const runtime = {
    async writeFile(path, bytes, options) {
      events.push(`write:${path}:${bytes.length}:${options?.mode}`);
    },
    async chmod(path, mode) {
      events.push(`chmod:${path}:${mode}`);
    },
    async rename(from, to) {
      events.push(`rename:${from}:${to}`);
    },
    async open(path) {
      events.push(`open:${path}`);
      return {
        async sync() {
          events.push(`sync:${path}`);
        },
        close() {
          events.push(`close:${path}`);
        },
      };
    },
  };
  await replaceDurably(runtime, "/state/world.bin.tmp", "/state/world.bin", Uint8Array.of(1, 2, 3));
  assert.deepEqual(events, [
    "write:/state/world.bin.tmp:3:384",
    "chmod:/state/world.bin.tmp:384",
    "open:/state/world.bin.tmp",
    "sync:/state/world.bin.tmp",
    "close:/state/world.bin.tmp",
    "rename:/state/world.bin.tmp:/state/world.bin",
    "open:/state",
    "sync:/state",
    "close:/state",
  ]);
});

test("durable replacement never renames unsynced bytes and tolerates only unsupported directory sync", async () => {
  let renamed = false;
  const unsynced = {
    async writeFile() {},
    async chmod() {},
    async rename() {
      renamed = true;
    },
    async open() {
      return {
        async sync() {
          throw new Error("disk sync failed");
        },
        close() {},
      };
    },
  };
  await assert.rejects(replaceDurably(unsynced, "/state/a.tmp", "/state/a", Uint8Array.of(1)), /disk sync failed/);
  assert.equal(renamed, false);

  const opened = [];
  const unsupportedDirectory = {
    async writeFile() {},
    async chmod() {},
    async rename() {},
    async open(path) {
      opened.push(path);
      return {
        async sync() {
          if (path === "/state") throw Object.assign(new Error("directory sync unavailable"), { code: "ENOTSUP" });
        },
        close() {
          opened.push(`closed:${path}`);
        },
      };
    },
  };
  await replaceDurably(unsupportedDirectory, "/state/a.tmp", "/state/a", Uint8Array.of(1));
  assert.deepEqual(opened, ["/state/a.tmp", "closed:/state/a.tmp", "/state", "closed:/state"]);
});

test("resume key generation is stable, private, and rejects malformed state", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "war-battles-state-"));
  const script = join(exampleRoot, "server", "ensure-resume-key.sh");
  try {
    await chmod(scratch, 0o755);
    const first = spawnSync(script, [scratch], { encoding: "utf8" });
    assert.equal(first.status, 0, first.stderr);
    const keyPath = join(scratch, "resume-key.hex");
    const firstBytes = await readFile(keyPath);
    assert.match(firstBytes.toString(), /^[0-9a-f]{64}\n$/u);
    assert.equal((await stat(keyPath)).mode & 0o777, 0o600);
    assert.equal((await stat(scratch)).mode & 0o777, 0o700);

    const second = spawnSync(script, [scratch], { encoding: "utf8" });
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(await readFile(keyPath), firstBytes, "a restart must not rotate the resume key");

    await writeFile(keyPath, `${"a".repeat(63)}x\n`);
    const malformed = spawnSync(script, [scratch], { encoding: "utf8" });
    assert.notEqual(malformed.status, 0);
    assert.match(malformed.stderr, /resume key must be one line/u);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
