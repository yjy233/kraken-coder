// Re-run one real issue against a fixed, clean fixture using the current Agent Server.
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { AgentClient } from '../../src/client/client.js';
import { runRemoteTurn } from '../../src/client/remote-turn.ts';
import { loadConfig, loadEnv } from '../../src/config.ts';
import { startAgentServer } from '../../src/server/server.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const fixture = '1fccb376a658ef95c94fbf653e002b3c29dd69fe';
const agentCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const { values } = parseArgs({ options: { 'max-steps': { type: 'string' }, 'grade-run': { type: 'string' } } });
const stepOverride = values['max-steps'] === undefined ? {} : { maxSteps: Number(values['max-steps']) };
const runs = join(root, 'eval/runs');
mkdirSync(runs, { recursive: true });
const run = values['grade-run'] ? resolve(values['grade-run']) : mkdtempSync(join(runs, 'shell-context-'));
const workspace = join(run, 'project');
const home = join(run, 'home');
console.log('Artifacts:', relative(root, run));

const task = `修复这个仓库的一处真实故障：在同一轮里执行一条输出很长的本机命令后，即使任务本身很短，上下文自动压缩也可能报超限。请定位根因并修改源码，为这个场景新增一个独立的 tests/*.test.ts 回归测试。要求小预算时模型仍能看到命令输出的开头、结尾及退出状态，磁盘会话保留原始输出。保留原有测试和超时、预算配置。可以运行 npm test、npm run typecheck 或 node --import tsx --test tests/文件名.test.ts 来验证。完成后报告实际验证结果。`;
const git = args => execFileSync('git', args, { cwd: workspace, encoding: 'utf8' }).trim();
const gradeEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('KRAKEN_') && k !== 'OPENAI_API_KEY'));
function grade(name, command, args, cwd = workspace) {
  const r = spawnSync(command, args, { cwd, env: gradeEnv, encoding: 'utf8', timeout: 120_000 });
  writeFileSync(join(run, name + '.log'), (r.stdout || '') + (r.stderr || '') + (r.error?.message || ''));
  return r.status;
}
const check = ['--import', 'tsx', join(root, 'eval/harness/check_shell_context.mjs'), workspace];
async function solve() {
  execFileSync('git', ['clone', '--quiet', '--local', '--no-checkout', root, workspace]);
  execFileSync('git', ['checkout', '--quiet', '--detach', fixture], { cwd: workspace });
  cpSync(join(root, 'node_modules'), join(workspace, 'node_modules'), { recursive: true, verbatimSymlinks: true });
  const baseline = grade('before', process.execPath, check);
  const beforeLog = readFileSync(join(run, 'before.log'), 'utf8');
  if (baseline !== 1 || !/\bpass 4\b/.test(beforeLog) || !/\bfail 4\b/.test(beforeLog)) {
    throw new Error('Expected four failing large-output checks and four passing controls; inspect before.log');
  }
  loadEnv(join(root, '.env'));
  const config = loadConfig(join(root, '.kraken-coder'), { mode: 'learner', approval: 'ask', ...stepOverride });
  if (config.provider === 'demo') throw new Error('Configure a real provider in .env before running this trial');
  const server = await startAgentServer({ config, workspace, home, port: 0, allowShell: true });
  const client = new AgentClient(server.url);
  const counts = { modelSteps: 0, tools: 0, toolErrors: 0, compactions: 0, approved: 0, denied: 0 };
  const started = Date.now();
  let session, status = 'failed', failure = null;
  try {
    session = (await client.createSession()).id;
    await runRemoteTurn({ client, session, message: task, signal: AbortSignal.timeout(15 * 60_000),
      emit(e) {
        if (e.type === 'model.start') counts.modelSteps++;
        if (e.type === 'tool.start') counts.tools++;
        if (e.type === 'tool.end' && !e.ok) counts.toolErrors++;
        if (e.type === 'context.trimmed') counts.compactions++;
        if (e.type === 'model.start' || e.type === 'tool.start') console.log(e.type, e.name ?? e.step + 1);
      },
      async approve(request) {
        const prefix = 'cwd: ' + workspace + '\n$ ';
        const cmd = request.preview.slice(prefix.length);
        const approved = request.name === 'apply_patch' || (request.name === 'shell' &&
          request.preview.startsWith(prefix) &&
          (cmd === 'npm test' || cmd === 'npm run typecheck' || /^node --import tsx --test tests\/[\w.-]+\.test\.ts$/.test(cmd)));
        counts[approved ? 'approved' : 'denied']++;
        return approved;
      },
    });
  } catch (e) { failure = e.message; }
  finally {
    try { if (session) status = (await client.session(session)).turn?.status ?? 'failed'; }
    finally { await server.close(); }
  }
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  return { fixture, agentCommit, session, provider: config.provider, model: config.model, mode: config.mode,
    maxSteps: config.maxSteps, requestTimeoutMs: config.requestTimeoutMs, turnTimeoutMs: config.turnTimeoutMs,
    contextWindowTokens: config.contextWindowTokens, contextCompactRatio: config.contextCompactRatio,
    deadlineSeconds: 900, status, failure, seconds, ...counts, baseline };
}

const trial = values['grade-run'] ? JSON.parse(readFileSync(join(run, 'summary.json'), 'utf8')) : await solve();
const after = grade('after', process.execPath, check);
const journal = grade('journal', process.execPath, ['--import', 'tsx', join(root, 'eval/harness/check_shell_journal.mjs'), workspace]);
const suite = grade('suite', 'npm', ['test']);
const types = grade('typecheck', 'npm', ['run', 'typecheck']);
const tracked = git(['diff', 'HEAD', '--name-only']).split('\n').filter(Boolean);
const added = git(['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean);
const newTests = added.filter(p => /^tests\/[\w.-]+\.test\.ts$/.test(p));
const extraPaths = [...tracked, ...added].filter(p => !p.startsWith('src/') && !newTests.includes(p));
// This fixture's AGENTS.md explicitly asks agents to log learning experiments here.
const scopeOK = extraPaths.every(p => p === 'docs/08-learning-progress.md');
let regression = false;
if (newTests.length && scopeOK) {
  // Challenge the agent's new tests against the original implementation, outside its working copy.
  const original = mkdtempSync(join(run, 'original-'));
  try {
    execFileSync('git', ['clone', '--quiet', '--local', '--no-checkout', workspace, original]);
    execFileSync('git', ['checkout', '--quiet', '--detach', fixture], { cwd: original });
    symlinkSync(join(root, 'node_modules'), join(original, 'node_modules'), 'dir');
    for (const test of newTests) cpSync(join(workspace, test), join(original, test));
    const testArgs = ['--import', 'tsx', '--test', ...newTests];
    const red = grade('new-tests-before', process.execPath, testArgs, original);
    const green = grade('new-tests-after', process.execPath, testArgs);
    const log = readFileSync(join(run, 'new-tests-before.log'), 'utf8');
    regression = red === 1 && /自动压缩后|Context budget exceeded|ERR_ASSERTION/.test(log) && green === 0;
  } finally { rmSync(original, { recursive: true, force: true }); }
}
const deliveryOK = trial.status === 'completed' && !trial.failure && trial.baseline === 1 &&
  after === 0 && journal === 0 && suite === 0 && types === 0 && regression;
const pass = deliveryOK && scopeOK;
const summary = { ...trial, after, journal, suite, types, tracked, added, regression, extraPaths, scopeOK, deliveryOK, pass };
writeFileSync(join(run, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
process.exitCode = pass ? 0 : 1;
