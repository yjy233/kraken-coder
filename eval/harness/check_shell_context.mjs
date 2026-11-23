// Run from the harness checkout: node --import tsx eval/harness/check_shell_context.mjs /path/to/candidate
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

if (!process.argv[2]) {
  console.error('Usage: node --import tsx eval/harness/check_shell_context.mjs <candidate-checkout>');
  process.exit(2);
}
const root = resolve(process.argv[2]);
const load = path => import(pathToFileURL(resolve(root, 'src', path)).href);
const [{ fitModelContext }, { algorithms }, { runShell }, { validateHistory }] = await Promise.all([
  load('context/budget.ts'), load('learning/index.ts'), load('tools/shell.ts'), load('core/validation.ts'),
]);

const marker = randomUUID();
const head = `BEGIN-${marker}`, tail = `END-${marker}`;
const budgets = [
  { source: 'fallback', thresholdChars: 3_500 },
  { source: 'manual', windowTokens: 4_000, thresholdTokens: 2_000 },
];
for (const long of [true, false]) {
  const command = long ? `printf '${head}\\n%012000d\\n${tail}' 0; exit 7` : 'printf short';
  const raw = await runShell(command, root, 5_000, new AbortController().signal);
  assert.equal(raw.exitCode, long ? 7 : 0, 'fixture command failed');
  assert.equal(raw.timedOut, false);
  assert.equal(raw.truncated, false);
  assert.equal(raw.output, long ? `${head}\n${'0'.repeat(12_000)}\n${tail}` : 'short');

  for (const mode of ['reference', 'learner']) {
    for (const budget of budgets) {
      test(`${mode} / ${budget.source} / ${long ? 'large shell observation' : 'short shell observation'}`, () => {
        const id = 'shell-call-1';
        const history = [
          { role: 'system', content: 'Keep the command exit status and diagnostic markers.' },
          { role: 'user', content: 'Explain the command result.' },
          { role: 'assistant', content: '', toolCalls: [{ id, name: 'shell', arguments: JSON.stringify({ command }) }] },
          { role: 'tool', toolCallId: id, content: JSON.stringify({ ok: true, result: raw }) },
        ];
        const original = structuredClone(history);
        // Measure the serialized payload independently using this checkout's documented budget units.
        const schemaSize = 300;
        const limit = budget.thresholdChars ?? budget.thresholdTokens;
        const measure = messages => budget.source === 'fallback'
          ? JSON.stringify(messages).length
          : Math.ceil(Buffer.byteLength(JSON.stringify(messages), 'utf8') / 2);
        assert.equal(measure(history) + schemaSize > limit, long);
        const { context } = fitModelContext(history, budget, schemaSize, algorithms(mode).fitContext);
        assert.ok(measure(context) + schemaSize <= limit, 'outgoing request exceeds its budget');
        validateHistory(context);
        assert.deepEqual(history, original, 'compaction changed the original history');
        if (!long) {
          assert.deepEqual(context, original);
          return;
        }
        assert.equal(context.length, original.length);
        assert.deepEqual(context.slice(0, 3), original.slice(0, 3));
        assert.equal(context[3].role, 'tool');
        assert.equal(context[3].toolCallId, id);
        const envelope = JSON.parse(context[3].content);
        assert.equal(envelope.ok, true);
        const result = envelope.result;
        for (const field of ['exitCode', 'timedOut', 'signal', 'truncated']) assert.equal(result[field], raw[field], field);
        assert.ok(result.output.length < raw.output.length);
        assert.ok(result.output.includes(head) && result.output.includes(tail), 'shell output lost a diagnostic marker');
      });
    }
  }
}
