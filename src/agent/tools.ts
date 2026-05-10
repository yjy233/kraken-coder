import {
  JsonRecord,
  ModelToolCall,
  ModelToolDefinition
} from '../shared/types';

export interface AgentToolResult {
  output: string;
}

export interface AgentTool {
  name: string;
  description: string;
  inputSchema: JsonRecord;
  execute(input: JsonRecord): Promise<AgentToolResult>;
}

export interface AgentToolExecution {
  toolCallId: string;
  toolName: string;
  isError: boolean;
  output: string;
}

export function toModelToolDefinitions(tools: AgentTool[]): ModelToolDefinition[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema
    }
  }));
}

export async function executeToolCall(toolCall: ModelToolCall, tools: AgentTool[]): Promise<AgentToolExecution> {
  const tool = tools.find((candidate) => candidate.name === toolCall.name);
  if (!tool) {
    return {
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      isError: true,
      output: `Unknown tool: ${toolCall.name}`
    };
  }

  try {
    const result = await tool.execute(toolCall.arguments);
    return {
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      isError: false,
      output: String(result.output || '')
    };
  } catch (error) {
    return {
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      isError: true,
      output: error instanceof Error ? error.message : String(error)
    };
  }
}
