import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { request as httpRequest } from 'node:http';
import { startAgentServer, type AgentServer, type AgentServerOptions } from '../src/server/server.js';
import { defaults } from '../src/config.js';
import type { Event, Message, Provider } from '../src/core/types.js';
import { validateHistory } from '../src/core/validation.js';
import { AgentClient } from '../src/client/client.js';
import type { ServerFrame, SessionSnapshot } from '../src/server/protocol.js';
import { SessionStore } from '../src/session/store.js';

async function until<T>(read: () => Promise<T> | T, predicate: (value: T) => boolean, timeout = 5000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) { const result = await read(); if (predicate(result)) return result; if (Date.now() >= deadline) throw new Error('Timed out waiting for test condition'); await delay(10); }
}
async function fixture(t: TestContext, overrides: Partial<AgentServerOptions> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'kraken-server-')));
  const options: AgentServerOptions = { workspace: root, home: join(root, '.kraken-coder'), config: { ...defaults }, port: 0, ...overrides };
  let server = await startAgentServer(options);
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  const request = async (path: string, body?: unknown, headers: Record<string, string> = {}) => fetch(server.url + '/api/v1' + path, {
    method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${server.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const create = async () => { const response = await request('/sessions', {}); assert.equal(response.status, 201); return (await response.json()).session.id as string; };
  const snapshot = async (id: string): Promise<SessionSnapshot> => { const response = await request(`/sessions/${id}`); assert.equal(response.status, 200); return response.json(); };
  const start = async (id: string, message: string) => { const response = await request(`/sessions/${id}/turns`, { message }); assert.equal(response.status, 202); return (await response.json()).turn; };
  const settled = async (id: string) => until(() => snapshot(id), s => !!s.turn && s.turn.status !== 'running');
  return { root, options, request, create, snapshot, start, settled, get server() { return server; }, async restart() { await server.close(); server = await startAgentServer(options); } };
}
async function watch(server: AgentServer, id: string) {
  const controller = new AbortController(), frames: ServerFrame[] = [];
  const response = await fetch(`${server.url}/api/v1/sessions/${id}/events`, { headers: { Authorization: `Bearer ${server.token}` }, signal: controller.signal });
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type')!, /text\/event-stream/);
  const reader = response.body!.getReader(), decoder = new TextDecoder();
  const done = (async () => {
    let buffer = '';
    try {
      for (;;) {
        const chunk = await reader.read(); if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let at: number;
        while ((at = buffer.indexOf('\n\n')) >= 0) {
          const line = buffer.slice(0, at); buffer = buffer.slice(at + 2);
          if (line.startsWith('data: ')) frames.push(JSON.parse(line.slice(6)));
        }
      }
    } catch (error) { if (!controller.signal.aborted) throw error; }
    finally { reader.releaseLock(); }
  })();
  await until(() => frames, value => value.length > 0);
  return { frames, async close() { controller.abort(); await done; } };
}
function patchProvider(): Provider {
  let calls = 0;
  return { name: 'test:patch', async complete(messages) {
    const last = messages.at(-1)!;
    if (last.role === 'tool') return { content: last.content };
    return { content: '', toolCalls: [{ id: `patch-${++calls}`, name: 'apply_patch', arguments: JSON.stringify({ patch: '*** Begin Patch\n*** Add File: created.txt\n+approved\n*** End Patch' }) }] };
  } };
}
const eventMessages = (events: Event[]) => events.filter(e => e.type === 'message').map(e => e.message as { role: string; content: string });

for (const mode of ['reference', 'learner'] as const) test(`agent-server (${mode}): steering follows the full tool group and follow-ups start in order`, async t => {
  let releaseDraft!: () => void;
  const draft = new Promise<void>(resolve => { releaseDraft = resolve; });
  const requests: Message[][] = [];
  const provider: Provider = { name: 'test:queued-input', async complete(messages, _tools, signal) {
    validateHistory(messages);
    requests.push([...messages]);
    const user = messages.findLast(message => message.role === 'user')!;
    if (user.content === 'original task') return { content: '', toolCalls: [
      { id: 'write', name: 'apply_patch', arguments: JSON.stringify({ patch: '*** Begin Patch\n*** Add File: created.txt\n+test\n*** End Patch' }) },
      { id: 'read', name: 'read_file', arguments: '{"path":"hello.txt"}' },
    ] };
    if (user.content === 'change scope') {
      await Promise.race([draft, delay(5000, undefined, { signal, ref: false })]);
      return { content: 'draft before revision' };
    }
    return { content: `answer: ${user.content}` };
  } };
  const f = await fixture(t, { provider, config: { ...defaults, mode } });
  t.after(releaseDraft);
  await writeFile(join(f.root, 'hello.txt'), 'hello');
  const client = new AgentClient(f.server.url, f.server.token);
  const id = await f.create(), other = await f.create(), stream = await watch(f.server, id);
  t.after(() => stream.close());
  const turn = await client.startTurn(id, 'original task');
  const waiting = await until(() => client.session(id), snapshot => snapshot.approvals.length === 1);
  const steer = await client.queueInput(id, turn.id, 'steer', 'change scope');
  const first = await client.queueInput(id, turn.id, 'follow_up', 'first follow-up');
  const removed = await client.queueInput(id, turn.id, 'follow_up', 'remove this');
  const second = await client.queueInput(id, turn.id, 'follow_up', 'second follow-up');
  await client.removeInput(id, removed.id);
  assert.equal((await f.request(`/sessions/${other}/turns`, { message: 'another session' })).status, 409);
  assert.equal((await client.session(id)).events.some(event => event.type === 'message' && (event.message as Message).steered), false);
  const reconnect = await watch(f.server, id);
  try {
    const frame = reconnect.frames[0];
    assert.equal(frame?.type, 'snapshot');
    assert.deepEqual(frame.snapshot.inputs, [steer, first, second]);
  } finally { await reconnect.close(); }
  await client.approve(id, waiting.approvals[0]!.id, false);
  await until(() => requests.length, count => count === 2);
  assert.deepEqual(requests[1]!.slice(-3).map(message => message.toolCallId ?? message.content), ['write', 'read', 'change scope']);
  await client.queueInput(id, turn.id, 'steer', 'late revision');
  releaseDraft();
  const result = await until(() => client.session(id), snapshot =>
    snapshot.turn?.status === 'completed' && snapshot.events.filter(event => event.type === 'turn.completed').length === 3);
  assert.deepEqual(result.inputs, []);
  assert.deepEqual(result.events.filter(event => event.type === 'turn.completed').map(event => event.answer),
    ['answer: late revision', 'answer: first follow-up', 'answer: second follow-up']);
  const messages = result.events.filter(event => event.type === 'message').map(event => event.message as Message);
  assert.deepEqual(messages.filter(message => message.steered).map(message => message.content), ['change scope', 'late revision']);
  assert.deepEqual(messages.filter(message => message.role === 'user' && !message.steered).map(message => message.content),
    ['original task', 'first follow-up', 'second follow-up']);
  const completed = await until(() => stream.frames.flatMap(frame =>
    frame.type === 'event' && frame.event.type === 'turn.completed' ? [frame.turnId] : []), ids => ids.length === 3);
  assert.equal(new Set(completed).size, 3);
  assert.equal(completed[0], turn.id);
  await assert.rejects(client.queueInput(id, turn.id, 'steer', 'stale'), { status: 409, code: 'stale_turn' });
});

test('agent-server: stopping leaves follow-ups for explicit resumption', async t => {
  const requests: string[] = [];
  const provider: Provider = { name: 'test:pause-input', async complete(messages, _tools, signal) {
    const input = messages.at(-1)!.content;
    requests.push(input);
    if (input === 'wait') await delay(5000, undefined, { signal, ref: false });
    return { content: input };
  } };
  const f = await fixture(t, { provider }), id = await f.create();
  const client = new AgentClient(f.server.url, f.server.token);
  const { id: turnId } = await client.startTurn(id, 'wait');
  await until(() => requests.length, count => count === 1);
  const followUp = await client.queueInput(id, turnId, 'follow_up', 'after cancellation');
  await client.cancelTurn(id, turnId);
  const stopped = await f.settled(id);
  assert.equal(stopped.turn?.status, 'cancelled');
  assert.deepEqual(stopped.inputs, [followUp]);
  await client.startTurn(id, 'unrelated task');
  const unrelated = await f.settled(id);
  assert.deepEqual(unrelated.inputs, [followUp]);
  assert.deepEqual(requests, ['wait', 'unrelated task']);
  await client.resumeFollowUps(id);
  const resumed = await f.settled(id);
  assert.equal(resumed.turn?.status, 'completed');
  assert.deepEqual(resumed.inputs, []);
  assert.deepEqual(requests, ['wait', 'unrelated task', 'after cancellation']);
});

test('agent-server: real Demo read, live events, reconnect, persistence and multi-turn history', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'hello.txt'), 'hello-server');
  const id = await f.create(), stream = await watch(f.server, id);
  t.after(() => stream.close());
  assert.equal(stream.frames[0]?.type, 'snapshot');
  const ownTurn = await f.start(id, '/read hello.txt');
  const first = await f.settled(id);
  assert.equal(first.turn?.status, 'completed');
  assert.match(eventMessages(first.events).at(-1)!.content, /hello-server/);
  assert.ok(stream.frames.some(frame => frame.type === 'event' && frame.event.type === 'tool.end' && frame.turnId === ownTurn.id));
  assert.ok(stream.frames.filter(frame => frame.type === 'event').every(frame => frame.turnId === ownTurn.id));
  await f.start(id, '/files');
  const second = await f.settled(id);
  assert.equal(eventMessages(second.events).filter(m => m.role === 'user').length, 2);
  await stream.close();
  await f.restart();
  const restored = await f.snapshot(id);
  assert.equal(restored.turn?.status, 'completed');
  assert.deepEqual(eventMessages(restored.events), eventMessages(second.events));
  const reconnect = await watch(f.server, id);
  assert.equal(reconnect.frames[0]?.type, 'snapshot');
  assert.deepEqual((reconnect.frames[0] as Extract<ServerFrame, { type: 'snapshot' }>).snapshot.events, restored.events);
  await reconnect.close();
  const sessions = (await (await f.request('/sessions')).json()).sessions;
  assert.equal(sessions.length, 1); assert.equal(sessions[0].title, '/read hello.txt');
});

