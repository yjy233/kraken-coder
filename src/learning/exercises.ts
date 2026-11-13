/**
 * 学习入口：L0～L5 全部已实现，供单步阅读或删掉函数体重新完成。
 * 不导入 reference，不在失败时偷跑答案。修改后 `check --mode learner` 验收。
 */
import type { Algorithms, Message, ModelReply } from '../core/types.js';
import { object, string, validateHistory, validateReply } from '../core/validation.js';

// L0：把 Chat Completions 的网络响应变成核心协议，保留工具 ID 和推理字段。
export const decodeChat: Algorithms['decodeChat'] = value => {
  const payload = object(value);
  const choice = object((payload.choices as unknown[])?.[0]);
  if (choice.finish_reason !== 'stop' && choice.finish_reason !== 'tool_calls') throw new Error(`Incomplete completion: ${String(choice.finish_reason)}`);
  const message = object(choice.message);
  if (message.role !== 'assistant') throw new Error('Expected assistant response');
  const rawCalls = message.tool_calls ?? [];
  if (!Array.isArray(rawCalls)) throw new Error('Invalid tool_calls');
  const reply: ModelReply = { content: message.content == null ? '' : string(message.content), toolCalls: [] };
  for (const raw of rawCalls) {
    const call = object(raw);
    if (call.type !== 'function') throw new Error('Unsupported tool call type');
    const fn = object(call.function);
    reply.toolCalls!.push({ id: string(call.id), name: string(fn.name), arguments: string(fn.arguments) });
  }
  if (message.reasoning_content != null) reply.reasoningContent = string(message.reasoning_content);
  validateReply(reply);
  return reply;
};

// L1：一次用户回合包含多次模型请求；assistant 声明先落盘，再逐个执行工具。
export const runLoop: Algorithms['runLoop'] = async (messages, runtime) => {
  const history = messages.slice();
  validateHistory(history);
  const usedIds = new Set(history.flatMap(m => (m.toolCalls ?? []).map(c => c.id)));
  for (let step = 0; step < runtime.maxSteps; step++) {
    runtime.signal.throwIfAborted();
    runtime.emit({ type: 'model.start', step });
    const response = await runtime.provider.complete(runtime.context(history), runtime.tools, runtime.signal);
    runtime.signal.throwIfAborted();
    validateReply(response);
    const calls = response.toolCalls ?? [];
    for (const call of calls) if (usedIds.has(call.id)) throw new Error('Reused tool call ID');
    const assistant: Message = { role: 'assistant', ...response };
    runtime.checkpoint(assistant);
    history.push(assistant);
    // 步数耗尽不启动副作用，但意图已落盘：恢复时按结果未知处理，而不是丢弃这次响应。
    if (calls.length > 0 && step === runtime.maxSteps - 1) throw new Error('Step limit reached before executing tools');
    runtime.emit({ type: 'model.end', step, toolCalls: calls.length });
    if (calls.length === 0) return assistant.content;
    for (const call of calls) {
      usedIds.add(call.id);
      runtime.signal.throwIfAborted();
      const observation = await runtime.execute(call, runtime.signal);
      runtime.checkpoint(observation);
      history.push(observation);
    }
  }
  throw new Error('Step limit reached');
};

// L2：审批策略和操作系统沙箱不是一回事；shell 必须独立开启。
export const decide: Algorithms['decide'] = (policy, effect, shellEnabled) => {
  if (effect === 'read' || effect === 'state') return 'allow';
  if (policy === 'read-only') return 'deny';
  if (effect === 'shell' && !shellEnabled) return 'deny';
  if (policy === 'full-auto') return 'allow';
  if (policy === 'workspace-write' && effect === 'write') return 'allow';
  return 'ask';
};

// L3：文本修改必须唯一匹配。模糊匹配容易把修改悄悄应用到错误函数。
export const replaceText: Algorithms['replaceText'] = (source, before, after) => {
  if (before.length === 0) throw new Error('Patch requires nonempty old text');
  let found = -1;
  for (let at = 0; at <= source.length - before.length; at++) {
    if (source.startsWith(before, at)) {
      if (found !== -1) throw new Error('Patch context is ambiguous');
      found = at;
    }
  }
  if (found === -1) throw new Error('Patch context not found');
  return source.substring(0, found) + after + source.substring(found + before.length);
};

// L4：仅删除完整旧用户轮次，不能从 assistant/tool 中间切开。
// 这是可解释的整轮裁剪，并非模型语义摘要；完整轨迹仍在 JSONL 中。
export const fitContext: Algorithms['fitContext'] = (messages, maxChars) => {
  validateHistory(messages);
  let context = messages.slice();
  while (JSON.stringify(context).length > maxChars) {
    const first = context.findIndex(m => m.role === 'user');
    const second = context.findIndex((m, i) => i > first && m.role === 'user');
    if (first === -1) throw new Error('Context budget exceeded by instructions; increase --context-chars');
    if (second === -1) throw new Error('Context budget exceeded by current turn; read smaller ranges or increase --context-chars');
    context = [...context.slice(0, first), ...context.slice(second)];
  }
  return context;
};

// L5：崩溃可能发生在“副作用已执行、结果未落盘”之间，所以永不自动重放工具。
export const replay: Algorithms['replay'] = messages => {
  const pending = validateHistory(messages, true);
  const restored = messages.slice();
  for (const [id, name] of pending) {
    restored.push({ role: 'tool', toolCallId: id, content: JSON.stringify({
      ok: false, error: `Interrupted ${name}: outcome unknown. Inspect workspace before retrying; this call was not replayed.`,
    }) });
  }
  return restored;
};

export const learner: Algorithms = { decodeChat, runLoop, decide, replaceText, fitContext, replay };
