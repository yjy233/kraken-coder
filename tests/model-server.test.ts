import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { defaults } from '../src/config.js';
import { AgentClient } from '../src/client/client.js';
import { modelProfiles, type ModelProvider } from '../src/providers/profiles.js';
import { startAgentServer } from '../src/server/server.js';

async function fixture(t: TestContext, startup: 'demo' | 'legacy' = 'demo') {
  const keys = ['KRAKEN_API_KEY', 'KRAKEN_BASE_URL', 'KRAKEN_MODEL', 'KRAKEN_MODEL_PROVIDER',
    ...Object.values(modelProfiles).flatMap(p => [p.keyEnv, p.modelEnv])];
  const before = keys.map(key => [key, process.env[key]] as const);
  keys.forEach(key => delete process.env[key]);
  t.after(() => { for (const [key, value] of before) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const root = await mkdtemp(join(tmpdir(), 'kraken-picker-')), env = join(root, '.env');
  const config = { ...defaults, contextWindowTokens: 0 };
  if (startup === 'legacy') {
    config.provider = 'compatible';
    config.model = process.env.KRAKEN_MODEL = 'ark-original';
    config.baseUrl = process.env.KRAKEN_BASE_URL = modelProfiles.volcengine.baseUrl;
    process.env.KRAKEN_API_KEY = 'ark-original-key';
  }
  const server = await startAgentServer({ config, workspace: root, home: join(root, 'state'), envFile: env, port: 0, allowShell: startup === 'demo' });
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  return { root, env, server, client: new AgentClient(server.url) };
}

test('picker discovers chat models using only the requested credential, previews before saving, and keeps raw keys private', async t => {
  const { client, env, server } = await fixture(t);
  const realFetch = globalThis.fetch;
  const upstream: [string, string | null][] = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(server.url + '/')) return realFetch(input, init);
    upstream.push([url, new Headers(init?.headers).get('authorization')]);
    if (url === modelProfiles.openrouter.baseUrl + '/models') {
      return Response.json({ data: [{ id: 'org/chat', architecture: { output_modalities: ['text'] }, supported_parameters: ['tools'] },
        { id: 'org/image', architecture: { output_modalities: ['image'] } }, { id: 'org/no-tools', supported_parameters: ['temperature'] }] });
    }
    if (url === modelProfiles.volcengine.baseUrl + '/models') {
      if (new Headers(init?.headers).get('authorization') === 'Bearer invalid-secret') return new Response('invalid-secret', { status: 401 });
      return Response.json({ data: [{ id: 'legacy-ark' }, { id: 'chat', domain: 'VLM' },
        { id: 'chat' }, { id: 'image', domain: 'ImageGeneration' }, { id: 'embed', modalities: { output_modalities: ['embedding'] } }] });
    }
    throw Error('Unexpected outbound request');
  });
  const initial = await client.modelSelection();
  assert.equal(initial.active.provider, null);
  assert.deepEqual(initial.providers.map(p => p.configured), [false, false]);
  assert.match((await client.modelSelection('volcengine')).catalogError!, /Key/);
  assert.deepEqual(upstream, []);
  assert.deepEqual((await client.modelSelection('openrouter')).models, ['org/chat']);
  const invalid = await client.previewModelCatalog({ provider: 'volcengine', apiKey: 'invalid-secret' });
  assert.match(invalid.catalogError!, /401/);
  assert.doesNotMatch(JSON.stringify(invalid), /invalid-secret/);
  const preview = await client.previewModelCatalog({ provider: 'volcengine', apiKey: 'volcano-new-key' });
  assert.deepEqual(preview.models, ['chat', 'legacy-ark']);
  assert.equal(preview.providers[0]!.configured, false);
  await assert.rejects(readFile(env), { code: 'ENOENT' });
  assert.deepEqual(upstream, [
    [modelProfiles.openrouter.baseUrl + '/models', null],
    [modelProfiles.volcengine.baseUrl + '/models', 'Bearer invalid-secret'],
    [modelProfiles.volcengine.baseUrl + '/models', 'Bearer volcano-new-key'],
  ]);
  const saved = await client.saveModelSelection({ provider: 'volcengine', model: 'ep-private', apiKey: 'volcano-new-key' });
  assert.deepEqual(saved.active, { provider: 'volcengine', model: 'ep-private' });
  assert.equal(saved.providers[0]!.configured, true);
  assert.doesNotMatch(JSON.stringify(saved), /volcano-new-key/);
  const persisted = await readFile(env, 'utf8');
  await assert.rejects(client.saveModelSelection({ provider: 'openrouter', model: 'org/chat' }), { status: 400, code: 'missing_key' });
  await assert.rejects(client.request('/model-selection', { provider: 'openrouter', model: 'org/chat', baseUrl: 'https://example.invalid' }), { status: 400 });
  await assert.rejects(client.saveModelSelection({ provider: 'openrouter', model: 'bad\nvalue', apiKey: 'router-key' }), { status: 400 });
  assert.equal(await readFile(env, 'utf8'), persisted);
  assert.equal((await client.info()).modelProvider, 'volcengine');
  assert.deepEqual((await client.modelSelection('openrouter')).models, ['org/chat']);
  assert.deepEqual(upstream.at(-1), [modelProfiles.openrouter.baseUrl + '/models', null]);
});

