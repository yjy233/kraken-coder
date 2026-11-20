import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type RequestListener } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { ResponsesProvider, decodeResponse, responseInput } from '../src/providers/responses.js';
import { CompatibleProvider } from '../src/providers/compatible.js';
import { reference } from '../src/learning/reference.js';
import { sse } from '../src/providers/sse.js';
import { apiUrl } from '../src/providers/http.js';
import type { Event, Message } from '../src/core/types.js';
import { defaults } from '../src/config.js';
import { resolveContextBudget } from '../src/context/budget.js';
async function server(handler: RequestListener) {
  const srv = createServer(handler); srv.listen(0, '127.0.0.1'); await once(srv, 'listening');
  return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1`, close: async () => {
    srv.closeAllConnections(); await new Promise<void>(resolve => srv.close(() => resolve()));
  } };
}
const completed = (output: unknown[]) => ({ status: 'completed', output });
const finalItem = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '完成 🐙' }] };
const chatChunk = (delta: unknown, finish_reason: string | null = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`;

test('Context budget matches the model ID, caches API metadata and falls back safely', async t => {
  let calls = 0;
  const local = await server((req, res) => {
    calls++;
    assert.equal(req.url, '/v1/models');
    res.end(JSON.stringify({ data: [
      { id: 'ark', token_limits: { context_window: 100_000, max_input_token_length: 75_000 } },
      { id: 'router/model', context_length: 50_000 },
      { id: 'openai', owned_by: 'openai' },
    ] }));
  });
  t.after(local.close);
  const config = { ...defaults, provider: 'compatible' as const, baseUrl: local.url, model: 'ark' };
  assert.deepEqual(await resolveContextBudget(config), { source: 'api', windowTokens: 100_000, thresholdTokens: 75_000 });
  assert.deepEqual(await resolveContextBudget({ ...config, contextCompactRatio: 0.7 }),
    { source: 'api', windowTokens: 100_000, thresholdTokens: 70_000 });
  assert.equal(calls, 1);
  assert.deepEqual(await resolveContextBudget({ ...config, model: 'router/model' }),
    { source: 'api', windowTokens: 50_000, thresholdTokens: 40_000 });
  assert.deepEqual(await resolveContextBudget({ ...config, model: 'openai', contextChars: 42_000 }),
    { source: 'fallback', thresholdChars: 42_000 });
  assert.deepEqual(await resolveContextBudget({ ...config, contextWindowTokens: 64_000 }),
    { source: 'manual', windowTokens: 64_000, thresholdTokens: 51_200 });
  assert.deepEqual(await resolveContextBudget({ ...config, contextWindowTokens: 0 }),
    { source: 'fallback', thresholdChars: defaults.contextChars });
  assert.equal(calls, 3);
});

test('Compatible streams before completion, merges interleaved tools and replays reasoning; JSON fallback works', { timeout: 5000 }, async t => {
  const requests: any[] = [], events: Event[] = [];
  let release!: () => void, firstDelta!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const streaming = new Promise<void>(resolve => { firstDelta = resolve; });
  t.after(() => release());
  const local = await server(async (req, res) => {
    const buffers: Buffer[] = []; for await (const c of req) buffers.push(c as Buffer);
    requests.push(JSON.parse(Buffer.concat(buffers).toString()));
    if (requests.length > 1) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'done' } }] }));
      return;
    }
    res.setHeader('content-type', 'text/event-stream');
    const initial = Buffer.from(chatChunk({ role: 'assistant', reasoning_content: '先查中文🐙' }));
    for (let i = 0; i < initial.length; i += 3) res.write(initial.subarray(i, i + 3));
    await gate;
    res.write(chatChunk({ reasoning_content: '。', content: '检查文件', tool_calls: [
      { index: 1, id: 'call_two', type: 'function', function: { name: 'echo', arguments: '{"value":' } },
      { index: 0, id: 'call_', type: 'function', function: { name: 'read_', arguments: '{"path":' } },
    ] }));
    res.write(chatChunk({ tool_calls: [
      { index: 0, id: 'one', function: { name: 'file', arguments: '"a.ts"}' } },
      { index: 1, function: { arguments: '"ok"}' } },
    ] }, 'tool_calls'));
    res.end('data: {"choices":[],"usage":{"total_tokens":12}}\n\ndata: [DONE]\n\n');
  }); t.after(local.close);
  const provider = new CompatibleProvider({ baseUrl: local.url, model: 'fixture', timeoutMs: 3000 }, reference.decodeChat, event => {
    events.push(event); firstDelta();
  });
  const messages: Message[] = [{ role: 'user', content: 'read' }];
  let completed = false;
  const pending = provider.complete(messages, [], new AbortController().signal).then(reply => { completed = true; return reply; });
  await streaming;
  assert.equal(completed, false);
  assert.deepEqual(events[0], { type: 'model.delta', channel: 'reasoning', text: '先查中文🐙' });
  release();
  const reply = await pending;
  assert.equal(reply.reasoningContent, '先查中文🐙。');
  assert.equal(reply.content, '检查文件');
  assert.deepEqual(reply.toolCalls, [
    { id: 'call_one', name: 'read_file', arguments: '{"path":"a.ts"}' },
    { id: 'call_two', name: 'echo', arguments: '{"value":"ok"}' },
  ]);
  assert.equal(events.filter(e => !e.channel).map(e => e.text).join(''), reply.content);
  messages.push({ role: 'assistant', ...reply }, ...reply.toolCalls!.map(call => ({ role: 'tool' as const, toolCallId: call.id, content: 'result' })));
  assert.equal((await provider.complete(messages, [], new AbortController().signal)).content, 'done');
  assert.equal(requests[0].stream, true);
  assert.equal(requests[1].messages[1].reasoning_content, reply.reasoningContent);
  assert.equal(requests[1].messages[2].tool_call_id, 'call_one');
});

