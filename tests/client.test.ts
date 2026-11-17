import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { defaults } from '../src/config.js';
import { startAgentServer } from '../src/server/server.js';
import { AgentClient } from '../src/client/client.js';
import { runRemoteTurn } from '../src/client/remote-turn.js';
import type { Event, Provider } from '../src/core/types.js';

const exec = promisify(execFile);
async function fixture(t: test.TestContext, provider?: Provider) {
  const workspace = await mkdtemp(join(tmpdir(), 'kraken-client-'));
  await writeFile(join(workspace, 'hello.txt'), '来自共享服务的内容');
  const server = await startAgentServer({ config: { ...defaults, mode: 'learner' }, workspace, home: join(workspace, '.kraken-coder'), port: 0, provider });
  t.after(async () => { await server.close(); await rm(workspace, { recursive: true, force: true }); });
  return { server, client: new AgentClient(server.url, server.token), workspace };
}

test('shared SDK observes remote turns and CLI resumes the same server-owned session', async t => {
  const { server, client } = await fixture(t);
  const session = await client.createSession(), events: Event[] = [];
  const answer = await runRemoteTurn({ client, session: session.id, message: '/read hello.txt', emit: event => events.push(event), approve: async () => false, signal: new AbortController().signal });
  assert.match(answer, /来自共享服务的内容/);
  assert.ok(events.some(e => e.type === 'tool.end' && e.ok === true));
  const url = `${server.url}/#token=${server.token}`;
  const result = await exec(process.execPath, ['--import', 'tsx', resolve('src/cli.ts'), 'exec', '--server', url, '--session', session.id, '--message', '/files', '--json'], { timeout: 15_000 });
  const output = result.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(output.at(-1).type, 'turn.completed');
  assert.match(output.at(-1).answer, /hello.txt/);
  const snapshot = await client.session(session.id);
  assert.equal(snapshot.events.filter(e => e.type === 'turn.completed').length, 2);
  const sessions = await exec(process.execPath, ['--import', 'tsx', resolve('src/cli.ts'), 'sessions', '--server', url], { timeout: 15_000 });
  assert.equal(JSON.parse(sessions.stdout)[0].id, session.id);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(server.token));
});

test('remote client relays approval decisions; rejecting a patch never changes the file', async t => {
  const provider: Provider = { name: 'test:approval', async complete(messages) {
    const last = messages.at(-1)!;
    return last.role === 'tool' ? { content: last.content } : { content: '', toolCalls: [{ id: 'patch-one', name: 'apply_patch', arguments: JSON.stringify({ patch: '*** Begin Patch\n*** Update File: hello.txt\n@@\n-来自共享服务的内容\n+changed\n*** End Patch' }) }] };
  } };
  const { client, workspace } = await fixture(t, provider);
  const { id } = await client.createSession(); let prompted = false;
  const answer = await runRemoteTurn({ client, session: id, message: 'edit', emit: () => {}, approve: async request => { prompted = true; assert.match(request.preview, /changed/); return false; }, signal: new AbortController().signal });
  assert.equal(prompted, true); assert.match(answer, /User denied/);
  const { readFile } = await import('node:fs/promises');
  assert.equal(await readFile(join(workspace, 'hello.txt'), 'utf8'), '来自共享服务的内容');
});

test('remote client cancellation reaches an in-flight model call', async t => {
  const provider: Provider = { name: 'test:wait', async complete(_messages, _tools, signal) {
    signal.throwIfAborted();
    return new Promise((_yes, no) => signal.addEventListener('abort', () => no(signal.reason), { once: true }));
  } };
  const { client } = await fixture(t, provider), session = await client.createSession();
  const controller = new AbortController();
  await assert.rejects(runRemoteTurn({ client, session: session.id, message: 'wait', emit: event => { if (event.type === 'model.start') controller.abort(); }, approve: async () => false, signal: controller.signal }), /Cancelled/);
  assert.equal((await client.session(session.id)).turn?.status, 'cancelled');
});

test('remote CLI rejects local permission overrides instead of silently ignoring them', async t => {
  const { server } = await fixture(t);
  await assert.rejects(exec(process.execPath, ['--import', 'tsx', resolve('src/cli.ts'), 'exec', '--server', `${server.url}/#token=${server.token}`, '--approval', 'full-auto', '--message', '/files']), error => {
    assert.match((error as { stderr: string }).stderr, /owned by the server/); return true;
  });
});
