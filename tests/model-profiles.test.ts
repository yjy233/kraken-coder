import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { defaults, loadConfig, loadEnv, saveModelSelection, validateConfig } from '../src/config.js';
import { resolveContextBudget } from '../src/context/budget.js';
import { createProvider } from '../src/core/agent.js';
import { apiKeyForConfig, modelConfig, modelProfiles, profileApiKey, profileForBaseUrl, rememberedModel } from '../src/providers/profiles.js';

function isolatedEnv(t: TestContext) {
  const vars = Object.keys(process.env).filter(k => k.startsWith('KRAKEN_') || k === 'OPENAI_API_KEY');
  const saved = Object.fromEntries(vars.map(k => [k, process.env[k]!]));
  const clear = () => {
    for (const key of Object.keys(process.env)) if (key.startsWith('KRAKEN_') || key === 'OPENAI_API_KEY') delete process.env[key];
  };
  clear();
  t.after(() => { clear(); Object.assign(process.env, saved); });
  return clear;
}
test('switching preserves legacy key binding, remembered models, file mode and restart selection', async t => {
  const restart = isolatedEnv(t);
  const home = await mkdtemp(join(tmpdir(), 'kraken-selection-')); t.after(() => rm(home, { recursive: true, force: true }));
  const path = join(home, '.env');
  await writeFile(path, '# old setup\nKRAKEN_PROVIDER=compatible\nKRAKEN_BASE_URL=https://ark.cn-beijing.volces.com/api/v3/\nKRAKEN_API_KEY=old-key\nKRAKEN_MODEL=ep-old\nKRAKEN_OPENROUTER_API_KEY=old-router-key\n');
  loadEnv(path);
  const previous = loadConfig(home, {});
  assert.equal(profileForBaseUrl(previous.baseUrl), 'volcengine');
  assert.equal(apiKeyForConfig(previous), 'old-key');
  assert.equal(rememberedModel('volcengine'), 'ep-old');
  assert.equal(rememberedModel('openrouter'), '');
  const routerKey = 'router#literal$&';
  saveModelSelection(path, 'openrouter', 'acme/model:free', routerKey, previous);
  restart(); loadEnv(path);
  const router = loadConfig(home, {});
  assert.equal(router.baseUrl, modelProfiles.openrouter.baseUrl);
  assert.equal(router.model, 'acme/model:free');
  assert.equal(apiKeyForConfig(router), routerKey);
  assert.equal(profileApiKey('volcengine'), 'old-key');
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.ok(!(JSON.stringify(router).includes(routerKey)));
  assert.equal(loadConfig(home, { provider: 'demo' }).provider, 'demo');
  assert.equal(loadConfig(home, { modelProvider: 'volcengine' }).model, 'ep-old');
  assert.equal(loadConfig(home, { model: 'acme/other' }).model, 'acme/other');

  saveModelSelection(path, 'volcengine', 'ep-second', undefined, router);
  restart(); loadEnv(path);
  assert.equal(apiKeyForConfig(loadConfig(home, {})), 'old-key');
  assert.equal(rememberedModel('openrouter'), 'acme/model:free');
  assert.match(await readFile(path, 'utf8'), /^# old setup\n/);
  assert.throws(() => saveModelSelection(path, 'volcengine', 'ep-test\nENV=injected'));
  assert.throws(() => saveModelSelection(path, 'volcengine', 'ep-test', 'broken\nkey'));
  assert.equal(rememberedModel('volcengine'), 'ep-second');
});

test('an explicit legacy endpoint can carry its old generic key through a switch', async t => {
  const restart = isolatedEnv(t);
  const home = await mkdtemp(join(tmpdir(), 'kraken-selection-')); t.after(() => rm(home, { recursive: true, force: true }));
  const path = join(home, '.env');
  await writeFile(path, 'KRAKEN_API_KEY=ark-legacy\n');
  loadEnv(path);
  const original = { ...defaults, provider: 'compatible' as const, baseUrl: modelProfiles.volcengine.baseUrl, model: 'old-id' };
  assert.equal(apiKeyForConfig(original), 'ark-legacy');
  const router = modelConfig(original, 'openrouter', 'a/b');
  assert.equal(apiKeyForConfig(router), undefined);
  saveModelSelection(path, 'openrouter', 'a/b', 'router-token', original);
  restart(); loadEnv(path);
  assert.equal(profileApiKey('volcengine'), 'ark-legacy');
  assert.equal(rememberedModel('volcengine'), 'old-id');
  assert.equal(apiKeyForConfig(loadConfig(home, {})), 'router-token');
});

test('chat and window lookups use the selected endpoint and the same scoped credential', async t => {
  isolatedEnv(t);
  Object.assign(process.env, {
    KRAKEN_API_KEY: 'legacy', KRAKEN_BASE_URL: modelProfiles.volcengine.baseUrl, KRAKEN_OPENROUTER_API_KEY: 'router',
  });
  const urls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: URL | string, init?: RequestInit) => {
    const url = String(input); urls.push(url);
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer router');
    if (url.endsWith('/models')) return Response.json({ data: [{ id: 'a/test', context_length: 10000 }] });
    assert.equal(JSON.parse(String(init?.body)).model, 'a/test');
    return Response.json({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] });
  });
  const selected = modelConfig(defaults, 'openrouter', 'a/test');
  const provider = createProvider(selected, () => {});
  assert.equal((await provider.complete([{ role: 'user', content: 'test' }], [], new AbortController().signal)).content, 'ok');
  assert.deepEqual(await resolveContextBudget(selected), { source: 'api', windowTokens: 10000, thresholdTokens: 8000 });
  assert.deepEqual(urls, [modelProfiles.openrouter.baseUrl + '/chat/completions', modelProfiles.openrouter.baseUrl + '/models']);
  const custom = { ...defaults, provider: 'compatible' as const, baseUrl: 'https://third-party.invalid/v1', model: 'local' };
  assert.equal(apiKeyForConfig(custom), 'legacy');
  assert.equal(profileForBaseUrl('https://openrouter.ai/unrelated'), undefined);
  assert.throws(() => validateConfig({ ...selected, baseUrl: custom.baseUrl }), /endpoint/);
  delete process.env.KRAKEN_OPENROUTER_API_KEY;
  assert.equal(apiKeyForConfig(selected), undefined);
});