test('Compatible rejects incomplete, invalid and errored streams', async t => {
  const cases: [string, string, RegExp][] = [
    ['missing DONE', chatChunk({ content: 'partial' }, 'stop'), /without \[DONE\]/],
    ['missing finish', chatChunk({ content: 'partial' }) + 'data: [DONE]\n\n', /without finish_reason/],
    ['length', chatChunk({ content: 'partial' }, 'length') + 'data: [DONE]\n\n', /Incomplete completion/],
    ['filter', chatChunk({ content: 'partial' }, 'content_filter') + 'data: [DONE]\n\n', /Incomplete completion/],
    ['truncated frame', 'data: {"choices":', /Truncated SSE/],
    ['remote error', 'data: {"error":{"message":"secret-do-not-print"}}\n\n', /stream failed/],
    ['unfinished tool', chatChunk({ tool_calls: [{ index: 0, type: 'function', function: { name: 'read_file', arguments: '{}' } }] }, 'tool_calls') + 'data: [DONE]\n\n', /Invalid or duplicate tool call ID/],
    ['bad index', chatChunk({ tool_calls: [{ index: 16 }] }) + 'data: [DONE]\n\n', /Invalid streamed tool index/],
    ['post-finish content', chatChunk({ content: 'done' }, 'stop') + chatChunk({ content: 'extra' }) + 'data: [DONE]\n\n', /continued after finish_reason/],
  ];
  for (const [name, data, error] of cases) await t.test(name, async t => {
    const local = await server((_req, res) => { res.setHeader('content-type', 'text/event-stream'); res.end(data); }); t.after(local.close);
    const provider = new CompatibleProvider({ baseUrl: local.url, model: 'fixture', timeoutMs: 1000 }, reference.decodeChat);
    await assert.rejects(provider.complete([], [], new AbortController().signal), failure => {
      assert.match((failure as Error).message, error);
      assert.doesNotMatch((failure as Error).message, /secret-do-not-print/);
      return true;
    });
  });
});

