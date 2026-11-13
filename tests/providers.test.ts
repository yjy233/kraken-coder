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
import type { Message } from '../src/core/types.js';
async function server(handler: RequestListener) {
  const srv = createServer(handler); srv.listen(0, '127.0.0.1'); await once(srv, 'listening');
  return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1`, close: async () => {
    srv.closeAllConnections(); await new Promise<void>(resolve => srv.close(() => resolve()));
  } };
}
const completed = (output: unknown[]) => ({ status: 'completed', output });
const finalItem = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '完成 🐙' }] };
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
  await assert.rejects(q.complete([], [], new AbortController().signal), /timeout/i);
});
test('Provider URL rejects embedded credentials and remote plaintext HTTP', () => {
  for (const url of ['https://user:pass@example.com/v1', 'http://example.com/v1', 'https://example.com/v1?key=x']) assert.throws(() => apiUrl(url, 'responses'));
  assert.equal(apiUrl('http://127.0.0.1:11434/v1/', 'chat/completions'), 'http://127.0.0.1:11434/v1/chat/completions');
  assert.deepEqual(responseInput([{ role: 'assistant', content: 'done' }]), [{ role: 'assistant', content: 'done' }]);
});
