/**
 * Agent 核心类型定义
 * 包含消息格式、工具定义、ReAct 循环结果等全量类型。
 */

/** 会话消息角色 */
export type SessionRole = 'user' | 'assistant'

/** 工具输入参数 */
export type ToolInput = Record<string, unknown>

/** JSON 对象通配 */
export type JsonRecord = Record<string, unknown>

/** 模型用量统计 */
export type ModelUsage = JsonRecord | null

export interface ContextWindowState {
  maxTokens: number
  rawTokens: number
  effectiveTokens: number
  rawUsageRatio: number
  effectiveUsageRatio: number
  rawUsagePercent: number
  effectiveUsagePercent: number
  compressionMode: 'none' | 'partial' | 'full'
  recentTurnsKept: number
  summarizedMessages: number
  originalMessageCount: number
  effectiveMessageCount: number
  summaryTokens: number
}

/** 事件发射函数，用于 SSE 流式推送运行时事件 */
export type EmitFn = (event: string, data: unknown) => void

/** 单个工具执行后的结果 */
export interface ToolExecutionResult {
  output: string
}

/** 工具定义：包含 JSON Schema 描述和可执行的函数 */
export interface ToolDefinition {
  name: string
  description: string
  input_schema: JsonRecord
  execute: (input: ToolInput) => Promise<ToolExecutionResult>
}

/** 模型返回的 tool_use 请求 */
export interface ToolUse {
  id: string
  name: string
  input: ToolInput
}

/** 工具执行后的记录（包含成功/失败标记） */
export interface ToolExecution {
  toolUseId: string
  toolName: string
  isError: boolean
  output: string
}

/** 文本块 */
export interface TextBlock {
  type: 'text'
  text: string
}

/** 模型请求使用工具的块 */
export interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: ToolInput
}

/** 工具执行结果块，会作为下一轮 user message 喂给模型 */
export interface ToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  tool_name?: string
  content: string
  is_error: boolean
}

/** Agent 消息内容块：文本 / 请求工具 / 返回工具结果 */
export type AgentContentBlock = TextBlock | ToolUseBlock | ToolResultBlock

/** Agent 消息结构，content 可以是纯文本或结构化块数组 */
export interface AgentMessage {
  role: SessionRole
  content: string | AgentContentBlock[]
}

/** 单步运行记录 */
export interface RunStep {
  step: number
  stopReason: string | null
  assistantText: string
  toolUseCount: number
}

/** 一次完整 ReAct 运行的结果 */
export interface RunResult {
  id: string
  sessionId: string
  createdAt: string
  model: string
  steps: RunStep[]
  finalText: string
  usage: ModelUsage[]
  toolExecutions: ToolExecution[]
  contextWindow?: ContextWindowState
}

/** 模型原始响应结构 */
export interface ModelResponse {
  text: string
  toolUses: ToolUse[]
  usage: ModelUsage
  stopReason: string | null
  raw: unknown
}

/** 调用模型的参数（供 model.ts 使用） */
export interface InvokeModelParams {
  model: string
  systemPrompt: string
  messages: AgentMessage[]
  tools: ToolDefinition[]
}

/** Agent 运行返回给调用方的结果 */
export interface RunAgentRequestResult {
  reply: string
  run: RunResult
  loadedSkills?: string[]
}
/** ReActAgent 类构造配置 */
export interface ReActAgentConfig {
  defaultModel: string
  defaultSystemPrompt: string
  maxSteps: number
  maxTokens: number
  timeout?: number
  toolRegistry: ToolDefinition[]
}

/** loopQuery 单轮执行结果 */
export interface LoopQueryResult {
  done: boolean               // 本轮是否已拿到最终文本（无 tool_use）
  assistantText: string       // 本轮模型输出的文本
  stopReason: string | null   // 模型 stop reason
  toolUseCount: number        // 本轮请求的工具数量
  toolExecutions: ToolExecution[]
  updatedMessages: AgentMessage[] // 已追加 assistant + tool_result 的新消息数组
  usage: ModelUsage
}

/** 兼容旧接口的完整选项（保留以备扩展） */
export interface RunAgentOptions {
  message: string
  sessionId?: string
  model?: string
  systemPrompt?: string
  maxAgentSteps: number
  maxTokens: number
  defaultModel: string
  defaultSystemPrompt: string
  toolRegistry: ToolDefinition[]
  emit: EmitFn | null
  onSaveSession: (session: unknown) => Promise<void>
  loadSession: (sessionId: string) => Promise<unknown | null>
  createSession: (params: { title: string; systemPrompt: string; model: string }) => unknown
  summarizeSession: (session: unknown) => unknown
  buildAgentMessages: (messages: unknown[], maxContextMessages: number) => AgentMessage[]
  executeTool: (toolUse: ToolUse) => Promise<ToolExecution>
  maxContextMessages: number
}
