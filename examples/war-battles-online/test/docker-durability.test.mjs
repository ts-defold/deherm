import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const exampleRoot = resolve(import.meta.dirname, "..");
const dockerRoot = join(exampleRoot, "docker");

test("Docker deployment owns durable resume state and readiness", async () => {
  const [compose, dockerfile, entrypoint, docs, packageJson, worldFile] = await Promise.all([
    readFile(join(dockerRoot, "compose.yaml"), "utf8"),
    readFile(join(dockerRoot, "Dockerfile"), "utf8"),
    readFile(join(dockerRoot, "entrypoint.sh"), "utf8"),
    readFile(join(dockerRoot, "README.md"), "utf8"),
    readFile(join(exampleRoot, "package.json"), "utf8"),
    readFile(join(exampleRoot, "server/durable-world-file.ts"), "utf8"),
  ]);

  assert.match(compose, /war-battles-local-state:\s*\/srv\/war-battles-online\/server\/state/u);
  assert.match(compose, /war-battles-local-cert:\s*\/srv\/war-battles-online\/server\/certs/u);
  assert.match(compose, /restart:\s*unless-stopped/u);
  assert.match(compose, /127\.0\.0\.1:\$\{WAR_BATTLES_HEALTH_PORT:-8080\}:8080\/tcp/u);
  assert.match(dockerfile, /HEALTHCHECK[\s\S]*readyz/u);
  assert.match(entrypoint, /ensure-resume-key\.sh/u);
  assert.match(entrypoint, /--allow-env/u);
  assert.match(entrypoint, /--resume-key-file \.\/server\/state\/resume-key\.hex/u);
  assert.match(entrypoint, /--session-state \.\/server\/state\/sessions\.bin/u);
  assert.match(entrypoint, /--world-checkpoint \.\/server\/state\/world\.bin/u);
  assert.match(worldFile, /writeFile\(this\.temporaryPath/u);
  assert.match(worldFile, /rename\(this\.temporaryPath, this\.path\)/u);
  assert.match(docs, /not evidence for WebTransport or datagrams/u);
  assert.match(docs, /Production still needs/u);
  assert.match(packageJson, /runtime:websocket:docker/u);

  // When Compose is available, validate the rendered model as well as the
  // source contract. `config` is a read-only operation and needs no daemon.
  const composeBinary = (() => {
    try { execFileSync("docker", ["compose", "version"], { stdio: "ignore" }); return ["docker", "compose"]; }
    catch { return ["docker-compose"]; }
  })();
  try {
    const rendered = JSON.parse(execFileSync(composeBinary[0], [...composeBinary.slice(1), "-f", join(dockerRoot, "compose.yaml"), "config", "--format", "json"], { encoding: "utf8" }));
    const service = rendered.services?.["war-battles"];
    assert.ok(service, "Compose must define the war-battles service");
    const mounts = new Map((service.volumes ?? []).map((volume) => [volume.target, volume.source]));
    assert.match(mounts.get("/srv/war-battles-online/server/state") ?? "", /war-battles-local-state$/u);
    assert.match(mounts.get("/srv/war-battles-online/server/certs") ?? "", /war-battles-local-cert$/u);
    assert.equal(service.restart, "unless-stopped");
  } catch (error) {
    // A checkout without Compose still gets the source-level deterministic
    // assertions above; the runtime gate reports the missing tool separately.
    if (error?.code !== "ENOENT") throw error;
  }
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