test('agent-server: approving a disconnected pending write resumes exactly once', async t => {
  const f = await fixture(t, { provider: patchProvider() }), id = await f.create();
  let stream = await watch(f.server, id);
  const turn = await f.start(id, 'create');
  const awaiting = await until(() => f.snapshot(id), s => s.approvals.length === 1);
  await assert.rejects(readFile(join(f.root, 'created.txt')), /ENOENT/);
  assert.equal(awaiting.approvals[0]!.turnId, turn.id);
  await stream.close();
  stream = await watch(f.server, id);
  const reconnect = (stream.frames[0] as Extract<ServerFrame, { type: 'snapshot' }>).snapshot;
  assert.equal(reconnect.approvals[0]!.id, awaiting.approvals[0]!.id);
  const approvalPath = `/sessions/${id}/approvals/${awaiting.approvals[0]!.id}`;
  assert.equal((await f.request(approvalPath, { approved: true })).status, 200);
  assert.equal((await f.request(approvalPath, { approved: true })).status, 409);
  const result = await f.settled(id);
  assert.equal(result.turn?.status, 'completed'); assert.deepEqual(result.approvals, []);
  assert.equal(await readFile(join(f.root, 'created.txt'), 'utf8'), 'approved\n');
  assert.equal(result.events.filter(e => e.type === 'files.changed').length, 1);
  await stream.close();
});

