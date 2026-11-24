import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { runTurn } from '../src/core/agent.js';
import { defaults } from '../src/config.js';
import type { Event, Provider } from '../src/core/types.js';
import { readSession } from '../src/session/store.js';
import { createHookRunner } from '../src/extensions/hooks.js';
import type { LocalPlugin } from '../src/extensions/catalog.js';

const command = (script: string, matcher?: string) => [{ matcher, hooks: [{ type: 'command', command: script }] }];

test('plugin hooks run through the turn, keep source, rewrite before approval and continue a stopped answer', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kraken-hooks-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace'), plugin = join(root, 'plugin'), home = join(root, 'home');
  await mkdir(workspace); await mkdir(join(plugin, '.codex-plugin'), { recursive: true });
  await mkdir(join(plugin, 'hooks'));
  await writeFile(join(plugin, '.codex-plugin/plugin.json'), JSON.stringify({ name: 'test-hooks' }));
  const hook = 'node "$PLUGIN_ROOT/observe.cjs"';
  await writeFile(join(plugin, 'hooks/hooks.json'), JSON.stringify({ hooks: {
    SessionStart: command(hook, 'startup|resume'), UserPromptSubmit: command(hook),
    PreToolUse: command(hook, '^Bash$'), PostToolUse: command(hook, 'shell'), Stop: command(hook),
  } }));
  await writeFile(join(plugin, 'observe.cjs'), `
    const fs = require('node:fs');
    const event = JSON.parse(fs.readFileSync(0, 'utf8'));
    fs.appendFileSync('observed.jsonl', JSON.stringify(event) + '\\n');
    if (process.env.KRAKEN_API_KEY || process.env.OPENAI_API_KEY) throw Error('provider credentials inherited');
    if (event.hook_event_name === 'SessionStart') console.log('session-context');
    if (event.hook_event_name === 'UserPromptSubmit') console.log('submit-context');
    if (event.hook_event_name === 'PreToolUse') console.log(JSON.stringify({hookSpecificOutput:{
      hookEventName:'PreToolUse',permissionDecision:'allow',updatedInput:{command:'printf rewritten'}
    }}));
    if (event.hook_event_name === 'Stop' && !event.stop_hook_active) { console.error('verify first'); process.exit(2); }
  `);
  let requests = 0;
  const provider: Provider = { name: 'hook-test', async complete(messages) {
    requests++;
    if (requests === 1) {
      assert.match(messages.at(-1)!.content, /session-context/);
      assert.match(messages.at(-1)!.content, /submit-context/);
      return { content: '', toolCalls: [{ id: 'invoke', name: 'shell', arguments: '{"command":"printf original"}' }] };
    }
    if (requests === 2) {
      assert.equal(JSON.parse(messages.at(-1)!.content).result.output, 'rewritten');
      return { content: 'draft' };
    }
    assert.match(messages.at(-1)!.content, /verify first/);
    return { content: 'final' };
  } };
  const approvals: string[] = [];
  const result = await runTurn({
    config: { ...defaults, approval: 'ask', plugins: [plugin] }, workspace, home, session: 'one', allowShell: true, provider,
    approve: async r => { approvals.push(r.name + ' ' + r.preview); return true; },
  }, 'check');
  assert.equal(result.answer, 'final');
  assert.equal(requests, 3);
  assert.ok(approvals.some(p => p.startsWith('shell ') && p.endsWith('$ printf rewritten')));
  assert.ok(approvals.some(p => p.startsWith('hook ')));
  const observed = (await readFile(join(workspace, 'observed.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(observed.map(e => e.hook_event_name), ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'Stop']);
  assert.equal(observed[0].source, 'startup');
  assert.equal(observed[2].tool_name, 'Bash');
  assert.equal(observed[3].tool_response.output, 'rewritten');
  assert.equal(observed[4].stop_hook_active, false);
  assert.equal(observed[5].stop_hook_active, true);
  assert.ok(readSession(home, 'one').some(r => r.event.type === 'message' && (r.event.message as {hookFeedback?: boolean}).hookFeedback));
});

test('standalone prompt hook can block, disabled shell and read-only skip command hooks', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'kraken-hook-block-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const hookFile = join(workspace, 'trusted-hooks.json');
  await writeFile(hookFile, JSON.stringify({ hooks: { UserPromptSubmit: command('echo prompt-rejected >&2; exit 2') } }));
  let calls = 0;
  const provider: Provider = { name: 'test', async complete() { calls++; return { content: 'ok' }; } };
  const options = { workspace, home: join(workspace, 'home'), config: { ...defaults, approval: 'full-auto' as const, hookFiles: [hookFile] }, provider };
  await assert.rejects(runTurn({ ...options, session: 'blocked', allowShell: true }, 'try'), /prompt-rejected/);
  assert.equal(calls, 0);
  assert.equal((await runTurn({ ...options, session: 'no-shell' }, 'try')).answer, 'ok');
  assert.equal((await runTurn({ ...options, config: { ...options.config, approval: 'read-only' }, session: 'readonly', allowShell: true }, 'try')).answer, 'ok');
  assert.equal(calls, 2);
});

test('hook runner cancels a pending process and times out its process group', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'kraken-hook-proc-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const makeRunner = async (log: Event[]) => {
    const plugin: LocalPlugin = { name: 'slow', root: cwd, mcpServers: {}, hooks: [{ hooks: {
      PreToolUse: [{ hooks: [{ type: 'command', command: 'sleep 10', timeout: 1 }] }],
    } }] };
    return createHookRunner([plugin], [], { cwd, session_id: 's', turn_id: 't', model: 'demo', permission_mode: 'default', transcript_path: 'transcript' },
      async () => true, e => log.push(e));
  };
  const log: Event[] = [];
  const runner = await makeRunner(log);
  await assert.rejects(runner.run('PreToolUse', {}, AbortSignal.timeout(120)), /timeout/i);
  assert.ok(log.some(e => e.type === 'hook.start'));
  await runner.run('PreToolUse', {}, new AbortController().signal);
  assert.ok(log.some(e => e.status === 'error' && String(e.message).includes('timed out')));
});

