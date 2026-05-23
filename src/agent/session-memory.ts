import type { ChatAttachment, ChatMessage } from '../shared/types'
import type { AgentMessage, ContextWindowState } from './types'

export interface SessionMemoryBuildResult {
  messages: AgentMessage[]
  contextWindow: ContextWindowState
}

const SUMMARY_MAX_CHARS = 6000
const MESSAGE_SUMMARY_MAX_CHARS = 360
const ATTACHMENT_SUMMARY_MAX_CHARS = 160

export function buildSessionMemoryMessages(history: ChatMessage[], maxChars = 0): SessionMemoryBuildResult {
  const normalized = history.filter((message) => message.role !== 'system')
  const rawChars = normalized.reduce((total, message) => total + estimateChatMessageChars(message), 0)
  const anchorIndex = findRecentAssistantAnswerIndex(normalized)
  const summarizedMessages = anchorIndex > 0 ? normalized.slice(0, anchorIndex) : []
  const preservedMessages = normalized.slice(anchorIndex > 0 ? anchorIndex : 0)
  const messages: AgentMessage[] = []
  let summaryChars = 0

  if (summarizedMessages.length) {
    const summaryBudget = resolveSummaryBudget(maxChars, summarizedMessages, preservedMessages)
    const summary = buildSessionSummary(summarizedMessages, summaryBudget)
    summaryChars = summary.length
    messages.push({
      role: 'user',
      content: summary,
    })
  }

  for (const message of preservedMessages) {
    messages.push(toAgentMessage(message))
  }

  const effectiveChars = messages.reduce((total, message) => total + estimateAgentMessageChars(message), 0)
  const compressionMode: ContextWindowState['compressionMode'] = summarizedMessages.length
    ? preservedMessages.length > 0 ? 'partial' : 'full'
    : 'none'

  return {
    messages,
    contextWindow: {
      maxTokens: 0,
      rawTokens: approximateTokens(rawChars),
      effectiveTokens: approximateTokens(effectiveChars),
      rawUsageRatio: 0,
      effectiveUsageRatio: 0,
      rawUsagePercent: 0,
      effectiveUsagePercent: 0,
      compressionMode,
      recentTurnsKept: preservedMessages.length,
      summarizedMessages: summarizedMessages.length,
      originalMessageCount: normalized.length,
      effectiveMessageCount: messages.length,
      summaryTokens: approximateTokens(summaryChars),
    },
  }
}

function findRecentAssistantAnswerIndex(messages: ChatMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === 'assistant' && !message.kind && message.status !== 'running' && message.content.trim()) {
      return index
    }
  }
  return 0
}

function toAgentMessage(message: ChatMessage): AgentMessage {
  if (message.kind === 'tool') {
    return {
      role: 'user',
      content: buildToolContextMessage(message),
    }
  }

  return {
    role: message.role === 'assistant' ? 'assistant' : 'user',
    content: message.content,
    ...(message.attachments?.length ? { attachments: summarizeHistoryAttachments(message.attachments) } : {}),
  }
}

function summarizeHistoryAttachments(attachments: ChatAttachment[]): ChatAttachment[] {
  return attachments.map((attachment) => {
    const summary = `[attachment from earlier session history] ${attachment.name || 'attachment'} (${attachment.mimeType || 'unknown'}, ${attachment.size || 0} bytes)`
    return {
      id: attachment.id,
      name: attachment.name,
      mimeType: attachment.mimeType,
      size: attachment.size,
      ...(attachment.path ? { path: attachment.path } : {}),
      textPreview: attachment.textPreview?.trim() || summary,
    }
  })
}

function buildToolContextMessage(message: ChatMessage): string {
  const lines = [
    'Tool result from preserved recent session context:',
    `Tool: ${message.toolName || 'tool'}`,
    `Status: ${message.status || 'complete'}`,
  ]

  if (message.metadata?.input) {
    lines.push('Input: ' + truncate(JSON.stringify(message.metadata.input), MESSAGE_SUMMARY_MAX_CHARS))
  }

  if (message.content.trim()) {
    lines.push('Output: ' + message.content.trim())
  }

  return lines.join('\n')
}

function resolveSummaryBudget(maxChars: number, summarizedMessages: ChatMessage[], preservedMessages: ChatMessage[]): number {
  const configuredMax = Math.max(0, maxChars)
  if (!configuredMax) {
    return SUMMARY_MAX_CHARS
  }

  const preservedChars = preservedMessages.reduce((total, message) => total + estimateChatMessageChars(message), 0)
  const summaryRawChars = summarizedMessages.reduce((total, message) => total + estimateChatMessageChars(message), 0)
  const remaining = configuredMax - preservedChars
  if (remaining <= 0) {
    return 0
  }
  return Math.min(SUMMARY_MAX_CHARS, summaryRawChars, remaining)
}

function buildSessionSummary(messages: ChatMessage[], maxChars: number): string {
  if (maxChars <= 0) {
    return 'Session history summary omitted because recent preserved context already reached the session context budget.'
  }

  const lines = [
    'Session history summary:',
    '',
    'Older messages before the latest preserved assistant answer were compacted to preserve context. Treat this as lossy conversation memory; prefer recent preserved messages and current user instructions when there is a conflict.',
    '',
  ]

  for (const message of messages) {
    const role = message.role === 'assistant' ? 'Assistant' : 'User'
    const createdAt = Number.isFinite(message.createdAt)
      ? new Date(message.createdAt).toISOString()
      : ''
    const prefix = createdAt ? `- ${role} (${createdAt}): ` : `- ${role}: `
    const content = summarizeMessageContent(message)
    if (content) {
      lines.push(prefix + content)
    }
  }

  const summary = lines.join('\n')
  if (summary.length <= maxChars) {
    return summary
  }
  return summary.slice(0, Math.max(0, maxChars - 20)).trimEnd() + '\n...[truncated]'
}

function summarizeMessageContent(message: ChatMessage): string {
  const parts = []
  const content = message.content.trim().replace(/\s+/g, ' ')
  if (content) {
    parts.push(truncate(content, MESSAGE_SUMMARY_MAX_CHARS))
  }

  if (message.attachments?.length) {
    parts.push('Attachments: ' + summarizeAttachments(message.attachments))
  }

  return parts.join(' ')
}

function summarizeAttachments(attachments: ChatAttachment[]): string {
  const text = attachments
    .map((attachment) => `${attachment.name || 'attachment'} (${attachment.mimeType || 'unknown'}, ${attachment.size || 0} bytes)`)
    .join('; ')
  return truncate(text, ATTACHMENT_SUMMARY_MAX_CHARS)
}

function estimateChatMessageChars(message: ChatMessage): number {
  return message.content.length + estimateAttachmentsChars(message.attachments)
}

function estimateAgentMessageChars(message: AgentMessage): number {
  if (typeof message.content === 'string') {
    return message.content.length + estimateAttachmentsChars(message.attachments)
  }
  return JSON.stringify(message.content).length + estimateAttachmentsChars(message.attachments)
}

function estimateAttachmentsChars(attachments?: ChatAttachment[]): number {
  if (!attachments?.length) {
    return 0
  }
  return attachments.reduce((total, attachment) => (
    total
    + (attachment.name?.length ?? 0)
    + (attachment.mimeType?.length ?? 0)
    + (attachment.textPreview?.length ?? 0)
  ), 0)
}

function approximateTokens(chars: number): number {
  return Math.ceil(Math.max(0, chars) / 4)
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value
  }
  return value.slice(0, Math.max(0, maxLength - 14)).trimEnd() + ' ...[truncated]'
}
