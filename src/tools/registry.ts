import type { Algorithms, Effect, Emit, Message, Policy, Schema, ToolCall, ToolSpec } from '../core/types.js';
import { errorText, object, validateSchema } from '../core/validation.js';
export interface Prepared { preview: string; run(signal: AbortSignal): Promise<unknown> }
export interface Tool extends ToolSpec { effect: Effect; prepare(args: Record<string, unknown>): Promise<Prepared> }
export type Approve = (request: { name: string; effect: Effect; preview: string }, signal: AbortSignal) => Promise<boolean>;
export class ToolRegistry {
  private tools = new Map<string, Tool>();
  constructor(private options: { policy: Policy; shellEnabled: boolean; algorithms: Algorithms; approve: Approve; emit: Emit }) {}
  register(tool: Tool): void {
    if (this.tools.has(tool.name)) throw new Error(`Duplicate tool: ${tool.name}`);
    this.tools.set(tool.name, tool);
  }
  schemas(): ToolSpec[] { return [...this.tools.values()].map(({ name, description, parameters }) => ({ name, description, parameters })); }
  async execute(call: ToolCall, signal: AbortSignal): Promise<Message> {
    signal.throwIfAborted();
    const { emit } = this.options;
    emit({ type: 'tool.start', name: call.name, callId: call.id });
    let content: string;
    try {
      const tool = this.tools.get(call.name);
      if (!tool) throw new Error(`Unknown tool: ${call.name}`);
      const args = object(JSON.parse(call.arguments));
      validateSchema(args, tool.parameters);
      const decision = this.options.algorithms.decide(this.options.policy, tool.effect, this.options.shellEnabled);
      if (decision === 'deny') throw new Error(`Policy denied ${call.name}`);
      const prepared = await tool.prepare(args);
      if (decision === 'ask') {
        emit({ type: 'approval.request', name: call.name, preview: prepared.preview });
        const approved = await this.options.approve({ name: call.name, effect: tool.effect, preview: prepared.preview }, signal);
        emit({ type: 'approval.result', name: call.name, approved });
        if (!approved) throw new Error(`User denied ${call.name}`);
      }
      signal.throwIfAborted();
      const result = await prepared.run(signal);
      const encoded = JSON.stringify(result);
      content = JSON.stringify({ ok: true, result: encoded.length > 20_000 ? { truncated: true, text: encoded.slice(0, 10_000) + '\n…\n' + encoded.slice(-9000) } : result });
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      content = JSON.stringify({ ok: false, error: errorText(error).slice(0, 3000) });
    }
    emit({ type: 'tool.end', name: call.name, callId: call.id, ok: JSON.parse(content).ok });
    return { role: 'tool', content, toolCallId: call.id };
  }
}
export const str = (maxLength = 2000): Schema => ({ type: 'string', maxLength });
export const integer = (minimum: number, maximum: number): Schema => ({ type: 'integer', minimum, maximum });
export const params = (properties: Record<string, Schema>, required = Object.keys(properties)): Schema => ({ type: 'object', properties, required, additionalProperties: false });
