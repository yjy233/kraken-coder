import { randomUUID } from 'node:crypto';
import type { Message, ModelReply, Provider } from '../core/types.js';
const call = (name: string, args: unknown): ModelReply => ({ content: '', toolCalls: [{ id: randomUUID(), name, arguments: JSON.stringify(args) }] });
export const FIX_PATCH = '*** Begin Patch\n*** Update File: calculator.js\n@@\n export function add(a, b) {\n-  return a - b;\n+  return a + b;\n }\n*** End Patch';
/** 这是确定性教学脚本，不能理解任意自然语言，也不是实际模型。 */
export class DemoProvider implements Provider {
  name = 'demo:v1';
  async complete(messages: readonly Message[]): Promise<ModelReply> {
    const at = messages.findLastIndex(m => m.role === 'user');
    const input = messages[at]?.content ?? '', turn = messages.slice(at + 1);
    const results = turn.filter(m => m.role === 'tool');
    const last = results.at(-1);
    if (last && JSON.parse(last.content).ok === false) return { content: `演示停止：${JSON.parse(last.content).error}` };
    if (input === '/fix') {
      if (results.length === 3) {
        const baseline = JSON.parse(last!.content).result;
        if (baseline.exitCode !== 1 || baseline.timedOut) return { content: '示例没有复现预期的测试失败；请在 npm run demo 创建的项目中运行。' };
      }
      const steps = [
        () => call('update_plan', { steps: [{ step: '阅读并复现', status: 'in_progress' }, { step: '修改并验证', status: 'pending' }] }),
        () => call('read_file', { path: 'calculator.js' }),
        () => call('shell', { command: 'node --test calculator.test.js' }),
        () => call('apply_patch', { patch: FIX_PATCH }),
        () => call('shell', { command: 'node --test calculator.test.js' }),
        () => call('update_plan', { steps: [{ step: '阅读并复现', status: 'completed' }, { step: '修改并验证', status: 'completed' }] }),
      ];
      if (results.length === 5) {
        const tested = JSON.parse(last!.content).result;
        if (tested.exitCode !== 0 || tested.timedOut) return { content: '修改后的测试未通过，请检查工具轨迹。' };
      }
      return steps[results.length]?.() ?? { content: '已将 add 的减法修复为加法；修改前复现失败，修改后 node --test calculator.test.js 通过。' };
    }
    if (results.length) return { content: last!.content };
    if (input.startsWith('/read ')) return call('read_file', { path: input.slice(6) });
    if (input.startsWith('/search ')) return call('search', { query: input.slice(8) });
    if (input.startsWith('/skill ')) return call('read_skill', { name: input.slice(7) });
    if (input === '/files') return call('list_files', {});
    return { content: 'Demo 是离线脚本。使用 /files、/read PATH、/search TEXT、/skill NAME；运行 npm run demo 观察完整修复。自然语言编程请选择 responses 或 compatible Provider。' };
  }
}