test('agent-server: denial returns a tool error to the model without mutating the file', async t => {
  const f = await fixture(t, { provider: patchProvider() }), id = await f.create();
  await f.start(id, 'create');
  const awaiting = await until(() => f.snapshot(id), s => s.approvals.length === 1);
  assert.equal((await f.request(`/sessions/${id}/approvals/${awaiting.approvals[0]!.id}`, { approved: false })).status, 200);
  const result = await f.settled(id);
  assert.equal(result.turn?.status, 'completed');
  assert.match(eventMessages(result.events).at(-1)!.content, /User denied/);
  await assert.rejects(readFile(join(f.root, 'created.txt')), /ENOENT/);
});

test('agent-server: cancellation aborts pending approvals and releases the global turn owner', async t => {
  const f = await fixture(t, { provider: patchProvider() }), id = await f.create(), second = await f.create();
  const turn = await f.start(id, 'create');
  const awaiting = await until(() => f.snapshot(id), s => s.approvals.length === 1);
  assert.equal((await f.request(`/sessions/${id}/turns`, { message: 'duplicate' })).status, 409);
  assert.equal((await f.request(`/sessions/${second}/turns`, { message: 'other workspace edit' })).status, 409);
  assert.equal((await f.request(`/sessions/${id}/turns/not-the-current-turn/cancel`, {})).status, 409);
  assert.equal((await f.request(`/sessions/${id}/turns/${turn.id}/cancel`, {})).status, 200);
  const result = await f.settled(id); assert.equal(result.turn?.status, 'cancelled'); assert.deepEqual(result.approvals, []);
  assert.equal((await f.request(`/sessions/${id}/approvals/${awaiting.approvals[0]!.id}`, { approved: true })).status, 409);
  await assert.rejects(readFile(join(f.root, 'created.txt')), /ENOENT/);
  const next = await f.start(second, 'try again');
  await until(() => f.snapshot(second), s => s.approvals.length === 1);
  await f.request(`/sessions/${second}/turns/${next.id}/cancel`, {});
  await f.settled(second);
});

