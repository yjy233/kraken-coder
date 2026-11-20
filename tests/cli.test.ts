import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { defaults, loadConfig, saveRuntimeEnv, saveTimeoutEnv, validateConfig } from '../src/config.js';
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

test('runtime settings preserve dotenv credentials and load through CLI with flag precedence', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kraken-timeout-')); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, '.env');
  await writeFile(path, '# provider\r\nKRAKEN_API_KEY="fixture-secret"\r\nexport KRAKEN_REQUEST_TIMEOUT_MS = 500\r\n');
  saveTimeoutEnv(path, { requestTimeoutMs: 180_000, turnTimeoutMs: 10_800_000 });
  saveRuntimeEnv(path, { approval: 'auto-review' });
  const saved = await readFile(path, 'utf8');
  assert.match(saved, /# provider\r\nKRAKEN_API_KEY="fixture-secret"\r\n/);
  assert.match(saved, /KRAKEN_REQUEST_TIMEOUT_MS=180000\r\n/);
  const args = ['doctor', '--cwd', root, '--env-file', path, '--provider', 'demo'];
  const result = JSON.parse((await cli(args)).stdout);
  assert.equal(result.config.requestTimeoutMs, 180_000);
  assert.equal(result.config.turnTimeoutMs, 10_800_000);
  assert.equal(result.config.approval, 'auto-review');
  assert.doesNotMatch(JSON.stringify(result), /fixture-secret/);
  const overrides = JSON.parse((await cli([...args, '--request-timeout-ms', '200000', '--approval', 'read-only'])).stdout).config;
  assert.equal(overrides.requestTimeoutMs, 200_000);
  assert.equal(overrides.approval, 'read-only');
  assert.throws(() => validateConfig({ ...defaults, turnTimeoutMs: 10_800_001 }), /turnTimeoutMs/);
  const multiline = 'KRAKEN_API_KEY="first\nKRAKEN_REQUEST_TIMEOUT_MS=embedded\nlast"\n';
  await writeFile(path, multiline);
  assert.throws(() => saveTimeoutEnv(path, { requestTimeoutMs: 1, turnTimeoutMs: 2 }), /无法安全更新/);
  assert.equal(await readFile(path, 'utf8'), multiline);
});
