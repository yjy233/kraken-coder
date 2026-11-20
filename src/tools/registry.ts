import type { Algorithms, Effect, Emit, Message, Policy, Schema, ToolCall, ToolSpec } from '../core/types.js';
import { errorText, object, validateSchema } from '../core/validation.js';
import { commandRule, hasCommandRule, rememberCommandRule } from '../permissions/command-rules.js';
export interface Prepared { preview: string; run(signal: AbortSignal): Promise<unknown> }
export interface Tool extends ToolSpec { effect: Effect; prepare(args: Record<string, unknown>): Promise<Prepared> }
export interface ApprovalRequest { name: string; effect: Effect; preview: string; commandPrefix?: string }
export type ApprovalDecision = boolean | 'remember';
export type Approve = (request: ApprovalRequest, signal: AbortSignal) => Promise<ApprovalDecision>;
export type Reviewer = (request: ApprovalRequest, signal: AbortSignal) => Promise<'allow' | 'deny' | 'ask'>;
export class ToolRegistry {
  private tools = new Map<string, Tool>();
  constructor(private options: { policy: Policy; shellEnabled: boolean; algorithms: Algorithms; approve: Approve; emit: Emit; workspace?: string; reviewer?: Reviewer }) {}
  register(tool: Tool): void {
    if (this.tools.has(tool.name)) throw new Error(`Duplicate tool: ${tool.name}`);
    this.tools.set(tool.name, tool);
  }
  schemas(): ToolSpec[] { return [...this.tools.values()].map(({ name, description, parameters }) => ({ name, description, parameters })); }
  private async requestApproval(request: ApprovalRequest, signal: AbortSignal): Promise<void> {
    const { workspace, policy, reviewer, approve, emit } = this.options;
    const { name, commandPrefix } = request;
    if (workspace && commandPrefix && await hasCommandRule(workspace, commandPrefix)) {
      emit({ type: 'approval.result', name, approved: true, source: 'rule', commandPrefix });
      return;
    }
    signal.throwIfAborted();
    if (policy === 'auto-review' && reviewer) {
      emit({ type: 'approval.reviewing', name });
      const verdict = await reviewer(request, signal);
      signal.throwIfAborted();
      if (verdict === 'allow' || verdict === 'deny') {
        emit({ type: 'approval.result', name, approved: verdict === 'allow', source: 'reviewer' });
        if (verdict === 'deny') throw new Error(`Reviewer denied ${name}`);
        return;
      }
    }
    emit({ type: 'approval.request', ...request });
    const decision = await approve(request, signal);
    signal.throwIfAborted();
    if (decision === 'remember') {
      if (!workspace || !commandPrefix) throw new Error('No command rule was offered for this action');
      await rememberCommandRule(workspace, commandPrefix);
    }
    const approved = decision === true || decision === 'remember';
    emit({ type: 'approval.result', name, approved, source: 'user', ...(decision === 'remember' ? { commandPrefix } : {}) });
    if (!approved) throw new Error(`User denied ${name}`);
  }
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
        const commandPrefix = this.options.workspace && call.name === 'shell' && tool.effect === 'shell' && typeof args.command === 'string'
          ? commandRule(args.command) : undefined;
        await this.requestApproval({ name: call.name, effect: tool.effect, preview: prepared.preview, ...(commandPrefix ? { commandPrefix } : {}) }, signal);
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
