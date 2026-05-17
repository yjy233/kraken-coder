import type {
  AgentContentBlock,
  AgentMessage,
  InvokeModelParams,
  ModelResponse,
  ToolDefinition,
  ToolUse
} from './types.js'
import type {
  ModelAssistantToolCall,
  ModelMessage,
  ModelRequest,
  ModelToolDefinition
} from '../shared/types'
import { OpenAICompatibleModelClient } from './modelClient'

let currentModelRequest: Pick<ModelRequest, 'settings' | 'apiKey' | 'signal'> | null = null

export function configureModelRequest(request: Pick<ModelRequest, 'settings' | 'apiKey' | 'signal'>): void {
  currentModelRequest = request
}

export async function invokeModel(params: InvokeModelParams & {
  maxOutputTokens?: number
  timeout?: number
}): Promise<ModelResponse> {
  if (!currentModelRequest) {
    throw new Error('Model request is not configured.')
  }

  const client = new OpenAICompatibleModelClient()
  const response = await client.complete({
    ...currentModelRequest,
    messages: convertMessages(params.systemPrompt, params.messages),
    tools: convertTools(params.tools),
    maxOutputTokens: params.maxOutputTokens,
    onDelta: params.onDelta,
    onThinkingDelta: params.onThinkingDelta,
    signal: params.signal,
  })

  return {
    text: response.content,
    thinking: response.thinking,
    toolUses: response.toolCalls.map((toolCall): ToolUse => ({
      id: toolCall.id,
      name: toolCall.name,
      input: toolCall.arguments,
    })),
    usage: null,
    stopReason: response.finishReason ?? null,
    raw: response,
  }
}

function convertTools(tools: ToolDefinition[]): ModelToolDefinition[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }))
}

function convertMessages(systemPrompt: string, messages: AgentMessage[]): ModelMessage[] {
  const result: ModelMessage[] = [
    {
      role: 'system',
      content: systemPrompt,
    },
  ]

  for (const message of messages) {
    if (typeof message.content === 'string') {
      result.push({
        role: message.role,
        content: message.content,
      })
      continue
    }

    if (message.role === 'assistant') {
      const textParts: string[] = []
      const toolCalls: ModelAssistantToolCall[] = []
      for (const block of message.content as AgentContentBlock[]) {
        if (block.type === 'text') {
          textParts.push(block.text)
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input || {}),
            },
          })
        }
      }
      result.push({
        role: 'assistant',
        content: textParts.join('\n') || null,
        tool_calls: toolCalls.length ? toolCalls : undefined,
      })
      continue
    }

    for (const block of message.content as AgentContentBlock[]) {
      if (block.type !== 'tool_result') {
        continue
      }
      result.push({
        role: 'tool',
        tool_call_id: block.tool_use_id,
        content: block.is_error ? `Error: ${block.content}` : block.content,
      })
    }
  }

  return result
}
