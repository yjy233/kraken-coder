import type { Algorithms, Message, Provider, ToolSpec } from '../core/types.js';
import { apiUrl, boundedText, post, type HttpOptions } from './http.js';
/** 保留 reasoning_content，让支持它的兼容服务能够继续工具回合。 */
export class CompatibleProvider implements Provider {
  readonly name: string;
  constructor(private options: HttpOptions, private decode: Algorithms['decodeChat']) {
    this.name = `compatible:${options.model}:${apiUrl(options.baseUrl, 'chat/completions')}`;
  }
  async complete(messages: readonly Message[], tools: ToolSpec[], signal: AbortSignal) {
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(this.options.timeoutMs)]);
    const response = await post(this.options, 'chat/completions', {
      model: this.options.model, stream: false,
      messages: messages.map(m => ({ role: m.role, content: m.content,
        ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
        ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })) } : {}),
        ...(m.reasoningContent !== undefined ? { reasoning_content: m.reasoningContent } : {}),
      })),
      ...(tools.length ? { tools: tools.map(t => ({ type: 'function', function: t })) } : {}),
    }, timeout);
    return this.decode(JSON.parse(await boundedText(response)));
  }
}
