import type { Algorithms, Effect, Emit, Message, Policy, Schema, ToolCall, ToolSpec } from '../core/types.js';
import { errorText, object, validateSchema } from '../core/validation.js';
import { commandRule, hasCommandRule, rememberCommandRule } from '../permissions/command-rules.js';
import type { HookRunner } from '../extensions/hooks.js';
export interface Prepared { preview: string; run(signal: AbortSignal): Promise<unknown> }
export interface Tool extends ToolSpec { effect: Effect; prepare(args: Record<string, unknown>): Promise<Prepared> }
export interface ApprovalRequest { name: string; effect: Effect; preview: string; commandPrefix?: string }
export type ApprovalDecision = boolean | 'remember';
export type Approve = (request: ApprovalRequest, signal: AbortSignal) => Promise<ApprovalDecision>;
export type Reviewer = (request: ApprovalRequest, signal: AbortSignal) => Promise<'allow' | 'deny' | 'ask'>;
const hookAliases = new Map<string, string[]>([
  ['shell', ['shell']], ['apply_patch', ['Write', 'Edit']], ['read_file', ['Read']],
  ['search', ['Grep']], ['list_files', ['Glob']],
]);
export class ToolRegistry {
  private tools = new Map<string, Tool>();
  hooks?: HookRunner;
  constructor(private options: { policy: Policy; shellEnabled: boolean; algorithms: Algorithms; approve: Approve; emit: Emit; workspace?: string; reviewer?: Reviewer }) {}
  register(tool: Tool): void {
    if (this.tools.has(tool.name)) throw new Error(`Duplicate tool: ${tool.name}`);
    this.tools.set(tool.name, tool);
  }
  schemas(): ToolSpec[] { return [...this.tools.values()].map(({ name, description, parameters }) => ({ name, description, parameters })); }
  async authorizeHook(preview: string, signal: AbortSignal): Promise<boolean> {
    const { algorithms, policy, shellEnabled } = this.options;
    const decision = algorithms.decide(policy, 'shell', shellEnabled);
    if (decision === 'deny') return false;
    if (decision === 'ask') await this.requestApproval({ name: 'hook', effect: 'shell', preview }, signal);
    signal.throwIfAborted();
    return true;
  }
  private async requestApproval(request: ApprovalRequest, signal: AbortSignal, forceUser = false): Promise<void> {
    const { workspace, policy, reviewer, approve, emit } = this.options;
    const { name, commandPrefix } = request;
    if (!forceUser && workspace && commandPrefix && await hasCommandRule(workspace, commandPrefix)) {
      emit({ type: 'approval.result', name, approved: true, source: 'rule', commandPrefix });
      return;
    }
    signal.throwIfAborted();
    if (!forceUser && policy === 'auto-review' && reviewer) {
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
      let args = object(JSON.parse(call.arguments));
      validateSchema(args, tool.parameters);
      const decision = this.options.algorithms.decide(this.options.policy, tool.effect, this.options.shellEnabled);
      if (decision === 'deny') throw new Error(`Policy denied ${call.name}`);
      const toolName = call.name === 'shell' ? 'Bash' : call.name;
      const hookInput = { tool_name: toolName, tool_input: args, tool_use_id: call.id };
      const aliases = hookAliases.get(call.name) ?? [];
      const pre = await this.hooks?.run('PreToolUse', hookInput, signal, aliases);
      if (pre?.block) throw new Error(`PreToolUse blocked ${call.name}: ${pre.block}`);
      if (pre?.updatedInput) {
        args = pre.updatedInput;
        validateSchema(args, tool.parameters);
        hookInput.tool_input = args;
      }
      const prepared = await tool.prepare(args);
      if (decision === 'ask' || pre?.ask) {
        const permission = await this.hooks?.run('PermissionRequest', { tool_name: toolName, tool_input: args }, signal, aliases);
        if (permission?.block) throw new Error(`PermissionRequest denied ${call.name}: ${permission.block}`);
        const commandPrefix = !pre?.ask && this.options.workspace && call.name === 'shell' && tool.effect === 'shell' && typeof args.command === 'string'
          ? commandRule(args.command) : undefined;
        await this.requestApproval({ name: call.name, effect: tool.effect, preview: prepared.preview, ...(commandPrefix ? { commandPrefix } : {}) }, signal, pre?.ask);
      }
      signal.throwIfAborted();
      const result = await prepared.run(signal);
      const encoded = JSON.stringify(result);
      const observation = encoded.length > 20_000 ? { truncated: true, text: encoded.slice(0, 10_000) + '\n…\n' + encoded.slice(-9000) } : result;
      const post = await this.hooks?.run('PostToolUse', { ...hookInput, tool_response: observation }, signal, aliases);
      if (post?.block) throw new Error(`Tool already executed. PostToolUse withheld its result: ${post.block}`);
      const hookContext = [pre?.context, post?.context].filter(Boolean).join('\n');
      content = JSON.stringify({ ok: true, result: observation, ...(hookContext ? { hookContext } : {}) });
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
