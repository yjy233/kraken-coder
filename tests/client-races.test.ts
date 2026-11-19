import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { AgentClient } from '../src/client/client.js';
import { runRemoteTurn } from '../src/client/remote-turn.js';
import type { ServerFrame } from '../src/server/protocol.js';
import type { Event } from '../src/core/types.js';

test('remote CLI cancellation stops an unfinished SSE handshake without submitting a task', { timeout: 2000 }, async t => {
  const controller = new AbortController(); let requests = 0;
  const server = createServer((_req, _res) => { requests++; controller.abort(new Error('cancel opening connection')); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const client = new AgentClient(`http://127.0.0.1:${address.port}`, 'test-token');
  await assert.rejects(runRemoteTurn({ client, session: 's', message: 'task', emit: () => {}, approve: async () => false, signal: controller.signal }), /cancel opening connection/);
  assert.equal(requests, 1);
});

/** A second client finishes a later turn before the first client's POST acknowledgement arrives. */
test('remote CLI identifies its result when later turn events arrive before its POST acknowledgement', { timeout: 5000 }, async t => {
  let stream: ServerResponse, acknowledgement: ServerResponse;
  const send = (frame: ServerFrame) => stream.write(`data: ${JSON.stringify(frame)}\n\n`);
  const server = createServer((req, res) => {
    if (req.url?.endsWith('/events')) {
      stream = res;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      send({ type: 'snapshot', snapshot: { session: { id: 's', title: 'session', updatedAt: '' }, events: [], turn: null, approvals: [], inputs: [] } });
      return;
    }
    if (req.url?.endsWith('/turns')) {
      acknowledgement = res;
      req.resume();
      send({ type: 'state', sessionId: 's', turn: { id: 'own', status: 'running' }, approvals: [], inputs: [] });
      send({ type: 'event', sessionId: 's', turnId: 'own', event: { type: 'turn.completed', answer: 'own answer' } });
      send({ type: 'state', sessionId: 's', turn: { id: 'own', status: 'completed' }, approvals: [], inputs: [] });
      send({ type: 'state', sessionId: 's', turn: { id: 'next', status: 'running' }, approvals: [], inputs: [] });
      send({ type: 'event', sessionId: 's', turnId: 'next', event: { type: 'turn.completed', answer: 'other answer' } });
      send({ type: 'state', sessionId: 's', turn: { id: 'next', status: 'completed' }, approvals: [], inputs: [] });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { stream?.end(); acknowledgement?.end(); server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const client = new AgentClient(`http://127.0.0.1:${address.port}`, 'test-token');
  const watch = client.watchSession.bind(client);
  client.watchSession = (id, onFrame, signal) => watch(id, frame => {
    onFrame(frame);
    // A controlled barrier: no timer assumptions about packet ordering or machine load.
    if (frame.type === 'state' && frame.turn?.id === 'next' && frame.turn.status === 'completed') {
      acknowledgement.writeHead(202, { 'Content-Type': 'application/json' });
      acknowledgement.end(JSON.stringify({ turn: { id: 'own', status: 'running' } }));
    }
  }, signal);
  const events: Event[] = [];
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_yes, no) => { timer = setTimeout(() => no(new Error('Client lost its completed turn while awaiting POST acknowledgement')), 2000); });
  const turn = runRemoteTurn({ client, session: 's', message: 'task', emit: event => events.push(event), approve: async () => false, signal: new AbortController().signal });
  try {
    assert.equal(await Promise.race([turn, timeout]), 'own answer');
    assert.deepEqual(events.filter(event => event.type === 'turn.completed').map(event => event.answer), ['own answer']);
  } finally { clearTimeout(timer!); }
});
