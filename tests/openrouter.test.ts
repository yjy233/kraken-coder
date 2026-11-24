import assert from 'node:assert/strict';
import test from 'node:test';
import type { Event, Message } from '../src/core/types.js';
import { algorithms } from '../src/learning/index.js';
import { CompatibleProvider } from '../src/providers/compatible.js';
import { modelProfiles } from '../src/providers/profiles.js';

for (const mode of ['learner', 'reference'] as const) {
  test(`${mode}: OpenRouter reassembles signed reasoning for a streamed tool loop and scopes JSON replies`, async t => {
    const requests: any[] = [], events: Event[] = [];
    const provider = (model: string, url: string = modelProfiles.openrouter.baseUrl) =>
      new CompatibleProvider({ baseUrl: url, model, timeoutMs: 1000 }, algorithms(mode).decodeChat, e => events.push(e));
    const call = { id: 'call', type: 'function', function: { name: 'search', arguments: '{}' } };
    const encrypted = { type: 'reasoning.encrypted', index: 0, data: 'opaque' };
    const deltas = [
      { reasoning: '思考', reasoning_details: [{ type: 'reasoning.text', text: 'a', signature: null, index: 0 }] },
      { reasoning_details: [{ type: 'reasoning.text', text: 'b', index: 0 }] },
      { reasoning_details: [{ type: 'reasoning.text', signature: 'signature-one', index: 0 }] },
      { reasoning_details: [{ type: 'reasoning.text', text: 'second', signature: 'signature-two', index: 0 }] },
      { reasoning_details: [{ type: 'reasoning.summary', summary: 'sum' }, { type: 'reasoning.summary', summary: 'mary' }] },
      { reasoning_details: [encrypted, encrypted], tool_calls: [{ ...call, index: 0 }] },
    ];
    const expected = [
      { type: 'reasoning.text', text: 'ab', signature: 'signature-one', index: 0 },
      { type: 'reasoning.text', text: 'second', signature: 'signature-two', index: 0 },
      { type: 'reasoning.summary', summary: 'summary' }, encrypted, encrypted,
    ];
    t.mock.method(globalThis, 'fetch', async (_url: URL | string, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      if (requests.length === 1) {
        const frames = deltas.map((delta, i) => JSON.stringify({ choices: [{ delta,
          finish_reason: i === deltas.length - 1 ? 'tool_calls' : null }] }));
        return new Response([...frames, '[DONE]'].map(s => 'data: ' + s + '\n\n').join(''), { headers: { 'content-type': 'text/event-stream' } });
      }
      return Response.json({ choices: [{ finish_reason: 'stop', message: {
        role: 'assistant', content: 'done', reasoning: '公开文本', reasoning_details: requests.length === 2 ? [encrypted] : [],
      } }] });
    });
    const client = provider('one'), signal = new AbortController().signal;
    const history: Message[] = [{ role: 'user', content: 'find it' }];
    const reply = await client.complete(history, [], signal);
    assert.equal(reply.reasoningContent, '思考');
    assert.deepEqual(reply.openRouterReasoning?.details, expected);
    assert.deepEqual(events, [{ type: 'model.delta', channel: 'reasoning', text: '思考' }]);
    history.push({ role: 'assistant', ...reply }, { role: 'tool', toolCallId: 'call', content: 'found' });
    const json = await client.complete(history, [], signal);
    assert.deepEqual(requests[1].messages[1].reasoning_details, expected);
    assert.equal(requests[1].messages[1].reasoning, '思考');
    assert.deepEqual(json.openRouterReasoning?.details, [encrypted]);
    assert.equal(json.reasoningContent, '公开文本');
    history.push({ role: 'assistant', ...json });
    const empty = await client.complete(history, [], signal);
    assert.deepEqual(requests[2].messages[3].reasoning_details, [encrypted]);
    assert.deepEqual(empty.openRouterReasoning?.details, []);
    for (const other of [provider('two'), provider('one', modelProfiles.volcengine.baseUrl)]) {
      await other.complete(history, [], signal);
      const body = JSON.stringify(requests.at(-1).messages);
      assert.doesNotMatch(body, /signature-|opaque|reasoning|思考|公开文本/);
      assert.match(body, /found/);
    }
  });
}
