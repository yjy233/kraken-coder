import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { rm, readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { runTurn } from '../src/core/agent.js';
import { createDemoProject } from '../src/demo-project.js';
import { defaults } from '../src/config.js';
import { readSession } from '../src/session/store.js';
import { validateHistory } from '../src/core/validation.js';
import type { Event, Message, ModelReply, Provider } from '../src/core/types.js';

test('streaming runTurn waits for completion before tools and persists full messages without deltas', { timeout: 5000 }, async t => {
  for (const complete of [true, false]) await t.test(complete ? 'complete' : 'truncated', async t => {
    const workspace = await mkdtemp(join(tmpdir(), 'kraken-stream-')), home = join(workspace, '.kraken-coder');
    t.after(() => rm(workspace, { recursive: true, force: true }));
    let release!: () => void, started!: () => void, requests = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const streaming = new Promise<void>(resolve => { started = resolve; });
    const frame = (delta: unknown, finish_reason: string | null = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    const srv = createServer(async (req, res) => {
      if (req.url === '/v1/models') { res.writeHead(404).end(); return; }
      for await (const _ of req) { /* Drain request body. */ }
      res.setHeader('content-type', 'text/event-stream');
      if (++requests > 1) { res.end(frame({ reasoning_content: 'Check result.', content: 'done' }, 'stop') + 'data: [DONE]\n\n'); return; }
      res.write(frame({ role: 'assistant', reasoning_content: 'Create the requested file.', tool_calls: [
        { index: 0, id: 'create', type: 'function', function: { name: 'apply_patch', arguments: JSON.stringify({ patch: '*** Begin Patch\n*** Add File: created.txt\n+once\n*** End Patch' }) } },
      ] }));
      await gate;
      res.end(complete ? frame({}, 'tool_calls') + 'data: [DONE]\n\n' : '');
    });
    srv.listen(0, '127.0.0.1'); await once(srv, 'listening');
    t.after(async () => { release(); srv.closeAllConnections(); await new Promise<void>(resolve => srv.close(() => resolve())); });
    const events: Event[] = [];
    const pending = runTurn({ workspace, home, session: 'stream', config: { ...defaults, mode: 'learner', provider: 'compatible', model: 'fixture', baseUrl: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1`, approval: 'full-auto' },
      emit(event) { events.push(event); if (event.type === 'model.delta') started(); },
    }, 'Create a file');
    // Attach the failure expectation before releasing a deliberately broken stream.
    const result = complete ? pending : assert.rejects(pending, /without \[DONE\]/);
    await streaming;
    try {
      assert.equal(events.some(e => e.type === 'tool.start'), false);
      await assert.rejects(readFile(join(workspace, 'created.txt')), /ENOENT/);
    } finally { release(); }
    await result;
    const records = readSession(home, 'stream');
    assert.equal(records.some(r => r.event.type === 'model.delta'), false);
    if (complete) {
      assert.equal(await readFile(join(workspace, 'created.txt'), 'utf8'), 'once\n');
      assert.equal(events.filter(e => e.type === 'tool.start').length, 1);
      const assistant = records.filter(r => r.event.type === 'message' && (r.event.message as Message).role === 'assistant');
      assert.equal(assistant.length, 2);
      assert.equal((assistant[0]!.event.message as Message).reasoningContent, 'Create the requested file.');
      assert.equal(requests, 2);
    } else {
      assert.equal(events.some(e => e.type === 'tool.start'), false);
      assert.equal(records.some(r => r.event.type === 'message' && (r.event.message as Message).role === 'assistant'), false);
      await assert.rejects(readFile(join(workspace, 'created.txt')), /ENOENT/);
    }
  });
});

test('Oversized user input reports the effective budget after compaction', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'kraken-budget-')), home = join(workspace, '.kraken-coder');
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const provider: Provider = { name: 'budget', async complete() { throw new Error('Unexpected model request'); } };
  for (const window of [0, 10_000]) {
    const config = { ...defaults, contextWindowTokens: window, contextChars: 12_000 };
    await assert.rejects(runTurn({ workspace, home, session: `budget-${window}`, config, provider }, '文'.repeat(16_000)),
      window ? /自动压缩后.+token（估算）.+阈值 8000.+运行设置/ : /自动压缩后.+字符.+阈值 12000.+--context-chars/);
  }
});

test('Model window triggers current-turn compaction while preserving instructions, protocol and the journal', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'kraken-budget-')), home = join(workspace, '.kraken-coder');
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await mkdir(join(workspace, 'src'));
  await writeFile(join(workspace, 'src/AGENTS.md'), 'Keep the nested project instruction.');
  await writeFile(join(workspace, 'src/long.txt'), '长行'.repeat(100).concat('\n').repeat(60));
  await writeFile(join(workspace, 'src/short.txt'), 'Recent observation');
  let metadataRequests = 0;
  const requests: { role: string; content: string; tool_call_id?: string }[][] = [];
  const srv = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && req.url === '/v1/models') {
      metadataRequests++;
      res.end(JSON.stringify({ data: [{ id: 'fixture', token_limits: { context_window: 12_000 } }] }));
      return;
    }
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(part as Buffer);
    requests.push(JSON.parse(Buffer.concat(parts).toString()).messages);
    res.end(JSON.stringify({ choices: [requests.length === 1
      ? { finish_reason: 'tool_calls', message: { role: 'assistant', tool_calls: ['long', 'short'].map(id => ({
        id, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: `src/${id}.txt` }) },
      })) } }
      : { finish_reason: 'stop', message: { role: 'assistant', content: 'done' } }] }));
  });
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  t.after(async () => { srv.closeAllConnections(); await new Promise<void>(resolve => srv.close(() => resolve())); });
  const result = await runTurn({ workspace, home, session: 'budget', config: {
    ...defaults, mode: 'learner', provider: 'compatible', model: 'fixture',
    baseUrl: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1`, contextChars: 1000,
  } }, 'Read both files');
  assert.equal(result.answer, 'done');
  assert.equal(metadataRequests, 1);
  const sent = requests[1]!;
  assert.equal(sent.find(message => message.role === 'user')?.content, 'Read both files');
  const observations = sent.filter(message => message.role === 'tool');
  assert.deepEqual(observations.map(message => message.tool_call_id), ['long', 'short']);
  const compressed = JSON.parse(observations[0]!.content);
  assert.equal(compressed.compacted, true);
  assert.match(compressed.result.instructions[0].content, /nested project instruction/);
  assert.equal(compressed.result.totalLines, 61);
  assert.match(observations[1]!.content, /Recent observation/);
  assert.equal(JSON.parse(observations[1]!.content).compacted, undefined);
  const records = readSession(home, 'budget');
  const original = records.find(row => (row.event.message as Message | undefined)?.toolCallId === 'long')!.event.message as Message;
  assert.equal(JSON.parse(original.content).compacted, undefined);
  assert.ok(JSON.parse(original.content).result.content.length > 10_000);
  assert.equal(records.find(row => row.event.type === 'context.trimmed')?.event.toolResults, 1);
});
for (const mode of ['reference', 'learner'] as const) test(`${mode}: end-to-end bug fix, actual tests, journal and next turn resume`, async t => {
  const workspace = await createDemoProject(); t.after(() => rm(workspace, { recursive: true, force: true }));
  const home = join(workspace, '.kraken-coder');
  const options = { workspace, home, session: 'e2e', allowShell: true, config: { ...defaults, approval: 'full-auto' as const, mode } };
  const result = await runTurn(options, '/fix'); assert.match(result.answer, /通过/);
  assert.match(await readFile(join(workspace, 'calculator.js'), 'utf8'), /return a \+ b/);
  const messages = readSession(home, 'e2e').filter(r => r.event.type === 'message').map(r => r.event.message as Message);
  validateHistory(messages);
  const shellIds = messages.flatMap(m => m.toolCalls ?? []).filter(c => c.name === 'shell').map(c => c.id);
  const codes = messages.filter(m => shellIds.includes(m.toolCallId ?? '')).map(m => JSON.parse(m.content).result.exitCode);
  assert.deepEqual(codes, [1, 0]);
  const resumed = await runTurn(options, '/read calculator.js'); assert.match(resumed.answer, /return a \+ b/);
});
test('Resume after side effect and provider failure does not execute the old tool again', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'kraken-resume-')); t.after(() => rm(workspace, { recursive: true, force: true }));
  const home = join(workspace, '.kraken-coder'); let calls = 0;
  const provider: Provider = { name: 'fixture', async complete(messages): Promise<ModelReply> {
    if (++calls === 1) return { content: '', toolCalls: [{ id: 'write', name: 'apply_patch', arguments: JSON.stringify({ patch: '*** Begin Patch\n*** Add File: created.txt\n+once\n*** End Patch' }) }] };
    if (calls === 2) throw new Error('model failed after write');
    validateHistory(messages); return { content: 'restored' };
  } };
  const options = { workspace, home, session: 'resume', provider, config: { ...defaults, approval: 'workspace-write' as const } };
  await assert.rejects(runTurn(options, 'create a file'), /model failed/);
  assert.equal(await readFile(join(workspace, 'created.txt'), 'utf8'), 'once\n');
  assert.equal((await runTurn(options, 'continue')).answer, 'restored');
  assert.equal(readSession(home, 'resume').filter(r => r.event.type === 'files.changed').length, 1);
});
test('Read-only mode returns a denied write to model without creating a file', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'kraken-deny-')); t.after(() => rm(workspace, { recursive: true, force: true }));
  let requests = 0;
  const provider: Provider = { name: 'deny-fixture', async complete(messages) {
    if (requests++ === 0) return { content: '', toolCalls: [{ id: 'write', name: 'apply_patch', arguments: '{"patch":"*** Begin Patch\\n*** Add File: no.txt\\n+no\\n*** End Patch"}' }] };
    assert.match(messages.at(-1)!.content, /Policy denied/); return { content: 'denied' };
  } };
  await runTurn({ workspace, home: join(workspace, '.kraken-coder'), session: 'deny', provider, config: { ...defaults, approval: 'read-only' } }, 'write');
  await assert.rejects(readFile(join(workspace, 'no.txt')), /ENOENT/);
});