test('agent-server: a failed model leaves a recoverable session and reports failure', async t => {
  let first = true;
  const provider: Provider = { name: 'test:fail', async complete() { if (first) { first = false; throw new Error('fixture failure'); } return { content: 'recovered', reasoningContent: 'returned reasoning text', responseItems: [{ encrypted_content: 'private encrypted item' }] }; } };
  const f = await fixture(t, { provider }), id = await f.create();
  await f.start(id, 'start');
  const failed = await f.settled(id); assert.equal(failed.turn?.status, 'failed'); assert.match(failed.turn?.error ?? '', /fixture failure/);
  await f.start(id, 'continue');
  const result = await f.settled(id); assert.equal(result.turn?.status, 'completed');
  const wire = JSON.stringify(result);
  assert.match(wire, /returned reasoning text/);
  assert.doesNotMatch(wire, /private encrypted item|responseItems|instructions\.snapshot/);
});

test('agent-server: returned reasoning accompanies tool calls and survives SSE reconnect and restart', async t => {
  const reasoning = '<script>fixture</script>\nRead the file before answering.';
  const provider: Provider = { name: 'test:reasoning', async complete(messages) {
    if (messages.at(-1)?.role === 'tool') return { content: 'done', reasoningContent: '   ' };
    return { content: '', reasoningContent: reasoning, responseItems: [{ type: 'reasoning', encrypted_content: 'opaque-state' }],
      toolCalls: [{ id: 'reasoning-read', name: 'read_file', arguments: '{"path":"hello.txt"}' }] };
  } };
  const f = await fixture(t, { provider }), id = await f.create();
  await writeFile(join(f.root, 'hello.txt'), 'hello');
  const stream = await watch(f.server, id);
  t.after(() => stream.close());
  await f.start(id, 'read');
  const result = await f.settled(id);
  assert.equal(result.turn?.status, 'completed');
  const thinking = result.events.filter(e => e.type === 'message' && (e.message as { reasoningContent?: string }).reasoningContent);
  assert.equal(thinking.length, 1);
  assert.deepEqual((thinking[0]!.message as { content: string; reasoningContent: string }).reasoningContent, reasoning);
  await until(() => stream.frames, frames => frames.some(frame => frame.type === 'event' && frame.event.type === 'message' && (frame.event.message as { reasoningContent?: string }).reasoningContent === reasoning));
  assert.doesNotMatch(JSON.stringify(result), /opaque-state|responseItems|instructions\.snapshot/);
  await stream.close();
  await f.restart();
  const restored = await f.snapshot(id);
  assert.deepEqual(restored.events, result.events);
  const reconnect = await watch(f.server, id);
  try {
    assert.deepEqual((reconnect.frames[0] as Extract<ServerFrame, { type: 'snapshot' }>).snapshot.events, restored.events);
  } finally { await reconnect.close(); }
});

test('agent-server: failures before runTurn emits are observable and do not leave a busy owner', async t => {
  const f = await fixture(t), id = await f.create();
  const lock = SessionStore.open(f.options.home, { id, workspace: f.root, provider: 'demo:v1' });
  t.after(() => lock.close());
  await f.start(id, '/files');
  const result = await f.settled(id); assert.equal(result.turn?.status, 'failed'); assert.match(result.turn?.error ?? '', /locked/);
  lock.close();
  await f.start(id, '/files');
  assert.equal((await f.settled(id)).turn?.status, 'completed');
});

test('agent-server: disconnect never cancels, but closing the server cancels its model request', async t => {
  let aborted = false;
  const provider: Provider = { name: 'test:wait', async complete(_m, _t, signal) { return new Promise((_resolve, reject) => { signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true }); }); } };
  const f = await fixture(t, { provider }), id = await f.create(), stream = await watch(f.server, id);
  await f.start(id, 'wait');
  await until(() => f.snapshot(id), s => s.events.some(e => e.type === 'model.start'));
  await stream.close(); assert.equal(aborted, false); assert.equal((await f.snapshot(id)).turn?.status, 'running');
  await f.server.close(); assert.equal(aborted, true);
});

