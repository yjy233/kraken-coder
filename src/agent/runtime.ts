import { ChatMessage, ContextItem, ModelSettings, AgentResult } from '../shared/types'
import { ReActAgent } from './react-agent'
import type { AgentMessage, EmitFn, ToolDefinition } from './types'
import { configureModelRequest } from './model'
import { PromptBuilder } from './prompt-builder'
import { parseAgentResult } from './resultParser'
import type { Skill } from '../skills/types'

const baseSystemPrompt = `You are Kraken Coder, a pragmatic coding agent running inside VS Code.

Your job is to help with code understanding, edits, tests, and project maintenance in the current workspace.

Follow this priority order:
1. System and tool safety rules.
2. Project instructions from AGENT.md.
3. User request.
4. Local code context and existing conventions.

Prefer reading the local project before making implementation claims. When a task depends on project-specific rules, read AGENT.md first if it exists. If AGENT.md is long, summarize the task-relevant instructions before proceeding. When edits are needed, use reviewable change proposals unless a direct file-write tool is explicitly enabled and appropriate.`

export interface RunAgentOptions {
  userText: string
  history: ChatMessage[]
  context: ContextItem[]
  settings: ModelSettings
  apiKey: string
  maxContextChars: number
  tools: ToolDefinition[]
  availableSkills?: Skill[]
  memoryPromptBlock?: string
  episodesPromptBlock?: string
  maxSteps?: number
  onProgress?: (message: string) => void
  signal?: AbortSignal
}

export class AgentRuntime {
  async run(options: RunAgentOptions): Promise<AgentResult> {
    configureModelRequest({
      settings: options.settings,
      apiKey: options.apiKey,
      signal: options.signal,
    })

    const systemPrompt = new PromptBuilder(
      baseSystemPrompt,
      options.tools,
      options.availableSkills ?? [],
      options.memoryPromptBlock,
      options.episodesPromptBlock
    ).build()
    const agent = new ReActAgent({
      defaultModel: options.settings.model,
      defaultSystemPrompt: systemPrompt,
      maxSteps: options.maxSteps ?? 8,
      maxTokens: 4096,
      toolRegistry: options.tools,
    })

    const result = await agent.run({
      messages: buildAgentMessages(options.userText, options.history, options.context, options.maxContextChars),
      model: options.settings.model,
      systemPrompt,
      tools: options.tools,
      emit: buildEmit(options.onProgress),
      signal: options.signal,
    })

    return parseAgentResult(result.reply)
  }
}

function buildAgentMessages(
  userText: string,
  history: ChatMessage[],
  context: ContextItem[],
  maxChars: number
): AgentMessage[] {
  const messages: AgentMessage[] = []
  for (const message of history.slice(-10)) {
    if (message.role === 'system') {
      continue
    }
    messages.push({
      role: message.role,
      content: message.content,
    })
  }

  messages.push({
    role: 'user',
    content: [
      buildContextBlock(context, maxChars),
      '',
      'User task:',
      userText,
    ].join('\n'),
  })

  return messages
}

function buildContextBlock(context: ContextItem[], maxChars: number): string {
  if (!context.length) {
    return 'Workspace context: none provided.'
  }

  const sections: string[] = []
  let used = 0
  for (const item of context) {
    const header = `Context: ${item.label}${item.path ? ` (${item.path})` : ''}`
    const remaining = maxChars - used - header.length - 8
    if (remaining <= 0) {
      break
    }
    const content = item.content.length > remaining
      ? `${item.content.slice(0, Math.max(0, remaining - 80))}\n...[truncated]`
      : item.content
    used += header.length + content.length
    sections.push([header, content].join('\n'))
  }

  if (!sections.length) {
    return 'Workspace context: omitted because token budget was exhausted.'
  }

  return ['Workspace context:', ...sections].join('\n\n')
}

function buildEmit(onProgress: RunAgentOptions['onProgress']): EmitFn {
  return (event, data) => {
    if (!onProgress) {
      return
    }

    if (event === 'run:step' && isRecord(data)) {
      onProgress(JSON.stringify({
        type: 'run:step',
        step: Number(data.step || 0),
      }))
      return
    }
    if (event === 'assistant:delta' && isRecord(data)) {
      onProgress(JSON.stringify({
        type: 'assistant:delta',
        text: String(data.text || ''),
      }))
      return
    }
    if (event === 'assistant:thinking_delta' && isRecord(data)) {
      onProgress(JSON.stringify({
        type: 'assistant:thinking_delta',
        text: String(data.text || ''),
      }))
      return
    }
    if (event === 'tool:requested' && isRecord(data) && isRecord(data.toolUse)) {
      const toolUse = data.toolUse
      onProgress(JSON.stringify({
        type: 'tool:requested',
        toolUseId: String(toolUse.id || ''),
        toolName: String(toolUse.name || ''),
        toolInput: isRecord(toolUse.input) ? toolUse.input : {},
      }))
      return
    }
    if (event === 'tool:running' && isRecord(data)) {
      onProgress(JSON.stringify({
        type: 'tool:running',
        toolUseId: String(data.toolUseId || ''),
        toolName: String(data.toolName || ''),
        outputPreview: String(data.outputPreview || ''),
      }))
      return
    }
    if (event === 'tool:result' && isRecord(data)) {
      onProgress(JSON.stringify({
        type: 'tool:result',
        toolUseId: String(data.toolUseId || ''),
        toolName: String(data.toolName || ''),
        isError: Boolean(data.isError),
        outputPreview: String(data.outputPreview || ''),
      }))
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
