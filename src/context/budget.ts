import type { Config } from '../config.js';
import type { Algorithms, Message } from '../core/types.js';
import { apiKeyForConfig } from '../providers/profiles.js';
import { discoverModelWindow } from '../providers/models.js';

export type ContextBudget =
  | { source: 'api' | 'manual'; windowTokens: number; thresholdTokens: number }
  | { source: 'fallback'; thresholdChars: number };

export async function resolveContextBudget(config: Config, discover = true, apiKey: string | null = apiKeyForConfig(config) ?? null): Promise<ContextBudget> {
  if (config.contextWindowTokens) {
    return { source: 'manual', windowTokens: config.contextWindowTokens, thresholdTokens: Math.floor(config.contextWindowTokens * config.contextCompactRatio) };
  }
  if (config.contextWindowTokens === null && discover && config.provider !== 'demo') {
    const detected = await discoverModelWindow(config.baseUrl, config.model, apiKey ?? undefined);
    if (detected) {
      const threshold = Math.floor(detected.windowTokens * config.contextCompactRatio);
      return { source: 'api', windowTokens: detected.windowTokens, thresholdTokens: Math.min(threshold, detected.maxInputTokens ?? threshold) };
    }
  }
  return { source: 'fallback', thresholdChars: config.contextChars };
}

// Cross-provider estimate. Bytes account for CJK text better than UTF-16 length.
export function contextSize(value: unknown, budget: ContextBudget): number {
  const json = JSON.stringify(value);
  return budget.source === 'fallback' ? json.length : Math.ceil(Buffer.byteLength(json, 'utf8') / 2);
}

function shorten(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const tail = Math.floor(limit / 4);
  return text.slice(0, limit - tail) + '\n… [工具输出已压缩] …\n' + text.slice(-tail);
}

/** Shorten known text fields and keep instructions, exit status, paths and call IDs. */
function compactTool(message: Message, name: string | undefined, limit: number): Message {
  if (name !== 'shell' && name !== 'read_file' && name !== 'search') return message;
  try {
    const value = JSON.parse(message.content);
    const result = value?.result;
    if (!result || typeof result !== 'object' || Array.isArray(result)) return message;
    let changed = false;
    const keys = name === 'shell' ? ['stdout', 'stderr', 'text'] : name === 'read_file' ? ['content', 'text'] : ['text'];
    for (const key of keys) {
      if (typeof result[key] !== 'string') continue;
      const clipped = shorten(result[key], limit);
      if (clipped === result[key]) continue;
      result[key] = clipped;
      changed = true;
    }
    if (name === 'search' && Array.isArray(result.matches) && result.matches.length > 8) {
      result.matches = [...result.matches.slice(0, 6), ...result.matches.slice(-2)];
      result.truncated = true;
      changed = true;
    }
    return changed ? { ...message, content: JSON.stringify({ ...value, compacted: true }) } : message;
  } catch {
    return message;
  }
}

/** Only the model request is compacted. The session journal retains the original messages. */
export function fitModelContext(messages: Message[], budget: ContextBudget, schemaSize: number, fitContext: Algorithms['fitContext']) {
  const size = (value: Message[]) => contextSize(value, budget);
  const threshold = budget.source === 'fallback' ? budget.thresholdChars : budget.thresholdTokens;
  const maxSize = threshold - schemaSize;
  if (size(messages) <= maxSize) return { context: messages, compacted: 0 };
  const firstTurn = messages.findIndex(message => message.role === 'user' && !message.steered);
  const lastTurn = messages.findLastIndex(message => message.role === 'user' && !message.steered);
  if (lastTurn < 0) return { context: fitContext(messages, maxSize, size), compacted: 0 };
  // If complete old turns can be dropped, do that before touching current observations.
  const current = [...messages.slice(0, firstTurn), ...messages.slice(lastTurn)];
  if (size(current) <= maxSize) return { context: fitContext(messages, maxSize, size), compacted: 0 };
  const names = new Map(current.flatMap(message => (message.toolCalls ?? []).map(call => [call.id, call.name])));
  const compacted = new Set<number>();
  for (const limit of [1600, 256]) {
    for (const [index, message] of current.entries()) {
      if (message.role !== 'tool') continue;
      const next = compactTool(message, names.get(message.toolCallId ?? ''), limit);
      if (next === message || size([next]) >= size([message])) continue;
      current[index] = next;
      compacted.add(index);
      if (size(current) <= maxSize) return { context: current, compacted: compacted.size };
    }
  }
  const unit = budget.source === 'fallback' ? '字符' : 'token（估算）';
  const setting = budget.source === 'fallback' ? '本地字符预算（--context-chars）' : '运行设置中的模型窗口或压缩比例';
  throw new Error(`自动压缩后，本轮消息和工具定义仍需 ${size(current) + schemaSize} ${unit}，超过阈值 ${threshold}。已缩短 ${compacted.size} 条工具结果。请拆分任务或调整${setting}。`);
}
