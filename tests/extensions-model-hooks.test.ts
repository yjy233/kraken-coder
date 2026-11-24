import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaults } from '../src/config.js';
import { runTurn } from '../src/core/agent.js';
import type { ModelReply, Provider } from '../src/core/types.js';
import type { HookEvent, HookOutcome } from '../src/extensions/hooks.js';
import { withCompactHooks, withModelHooks } from '../src/extensions/model-hooks.js';

const signal = new AbortController().signal;

function hookFixture(events: HookEvent[], behavior: (event: HookEvent) => HookOutcome = () => ({})) {
  const seen: { event: HookEvent; fields: Record<string, unknown> }[] = [];
  return {
    seen, handles(event: HookEvent) { return events.includes(event); },
    async run(event: HookEvent, fields: Record<string, unknown>) {
      seen.push({ event, fields });
      return behavior(event);
    },
  };
}

test('Model observers cannot change model input or output and receive only event metadata', async () => {
  const hooks = hookFixture(['PreModelRequest', 'PostModelRequest'], () => ({ block: 'block', context: 'change' }));
  const reply: ModelReply = { content: 'done', reasoningContent: 'secret reasoning' };
  const provider: Provider = { name: 'test', async complete(messages) {
    assert.deepEqual(hooks.seen.map(row => row.event), ['PreModelRequest']);
    assert.equal(messages[0]?.content, 'private prompt');
    return reply;
  } };
  const wrapped = withModelHooks(provider, hooks);
  assert.equal(wrapped.name, provider.name);
  assert.equal(await wrapped.complete([{ role:'user', content:'private prompt' }], [], signal), reply);
  assert.deepEqual(hooks.seen, [
    { event: 'PreModelRequest', fields: {} },
    { event: 'PostModelRequest', fields: { status: 'completed', error: null, token_usage: null } },
  ]);
  assert.equal(withModelHooks(provider, hookFixture([])), provider);
});

test('Provider errors keep their original identity but sensitive details do not reach the post hook', async () => {
  const cases = [
    { error: new Error('credential or hidden provider payload'), status:'failed', description:'Provider request failed' },
    { error: new Error('Provider HTTP 403'), status:'failed', description:'Provider HTTP 403' },
    { error: new DOMException('stopped', 'AbortError'), status:'cancelled', description:null },
  ];
  for (const {error,status,description} of cases) {
    const hooks = hookFixture(['PostModelRequest']);
    const wrapped = withModelHooks({ name:'test', async complete() { throw error; } }, hooks);
    await assert.rejects(wrapped.complete([], [], signal), (actual: unknown) => actual === error);
    assert.deepEqual(hooks.seen, [{ event:'PostModelRequest', fields:{status, error:description, token_usage:null} }]);
  }
});

test('User cancellation does not launch further model observer commands', async () => {
  const controller = new AbortController();
  const hooks = hookFixture(['PreModelRequest','PostModelRequest']);
  const wrapped = withModelHooks({ name:'test', async complete() {
    controller.abort(new Error('cancelled'));
    throw new Error('provider cleanup');
  } }, hooks);
  await assert.rejects(wrapped.complete([], [], controller.signal), /cancelled/);
  assert.deepEqual(hooks.seen.map(row => row.event), ['PreModelRequest']);
});

test('Compaction hooks bracket actual compaction and preserve an unchanged fitting request', async () => {
  const order: string[] = [];
  const hooks = hookFixture(['PreCompact','PostCompact'], event => { order.push(event); return {}; });
  assert.equal(await withCompactHooks(hooks, () => true, () => { order.push('fit'); return 42; }, signal), 42);
  assert.deepEqual(order, ['PreCompact','fit','PostCompact']);
  assert.ok(hooks.seen.every(({fields}) => fields.trigger === 'auto'));
  await withCompactHooks(hooks, () => false, () => order.push('fits'), signal);
  assert.deepEqual(order, ['PreCompact','fit','PostCompact','fits']);
  await withCompactHooks(hookFixture([]), () => assert.fail('unnecessary budget estimate'), () => 1, signal);
});

test('PreCompact can stop before fitting; failed fitting never reports PostCompact; PostCompact can stop dispatch', async () => {
  const pre = hookFixture(['PreCompact','PostCompact'], event => event === 'PreCompact' ? {block:'pre stopped'} : {});
  await assert.rejects(withCompactHooks(pre, () => true, () => assert.fail('must not fit'), signal), /pre stopped/);
  assert.deepEqual(pre.seen.map(row => row.event), ['PreCompact']);
  const post = hookFixture(['PostCompact'], () => ({block:'post stopped'}));
  await assert.rejects(withCompactHooks(post, () => true, () => { throw new Error('too large'); }, signal), /too large/);
  assert.deepEqual(post.seen,[]);
  await assert.rejects(withCompactHooks(post, () => true, () => 42, signal), /post stopped/);
});

test('runTurn executes real model and compact command hooks in dispatch order', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kraken-model-hooks-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'large.txt'), 'x'.repeat(16_000));
  const hookPath = join(root, 'hooks.json');
  const record = 'cat >> observed.jsonl';
  const observer = [{ matcher:'unused-for-observers', hooks:[{ type:'command', command:record + " && echo '{\"continue\":false}'" }] }];
  const compact = [{ matcher:'auto', hooks:[{ type:'command', command:record }] }];
  await writeFile(hookPath, JSON.stringify({ hooks: {
    PreModelRequest: observer, PostModelRequest: observer, PreCompact: compact, PostCompact: compact,
  } }));
  let requests = 0;
  const result = await runTurn({
    workspace: root, home: join(root, '.kraken-coder'), session: 'hooked', allowShell: true,
    config: { ...defaults, approval:'full-auto', contextChars:14_000, contextWindowTokens:0, hookFiles:[hookPath] },
    provider: { name:'test', async complete() {
      if (++requests === 1) return { content:'', toolCalls:[{id:'read',name:'read_file',arguments:'{"path":"large.txt"}'}] };
      return { content:'answer', reasoningContent:'PRIVATE_PROVIDER_REASONING' };
    } },
  }, 'PRIVATE_USER_INPUT');
  assert.equal(result.answer, 'answer');
  const output = await readFile(join(root, 'observed.jsonl'), 'utf8');
  assert.doesNotMatch(output, /PRIVATE_PROVIDER_REASONING|PRIVATE_USER_INPUT/);
  const rows = output.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(rows.map(row => row.hook_event_name), [
    'PreModelRequest', 'PostModelRequest', 'PreCompact', 'PostCompact', 'PreModelRequest', 'PostModelRequest',
  ]);
  assert.deepEqual(rows.filter(row => row.trigger).map(row => row.trigger), ['auto','auto']);
});
