import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, link } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Workspace } from '../src/tools/workspace.js';
import { preparePatch, applyChanges } from '../src/tools/patch.js';
import { reference } from '../src/learning/reference.js';
import { runShell } from '../src/tools/shell.js';
import { ToolRegistry, params } from '../src/tools/registry.js';
const signal = () => new AbortController().signal;
test('Patch rejects ambiguous and partial-line matches, preserves newline convention, deletes files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kraken-patch-')); t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = await Workspace.open(root);
  const update = (before: string, after: string) => `*** Begin Patch\n*** Update File: a.txt\n@@\n-${before}\n+${after}\n*** End Patch`;
  await writeFile(join(root, 'a.txt'), 'aaa\n');
  await assert.rejects(preparePatch(workspace, update('a', 'b'), reference.replaceText), /not found/);
  await writeFile(join(root, 'a.txt'), 'x\nx\n');
  await assert.rejects(preparePatch(workspace, update('x', 'y'), reference.replaceText), /ambiguous/);
  for (const ending of ['\n', '\r\n', '']) {
    await writeFile(join(root, 'a.txt'), 'old' + ending);
    const changes = await preparePatch(workspace, update('old', 'new'), reference.replaceText);
    await applyChanges(workspace, changes, signal()); assert.equal(await workspace.read('a.txt'), 'new' + ending);
  }
  const deletion = await preparePatch(workspace, '*** Begin Patch\n*** Delete File: a.txt\n*** End Patch', reference.replaceText);
  await applyChanges(workspace, deletion, signal()); await assert.rejects(readFile(join(root, 'a.txt')), /ENOENT/);
});
test('Patch validation failure in a later file never mutates earlier files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kraken-patch-')); t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = await Workspace.open(root);
  const patch = '*** Begin Patch\n*** Add File: new.txt\n+new\n*** Update File: missing.txt\n@@\n-x\n+y\n*** End Patch';
  await assert.rejects(preparePatch(workspace, patch, reference.replaceText), /does not exist/);
  await assert.rejects(readFile(join(root, 'new.txt')), /ENOENT/);
  await writeFile(join(root, 'target.txt'), 'secret'); await link(join(root, 'target.txt'), join(root, 'alias.txt'));
  await assert.rejects(workspace.read('alias.txt'), /Hard-linked/);
});
test('Shell reports nonzero exit, bounds output, times out and supports cancellation', async () => {
  const failed = await runShell('printf failed; exit 7', tmpdir(), 1000, signal()) as { exitCode: number; output: string };
  assert.equal(failed.exitCode, 7); assert.equal(failed.output, 'failed');
  const output = await runShell("node -e 'process.stdout.write(\"x\".repeat(100000))'", tmpdir(), 5000, signal()) as { truncated: boolean; output: string };
  assert.equal(output.truncated, true); assert.equal(output.output.length, 16_000);
  const timeout = await runShell('sleep 10', tmpdir(), 30, signal()) as { timedOut: boolean };
  assert.equal(timeout.timedOut, true);
  const controller = new AbortController(); const task = runShell('sleep 10', tmpdir(), 5000, controller.signal);
  controller.abort(new Error('user cancel')); await assert.rejects(task, /user cancel/);
});
test('Shell does not inherit API credentials or NODE_OPTIONS', async () => {
  const saved = process.env.KRAKEN_TEST_SECRET; process.env.KRAKEN_TEST_SECRET = 'do-not-inherit';
  try {
    const result = await runShell('printf "%s" "$KRAKEN_TEST_SECRET"', tmpdir(), 1000, signal()) as { output: string };
    assert.equal(result.output, '');
  } finally { if (saved === undefined) delete process.env.KRAKEN_TEST_SECRET; else process.env.KRAKEN_TEST_SECRET = saved; }
});
test('Tool failures are observations; cancellation propagates instead of becoming an error result', async () => {
  const registry = new ToolRegistry({ policy: 'full-auto', shellEnabled: true, algorithms: reference, approve: async () => true, emit: () => {} });
  registry.register({ name: 'broken', effect: 'read', description: '', parameters: params({}), async prepare() { throw new Error('broken tool'); } });
  const reply = await registry.execute({ id: 'x', name: 'broken', arguments: '{}' }, signal());
  assert.equal(JSON.parse(reply.content).ok, false);
  await assert.rejects(registry.execute({ id: 'x', name: 'broken', arguments: '{}' }, AbortSignal.abort(new Error('stop'))), /stop/);
});

test('Protected path matching also rejects case variants on case-insensitive filesystems', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kraken-case-')); t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = await Workspace.open(root);
  for (const path of ['.GIT/config', '.Kraken-Coder/sessions/x', '.ENV', '.ENV.local', 'Node_Modules/x']) await assert.rejects(workspace.path(path), /Protected/);
});
test('Schema rejects prototype-named extra keys rather than treating them as declared properties', async () => {
  const registry = new ToolRegistry({ policy: 'read-only', shellEnabled: false, algorithms: reference, approve: async () => false, emit: () => {} });
  let executed = 0;
  registry.register({ name: 'empty', effect: 'read', description: '', parameters: params({}), async prepare() { return { preview: '', run: async () => ++executed }; } });
  for (const key of ['__proto__', 'constructor', 'toString']) {
    const result = await registry.execute({ id: key, name: 'empty', arguments: JSON.stringify({ [key]: true }) }, signal());
    assert.match(result.content, /not allowed/);
  }
  assert.equal(executed, 0);
});