test('legacy Ark active turn retains its model and key, follow-up uses newly selected provider and same conversation', { timeout: 8000 }, async t => {
  const { client, server } = await fixture(t, 'legacy');
  let started!: () => void, release!: () => void;
  const firstRequest = new Promise<void>(resolve => { started = resolve; });
  const waitForSwitch = new Promise<void>(resolve => { release = resolve; });
  t.after(() => release());
  const realFetch = globalThis.fetch;
  const calls: { provider: ModelProvider; model: string; auth: string | null; messages: { content: string }[] }[] = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).startsWith(server.url + '/')) return realFetch(input, init);
    const provider = String(input) === modelProfiles.volcengine.baseUrl + '/chat/completions' ? 'volcengine' : 'openrouter';
    assert.equal(String(input), modelProfiles[provider].baseUrl + '/chat/completions');
    const { model, messages } = JSON.parse(String(init?.body));
    calls.push({ provider, model, messages, auth: new Headers(init?.headers).get('authorization') });
    if (calls.length === 1) {
      started(); await waitForSwitch;
      return Response.json({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: '', tool_calls: [
        { id: 'read-id', type: 'function', function: { name: 'list_files', arguments: '{}' } },
      ] } }] });
    }
    return Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'reply-' + model } }] });
  });
  const { id } = await client.createSession();
  assert.equal((await client.info()).modelProvider, 'volcengine');
  const turn = await client.startTurn(id, 'first question');
  await firstRequest;
  await client.queueInput(id, turn.id, 'follow_up', 'second question');
  await client.saveModelSelection({ provider: 'openrouter', model: 'org/new', apiKey: 'router-secret' });
  release();
  let session = await client.session(id);
  for (let i = 0; i < 300 && session.events.filter(e => e.type === 'turn.completed').length < 2; i++) {
    await delay(10); session = await client.session(id);
  }
  assert.equal(session.events.filter(e => e.type === 'turn.completed').length, 2);
  assert.deepEqual(calls.map(c => [c.provider, c.model, c.auth]), [
    ['volcengine', 'ark-original', 'Bearer ark-original-key'], ['volcengine', 'ark-original', 'Bearer ark-original-key'],
    ['openrouter', 'org/new', 'Bearer router-secret'],
  ]);
  assert.ok(calls[2]!.messages.some(m => m.content === 'first question'));
  assert.ok(calls[2]!.messages.some(m => m.content === 'reply-ark-original'));
  assert.equal((await client.sessions())[0]?.id, id);
  await client.saveModelSelection({ provider: 'volcengine', model: 'ark-second' });
  assert.equal((await client.modelSelection()).providers[1]!.model, 'org/new');
});

test('an incompatible demo turn and its pending follow-up stay reachable during an attempted switch', async t => {
  const { client, root } = await fixture(t);
  await writeFile(join(root, 'calculator.js'), 'export function add(a, b) { return a - b; }\n');
  const { id } = await client.createSession();
  const turn = await client.startTurn(id, '/fix');
  for (let i = 0; i < 200 && !(await client.session(id)).approvals.length; i++) await delay(10);
  const waiting = await client.session(id);
  assert.ok(waiting.approvals.length);
  const input = await client.queueInput(id, turn.id, 'follow_up', '/files');
  const selection = { provider: 'openrouter' as const, model: 'org/chat', apiKey: 'router-secret' };
  await assert.rejects(client.saveModelSelection(selection), { status: 409, code: 'turn_busy' });
  await client.cancelTurn(id, turn.id);
  for (let i = 0; i < 200 && (await client.session(id)).turn?.status === 'running'; i++) await delay(10);
  await assert.rejects(client.saveModelSelection(selection), { status: 409, code: 'turn_busy' });
  await client.removeInput(id, input.id);
  await client.saveModelSelection(selection);
  assert.equal((await client.sessions()).length, 0);
  await assert.rejects(client.startTurn(id, 'old demo thread'), { status: 409, code: 'session_mismatch' });
});
