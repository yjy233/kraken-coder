import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { commandRule, hasCommandRule, rememberCommandRule } from '../src/permissions/command-rules.js';

test('simple display commands share rules only across known literal options', () => {
  const examples = [
    ['git status', 'git status'],
    ['  git\tstatus --short --branch  ', 'git status'],
    ['git status -sb --porcelain=v2', 'git status'],
    ['git ls-files --others --exclude-standard', 'git ls-files'],
    ['ls -lah', 'ls'],
    ['pwd -P', 'pwd'],
  ] as const;
  for (const [command, rule] of examples) assert.equal(commandRule(command), rule, command);
  for (const command of [
    'git status-other', 'git status --shortx', 'git status --short README', 'git status -- ../../',
    'git status; pwd', 'git status && pwd', 'git status | pwd', 'git status > out',
    'git status\npwd', 'git status\n', '\ngit status', 'git status\r', 'git status\0',
    'git status $(pwd)', 'git status `pwd`', 'git status # comment', 'git status *',
    "git 'status'", 'git stat\\us', 'A=1 git status', 'git -C other status', 'git diff --output=out',
    'ls /etc', 'ls -R', 'ls --color=always', 'pwd --help', 'git', 'bash -c pwd', 'toString',
  ]) assert.equal(commandRule(command), undefined, command);
});

test('each npm script grant covers only its complete argument sequence', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kraken-npm-rules-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'project'), store = join(root, 'user-rules');
  await mkdir(workspace);
  const scripts = ['npm test', 'npm run test', 'npm run build', 'npm run typecheck', 'npm run lint', 'npm run verify'];
  for (const invocation of scripts) {
    assert.equal(commandRule(invocation.replaceAll(' ', '\t')), invocation);
    assert.equal(await hasCommandRule(workspace, invocation, store), false);
    await rememberCommandRule(workspace, invocation, store);
    assert.equal(await hasCommandRule(workspace, invocation, store), true);
  }
  for (const invocation of [
    'npm', 'npm run', 'npm run other', 'npm run build-local', 'npm run-script build', 'npm exec test',
    'npm --prefix project test', 'npm test -- --watch', 'npm run test --silent', 'npm test && pwd',
    'npm run build > out', 'npm run verify\n', 'npm run "build"',
  ]) {
    assert.equal(commandRule(invocation), undefined, invocation);
    assert.equal(await hasCommandRule(workspace, invocation, store), false);
    await assert.rejects(rememberCommandRule(workspace, invocation, store), /Unknown command rule/);
  }
});

test('remembered rules persist per canonical workspace and concurrent decisions accumulate', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kraken-command-rules-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'project'), other = join(root, 'another-project');
  const alias = join(root, 'project-alias'), store = join(root, 'user-rules');
  await Promise.all([mkdir(workspace), mkdir(other)]);
  await symlink(workspace, alias);
  assert.equal(await hasCommandRule(workspace, 'git status', store), false);
  const grants = ['git status', 'ls', 'git status', 'git ls-files', 'pwd'];
  await Promise.all(grants.map(rule => rememberCommandRule(workspace, rule, store)));
  for (const rule of grants) {
    assert.equal(await hasCommandRule(alias, rule, store), true);
    assert.equal(await hasCommandRule(other, rule, store), false);
  }
  await assert.rejects(rememberCommandRule(workspace, '../invalid', store), /Unknown command rule/);
  assert.equal(await hasCommandRule(workspace, '../invalid', store), false);

  const repoStore = join(workspace, 'command-rules');
  await rename(store, repoStore);
  assert.equal(await hasCommandRule(workspace, 'git status', store), false);
  assert.equal(await hasCommandRule(workspace, 'git status', repoStore), false);
  await assert.rejects(rememberCommandRule(workspace, 'git status', repoStore), /outside the workspace/);
});

test('invalid storage never grants permission or silently records approval', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kraken-command-rules-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'project'), store = join(root, 'user-rules');
  await mkdir(workspace);
  await rememberCommandRule(workspace, 'pwd', store);
  const [scope] = await readdir(store);
  assert.ok(scope);
  const scopePath = join(store, scope);
  const forged = join(workspace, 'forged');
  await mkdir(forged);
  await writeFile(join(forged, 'ls'), '');
  await symlink(join(forged, 'ls'), join(scopePath, 'ls'));
  assert.equal(await hasCommandRule(workspace, 'ls', store), false);
  await assert.rejects(rememberCommandRule(workspace, 'ls', store));
  await rm(scopePath, { recursive: true });
  await symlink(forged, scopePath);
  assert.equal(await hasCommandRule(workspace, 'ls', store), false);
  await assert.rejects(rememberCommandRule(workspace, 'ls', store));
});