test('agent-server: token, Host, Origin, JSON validation and allowlisted assets protect local runtime', async t => {
  const f = await fixture(t), id = await f.create();
  assert.equal((await fetch(f.server.url + '/api/v1/info')).status, 401);
  assert.equal((await f.request('/info', undefined, { Authorization: 'Bearer invalid' })).status, 401);
  assert.equal(await new Promise<number | undefined>((resolve, reject) => { const req = httpRequest(f.server.url + '/api/v1/info', { headers: { Host: 'attacker.example', Authorization: `Bearer ${f.server.token}` } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); req.end(); }), 403);
  assert.equal((await f.request('/info', undefined, { Origin: 'https://attacker.example' })).status, 403);
  assert.equal((await f.request('/info', undefined, { Origin: f.server.url })).status, 200);
  assert.equal((await f.request('/sessions', {}, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await f.request('/sessions', { config: { approval: 'full-auto' } })).status, 400);
  assert.equal((await f.request(`/sessions/${id}/turns`, { message: '' })).status, 400);
  assert.equal((await f.request(`/sessions/${id}/turns`, { message: 'a'.repeat(32_001) })).status, 400);
  assert.equal((await f.request(`/sessions/${id}/turns`, { message: 'a'.repeat(128_001) })).status, 413);
  assert.equal((await f.request('/sessions/missing')).status, 404);
  assert.equal((await f.request('/sessions/%2f')).status, 400);
  assert.equal((await fetch(f.server.url + '/.env')).status, 404);
  assert.equal((await fetch(f.server.url + '/src/server/server.ts')).status, 404);
  const info = await (await f.request('/info')).json();
  assert.deepEqual(Object.keys(info).sort(), ['approval', 'mode', 'model', 'provider', 'requestTimeoutMs', 'shellEnabled', 'turnTimeoutMs', 'version', 'workspace']);
  assert.doesNotMatch(JSON.stringify(info), new RegExp(f.server.token));
});

test('agent-server: sessions from another workspace/provider are not exposed', async t => {
  const f = await fixture(t), id = await f.create();
  const other = SessionStore.open(f.options.home, { id: 'other', workspace: f.root, provider: 'different-model' }); other.close();
  assert.equal((await f.request('/sessions/other')).status, 409);
  assert.deepEqual((await (await f.request('/sessions')).json()).sessions.map((s: { id: string }) => s.id), [id]);
});

test('agent-server: timeout settings persist only allowed fields without exposing credentials', async t => {
  const f = await fixture(t), path = join(f.root, '.env');
  await writeFile(path, '# Keep provider settings\nKRAKEN_API_KEY=fixture-secret\nKRAKEN_MODEL=example\n');
  assert.equal((await fetch(f.server.url + '/api/v1/settings')).status, 401);
  const limits = { requestTimeoutMs: 180_000, turnTimeoutMs: 10_800_000 };
  assert.deepEqual(await (await f.request('/settings', limits)).json(), limits);
  const saved = await readFile(path, 'utf8');
  assert.match(saved, /# Keep provider settings\nKRAKEN_API_KEY=fixture-secret\nKRAKEN_MODEL=example\n/);
  assert.match(saved, /KRAKEN_TURN_TIMEOUT_MS=10800000/);
  assert.deepEqual(await (await f.request('/settings')).json(), limits);
  assert.equal((await (await f.request('/info')).json()).turnTimeoutMs, limits.turnTimeoutMs);
  assert.doesNotMatch(JSON.stringify(await (await f.request('/settings')).json()), /fixture-secret|KRAKEN_API_KEY/);
  for (const input of [{ ...limits, turnTimeoutMs: 10_800_001 }, { ...limits, requestTimeoutMs: '180000' }, { ...limits, apiKey: 'forbidden' }, { requestTimeoutMs: 1 }]) {
    assert.equal((await f.request('/settings', input)).status, 400);
  }
  assert.equal(await readFile(path, 'utf8'), saved);
});

test('agent-server: new timeout settings apply to the next turn, not an active one', async t => {
  const provider: Provider = { name: 'test:settings', complete(_m, _t, signal) {
    return new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
  } };
  const f = await fixture(t, { config: { ...defaults, turnTimeoutMs: 5000 }, provider }), id = await f.create();
  const first = await f.start(id, 'wait');
  await until(() => f.snapshot(id), snapshot => snapshot.events.some(event => event.type === 'model.start'));
  assert.equal((await f.request('/settings', { requestTimeoutMs: 180_000, turnTimeoutMs: 30 })).status, 200);
  await delay(60);
  assert.equal((await f.snapshot(id)).turn?.status, 'running');
  await f.request(`/sessions/${id}/turns/${first.id}/cancel`, {});
  assert.equal((await f.settled(id)).turn?.status, 'cancelled');
  await f.start(id, 'next');
  const result = await f.settled(id);
  assert.equal(result.turn?.status, 'failed');
  assert.match(result.turn?.error ?? '', /整轮任务超时/);
});
