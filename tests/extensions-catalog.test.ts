import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Instructions, systemPrompt } from '../src/context/instructions.js';
import { loadExtensionCatalog, readSkill } from '../src/extensions/catalog.js';
import { Workspace } from '../src/tools/workspace.js';

const standard = { $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', name: 'team-qa' };
const skill = '---\ndescription: >-\n  review code\n  and tests\n---\nPRIVATE BODY';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'kraken-catalog-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ws = join(root, 'workspace'), pkg = join(root, 'package');
  await mkdir(ws);
  const write = async (path: string, source: string | object): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, typeof source === 'string' ? source : JSON.stringify(source));
  };
  return { ws, pkg, workspace: await Workspace.open(ws), write };
}

test('workspace and portable plugin skills share a metadata catalog and open private resources on demand', async t => {
  const { ws, pkg, workspace, write } = await fixture(t);
  await write(join(ws, '.agents/skills/review/SKILL.md'), skill);
  await write(join(pkg, 'plugin.json'), standard);
  await write(join(pkg, 'skills/review/SKILL.md'), skill);
  await write(join(pkg, 'skills/review/references/check.md'), 'evidence');
  const hooks = { hooks: { PreToolUse: [] } };
  const servers = { demo: { command: 'server' } };
  await write(join(pkg, 'hooks/hooks.json'), hooks);
  await write(join(pkg, 'mcp.json'), { mcpServers: servers });
  const catalog = await loadExtensionCatalog(workspace, [pkg]);
  assert.deepEqual(catalog.diagnostics, []);
  assert.deepEqual(catalog.skills.map(s => s.name), ['review', 'team-qa:review']);
  const plugin = catalog.skills[1]!;
  assert.equal(plugin.description, 'review code and tests');
  assert.equal(plugin.path, 'skills/review/SKILL.md');
  assert.deepEqual(catalog.plugins[0]?.hooks, [hooks]);
  assert.deepEqual(catalog.plugins[0]?.mcpServers, servers);
  const prompt = await systemPrompt(workspace, new Instructions(workspace), catalog.skills);
  assert.match(prompt, /team-qa:review/);
  assert.doesNotMatch(prompt, /PRIVATE BODY/);
  assert.match(await readSkill(workspace, plugin), /PRIVATE BODY/);
  assert.equal(await readSkill(workspace, plugin, 'references/check.md'), 'evidence');
  assert.deepEqual((await loadExtensionCatalog(workspace)).skills.map(s => s.name), ['review']);

  await write(join(pkg, 'outside'), 'outside');
  await write(join(pkg, 'skills/review/.env.local'), 'private');
  await symlink(join(pkg, 'outside'), join(pkg, 'skills/review/shortcut'));
  await link(join(pkg, 'outside'), join(pkg, 'skills/review/hard'));
  for (const resource of ['../../outside', '/outside', '.env.local', 'shortcut', 'hard']) {
    await assert.rejects(readSkill(workspace, plugin, resource));
  }
});

test('legacy inline and file configurations plus configured personal skills', async t => {
  const { ws, pkg, workspace, write } = await fixture(t);
  const personal = join(dirname(ws), 'personal');
  const hooks = { hooks: { Stop: [] } };
  const servers = { demo: { command: 'demo' } };
  const manifest = { name: 'legacy', skills: ['./procedures'], hooks: [hooks], mcpServers: servers };
  await write(join(pkg, '.codex-plugin/plugin.json'), manifest);
  await write(join(pkg, 'procedures/review/SKILL.md'), skill);
  await write(join(personal, 'mine/SKILL.md'), '---\nname: mine\ndescription: "A: quoted description"\n---\nprivate');
  let catalog = await loadExtensionCatalog(workspace, [pkg], [personal]);
  assert.deepEqual(catalog.skills.map(s => s.name), ['mine', 'legacy:review']);
  assert.deepEqual(catalog.plugins[0]?.hooks, [hooks]);
  assert.deepEqual(catalog.plugins[0]?.mcpServers, servers);
  await write(join(pkg, '.codex-plugin/plugin.json'), { ...manifest, hooks: './hook-config.json', mcpServers: './servers.json' });
  await write(join(pkg, 'hook-config.json'), hooks);
  await write(join(pkg, 'servers.json'), { mcpServers: servers });
  catalog = await loadExtensionCatalog(workspace, [pkg]);
  assert.deepEqual(catalog.diagnostics, []);
  assert.deepEqual(catalog.plugins[0]?.hooks, [hooks]);
  assert.deepEqual(catalog.plugins[0]?.mcpServers, servers);
});

test('malformed packages, path escapes, and duplicate names produce diagnostics without breaking other skills', async t => {
  const { ws, pkg, workspace, write } = await fixture(t);
  const invalid = join(dirname(pkg), 'invalid');
  await write(join(invalid, 'plugin.json'), { ...standard, $schema: 'https://agent-plugins.org/schemas/unknown' });
  await write(join(ws, '.agents/skills/broken/SKILL.md'), 'invalid');
  await write(join(pkg, '.codex-plugin/plugin.json'), { name: 'working', hooks: ['./../outside'], mcpServers: './config/secret.json' });
  await write(join(pkg, 'skills/first/SKILL.md'), skill.replace('description:', 'name: review\ndescription:'));
  await write(join(pkg, 'skills/second/SKILL.md'), skill.replace('description:', 'name: review\ndescription:'));
  await symlink(ws, join(pkg, 'config'));
  const catalog = await loadExtensionCatalog(workspace, [invalid, pkg]);
  assert.deepEqual(catalog.skills.map(s => s.name), ['working:review']);
  assert.deepEqual(catalog.plugins[0]?.hooks, []);
  assert.deepEqual(catalog.plugins[0]?.mcpServers, {});
  for (const expected of [/YAML/, /Duplicate skill/, /Unsupported Agent Plugins schema/, /paths must/, /Symbolic links/]) {
    assert.ok(catalog.diagnostics.some(s => expected.test(s)), String(expected));
  }
});
