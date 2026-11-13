import type { Algorithms, Message, ModelReply } from '../core/types.js';
import { object, string, validateHistory, validateReply } from '../core/validation.js';

export const reference: Algorithms = {
  decodeChat(value): ModelReply {
    const root = object(value);
    const choice = object((root.choices as unknown[])?.[0]);
    if (!['stop', 'tool_calls'].includes(String(choice.finish_reason))) throw new Error(`Incomplete completion: ${String(choice.finish_reason)}`);
    const m = object(choice.message);
    if (m.role !== 'assistant') throw new Error('Expected assistant response');
    const calls = m.tool_calls == null ? [] : m.tool_calls;
    if (!Array.isArray(calls)) throw new Error('Invalid tool_calls');
    const reply: ModelReply = {
      content: m.content == null ? '' : string(m.content),
      toolCalls: calls.map(raw => {
        const c = object(raw), f = object(c.function);
        if (c.type !== 'function') throw new Error('Unsupported tool call type');
        return { id: string(c.id), name: string(f.name), arguments: string(f.arguments) };
      }),
      ...(m.reasoning_content == null ? {} : { reasoningContent: string(m.reasoning_content) }),
    };
    validateReply(reply); return reply;
  },
  async runLoop(messages, r) {
    const history = [...messages];
    validateHistory(history);
    const used = new Set(history.flatMap(m => m.toolCalls?.map(c => c.id) ?? []));
    for (let step = 0; step < r.maxSteps; step++) {
      r.signal.throwIfAborted();
      r.emit({ type: 'model.start', step });
      const reply = await r.provider.complete(r.context(history), r.tools, r.signal);
      r.signal.throwIfAborted(); validateReply(reply);
      const calls = reply.toolCalls ?? [];
      for (const call of calls) if (used.has(call.id)) throw new Error('Reused tool call ID');
      // 最后一次模型请求不再启动副作用：必须留出一次请求来解释工具结果。
      if (calls.length && step + 1 === r.maxSteps) throw new Error('Step limit reached before executing tools');
      const assistant: Message = { ...reply, role: 'assistant' };
      r.checkpoint(assistant); history.push(assistant);
      r.emit({ type: 'model.end', step, toolCalls: calls.length });
      if (!calls.length) return reply.content;
      for (const call of calls) {
        used.add(call.id); r.signal.throwIfAborted();
        const result = await r.execute(call, r.signal);
        r.checkpoint(result); history.push(result);
      }
    }
    throw new Error('Step limit reached');
  },
  decide(policy, effect, shellEnabled) {
    if (effect === 'shell' && (!shellEnabled || policy === 'read-only')) return 'deny';
    if (effect === 'read' || effect === 'state') return 'allow';
    if (policy === 'read-only') return 'deny';
    if (policy === 'full-auto' || (policy === 'workspace-write' && effect === 'write')) return 'allow';
    return 'ask';
  },
  replaceText(source, before, after) {
    if (!before) throw new Error('Patch requires nonempty old text');
    const at = source.indexOf(before);
    if (at < 0) throw new Error('Patch context not found');
    if (source.indexOf(before, at + 1) >= 0) throw new Error('Patch context is ambiguous');
    return source.slice(0, at) + after + source.slice(at + before.length);
  },
  fitContext(messages, maxChars) {
    validateHistory(messages);
    const next = [...messages];
    while (JSON.stringify(next).length > maxChars) {
      const users = next.flatMap((m, i) => m.role === 'user' ? [i] : []);
      if (users.length < 2) throw new Error('Context budget exceeded by instructions or current turn; increase --context-chars');
      next.splice(users[0]!, users[1]! - users[0]!);
    }
    return next;
  },
  replay(messages) {
    const pending = validateHistory(messages, true);
    return [...messages, ...[...pending].map(([id, name]): Message => ({
      role: 'tool', toolCallId: id,
      content: JSON.stringify({ ok: false, error: `Interrupted ${name}: outcome unknown. Inspect workspace before retrying; this call was not replayed.` }),
    }))];
  },
};
