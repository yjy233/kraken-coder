import type { Message, ModelReply, Schema } from './types.js';
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object');
  return value as Record<string, unknown>;
}
export function string(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Expected a string');
  return value;
}
export function validateReply(reply: ModelReply): void {
  string(reply.content);
  const calls = reply.toolCalls ?? [];
  if (!reply.content.trim() && calls.length === 0) throw new Error('Model returned no text or tool calls');
  if (calls.length > 16) throw new Error('Too many tool calls (max 16)');
  const ids = new Set<string>();
  for (const call of calls) {
    if (!string(call.id) || ids.has(call.id)) throw new Error('Invalid or duplicate tool call ID');
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(string(call.name))) throw new Error('Invalid tool name');
    if (string(call.arguments).length > 100_000) throw new Error('Tool arguments too large');
    ids.add(call.id);
  }
}
export function validateSchema(value: unknown, schema: Schema, path = 'arguments'): void {
  if (schema.type === 'object') {
    const o = object(value);
    for (const key of schema.required ?? []) if (!Object.hasOwn(o, key)) throw new Error(`${path}.${key} is required`);
    for (const [key, val] of Object.entries(o)) {
      const child = schema.properties && Object.hasOwn(schema.properties, key) ? schema.properties[key] : undefined;
      if (!child) throw new Error(`${path}.${key} is not allowed`);
      validateSchema(val, child, `${path}.${key}`);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length > (schema.maxItems ?? 100)) throw new Error(`${path}: invalid array`);
    for (const item of value) validateSchema(item, schema.items!, path + '[]');
  } else if (schema.type === 'string') {
    if (typeof value !== 'string' || value.length > (schema.maxLength ?? 100_000)) throw new Error(`${path}: invalid string`);
    if (schema.enum && !schema.enum.includes(value)) throw new Error(`${path}: invalid enum value`);
  } else if (schema.type === 'integer') {
    if (!Number.isSafeInteger(value) || (value as number) < (schema.minimum ?? 0) || (value as number) > (schema.maximum ?? Number.MAX_SAFE_INTEGER)) throw new Error(`${path}: invalid integer`);
  } else if (typeof value !== 'boolean') throw new Error(`${path}: invalid boolean`);
}
/** 只允许完整的 assistant/tool 组；避免恢复后把孤立结果发给 API。 */
export function validateHistory(messages: readonly Message[], allowPending = false): Map<string, string> {
  const pending = new Map<string, string>();
  const seen = new Set<string>();
  for (const m of messages) {
    if (!['system', 'user', 'assistant', 'tool'].includes(m.role)) throw new Error('Invalid message role');
    string(m.content);
    if (m.role === 'tool') {
      if (!m.toolCallId || !pending.delete(m.toolCallId)) throw new Error('Orphan or duplicate tool result');
    } else {
      if (pending.size) throw new Error('Missing tool result before next message');
      if (m.role === 'assistant') {
        validateReply(m);
        for (const call of m.toolCalls ?? []) {
          if (seen.has(call.id)) throw new Error('Reused tool call ID');
          seen.add(call.id); pending.set(call.id, call.name);
        }
      }
    }
  }
  if (pending.size && !allowPending) throw new Error('Incomplete tool group');
  return pending;
}
export const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
