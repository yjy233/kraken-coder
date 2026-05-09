import { ChatMessage, ContextItem, ModelSettings, AgentResult } from '../shared/types';
import { buildModelMessages } from './promptBuilder';
import { OpenAICompatibleModelClient } from './modelClient';
import { parseAgentResult } from './resultParser';

export interface RunAgentOptions {
  userText: string;
  history: ChatMessage[];
  context: ContextItem[];
  settings: ModelSettings;
  apiKey: string;
  maxContextChars: number;
  signal?: AbortSignal;
}

export class AgentRuntime {
  private readonly modelClient = new OpenAICompatibleModelClient();

  async run(options: RunAgentOptions): Promise<AgentResult> {
    const messages = buildModelMessages(
      options.userText,
      options.history,
      options.context,
      options.maxContextChars
    );

    const raw = await this.modelClient.complete({
      settings: options.settings,
      apiKey: options.apiKey,
      messages,
      signal: options.signal
    });

    return parseAgentResult(raw);
  }
}

