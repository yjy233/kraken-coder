import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaults } from '../src/config.js';
import { runTurn } from '../src/core/agent.js';
import type { Message, Provider } from '../src/core/types.js';
import { AgentClient } from '../src/client/client.js';
import { runRemoteTurn } from '../src/client/remote-turn.js';
import { startAgentServer } from '../src/server/server.js';

test('a remote turn expands only the selected plugin skill, supports relative references, and keeps the public history clean', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'kraken-skill-api-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const workspace = join(temp, 'project'), plugin = join(temp, 'team'), home = join(temp, 'state');
  const local = join(workspace, '.agents/skills/review'), packaged = join(plugin, 'skills/review');
  await Promise.all([mkdir(local, { recursive: true }), mkdir(join(packaged, 'references'), { recursive: true })]);
  const manifest = { $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', name: 'team' };
  const front = '---\nname: Review_v2\ndescription: review a patch\n---\n';
  await Promise.all([
    writeFile(join(plugin, 'plugin.json'), JSON.stringify(manifest)),
    writeFile(join(plugin, 'mcp.json'), JSON.stringify({ mcpServers: { optional: { command: 'unused', env: { PRIVATE: 'private-fixture-value' } } } })),
    writeFile(join(local, 'SKILL.md'), front + 'LOCAL_BODY'),
    writeFile(join(packaged, 'SKILL.md'), front + 'PACKAGE_BODY'),
    writeFile(join(packaged, 'references/check.txt'), 'one\ntwo\nthree'),
  ]);
  let steps = 0;
  const provider: Provider = { name: 'capture', async complete(messages) {
    steps++;
    if (steps === 1) {
      assert.doesNotMatch(messages[0]!.content, /PACKAGE_BODY|LOCAL_BODY/);
      assert.match(messages.at(-1)!.content, /PACKAGE_BODY/);
      assert.doesNotMatch(messages.at(-1)!.content, /LOCAL_BODY/);
      return { content: '', toolCalls: [{ id: 'ref', name: 'read_skill', arguments: JSON.stringify({
        name: 'team:Review_v2', resource: 'references/check.txt', start_line: 2, line_count: 1,
      }) }] };
    }
    const result = JSON.parse(messages.at(-1)!.content);
    assert.equal(result.result.content, 'two');
    return { content: 'verified' };
  } };
  const server = await startAgentServer({ config: { ...defaults, plugins: [plugin], approval: 'read-only' }, workspace, home, provider, port: 0 });
  t.after(() => server.close());
  const client = new AgentClient(server.url);
  const catalog = await client.extensions();
  assert.deepEqual(catalog.skills.map(s => s.name).sort(), ['Review_v2', 'team:Review_v2']);
  assert.doesNotMatch(JSON.stringify(catalog), /PACKAGE_BODY|LOCAL_BODY|private-fixture-value/);
  const session = (await client.createSession()).id;
  await runRemoteTurn({ client, session, message: '请使用 $team:Review_v2。', signal: AbortSignal.timeout(5000), emit() {}, approve: async () => false });
  assert.equal(steps, 2);
  const events = (await client.session(session)).events;
  const user = events.find(e => e.type === 'message' && (e.message as Message).role === 'user')!;
  assert.deepEqual(user.message, { role: 'user', content: '请使用 $team:Review_v2。' });
  assert.ok(events.some(e => e.type === 'turn.completed' && e.answer === 'verified'));
});

test('an explicit skill in steer is expanded once and the journal replays its original snapshot', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kraken-steer-skill-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, '.agents/skills/review');
  await mkdir(dir, { recursive: true });
  const front = '---\nname: review\ndescription: verify\n---\n';
  await writeFile(join(dir, 'SKILL.md'), front + 'first revision');
  const requests: string[][] = [];
  let queue: string[] = [];
  const provider: Provider = { name: 'steer-capture', async complete(messages) {
    requests.push(messages.map(m => m.content));
    if (requests.length === 1) queue = ['$review'];
    return { content: 'observed' };
  } };
  const options = { workspace: root, home: join(root, '.kraken-coder'), session: 'capture', config: defaults, provider,
    takeSteering: () => queue.splice(0) };
  await runTurn(options, 'please check');
  assert.equal(requests.length, 2);
  assert.doesNotMatch(requests[0]!.join('\n'), /first revision/);
  assert.match(requests[1]!.join('\n'), /first revision/);
  await writeFile(join(dir, 'SKILL.md'), front + 'updated revision');
  await runTurn(options, 'continue');
  assert.match(requests[2]!.join('\n'), /first revision/);
  assert.doesNotMatch(requests[2]!.join('\n'), /updated revision/);
});

for (const mode of ['learner', 'reference'] as const) {
  test(`${mode}: a steer received during Stop hook approval reaches the next model request`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'kraken-stop-steer-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const hookFile = join(root, 'hooks.json');
    await writeFile(hookFile, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'true' }] }] } }));
    const queue: string[] = [];
    let approvals = 0, steps = 0;
    const provider: Provider = { name: 'stop-steer', async complete(messages) {
      if (++steps === 2) assert.equal(messages.at(-1)?.content, 'one more check');
      return { content: 'done' };
    } };
    await runTurn({ config: { ...defaults, mode, hookFiles: [hookFile] }, workspace: root, home: root, session: mode,
      allowShell: true, provider, takeSteering: () => queue.splice(0), approve: async () => {
        if (++approvals === 1) queue.push('one more check');
        return true;
      } }, 'original task');
    assert.equal(steps, 2);
  });
}
