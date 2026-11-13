import type { Emit, Message, ModelReply, Provider, ToolSpec } from '../core/types.js';
import { object, string, validateReply } from '../core/validation.js';
import { apiUrl, boundedText, post, type HttpOptions } from './http.js';
import { sse } from './sse.js';
export function responseInput(messages: readonly Message[]): unknown[] {
  return messages.flatMap((m): unknown[] => {
    if (m.role === 'tool') return [{ type: 'function_call_output', call_id: m.toolCallId, output: m.content }];
    if (m.role === 'assistant' && m.responseItems) return m.responseItems;
    const items: unknown[] = m.content ? [{ role: m.role, content: m.content }] : [];
    for (const c of m.toolCalls ?? []) items.push({ type: 'function_call', call_id: c.id, name: c.name, arguments: c.arguments });
    return items;
  });
}
export function decodeResponse(value: unknown): ModelReply {
  const response = object(value);
  if (response.status !== 'completed') throw new Error(`Incomplete response: ${String(response.status)}`);
  if (!Array.isArray(response.output)) throw new Error('Responses output must be an array');
  const items = response.output.map(object);
  const reply: ModelReply = { content: '', toolCalls: [], responseItems: items };
  for (const item of items) {
    if (item.type === 'function_call') reply.toolCalls!.push({ id: string(item.call_id), name: string(item.name), arguments: string(item.arguments) });
    else if (item.type === 'message') {
      if (!Array.isArray(item.content)) throw new Error('Invalid response message');
      for (const raw of item.content) {
        const part = object(raw);
        if (part.type === 'output_text') reply.content += string(part.text);
        else if (part.type === 'refusal') reply.content += string(part.refusal);
      }
    } else if (item.type !== 'reasoning') throw new Error(`Unsupported Responses item: ${String(item.type)}`);
  }
  validateReply(reply); return reply;
}
export class ResponsesProvider implements Provider {
  readonly name: string;
  constructor(private options: HttpOptions, private emit: Emit = () => {}) {
    this.name = `responses:${options.model}:${apiUrl(options.baseUrl, 'responses')}`;
  }
  async complete(messages: readonly Message[], tools: ToolSpec[], signal: AbortSignal): Promise<ModelReply> {
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(this.options.timeoutMs)]);
    const response = await post(this.options, 'responses', {
      model: this.options.model, input: responseInput(messages), store: false, stream: true,
      include: ['reasoning.encrypted_content'],
      tools: tools.map(t => ({ type: 'function', ...t, strict: false })),
    }, timeout);
    if (!response.headers.get('content-type')?.includes('text/event-stream')) return decodeResponse(JSON.parse(await boundedText(response)));
    if (!response.body) throw new Error('Empty Responses stream');
    for await (const raw of sse(response.body)) {
      const event = object(raw);
      if (event.type === 'response.output_text.delta') this.emit({ type: 'model.delta', text: string(event.delta) });
      if (['error', 'response.failed', 'response.incomplete'].includes(String(event.type))) throw new Error(`Responses stream failed: ${String(event.type)}`);
      // 未收到 completed 的部分文本绝不能作为成功回合落盘，更不能执行半个工具调用。
      if (event.type === 'response.completed') return decodeResponse(event.response);
    }
    throw new Error('Responses stream ended without response.completed');
  }
}