test('PermissionRequest deny blocks the proposed action and rejected prompts stay out of replay', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'kraken-hook-permission-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const hookFile = join(workspace, 'hooks.json'), home = join(workspace, 'home');
  const permission = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'requires owner' } } };
  await writeFile(hookFile, JSON.stringify({ hooks: { PermissionRequest: command(`printf '%s' '${JSON.stringify(permission)}'`, 'Bash') } }));
  const approvals: string[] = [];
  const provider: Provider = { name: 'permission-test', async complete(messages) {
    if (messages.at(-1)!.role === 'user') return { content: '', toolCalls: [{ id: 'x', name: 'shell', arguments: '{"command":"touch ran"}' }] };
    assert.match(messages.at(-1)!.content, /requires owner/);
    return { content: 'denied' };
  } };
  const config = { ...defaults, approval: 'ask' as const, hookFiles: [hookFile] };
  await runTurn({ workspace, home, session: 'one', allowShell: true, config, provider, approve: async r => { approvals.push(r.name); return true; } }, 'run');
  assert.deepEqual(approvals, ['hook']);
  await assert.rejects(readFile(join(workspace, 'ran')), /ENOENT/);
  await writeFile(hookFile, JSON.stringify({ hooks: { UserPromptSubmit: command('echo blocked >&2; exit 2') } }));
  await assert.rejects(runTurn({ workspace, home, session: 'one', allowShell: true, config, provider, approve: async () => true }, 'blocked input'), /UserPromptSubmit blocked/);
  const events = readSession(home, 'one').map(r => r.event);
  assert.ok(events.some(e => e.type === 'turn.input' && e.content === 'blocked input'));
  assert.ok(!events.some(e => e.type === 'message' && (e.message as {content: string}).content === 'blocked input'));
});

test('async command hooks do not block the tool and are cancelled before the journal closes', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'kraken-hook-async-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const plugin: LocalPlugin = { name: 'hooks', root: cwd, mcpServers: {}, hooks: [{ hooks: {
    PreToolUse: [{ hooks: [
      { type: 'command', async: true, command: 'sleep 15; touch late', timeout: 20 },
      { type: 'command', async: true, command: 'echo ignored >&2; exit 2' },
    ] }],
  } }] };
  const log: Event[] = [];
  const runner = await createHookRunner([plugin], [], { cwd, session_id: 's', turn_id: 't', model: 'demo', permission_mode: 'default', transcript_path: 't' },
    async () => true, e => log.push(e));
  const outcome = await runner.run('PreToolUse', {tool_name:'Bash'}, AbortSignal.timeout(3_000));
  assert.equal(outcome.block, undefined);
  await runner.close();
  assert.equal(log.filter(e => e.type === 'hook.start').length, 2);
  assert.equal(log.filter(e => e.type === 'hook.end').length, 2);
  assert.ok(log.some(e => e.status === 'cancelled'));
  await assert.rejects(readFile(join(cwd, 'late')), /ENOENT/);
});
