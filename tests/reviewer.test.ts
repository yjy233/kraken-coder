import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaults } from '../src/config.js';
import { runTurn } from '../src/core/agent.js';
import type { Event, Message, Provider } from '../src/core/types.js';
import { createReviewer } from '../src/permissions/reviewer.js';
import { readSession } from '../src/session/store.js';

const action = { name: 'shell', effect: 'shell' as const, preview: 'cwd: /work\n$ npm test' };
const budget = { source: 'fallback' as const, thresholdChars: 10000 };

test('reviewer requires a complete action and an explicit structured decision', async () => {
  const signal = new AbortController().signal;
  for (const [content, expected] of [
    ['{"decision":"allow"}', 'allow'], ['{"decision":"deny"}', 'deny'], ['{"decision":"ask"}', 'ask'],
    ['allow', 'ask'], ['{"decision":true}', 'ask'], ['{"decision":"allow","other":"deny"}', 'ask'],
    ['{"decision":"deny","decision":"allow"}', 'ask'], ['{\n  "decision": "allow"\n}', 'allow'],
  ] as const) {
    const review = createReviewer(() => ({ name: 'fixture', async complete() { return { content }; } }), '/work', ['Run tests'], budget);
    assert.equal(await review(action, signal), expected);
  }
  let called = 0;
  const review = createReviewer(() => {
    called++;
    throw new Error('review provider unavailable');
  }, '/work', ['Run tests'], budget);
  assert.equal(await review({ ...action, preview: '' }, signal), 'ask');
  assert.equal(await review({ ...action, preview: 'x'.repeat(budget.thresholdChars) }, signal), 'ask');
  assert.equal(called, 0);
  assert.equal(await review(action, signal), 'ask');
  assert.equal(called, 1);
});

test('review propagates a turn cancellation while awaiting its model', async () => {
  const controller = new AbortController();
  const review = createReviewer(() => ({
    name: 'pending',
    complete(_messages, _tools, signal) {
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
  }), '/work', ['Run tests'], budget);
  const pending = review(action, controller.signal);
  const reason = new Error('turn stopped');
  controller.abort(reason);
  await assert.rejects(pending, err => err === reason);
});

const patch = (name: string) => `*** Begin Patch\n*** Add File: ${name}\n+ok\n*** End Patch`;
function proposalProvider(names: string[]): Provider {
  let proposed = false;
  return { name: 'proposal-fixture', async complete() {
    if (proposed) return { content: 'done' };
    proposed = true;
    return { content: '', toolCalls: names.map((name, i) => ({
      id: String(i), name: 'apply_patch', arguments: JSON.stringify({ patch: patch(name) }),
    })) };
  } };
}

test('runTurn sends current user instructions to a separate reviewer and isolates its stream', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'kraken-review-')), home = join(workspace, '.kraken-coder');
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const payloads: { messages: Message[]; tools?: unknown[] }[] = [];
  const responses = ['{"decision":"allow"}', '{"decision":"deny"}', 'invalid'];
  const srv = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    payloads.push(JSON.parse(Buffer.concat(chunks).toString()));
    const delta = { role: 'assistant', content: responses[payloads.length - 1], reasoning_content: 'private reviewer reasoning' };
    res.writeHead(200, { 'content-type': 'text/event-stream' }).end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  t.after(() => new Promise<void>(resolve => { srv.closeAllConnections(); srv.close(() => resolve()); }));
  const events: Event[] = [], prompts: string[] = [], steering = ['Only create first.txt'];
  const result = await runTurn({
    workspace, home, session: 'review', provider: proposalProvider(['first.txt', 'second.txt', 'third.txt']),
    config: { ...defaults, approval: 'auto-review', provider: 'compatible', model: 'local-fixture', baseUrl: `http://127.0.0.1:${(srv.address() as AddressInfo).port}` },
    takeSteering: () => steering.splice(0), emit: event => events.push(event),
    approve: async request => { prompts.push(request.preview); return false; },
  }, 'Create files');
  assert.equal(result.answer, 'done');
  assert.equal(payloads.length, 3);
  for (const [index, request] of payloads.entries()) {
    assert.equal(request.tools?.length ?? 0, 0);
    assert.deepEqual(request.messages.map(m => m.role), ['system', 'user']);
    const payload = JSON.parse(request.messages[1]!.content);
    assert.deepEqual(payload.userMessages, ['Create files', 'Only create first.txt']);
    assert.equal(payload.action.preview, patch(['first.txt', 'second.txt', 'third.txt'][index]!));
    assert.equal(payload.workspace, await realpath(workspace));
  }
  assert.deepEqual(prompts, [patch('third.txt')]);
  assert.equal(await readFile(join(workspace, 'first.txt'), 'utf8'), 'ok\n');
  for (const file of ['second.txt', 'third.txt']) await assert.rejects(readFile(join(workspace, file)), { code: 'ENOENT' });
  assert.equal(events.some(e => e.type === 'model.delta'), false);
  assert.doesNotMatch(JSON.stringify(readSession(home, 'review')), /private reviewer reasoning/);
});

test('demo auto-review asks the user before writing', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'kraken-demo-review-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  let prompts = 0;
  await runTurn({
    workspace, home: join(workspace, '.kraken-coder'), session: 'demo-review', provider: proposalProvider(['demo.txt']),
    config: { ...defaults, approval: 'auto-review' }, approve: async () => { prompts++; return false; },
  }, 'Create demo.txt');
  assert.equal(prompts, 1);
  await assert.rejects(readFile(join(workspace, 'demo.txt')), { code: 'ENOENT' });
});
