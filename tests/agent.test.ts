import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { rm, readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { runTurn } from '../src/core/agent.js';
import { createDemoProject } from '../src/demo-project.js';
import { defaults } from '../src/config.js';
import { readSession } from '../src/session/store.js';
import { validateHistory } from '../src/core/validation.js';
import type { Message, ModelReply, Provider } from '../src/core/types.js';
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
