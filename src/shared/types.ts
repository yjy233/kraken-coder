export type ChatRole = 'user' | 'assistant' | 'system';

export type ChatMessageKind = 'text' | 'tool' | 'thinking';
export type ChatMessageStatus = 'queued' | 'running' | 'complete' | 'interrupted' | 'error';

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: number;
  kind?: ChatMessageKind;
  status?: ChatMessageStatus;
  toolName?: string;
  toolUseId?: string;
  metadata?: Record<string, unknown>;
}

export interface ContextItem {
  id: string;
  label: string;
  kind: 'selection' | 'file' | 'diagnostics' | 'workspace';
  path?: string;
  content: string;
  createdAt: number;
}

export interface FileChange {
  path: string;
  type: 'create' | 'modify' | 'delete';
  fullText?: string;
  patch?: string;
  rationale?: string;
}

export interface CommandSuggestion {
  command: string;
  rationale?: string;
}

export type SlashCompletionKind = 'command' | 'skill';

export interface SlashCompletionItem {
  id: string;
  kind: SlashCompletionKind;
  label: string;
  insertText: string;
  detail?: string;
  description?: string;
  replaceStart?: number;
  replaceEnd?: number;
}

export interface AgentResult {
  summary: string;
  changes?: FileChange[];
  commands?: CommandSuggestion[];
  followUps?: string[];
}

export interface ChangeSetFile {
  path: string;
  beforeText: string | null;
  afterText: string | null;
  status: 'created' | 'modified' | 'deleted';
}

export interface ChangeSet {
  id: string;
  title: string;
  description: string;
  files: ChangeSetFile[];
  createdAt: number;
}

export interface ChatSession {
  id: string;
  title?: string;
  messages: ChatMessage[];
  context: ContextItem[];
  changeSets: ChangeSet[];
  busy: boolean;
  activeRunId?: string;
  queueLength?: number;
}

export interface ChatSessionSummary {
  id: string;
  title: string;
  updatedAt: number;
  messageCount: number;
}

export interface ModelStatusInfo {
  provider: ModelProvider;
  api: ModelApiMode;
  model: string;
  effort: ModelReasoningEffort;
  reasoningEnabled: boolean;
  cacheEnabled: boolean;
  cacheStrategy: ModelCacheStrategy;
  thinking?: string;
  cacheMode?: string;
  contextUsedChars: number;
  contextMaxChars: number;
  contextUsagePercent: number;
}

export type WebviewToExtensionMessage =
  | { type: 'chat.send'; text: string }
  | { type: 'agent.stop'; runId?: string }
  | { type: 'slash.completions'; requestId: string; text: string; cursor: number }
  | { type: 'change.apply'; changeSetId: string }
  | { type: 'change.openDiff'; changeSetId: string; filePath: string }
  | { type: 'change.reject'; changeSetId: string }
  | { type: 'context.remove'; contextId: string }
  | { type: 'config.open' }
  | { type: 'session.clear' }
  | { type: 'session.new' }
  | { type: 'session.switch'; sessionId: string }
  | { type: 'session.delete'; sessionId: string };

export type ExtensionToWebviewMessage =
  | { type: 'session.updated'; session: ChatSession; sessions?: ChatSessionSummary[]; modelInfo?: ModelStatusInfo }
  | { type: 'agent.runStarted'; runId: string }
  | { type: 'agent.runStopped'; runId: string; reason: 'user' | 'system' }
  | { type: 'slash.completions'; requestId: string; items: SlashCompletionItem[] }
  | { type: 'agent.progress'; message: string }
  | { type: 'error'; message: string; recoverable: boolean };

export type ModelProvider = 'openrouter' | 'openai' | 'anthropic' | 'qwen' | 'openai-compatible';
export type ModelApiMode = 'responses' | 'chat-completions' | 'messages';
export type ModelReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type ModelReasoningDisplay = 'hidden' | 'summary' | 'visible';
export type ModelCacheStrategy = 'auto' | 'auto-prefix' | 'explicit' | 'explicit-blocks' | 'implicit' | 'disabled';

export interface ModelReasoningSettings {
  enabled: boolean;
  effort: ModelReasoningEffort;
  display: ModelReasoningDisplay;
  budgetTokens: number;
  preserve: boolean;
  maxStoredTokens: number;
}

export interface ModelCacheSettings {
  enabled: boolean;
  strategy: ModelCacheStrategy;
  retention: string;
}

export interface ModelProviderSettings {
  openai: {
    api: 'responses' | 'chat-completions';
    effort: ModelReasoningEffort;
    promptCacheKey: string;
    promptCacheRetention: string;
  };
  anthropic: {
    api: 'messages';
    thinking: 'auto' | 'adaptive' | 'enabled' | 'disabled';
    effort: ModelReasoningEffort;
    thinkingBudgetTokens: number;
    maxTokens: number;
    preserveThinking: boolean;
    cacheTtl: string;
  };
  qwen: {
    api: 'chat-completions';
    enableThinking: boolean;
    thinkingBudget: number;
    preserveThinking: boolean;
    cacheMode: 'auto' | 'explicit' | 'implicit' | 'disabled';
  };
}

export interface ModelSettings {
  baseUrl: string;
  provider: ModelProvider;
  api: ModelApiMode;
  model: string;
  apiKey: string;
  proxy?: string;
  reasoning: ModelReasoningSettings;
  cache: ModelCacheSettings;
  providers: ModelProviderSettings;
}

export type JsonRecord = Record<string, unknown>;

export interface ModelAssistantToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export type ModelMessage =
  | {
      role: 'system' | 'user';
      content: string;
    }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: ModelAssistantToolCall[];
    }
  | {
      role: 'tool';
      content: string;
      tool_call_id: string;
    };

export interface ModelToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: JsonRecord;
  };
}

export interface ModelToolCall {
  id: string;
  name: string;
  arguments: JsonRecord;
  rawArguments: string;
}

export interface ModelResponse {
  content: string;
  thinking?: string;
  toolCalls: ModelToolCall[];
  finishReason?: string;
}

export interface ModelRequest {
  settings: ModelSettings;
  apiKey: string;
  messages: ModelMessage[];
  tools?: ModelToolDefinition[];
  maxOutputTokens?: number;
  onDelta?: (delta: string) => void;
  onThinkingDelta?: (delta: string) => void;
  debug?: {
    logDir: string;
    sessionId?: string;
    runId?: string;
  };
  signal?: AbortSignal;
}
