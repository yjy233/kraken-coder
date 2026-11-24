/** 协议层只描述数据；这里不依赖 CLI、HTTP 或文件系统。 */
export type Mode = 'reference' | 'learner';
export type Policy = 'read-only' | 'ask' | 'auto-review' | 'workspace-write' | 'full-auto';
export type Effect = 'read' | 'write' | 'shell' | 'state';
export interface ToolCall { id: string; name: string; arguments: string }
export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** A user message inside an existing turn, so it cannot split a context group. */
  steered?: true;
  /** Snapshot of explicitly selected skills, attached only to the model's view of a user message. */
  skillContext?: string;
  /** Observations supplied by lifecycle hooks, kept distinct from human input. */
  hookContext?: string;
  hookFeedback?: true;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  reasoningContent?: string;
  /** OpenRouter tool continuation state belongs to the originating endpoint/model. */
  openRouterReasoning?: { provider: string; details?: Record<string, unknown>[] };
  /** Responses 原始输出（含 reasoning）按原序回传，不能只保存可见文本。 */
  responseItems?: Record<string, unknown>[];
}
export interface Schema {
  type: 'object' | 'string' | 'integer' | 'boolean' | 'array';
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: false;
  items?: Schema;
  enum?: string[];
  maxLength?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
}
export interface ToolSpec { name: string; description: string; parameters: Schema }
export interface ModelReply extends Omit<Message, 'role' | 'toolCallId' | 'steered' | 'skillContext' | 'hookContext' | 'hookFeedback'> {}
export interface Provider {
  name: string;
  complete(messages: readonly Message[], tools: ToolSpec[], signal: AbortSignal): Promise<ModelReply>;
}
export interface Event { type: string; [key: string]: unknown }
export type Emit = (event: Event) => void;
export interface LoopRuntime {
  provider: Provider;
  tools: ToolSpec[];
  maxSteps: number;
  signal: AbortSignal;
  emit: Emit;
  /** checkpoint 是原始轨迹；context 只改变发给模型的窗口。 */
  checkpoint(message: Message): void;
  takeSteering?(): string[];
  prepareSteering?(text: string): Promise<Message>;
  beforeFinish?(answer: string): Promise<string | undefined>;
  context(messages: Message[]): Message[] | Promise<Message[]>;
  execute(call: ToolCall, signal: AbortSignal): Promise<Message>;
}
export interface Algorithms {
  decodeChat(value: unknown): ModelReply;
  runLoop(messages: Message[], runtime: LoopRuntime): Promise<string>;
  decide(policy: Policy, effect: Effect, shellEnabled: boolean): 'allow' | 'ask' | 'deny';
  replaceText(source: string, before: string, after: string): string;
  fitContext(messages: Message[], maxSize: number, size?: (messages: Message[]) => number): Message[];
  replay(messages: Message[]): Message[];
}
