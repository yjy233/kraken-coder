/**
 * loopQuery —— ReAct 单轮查询函数
 *
 * 职责：执行一次"模型调用 → 工具执行"的完整回合。
 * - 若模型未请求工具（done === true），直接返回文本结果。
 * - 若模型请求了工具，则依次执行每个工具，并将 tool_result 追加到消息数组，
 *   供下一轮 ReAct 循环继续使用。
 */

import { invokeModel } from './model.js'
import type { AgentMessage, AgentContentBlock, ToolDefinition, ToolExecution, ToolUse, EmitFn, LoopQueryResult } from './types.js'
import { collapseWhitespace, truncate } from '../utils/helpers.js'

/**
 * 执行单轮 ReAct 查询。
 * @param params.messages   当前上下文消息（不含本轮 assistant 回复）
 * @param params.model      使用的模型 ID
 * @param params.systemPrompt 系统提示词
 * @param params.tools      可用工具列表
 * @param params.maxOutputTokens 最大输出 token 数
 * @param params.timeout    请求超时（毫秒）
 * @param params.step       当前步数（仅用于 emit 事件）
 * @param params.emit       SSE 事件发射器
 */
export async function loopQuery(params: {
  messages: AgentMessage[]
  model: string
  systemPrompt: string
  tools: ToolDefinition[]
  maxOutputTokens: number
  timeout?: number
  step: number
  emit?: EmitFn | undefined
  signal?: AbortSignal | undefined
}): Promise<LoopQueryResult> {
  const { messages, model, systemPrompt, tools, maxOutputTokens, timeout, step, emit, signal } = params
  throwIfAborted(signal)

  // 1. 调用模型
  const modelOptions: Parameters<typeof invokeModel>[0] = { model, systemPrompt, messages, tools, maxOutputTokens }
  modelOptions.onDelta = (delta: string) => {
    emit?.('assistant:delta', { step, text: delta })
  }
  modelOptions.onThinkingDelta = (delta: string) => {
    emit?.('assistant:thinking_delta', { step, text: delta })
  }
  modelOptions.signal = signal
  if (timeout !== undefined) {
    modelOptions.timeout = timeout
  }
  const modelResponse = await invokeModel(modelOptions)
  throwIfAborted(signal)

  // 2. 组装本轮 assistant 内容块
  const assistantContent: AgentContentBlock[] = []
  if (modelResponse.text) {
    assistantContent.push({ type: 'text', text: modelResponse.text })
  }

  for (const toolUse of modelResponse.toolUses) {
    assistantContent.push({ type: 'tool_use', id: toolUse.id, name: toolUse.name, input: toolUse.input })
    if (!isSkippableInvalidToolUse(toolUse)) {
      emit?.('tool:requested', { step, toolUse })
    }
  }

  const updatedMessages: AgentMessage[] = [...messages]
  if (assistantContent.length > 0) {
    updatedMessages.push({ role: 'assistant', content: assistantContent })
  }

  // 3. 无 tool_use → 本轮结束，直接返回
  if (modelResponse.toolUses.length === 0) {
    return {
      done: true,
      assistantText: modelResponse.text || '',
      stopReason: modelResponse.stopReason,
      toolUseCount: 0,
      toolExecutions: [],
      updatedMessages,
      usage: modelResponse.usage,
      thinkingText: modelResponse.thinking,
    }
  }

  // 4. 有 tool_use → 逐个执行工具，并把结果拼成 user message
  const toolExecutions: ToolExecution[] = []
  const toolResults: AgentContentBlock[] = []

  for (const toolUse of modelResponse.toolUses) {
    throwIfAborted(signal)
    if (!isSkippableInvalidToolUse(toolUse)) {
      emit?.('tool:running', { step, toolUseId: toolUse.id, toolName: toolUse.name })
    }
    const toolResult = await executeTool(toolUse, tools, signal, emit)
    toolExecutions.push(toolResult)
    toolResults.push({
      type: 'tool_result',
      tool_use_id: toolUse.id,
      tool_name: toolUse.name,
      content: toolResult.output,
      is_error: toolResult.isError,
    })
    if (isSkippableInvalidToolUse(toolUse)) {
      continue
    }
    emit?.('tool:result', {
      step,
      toolUseId: toolUse.id,
      toolName: toolUse.name,
      outputPreview: truncate(collapseWhitespace(toolResult.output), 320),
      output: toolResult.output,
      isError: toolResult.isError,
    })
  }

  updatedMessages.push({ role: 'user', content: toolResults })

  return {
    done: false,
    assistantText: modelResponse.text || '',
    stopReason: modelResponse.stopReason,
    toolUseCount: modelResponse.toolUses.length,
    toolExecutions,
    updatedMessages,
    usage: modelResponse.usage,
    thinkingText: modelResponse.thinking,
  }
}

/**
 * 根据 ToolUse 在注册表中查找并执行对应工具。
 */
async function executeTool(
  toolUse: ToolUse,
  tools: ToolDefinition[],
  signal?: AbortSignal,
  emit?: EmitFn
): Promise<ToolExecution> {
  const validationError = validateToolUse(toolUse)
  if (validationError) {
    return {
      toolUseId: toolUse.id,
      toolName: toolUse.name,
      isError: true,
      output: validationError,
    }
  }

  const tool = tools.find((entry) => entry.name === toolUse.name)
  if (!tool) {
    return {
      toolUseId: toolUse.id,
      toolName: toolUse.name,
      isError: true,
      output: `Unknown tool: ${toolUse.name}`,
    }
  }
  throwIfAborted(signal)
  try {
    const result = await tool.execute(toolUse.input || {}, signal, buildToolEmit(emit, toolUse))
    throwIfAborted(signal)
    return {
      toolUseId: toolUse.id,
      toolName: toolUse.name,
      isError: false,
      output: String(result.output || ''),
    }
  } catch (error) {
    if (signal?.aborted) {
      throw error
    }
    return {
      toolUseId: toolUse.id,
      toolName: toolUse.name,
      isError: true,
      output: error instanceof Error ? error.message : 'Unknown tool error',
    }
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error('Agent run interrupted.')
  }
}

function buildToolEmit(emit: EmitFn | undefined, toolUse: ToolUse): EmitFn | undefined {
  if (!emit) {
    return undefined
  }
  return (event, data) => {
    if (event.startsWith('tool:') && isRecord(data)) {
      emit(event, {
        ...data,
        toolUseId: typeof data.toolUseId === 'string' && data.toolUseId ? data.toolUseId : toolUse.id,
        toolName: typeof data.toolName === 'string' && data.toolName ? data.toolName : toolUse.name,
      })
      return
    }
    emit(event, data)
  }
}

function validateToolUse(toolUse: ToolUse): string | null {
  if (toolUse.inputParseError) {
    return `Invalid tool arguments for ${toolUse.name}: ${toolUse.inputParseError} Raw arguments: ${toolUse.rawInput || '{}'}`
  }

  if (toolUse.name !== 'propose_changes') {
    return null
  }

  const summary = typeof toolUse.input.summary === 'string' ? toolUse.input.summary.trim() : ''
  const changes = Array.isArray(toolUse.input.changes) ? toolUse.input.changes : []
  if (!summary || changes.length === 0) {
    return 'Invalid propose_changes call: summary and at least one file change are required. Read files and build the full proposal before calling propose_changes.'
  }

  return null
}

function isSkippableInvalidToolUse(toolUse: ToolUse): boolean {
  return Boolean(validateToolUse(toolUse) && toolUse.name === 'propose_changes')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
