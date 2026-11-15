import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Workspace } from '../src/tools/workspace.js';
import { Instructions } from '../src/context/instructions.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { registerBuiltins } from '../src/tools/builtins.js';
import { reference } from '../src/learning/reference.js';

test('search ignore_case through the real tool entry point', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kraken-search-acceptance-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'sample.js'), '// fixture\nRunLoop();\n');
  const workspace = await Workspace.open(root);
  const registry = new ToolRegistry({ policy: 'read-only', shellEnabled: false, algorithms: reference, approve: async () => false, emit: () => {} });
  registerBuiltins(registry, workspace, reference, new Instructions(workspace), [], () => {});
  const execute = async (args: Record<string, unknown>) => JSON.parse((await registry.execute({ id: 'search-case', name: 'search', arguments: JSON.stringify(args) }, new AbortController().signal)).content);
  const cases = [
    { name: 'omitted flag preserves case-sensitive behavior', args: { query: 'runLoop' }, matches: [] },
    { name: 'false preserves case-sensitive behavior', args: { query: 'runLoop', ignore_case: false }, matches: [] },
    { name: 'true finds mixed case and preserves original path, line and text', args: { query: 'runLoop', ignore_case: true }, matches: [{ path: 'sample.js', line: 2, text: 'RunLoop();' }] },
    { name: 'existing same-case query still matches', args: { query: 'RunLoop' }, matches: [{ path: 'sample.js', line: 2, text: 'RunLoop();' }] },
  ];
  for (const entry of cases) await t.test(entry.name, async () => {
    const reply = await execute(entry.args);
    assert.equal(reply.ok, true, reply.error);
    assert.deepEqual(reply.result, { matches: entry.matches, truncated: false, skipped: 0 });
  });
  await t.test('string flag is rejected as a boolean type error', async () => {
    const reply = await execute({ query: 'runLoop', ignore_case: 'true' });
    assert.equal(reply.ok, false);
    assert.match(reply.error, /ignore_case: invalid boolean/);
  });
});
