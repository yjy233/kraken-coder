import type { Algorithms, Emit, Message, ModelReply, Provider, ToolSpec } from '../core/types.js';
import { object, string } from '../core/validation.js';
import { apiUrl, boundedText, post, withRequestTimeout, type HttpOptions } from './http.js';
import { profileForBaseUrl } from './profiles.js';
import { sse } from './sse.js';

interface StreamCall { id: string; type: string; function: { name: string; arguments: string } }
function detailArray(raw: unknown): Record<string, unknown>[] {
  if (!Array.isArray(raw)) throw new Error('Invalid reasoning_details');
  return raw.map(object);
}

// A signature terminates a text block. Encrypted details are discrete opaque blocks,
// even when two adjacent blocks use the same index.
function appendDetails(blocks: Record<string, unknown>[], raw: unknown): void {
  for (const part of detailArray(raw)) {
    const last = blocks.at(-1);
    const field = part.type === 'reasoning.text' ? 'text' : part.type === 'reasoning.summary' ? 'summary' : undefined;
    if (field && last && last.type === part.type && !last.signature &&
        ['id', 'index', 'format'].every(key => last[key] == null || part[key] == null || last[key] === part[key])) {
      const joined = string(last[field] ?? '') + string(part[field] ?? '');
      for (const [key, value] of Object.entries(part)) {
        if (value != null && key !== '__proto__') last[key] = value;
      }
      last[field] = joined;
    } else blocks.push({ ...part });
  }
}

/** 保留 reasoning_content，让支持它的兼容服务能够继续工具回合。 */
export class CompatibleProvider implements Provider {
  readonly name: string;
  private readonly openRouter: boolean;
  constructor(private options: HttpOptions, private decode: Algorithms['decodeChat'], private emit: Emit = () => {}) {
    this.openRouter = profileForBaseUrl(options.baseUrl) === 'openrouter';
    this.name = `compatible:${options.model}:${apiUrl(options.baseUrl, 'chat/completions')}`;
  }
  async complete(messages: readonly Message[], tools: ToolSpec[], signal: AbortSignal) {
    return withRequestTimeout(this.options.timeoutMs, signal, timeout => this.request(messages, tools, timeout));
  }
  private reasoningFields(message: Message) {
    if (message.role !== 'assistant') return {};
    const state = message.openRouterReasoning;
    if (state && (!this.openRouter || state.provider !== this.name)) return {};
    if (this.openRouter) return { reasoning: message.reasoningContent, reasoning_details: state?.details };
    return { reasoning_content: message.reasoningContent };
  }
  private decodeResponse(value: unknown): ModelReply {
    const reply = this.decode(value);
    if (!this.openRouter) return reply;
    const choices = object(value).choices as unknown[];
    const message = object(object(choices[0]).message);
    if (message.reasoning != null) reply.reasoningContent = string(message.reasoning);
    if (message.reasoning_details != null || reply.reasoningContent !== undefined) {
      reply.openRouterReasoning = { provider: this.name };
      if (message.reasoning_details != null) reply.openRouterReasoning.details = detailArray(message.reasoning_details);
    }
    return reply;
  }
  private async request(messages: readonly Message[], tools: ToolSpec[], timeout: AbortSignal) {
    const response = await post(this.options, 'chat/completions', {
      model: this.options.model, stream: true,
      messages: messages.map(m => ({ role: m.role, content: m.content,
        ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
        ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })) } : {}),
        ...this.reasoningFields(m),
      })),
      ...(tools.length ? { tools: tools.map(t => ({ type: 'function', function: t })) } : {}),
    }, timeout);
    // Some compatible endpoints ignore stream=true and return a complete JSON response.
    if (!response.headers.get('content-type')?.includes('text/event-stream')) return this.decodeResponse(JSON.parse(await boundedText(response)));
    if (!response.body) throw new Error('Empty Chat completion stream');
    let content = '', reasoning = '', finish: string | undefined;
    let details: Record<string, unknown>[] | undefined;
    const calls = new Map<number, StreamCall>();
    for await (const raw of sse(response.body, true)) {
      const chunk = object(raw);
      if (chunk.error) throw new Error('Chat completion stream failed');
      if (!Array.isArray(chunk.choices)) throw new Error('Invalid streamed choices');
      if (!chunk.choices.length) continue; // Optional usage-only chunk.
      if (chunk.choices.length !== 1) throw new Error('Expected one streamed choice');
      const choice = object(chunk.choices[0]);
      if (choice.index != null && choice.index !== 0) throw new Error('Unexpected streamed choice index');
      if (finish !== undefined) throw new Error('Chat completion continued after finish_reason');
      const delta = choice.delta == null ? {} : object(choice.delta);
      if (delta.role != null && delta.role !== 'assistant') throw new Error('Expected assistant response');
      if (this.openRouter && delta.reasoning_details != null) appendDetails(details ??= [], delta.reasoning_details);
      const reasoningDelta = this.openRouter ? delta.reasoning ?? delta.reasoning_content : delta.reasoning_content;
      if (reasoningDelta != null) {
        const text = string(reasoningDelta); reasoning += text;
        if (text) this.emit({ type: 'model.delta', channel: 'reasoning', text });
      }
      if (delta.content != null) {
        const text = string(delta.content); content += text;
        if (text) this.emit({ type: 'model.delta', text });
      }
      if (delta.tool_calls != null) {
        if (!Array.isArray(delta.tool_calls)) throw new Error('Invalid streamed tool_calls');
        for (const rawCall of delta.tool_calls) {
          const part = object(rawCall), index = part.index;
          if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= 16) throw new Error('Invalid streamed tool index');
          let call = calls.get(index);
          if (!call) { call = { id: '', type: '', function: { name: '', arguments: '' } }; calls.set(index, call); }
          if (part.id != null) call.id += string(part.id);
          if (part.type != null) {
            if (part.type !== 'function') throw new Error('Unsupported tool call type');
            call.type = part.type;
          }
          if (part.function != null) {
            const fn = object(part.function);
            if (fn.name != null) call.function.name += string(fn.name);
            if (fn.arguments != null) call.function.arguments += string(fn.arguments);
            if (call.function.arguments.length > 100_000) throw new Error('Tool arguments too large');
          }
        }
      }
      if (choice.finish_reason != null) finish = string(choice.finish_reason);
    }
    if (finish === undefined) throw new Error('Chat completion stream ended without finish_reason');
    const ordered = [...calls].sort(([a], [b]) => a - b);
    if (ordered.some(([index], i) => index !== i)) throw new Error('Missing streamed tool index');
    // Only a terminal, validated response may enter history or execute tools.
    return this.decodeResponse({ choices: [{ finish_reason: finish, message: {
      role: 'assistant', content, ...(reasoning ? { reasoning_content: reasoning } : {}), tool_calls: ordered.map(([, call]) => call),
      ...(details ? { reasoning_details: details } : {}),
    } }] });
  }
}