test('Compatible cancellation and timeout abort an unfinished response body', async t => {
  for (const cancel of [true, false]) await t.test(cancel ? 'cancel' : 'timeout', async t => {
    const local = await server((_req, res) => { res.setHeader('content-type', 'text/event-stream'); res.write(chatChunk({ reasoning_content: 'working' })); }); t.after(local.close);
    const controller = new AbortController();
    let streamed = false;
    const provider = new CompatibleProvider({ baseUrl: local.url, model: 'fixture', timeoutMs: cancel ? 1000 : 100 }, reference.decodeChat, () => {
      streamed = true;
      if (cancel) controller.abort(new Error('cancelled stream'));
    });
    await assert.rejects(provider.complete([], [], controller.signal), /cancelled|abort|timeout/i);
    assert.equal(streamed, true);
  });
});
test('SSE handles single-byte chunks, CRLF, UTF-8, comments and multiline data', async () => {
  const bytes = Buffer.from(': keepalive\r\ndata: {"text":\r\ndata: "中文🐙"}\r\n\r\ndata: [DONE]\r\n\r\n');
  const stream = new ReadableStream<Uint8Array>({ start(c) { for (const byte of bytes) c.enqueue(Uint8Array.of(byte)); c.close(); } });
  const frames = []; for await (const frame of sse(stream)) frames.push(frame);
  assert.deepEqual(frames, [{ text: '中文🐙' }]);
});
test('Responses streams text, retains encrypted reasoning and replays call IDs', async t => {
  const requests: Record<string, unknown>[] = [], headers: unknown[] = [], deltas: unknown[] = [];
  const reasoning = { id: 'rs_1', type: 'reasoning', summary: [], encrypted_content: 'opaque-test-state' };
  const call = { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a.ts"}', status: 'completed' };
  const local = await server(async (req, res) => {
    const buffers: Buffer[] = []; for await (const c of req) buffers.push(c as Buffer);
    requests.push(JSON.parse(Buffer.concat(buffers).toString()) as Record<string, unknown>); headers.push(req.headers.authorization);
    assert.equal(req.url, '/v1/responses');
    res.setHeader('content-type', 'text/event-stream');
    const result = requests.length === 1 ? completed([reasoning, call]) : completed([finalItem]);
    const data = `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: '完成 🐙' })}\n\ndata: ${JSON.stringify({ type: 'response.completed', response: result })}\n\n`;
    const encoded = Buffer.from(data);
    for (let i = 0; i < encoded.length; i += 7) res.write(encoded.subarray(i, i + 7)); res.end();
  }); t.after(local.close);
  const provider = new ResponsesProvider({ baseUrl: local.url, model: 'fixture', apiKey: 'fake-key', timeoutMs: 2000 }, e => deltas.push(e));
  const messages: Message[] = [{ role: 'system', content: 'rules' }, { role: 'user', content: 'read' }];
  const reply = await provider.complete(messages, [], new AbortController().signal);
  assert.equal(reply.toolCalls![0]!.id, 'call_1');
  messages.push({ role: 'assistant', ...reply }, { role: 'tool', toolCallId: 'call_1', content: 'file content' });
  assert.equal((await provider.complete(messages, [], new AbortController().signal)).content, '完成 🐙');
  const input = requests[1]!.input as Record<string, unknown>[];
  assert.deepEqual(input.slice(2, 4), [reasoning, call]);
  assert.deepEqual(input[4], { type: 'function_call_output', call_id: 'call_1', output: 'file content' });
  assert.equal(requests[0]!.store, false); assert.deepEqual(requests[0]!.include, ['reasoning.encrypted_content']);
  assert.deepEqual(headers, ['Bearer fake-key', 'Bearer fake-key']); assert.equal(deltas.length, 2);
});
test('Responses rejects incomplete streams and incomplete output', async t => {
  const local = await server((_req, res) => { res.setHeader('content-type', 'text/event-stream'); res.end('data: {"type":"response.output_text.delta","delta":"partial"}\n\n'); }); t.after(local.close);
  const provider = new ResponsesProvider({ baseUrl: local.url, model: 'fixture', timeoutMs: 1000 });
  await assert.rejects(provider.complete([], [], new AbortController().signal), /without response.completed/);
  assert.throws(() => decodeResponse({ status: 'incomplete', output: [finalItem] }), /Incomplete/);
  assert.throws(() => decodeResponse(completed([{ type: 'unsupported' }])));
});
test('HTTP failures never expose remote body; request timeout aborts waiting', async t => {
  const failing = await server((_req, res) => { res.statusCode = 401; res.end('secret-echo-do-not-print'); }); t.after(failing.close);
  const p = new CompatibleProvider({ baseUrl: failing.url, model: 'fixture', timeoutMs: 1000 }, reference.decodeChat);
  await assert.rejects(p.complete([], [], new AbortController().signal), error => {
    assert.match((error as Error).message, /HTTP 401/); assert.doesNotMatch((error as Error).message, /secret/); return true;
  });
  const waiting = await server(() => {}); t.after(waiting.close);
  const q = new CompatibleProvider({ baseUrl: waiting.url, model: 'fixture', timeoutMs: 30 }, reference.decodeChat);
  await assert.rejects(q.complete([], [], new AbortController().signal), /模型单次请求超时/);
});
test('Provider URL rejects embedded credentials and remote plaintext HTTP', () => {
  for (const url of ['https://user:pass@example.com/v1', 'http://example.com/v1', 'https://example.com/v1?key=x']) assert.throws(() => apiUrl(url, 'responses'));
  assert.equal(apiUrl('http://127.0.0.1:11434/v1/', 'chat/completions'), 'http://127.0.0.1:11434/v1/chat/completions');
  assert.deepEqual(responseInput([{ role: 'assistant', content: 'done' }]), [{ role: 'assistant', content: 'done' }]);
});
