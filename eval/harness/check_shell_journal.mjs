// Offline end-to-end check: node --import tsx eval/harness/check_shell_journal.mjs /path/to/candidate
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

if (!process.argv[2]) {
  console.error('Usage: node --import tsx eval/harness/check_shell_journal.mjs <candidate-checkout>');
  process.exit(2);
}
const load = name => import(pathToFileURL(resolve(process.argv[2], 'src', name)).href);
const [{ runTurn }, { defaults }] = await Promise.all([load('core/agent.ts'), load('config.ts')]);

for (const mode of ['learner', 'reference']) {
  test(`${mode}: next request fits and the journal keeps the original shell observation`, async t => {
    const workspace = await mkdtemp(join(tmpdir(), 'kraken-shell-journal-'));
    t.after(() => rm(workspace, { recursive: true, force: true }));
    const home = join(workspace, '.kraken-coder');
    const marker = randomUUID(), head = `begin-${marker}`, tail = `end-${marker}`;
    const command = `printf '${head}\\n%013500d\\n${tail}' 0; exit 9`;
    const raw = head + '\n' + '0'.repeat(13_500) + '\n' + tail;
    const user = 'Run the local diagnostic and report the result.';
    const id = 'diagnostic', session = 'offline', contextChars = 11_500;
    let requests = 0;
    const provider = {
      name: 'offline-shell-journal',
      async complete(messages, tools) {
        requests++;
        if (requests === 1) return { content: '', toolCalls: [{ id, name: 'shell', arguments: JSON.stringify({ command }) }] };
        assert.equal(requests, 2);
        assert.ok(JSON.stringify(messages).length + JSON.stringify(tools).length <= contextChars);
        assert.equal(messages.find(m => m.role === 'user')?.content, user);
        const observation = messages.find(m => m.role === 'tool' && m.toolCallId === id);
        const { ok, result } = JSON.parse(observation.content);
        assert.equal(ok, true);
        assert.equal(result.exitCode, 9);
        assert.ok(result.output.length < raw.length);
        assert.ok(result.output.startsWith(head) && result.output.endsWith(tail));
        return { content: 'observed exit 9' };
      },
    };
    const config = { ...defaults, mode, approval: 'full-auto', contextWindowTokens: 0, contextChars, maxSteps: 2 };
    await runTurn({ workspace, home, session, config, provider, allowShell: true }, user);
    assert.equal(requests, 2);

    // Read the disk transcript directly, independently of the candidate's replay API.
    const file = await readFile(join(home, 'sessions', session + '.jsonl'), 'utf8');
    const events = file.trimEnd().split('\n').map(line => JSON.parse(line).event);
    const persisted = events.find(e => e.type === 'message' && e.message.role === 'tool' && e.message.toolCallId === id);
    const { ok, result } = JSON.parse(persisted.message.content);
    assert.equal(ok, true);
    assert.equal(result.output, raw, 'stored shell output must be byte-for-byte complete');
    assert.equal(result.exitCode, 9);
    assert.equal(result.timedOut, false);
    assert.equal(result.truncated, false);
    assert.equal(result.signal, null);
    assert.ok(events.some(e => e.type === 'context.trimmed' && e.toolResults > 0));
    assert.equal(events.at(-1).type, 'turn.completed');
  });
}
