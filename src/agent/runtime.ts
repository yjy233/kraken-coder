import { ChatMessage, ContextItem, ModelSettings, AgentResult } from '../shared/types';
import { buildModelMessages } from './promptBuilder';
import { OpenAICompatibleModelClient } from './modelClient';
import { parseAgentResult } from './resultParser';
import { AgentTool, executeToolCall, toModelToolDefinitions } from './tools';

export interface RunAgentOptions {
  userText: string;
  history: ChatMessage[];
  context: ContextItem[];
  settings: ModelSettings;
  apiKey: string;
  maxContextChars: number;
  tools?: AgentTool[];
  maxSteps?: number;
  onProgress?: (message: string) => void;
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
    const tools = options.tools ?? [];
    const toolDefinitions = toModelToolDefinitions(tools);
    const maxSteps = options.maxSteps ?? 8;

    for (let stepIndex = 0; stepIndex < maxSteps; stepIndex += 1) {
      options.onProgress?.(`Thinking... step ${stepIndex + 1}/${maxSteps}`);

      const response = await this.modelClient.complete({
        settings: options.settings,
        apiKey: options.apiKey,
        messages,
        tools: toolDefinitions,
        signal: options.signal
      });

      if (!response.toolCalls.length) {
        return parseAgentResult(response.content);
      }

      messages.push({
        role: 'assistant',
        content: response.content || null,
        tool_calls: response.toolCalls.map((toolCall) => ({
          id: toolCall.id,
          type: 'function',
          function: {
            name: toolCall.name,
            arguments: toolCall.rawArguments
          }
        }))
      });

      for (const toolCall of response.toolCalls) {
        options.onProgress?.(`Running tool: ${toolCall.name}`);
        const result = await executeToolCall(toolCall, tools);
        messages.push({
          role: 'tool',
          tool_call_id: result.toolCallId,
          content: result.isError ? `Error: ${result.output}` : result.output
        });
      }
    }

    return {
      summary: `Agent stopped after reaching the maximum tool step limit (${maxSteps}).`
    };
  }
}
