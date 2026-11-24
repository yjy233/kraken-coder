import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { defaults } from '../src/config.js';
import { runTurn } from '../src/core/agent.js';
import type { Message } from '../src/core/types.js';
import { sessionProvidersMatch, SessionStore } from '../src/session/store.js';

const ark = 'compatible:ark-model:https://ark.cn-beijing.volces.com/api/v3/chat/completions';
const router = 'compatible:vendor/model:free:https://openrouter.ai/api/v1/chat/completions';

test('preset Chat models share a session while custom endpoints and Responses retain their binding', () => {
  assert.equal(sessionProvidersMatch(ark, router), true);
  assert.equal(sessionProvidersMatch(router, ark), true);
  for (const other of ['demo:v1', router.replace('compatible:', 'responses:'), ark.replace('/api/v3', '/api/coding/v3'),
    router.replace('openrouter.ai', 'openrouter.ai.example')]) {
    assert.equal(sessionProvidersMatch(other, router), false);
    assert.equal(sessionProvidersMatch(other, other), true);
  }
});

test('switching models in a legacy session preserves tool pairs and keeps model-specific reasoning with its source', async t => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'kraken-model-session-')));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const home = join(workspace, '.kraken-coder'), session = 'switch-model';
  // Old journals only identify the model on session.created.
  const original = SessionStore.open(home, { id: session, workspace, provider: ark });
  original.append({ type: 'turn.started', session });
  const call = { id: 'read-1', name: 'read_file', arguments: '{"path":"a.txt"}' };
  for (const message of [
    { role: 'user', content: 'Read a.txt' },
    { role: 'assistant', content: '', reasoningContent: 'ark-only', toolCalls: [call] },
    { role: 'tool', content: 'file contents', toolCallId: call.id },
    { role: 'assistant', content: 'Read it.' },
  ]) original.append({ type: 'message', message });
  original.append({ type: 'turn.completed', session });
  original.close();

  async function next(name: string, model: string) {
    let received: readonly Message[] = [];
    await runTurn({ workspace, home, session, config: { ...defaults, model }, provider: {
      name, async complete(messages) {
        received = messages;
        return { content: 'Continued.', reasoningContent: model, ...(name === router ? {
          openRouterReasoning: { provider: router, details: [{ type: 'reasoning.encrypted', data: 'router-only-block' }] },
        } : {}) };
      },
    } }, 'Continue.');
    return received;
  }
  const afterSwitch = await next(router, 'router-only');
  assert.equal(afterSwitch.find(m => m.toolCalls)?.reasoningContent, undefined);
  assert.deepEqual(afterSwitch.find(m => m.toolCalls)?.toolCalls, [call]);
  assert.equal(afterSwitch.find(m => m.toolCallId === call.id)?.content, 'file contents');

  const back = await next(ark, 'ark-new');
  assert.equal(back.find(m => m.toolCalls)?.reasoningContent, 'ark-only');
  assert.equal(back.find(m => m.content === 'Continued.')?.reasoningContent, undefined);
  assert.equal(back.find(m => m.content === 'Continued.')?.openRouterReasoning, undefined);
  const saved = SessionStore.open(home, { id: session, workspace, provider: ark });
  try {
    assert.deepEqual(saved.records.filter(r => r.event.type === 'turn.started').map(r => r.event.provider), [undefined, router, ark]);
    assert.deepEqual(saved.messages().filter(m => m.reasoningContent).map(m => m.reasoningContent), ['ark-only', 'router-only', 'ark-new']);
  } finally { saved.close(); }
});
