import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { defaults, loadConfig } from '../src/config.js';
const exec = promisify(execFile);
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('KRAKEN_') && key !== 'OPENAI_API_KEY'));
async function cli(args: string[], extra: Record<string, string> = {}) {
  return exec(process.execPath, ['--import', 'tsx', resolve('src/cli.ts'), ...args], { env: { ...baseEnv, ...extra }, timeout: 15_000 });
}
test('CLI JSONL output, persisted history and session resume work without a terminal', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kraken-cli-')); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'hello.txt'), 'hello');
  const args = ['exec', '--cwd', root, '--provider', 'demo', '--session', 'cli-test', '--json'];
  const first = await cli([...args, '--message', '/read hello.txt']);
  const events = first.stdout.trim().split('\n').map(line => JSON.parse(line) as { type: string; answer?: string });
  assert.equal(events.at(-1)!.type, 'turn.completed'); assert.match(events.at(-1)!.answer!, /hello/);
  await cli([...args, '--message', '/files']);
  const history = await cli(['history', 'cli-test', '--cwd', root]);
  assert.equal(history.stdout.split('\n').filter(line => line.includes('"type":"turn.completed"')).length, 2);
});
test('doctor only reports key presence; init preserves existing configuration', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kraken-config-')); t.after(() => rm(root, { recursive: true, force: true }));
  const args = ['--cwd', root]; await cli(['init', ...args]);
  const file = join(root, '.kraken-coder/config.json');
  await writeFile(file, JSON.stringify({ ...defaults, maxSteps: 7 })); await cli(['init', ...args]);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).maxSteps, 7);
  const result = await cli(['doctor', ...args, '--provider', 'compatible', '--base-url', 'http://127.0.0.1:1/v1', '--model', 'fixture'], { KRAKEN_API_KEY: 'never-print-this-key' });
  assert.equal(JSON.parse(result.stdout).apiKeyConfigured, true); assert.doesNotMatch(result.stdout + result.stderr, /never-print/);
});
test('CLI rejects bad stages, unknown flags and invalid numeric limits with nonzero exit', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kraken-bad-cli-')); t.after(() => rm(root, { recursive: true, force: true }));
  for (const args of [ ['check', '--stage', '99'], ['check', '--unknown'], ['doctor', '--cwd', root, '--max-steps', 'NaN'], ['exec', '--cwd', root] ]) {
    await assert.rejects(cli(args), error => { assert.equal((error as { code: number }).code, 1); return true; });
  }
});
test('Config rejects unknown fields, zero budgets and wrong enum values', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kraken-bad-config-')); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'config.json'), '{"apiKey":"must-not-be-here"}');
  assert.throws(() => loadConfig(root, {}), /Unknown config field/);
  await writeFile(join(root, 'config.json'), '{"maxSteps":0}'); assert.throws(() => loadConfig(root, {}), /maxSteps/);
});
