export type ChatRole = 'user' | 'assistant' | 'system';

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: number;
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
  messages: ChatMessage[];
  context: ContextItem[];
  changeSets: ChangeSet[];
  busy: boolean;
}

export type WebviewToExtensionMessage =
  | { type: 'chat.send'; text: string }
  | { type: 'change.apply'; changeSetId: string }
  | { type: 'change.openDiff'; changeSetId: string; filePath: string }
  | { type: 'change.reject'; changeSetId: string }
  | { type: 'context.remove'; contextId: string }
  | { type: 'config.open' }
  | { type: 'secret.setApiKey' }
  | { type: 'session.clear' };

export type ExtensionToWebviewMessage =
  | { type: 'session.updated'; session: ChatSession }
  | { type: 'agent.progress'; message: string }
  | { type: 'error'; message: string; recoverable: boolean };

export interface ModelSettings {
  baseUrl: string;
  provider: 'openai-compatible';
  model: string;
}

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ModelRequest {
  settings: ModelSettings;
  apiKey: string;
  messages: ModelMessage[];
  signal?: AbortSignal;
}

