#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaults, loadConfig, loadEnv, type Config } from './config.js';
import { runTurn } from './core/agent.js';
import { errorText } from './core/validation.js';
import type { Emit, Mode } from './core/types.js';
import { createDemoProject } from './demo-project.js';
import { listSessions, readSession } from './session/store.js';
import { runChecks } from './lab.js';
import { listSkills } from './context/instructions.js';
import { Workspace } from './tools/workspace.js';
import { startAgentServer } from './server/server.js';
import { AgentClient } from './client/client.js';
import { runRemoteTurn } from './client/remote-turn.js';
import type { Approve } from './tools/registry.js';

const help = `kraken-coder — Codex 风格 Coding Agent 教学项目（Node.js 24+）

  demo                          在临时项目中实际复现、修复、验证 bug（离线）
  check --all                   离线验收 L0～L6；支持 --stage 0..6 --mode learner
  chat                          交互聊天；/new /quit /help 为客户端命令，Ctrl+C 取消当前回合
  serve                         启动本机 agent-server 与 Web 界面（默认端口 4317）
  exec --message TEXT           执行一次用户回合（chat --message 等价）
  sessions                      列出本地会话
  history SESSION_ID            输出持久化 JSONL 轨迹
  skills                        列出当前工作区 .agents/skills
  init                          创建无密钥的本地配置，保留已有文件
  doctor                        查看生效配置与密钥是否配置，不访问网络

  --cwd PATH                    工具工作区，默认当前目录
  --home PATH                   运行数据目录，默认工作区/.kraken-coder
  --session ID                  恢复同一工作区和 Provider/model 的会话
  --provider demo|responses|compatible
  --model ID --base-url URL      真实模型配置；密钥只从环境读取
  --mode reference|learner       两份独立算法，默认 reference
  --approval ask|auto-review|full-auto|read-only|workspace-write   默认 ask
  --allow-shell                 允许考虑本机 shell（无 OS 沙箱）；仍受审批策略控制
  --max-steps N --context-chars N
  --context-window-tokens N|auto    手动模型窗口，auto 为自动探测，0 为字符预算
  --context-compact-ratio N         压缩比例（0.1–0.95，默认 0.8）
  --request-timeout-ms N --turn-timeout-ms N
  --env-file PATH                .env 文件；已有 shell 环境优先
  --port N                       serve 监听端口，固定绑定 127.0.0.1
  --server URL                   chat/exec/sessions/doctor 连接已有本机服务
  --json                        stdout 输出 JSONL 事件；非交互审批自动拒绝
  --trace --debug                stderr 事件摘要 / 错误栈

DemoProvider 只支持 /files、/read PATH、/search TEXT、/skill NAME、示例项目的 /fix。
真实自然语言编程需要配置模型。shell 可访问整台机器，cwd 不是权限边界。
`;
async function main(): Promise<void> {
  const { values: flags, positionals } = parseArgs({ allowPositionals: true, strict: true, options: {
    help: { type: 'boolean', short: 'h' }, trace: { type: 'boolean' }, debug: { type: 'boolean' }, json: { type: 'boolean' }, all: { type: 'boolean' },
    'allow-shell': { type: 'boolean' }, cwd: { type: 'string' }, home: { type: 'string' }, session: { type: 'string' }, message: { type: 'string', short: 'm' },
    provider: { type: 'string' }, mode: { type: 'string' }, approval: { type: 'string' }, model: { type: 'string' }, 'base-url': { type: 'string' },
    'max-steps': { type: 'string' }, 'context-chars': { type: 'string' }, 'request-timeout-ms': { type: 'string' }, 'turn-timeout-ms': { type: 'string' },
    'context-window-tokens': { type: 'string' }, 'context-compact-ratio': { type: 'string' },
    'env-file': { type: 'string' }, stage: { type: 'string' }, port: { type: 'string' }, server: { type: 'string' },
  } });
  const command = positionals[0] ?? 'help';
  if (flags.help || command === 'help') { console.log(help); return; }
  const emit: Emit = event => {
    if (flags.json) console.log(JSON.stringify(event));
    else if (flags.trace && !['message', 'instructions.snapshot', 'model.delta'].includes(event.type)) console.error(JSON.stringify(event));
  };
  // 教学验收和 demo 永远忽略本地密钥、线上配置，确保可重复、离线。
  if (command === 'check') {
    const mode = flags.mode ?? 'reference';
    if (!['learner', 'reference'].includes(mode)) throw new Error('Invalid mode');
    const stages = flags.stage !== undefined ? [Number(flags.stage)] : [0, 1, 2, 3, 4, 5, 6];
    if (flags.all && flags.stage !== undefined) throw new Error('Use either --all or --stage');
    const report = await runChecks(stages, mode as Mode, emit);
    console.log(JSON.stringify(report, null, flags.json ? 0 : 2));
    if (!report.ok) process.exitCode = 1;
    return;
  }
  if (command === 'demo') {
    const mode = flags.mode ?? 'reference';
    if (!['reference', 'learner'].includes(mode)) throw new Error('Invalid mode');
    const root = await createDemoProject();
    console.error(`演示项目（保留供查看）：${root}`);
    const result = await runTurn({ config: { ...defaults, mode: mode as Mode, approval: 'full-auto' }, workspace: root, home: resolve(root, '.kraken-coder'), session: 'demo', allowShell: true, emit }, '/fix');
    if (!flags.json) console.log(result.answer + '\n轨迹：' + result.journal);
    return;
  }
  if (flags['env-file'] && !existsSync(resolve(flags['env-file']))) throw new Error('Specified --env-file does not exist');
  loadEnv(resolve(flags['env-file'] ?? '.env'));
  if (flags.port !== undefined && command !== 'serve') throw new Error('--port is only supported by serve');
  if (flags.server && !['exec', 'chat', 'sessions', 'doctor'].includes(command)) throw new Error('--server supports chat, exec, sessions and doctor');
  if (flags.server) {
    for (const key of ['cwd', 'home', 'provider', 'model', 'mode', 'approval', 'base-url', 'allow-shell', 'max-steps', 'context-chars', 'context-window-tokens', 'context-compact-ratio', 'request-timeout-ms', 'turn-timeout-ms'] as const) {
      if (flags[key] !== undefined) throw new Error(`--${key} is owned by the server; set it when starting serve`);
    }
  }
  const remote = flags.server ? new AgentClient(flags.server) : undefined;
  const workspace = resolve(flags.cwd ?? '.'), home = resolve(flags.home ?? process.env.KRAKEN_HOME ?? resolve(workspace, '.kraken-coder'));
  if (command === 'sessions') { console.log(JSON.stringify(remote ? await remote.sessions() : listSessions(home), null, 2)); return; }
  if (command === 'history') {
    const id = positionals[1] ?? flags.session;
    if (!id) throw new Error('history requires SESSION_ID');
    for (const r of readSession(home, id)) console.log(JSON.stringify(r));
    return;
  }
  if (command === 'skills') { console.log(JSON.stringify(await listSkills(await Workspace.open(workspace)), null, 2)); return; }
  if (command === 'init') {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const path = resolve(home, 'config.json');
    if (!existsSync(path)) writeFileSync(path, JSON.stringify(defaults, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(`配置：${path}`); return;
  }
  if (!['exec', 'chat', 'doctor', 'serve'].includes(command)) throw new Error(`Unknown command: ${command}`);
  const overrides: Partial<Config> = {};
  for (const key of ['provider', 'mode', 'approval', 'model'] as const) if (flags[key] !== undefined) Object.assign(overrides, { [key]: flags[key] });
  if (flags['base-url'] !== undefined) overrides.baseUrl = flags['base-url'];
  const windowFlag = flags['context-window-tokens'];
  if (windowFlag !== undefined) overrides.contextWindowTokens = windowFlag === 'auto' ? null : Number(windowFlag);
  else if (flags['context-chars'] !== undefined) overrides.contextWindowTokens = 0;
  if (flags['context-compact-ratio'] !== undefined) overrides.contextCompactRatio = Number(flags['context-compact-ratio']);
  for (const [flag, key] of [['max-steps', 'maxSteps'], ['context-chars', 'contextChars'], ['request-timeout-ms', 'requestTimeoutMs'], ['turn-timeout-ms', 'turnTimeoutMs']] as const) if (flags[flag] !== undefined) overrides[key] = Number(flags[flag]);
  const config = remote ? undefined : loadConfig(home, overrides);
  if (command === 'serve') {
    const port = flags.port === undefined ? 4317 : Number(flags.port);
    if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('--port must be an integer between 0 and 65535');
    const server = await startAgentServer({ config: config!, workspace, home, allowShell: flags['allow-shell'], port, envFile: resolve(flags['env-file'] ?? '.env') });
    console.error(`Kraken agent-server\n工作区：${workspace}\nWeb：${server.url}/\nCtrl+C 停止服务。`);
    await new Promise<void>(resolveStopped => {
      const stop = (): void => {
        process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
        void server.close().then(resolveStopped, error => { console.error(errorText(error)); process.exitCode = 1; resolveStopped(); });
      };
      process.on('SIGINT', stop); process.on('SIGTERM', stop);
    });
    return;
  }
  if (command === 'doctor') {
    console.log(JSON.stringify(remote ? await remote.info() : { config, workspace, home, shellEnabled: !!flags['allow-shell'], apiKeyConfigured: !!(config!.provider === 'responses' ? process.env.OPENAI_API_KEY : config!.provider === 'compatible' ? process.env.KRAKEN_API_KEY : undefined) }, null, 2)); return;
  }
  if (command === 'exec' && !flags.message) throw new Error('exec requires --message');
  if (!flags.message && (!process.stdin.isTTY || flags.json)) throw new Error('Interactive chat requires a terminal without --json; use exec --message');
  const interactive = process.stdin.isTTY && !flags.json;
  const rl = interactive ? createInterface({ input: process.stdin, output: process.stderr }) : undefined;
  let session = flags.session ?? (remote ? undefined : randomUUID()), controller = new AbortController();
  let busy = false, quit = false;
  const idle = new AbortController();
  // 忙时只取消当前回合；空闲时退出。close() 不会结束 pending 的 question，必须显式 abort。
  const cancel = (): void => { if (busy) controller.abort(new Error('Cancelled by user')); else { quit = true; idle.abort(); rl?.close(); } };
  process.on('SIGINT', cancel); rl?.on('SIGINT', cancel);
  const oneTurn = async (message: string): Promise<void> => {
    controller = new AbortController(); busy = true;
    try {
      session ??= remote ? (await remote.createSession()).id : randomUUID();
      console.error(`session: ${session}`);
      const approve: Approve = async (request, signal) => {
        if (!rl) return false;
        console.error(`\n${request.name} 申请执行：\n${request.preview}`);
        const prompt = request.commandPrefix
          ? `y 批准一次，p 以后也允许此工作区的「${request.commandPrefix}」${request.commandPrefix.startsWith('npm ') ? '项目脚本' : '及其常用显示参数'}，Enter 拒绝 [y/p/N] `
          : '批准本次操作？[y/N] ';
        const answer = (await rl.question(prompt, { signal })).trim().toLowerCase();
        if (request.commandPrefix && answer === 'p') return 'remember';
        return answer === 'y';
      };
      const answer = remote
        ? await runRemoteTurn({ client: remote, session, message, emit, approve, signal: controller.signal })
        : (await runTurn({ config: config!, workspace, home, session, allowShell: flags['allow-shell'], emit, approve }, message, controller.signal)).answer;
      if (!flags.json) console.log(answer);
    } finally { busy = false; }
  };
  try {
    if (flags.message) await oneTurn(flags.message);
    else while (!quit) {
      let line: string;
      try { line = (await rl!.question('kraken> ', { signal: idle.signal })).trim(); } catch { break; }
      if (line === '/quit') break;
      if (line === '/new') { session = remote ? (await remote.createSession()).id : randomUUID(); console.error(`新会话：${session}`); continue; }
      if (line === '/help') { console.log(help); continue; }
      if (!line) continue;
      try { await oneTurn(line); } catch (error) { console.error(errorText(error)); }
    }
  } finally { process.removeListener('SIGINT', cancel); rl?.close(); }
}
main().catch(error => {
  console.error(process.argv.includes('--debug') ? error : `Error: ${errorText(error)}`);
  process.exitCode = 1;
});
