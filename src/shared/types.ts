export type ChatRole = 'user' | 'assistant' | 'system';

export type ChatMessageKind = 'text' | 'tool';
export type ChatMessageStatus = 'running' | 'complete' | 'error';

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
}

export interface ChatSessionSummary {
  id: string;
  title: string;
  updatedAt: number;
  messageCount: number;
}

export type WebviewToExtensionMessage =
  | { type: 'chat.send'; text: string }
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
  | { type: 'session.updated'; session: ChatSession; sessions?: ChatSessionSummary[] }
  | { type: 'agent.progress'; message: string }
  | { type: 'error'; message: string; recoverable: boolean };

export interface ModelSettings {
  baseUrl: string;
  provider: 'openai-compatible';
  model: string;
  apiKey: string;
  proxy?: string;
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
  toolCalls: ModelToolCall[];
  finishReason?: string;
}

export interface ModelRequest {
  settings: ModelSettings;
  apiKey: string;
  messages: ModelMessage[];
  tools?: ModelToolDefinition[];
  onDelta?: (delta: string) => void;
  signal?: AbortSignal;
}
