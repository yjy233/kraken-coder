/** 每阶段使用独立临时目录/本机 HTTP；不读取用户配置、不调用线上模型。 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Algorithms, Emit, LoopRuntime, Message, Mode, ModelReply } from './core/types.js';
import { algorithms } from './learning/index.js';
import { CompatibleProvider } from './providers/compatible.js';
import { Workspace } from './tools/workspace.js';
import { ToolRegistry, params, str } from './tools/registry.js';
import { preparePatch, applyChanges } from './tools/patch.js';
import { SessionStore, readSession } from './session/store.js';
import { Instructions, listSkills, systemPrompt } from './context/instructions.js';
import { registerBuiltins } from './tools/builtins.js';
import { validateHistory, errorText } from './core/validation.js';
export interface Case { name: string; run(a: Algorithms, root: string): Promise<void> | void }
const signal = (): AbortSignal => new AbortController().signal;
const toolCall = { id: 'call-1', name: 'echo', arguments: '{"value":"42"}' };
export function loopFixture(replies: ModelReply[]): { runtime: LoopRuntime; saved: Message[]; executions: string[] } {
  const saved: Message[] = [], executions: string[] = [];
  let index = 0;
  return { saved, executions, runtime: {
    provider: { name: 'script', async complete(messages) { validateHistory(messages); const reply = replies[index++]; if (!reply) throw new Error('Script exhausted'); return reply; } },
    tools: [], maxSteps: 8, signal: signal(), emit: () => {}, checkpoint: m => saved.push(m), context: m => m,
    async execute(call) { executions.push(call.id); return { role: 'tool', toolCallId: call.id, content: '{"ok":true,"result":42}' }; },
  } };
}
export const stageNames = ['模型协议', 'Agent 循环', '工具与审批', '文件和补丁', '上下文窗口', '会话恢复', '指令与 Skills'];
export const stages: Case[][] = [
  [
    { name: 'L0 本机 HTTP 工具调用与 reasoning_content 回传', async run(a) {
      let count = 0, observed: Record<string, unknown>[] = [];
      const server = createServer(async (req, res) => {
        const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
        observed.push(JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ choices: [{ finish_reason: count++ ? 'stop' : 'tool_calls', message: count === 1 ? {
          role: 'assistant', content: '先调用工具', reasoning_content: 'protocol fixture', tool_calls: [{ id: 'http-1', type: 'function', function: { name: 'echo', arguments: '{"value":"42"}' } }],
        } : { role: 'assistant', content: '42' } }] }));
      });
      server.listen(0, '127.0.0.1'); await once(server, 'listening');
      try {
        const provider = new CompatibleProvider({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, model: 'test', timeoutMs: 2000 }, a.decodeChat);
        const f = loopFixture([]); f.runtime.provider = provider;
        assert.equal(await a.runLoop([{ role: 'user', content: '42' }], f.runtime), '42');
        const second = observed[1]!.messages as Record<string, unknown>[];
        assert.equal(second[1]!.reasoning_content, 'protocol fixture');
        assert.equal(second[2]!.tool_call_id, 'http-1');
      } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    } },
    { name: 'L0 拒绝截断与重复调用 ID', run(a) {
      assert.throws(() => a.decodeChat({ choices: [{ finish_reason: 'length', message: { role: 'assistant', content: 'partial' } }] }));
      const call = { id: 'x', type: 'function', function: { name: 'echo', arguments: '{}' } };
      assert.throws(() => a.decodeChat({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [call, call] } }] }));
    } },
  ],
  [
    { name: 'L1 同时出现文本和工具时继续循环，保存多工具配对', async run(a) {
      const f = loopFixture([{ content: '先检查', toolCalls: [toolCall, { ...toolCall, id: 'call-2' }] }, { content: '完成' }]);
      assert.equal(await a.runLoop([{ role: 'user', content: '任务' }], f.runtime), '完成');
      assert.deepEqual(f.executions, ['call-1', 'call-2']);
      assert.deepEqual(f.saved.map(m => m.role), ['assistant', 'tool', 'tool', 'assistant']);
      validateHistory(f.saved);
    } },
    { name: 'L1 步数耗尽不启动工具但落盘意图，取消后不请求模型', async run(a) {
      const f = loopFixture([{ content: '', toolCalls: [toolCall] }]); f.runtime.maxSteps = 1;
      await assert.rejects(a.runLoop([{ role: 'user', content: '任务' }], f.runtime), /Step limit/);
      assert.equal(f.executions.length, 0); assert.deepEqual(f.saved.map(m => m.role), ['assistant']);
      f.runtime.signal = AbortSignal.abort(new Error('cancelled'));
      await assert.rejects(a.runLoop([], f.runtime), /cancelled/);
    } },
    { name: 'L1 跨请求重复 ID 被拒绝', async run(a) {
      const f = loopFixture([{ content: '', toolCalls: [toolCall] }, { content: '', toolCalls: [toolCall] }]);
      await assert.rejects(a.runLoop([], f.runtime), /Reused/); assert.equal(f.executions.length, 1);
    } },
  ],
  [
    { name: 'L2 权限矩阵及 shell 独立开关', run(a) {
      for (const policy of ['read-only', 'ask', 'workspace-write', 'full-auto'] as const) {
        assert.equal(a.decide(policy, 'read', false), 'allow');
        assert.equal(a.decide(policy, 'shell', false), 'deny');
      }
      assert.equal(a.decide('read-only', 'write', true), 'deny');
      assert.equal(a.decide('read-only', 'shell', true), 'deny');
      assert.equal(a.decide('ask', 'write', false), 'ask');
      assert.equal(a.decide('workspace-write', 'write', false), 'allow');
      assert.equal(a.decide('workspace-write', 'shell', true), 'ask');
      assert.equal(a.decide('full-auto', 'shell', true), 'allow');
    } },
    { name: 'L2 参数校验、预览、拒绝不产生副作用', async run(a) {
      let writes = 0, approvals = 0;
      const registry = new ToolRegistry({ policy: 'ask', shellEnabled: false, algorithms: a, emit: () => {}, approve: async request => { approvals++; assert.equal(request.preview, 'concrete change'); return false; } });
      registry.register({ name: 'echo', effect: 'write', description: '', parameters: params({ value: str() }), async prepare() { return { preview: 'concrete change', run: async () => ++writes }; } });
      const malformed = await registry.execute({ ...toolCall, arguments: '{"wrong":1}' }, signal());
      assert.equal(JSON.parse(malformed.content).ok, false); assert.equal(approvals, 0);
      const denied = await registry.execute(toolCall, signal());
      assert.match(denied.content, /User denied/); assert.equal(writes, 0); assert.equal(approvals, 1);
    } },
  ],
  [
    { name: 'L3 唯一匹配、冲突检测与多文件预检', async run(a, root) {
      assert.equal(a.replaceText('a\nb\nc', 'b', 'B'), 'a\nB\nc');
      assert.throws(() => a.replaceText('aaa', 'aa', 'b'), /ambiguous/);
      assert.throws(() => a.replaceText('abc', '', 'x'));
      const workspace = await Workspace.open(root); await writeFile(join(root, 'a.txt'), 'old\n');
      const patch = '*** Begin Patch\n*** Update File: a.txt\n@@\n-old\n+new\n*** Add File: b.txt\n+hello\n*** End Patch';
      const changes = await preparePatch(workspace, patch, a.replaceText);
      assert.equal(await workspace.read('a.txt'), 'old\n');
      await writeFile(join(root, 'a.txt'), 'user edit\n');
      await assert.rejects(applyChanges(workspace, changes, signal()), /changed/);
      await assert.rejects(readFile(join(root, 'b.txt')), /ENOENT/);
      await writeFile(join(root, 'a.txt'), 'old\n');
      await applyChanges(workspace, changes, signal());
      assert.equal(await workspace.read('a.txt'), 'new\n');
      assert.equal(await workspace.read('b.txt'), 'hello\n');
    } },
    { name: 'L3 阻止越界、符号链接和受保护文件', async run(_a, root) {
      const workspace = await Workspace.open(root); await symlink(tmpdir(), join(root, 'outside'));
      for (const path of ['../escape', '/tmp/absolute', 'outside/file', '.git/config', '.env', '.kraken-coder/config.json']) await assert.rejects(workspace.path(path));
    } },
  ],
  [
    { name: 'L4 只删除完整旧轮次，保留 system 与当前工具组', run(a) {
      const messages: Message[] = [
        { role: 'system', content: 'instructions' }, { role: 'user', content: 'old'.repeat(200) },
        { role: 'assistant', content: '', toolCalls: [toolCall] }, { role: 'tool', toolCallId: toolCall.id, content: 'result'.repeat(200) }, { role: 'assistant', content: 'done' },
        { role: 'user', content: 'current' }, { role: 'assistant', content: '', toolCalls: [{ ...toolCall, id: 'current' }] }, { role: 'tool', toolCallId: 'current', content: 'current result' },
      ];
      const copy = structuredClone(messages), expected = [messages[0], ...messages.slice(5)];
      const context = a.fitContext(messages, JSON.stringify(expected).length);
      assert.deepEqual(context, expected); assert.deepEqual(messages, copy); validateHistory(context);
      assert.throws(() => a.fitContext(context, 10), /Context budget/);
    } },
  ],
  [
    { name: 'L5 追加日志、恢复未知结果、独占锁与截断尾行', async run(a, root) {
      const meta = { id: 'test', workspace: root, provider: 'demo' };
      const store = SessionStore.open(root, meta);
      store.append({ type: 'message', message: { role: 'user', content: 'go' } });
      store.append({ type: 'message', message: { role: 'assistant', content: '', toolCalls: [toolCall] } });
      assert.throws(() => SessionStore.open(root, meta), /locked/);
      const path = store.path; store.close();
      await appendFile(path, '{"partial":');
      const reopened = SessionStore.open(root, meta);
      try {
        const restored = a.replay(reopened.messages()); validateHistory(restored);
        assert.match(restored.at(-1)!.content, /outcome unknown/);
        assert.deepEqual(a.replay(restored), restored);
        reopened.append({ type: 'message', message: restored.at(-1)! });
      } finally { reopened.close(); }
      assert.equal(readSession(root, 'test').length, 4);
      assert.throws(() => SessionStore.open(root, { ...meta, workspace: root + '-other' }), /different/);
    } },
    { name: 'L5 孤立工具结果不能悄悄恢复', run(a) {
      assert.throws(() => a.replay([{ role: 'tool', content: 'orphan', toolCallId: 'unknown' }]));
    } },
  ],
  [
    { name: 'L6 指令作用域、技能按需加载、plan 事件', async run(a, root) {
      await mkdir(join(root, 'src'), { recursive: true }); await mkdir(join(root, '.agents/skills/review'), { recursive: true });
      await writeFile(join(root, 'AGENTS.md'), 'root rules'); await writeFile(join(root, 'src/AGENTS.md'), 'nested rules');
      await writeFile(join(root, '.agents/skills/review/SKILL.md'), '---\nname: review\ndescription: review changes\n---\nSECRET_SKILL_BODY');
      const workspace = await Workspace.open(root), instructions = new Instructions(workspace), skills = await listSkills(workspace);
      const prompt = await systemPrompt(workspace, instructions, skills);
      assert.match(prompt, /root rules/); assert.doesNotMatch(prompt, /nested rules|SECRET_SKILL_BODY/);
      await assert.rejects(instructions.requireRead('src/new.ts'), /project_instructions/);
      assert.deepEqual((await instructions.forPath('src/new.ts')).map(x => x.path), ['AGENTS.md', 'src/AGENTS.md']);
      await instructions.requireRead('src/new.ts');
      const events: string[] = [], emit: Emit = e => { events.push(e.type); };
      const registry = new ToolRegistry({ policy: 'read-only', shellEnabled: false, algorithms: a, approve: async () => false, emit });
      registerBuiltins(registry, workspace, a, instructions, skills, emit);
      const skill = await registry.execute({ id: 'skill', name: 'read_skill', arguments: '{"name":"review"}' }, signal());
      assert.match(skill.content, /SECRET_SKILL_BODY/);
      const plan = await registry.execute({ id: 'plan', name: 'update_plan', arguments: '{"steps":[{"step":"read","status":"in_progress"}]}' }, signal());
      assert.equal(JSON.parse(plan.content).ok, true); assert.ok(events.includes('plan.updated'));
    } },
  ],
];
export async function runChecks(selected: number[], mode: Mode, emit: Emit = () => {}) {
  if (!selected.length || selected.some(n => !Number.isInteger(n) || !stages[n])) throw new Error('Stage must be an integer from 0 to 6');
  const reports: { stage: number; name: string; cases: { name: string; ok: boolean; error?: string }[] }[] = [];
  for (const stage of selected) {
    const cases: { name: string; ok: boolean; error?: string }[] = [];
    for (const entry of stages[stage]!) {
      const root = await mkdtemp(join(tmpdir(), 'kraken-check-'));
      emit({ type: 'check.start', stage, name: entry.name });
      try { await entry.run(algorithms(mode), root); cases.push({ name: entry.name, ok: true }); }
      catch (error) { cases.push({ name: entry.name, ok: false, error: errorText(error) }); }
      finally { await rm(root, { recursive: true, force: true }); }
      emit({ type: 'check.end', stage, ...cases.at(-1) });
    }
    reports.push({ stage, name: stageNames[stage]!, cases });
  }
  return { ok: reports.every(r => r.cases.every(c => c.ok)), mode, stages: reports };
}
