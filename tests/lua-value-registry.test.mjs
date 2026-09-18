import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'tests', 'native', 'lua_value_registry');
const build = path.join(root, 'build', 'lua-value-registry-test');

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
  });
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`,
  );
  return result.stdout;
}

test('universal Lua value registry passes strict pinned-Lua tests', { timeout: 120_000 }, () => {
  mkdirSync(build, { recursive: true });
  run('cmake', ['-S', source, '-B', build, '-DDEHERM_SANITIZE=OFF']);
  run('cmake', ['--build', build, '--target', 'lua-value-registry-test']);
  const output = run(path.join(build, 'lua-value-registry-test'), []);
  assert.match(output, /all tests passed/);
});
