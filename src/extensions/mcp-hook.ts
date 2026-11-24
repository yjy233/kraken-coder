import { object } from '../core/validation.js';
import type { Prepared } from '../tools/registry.js';

export type PrepareMcpHook = (pluginName: string | undefined, server: string, tool: string, args: Record<string, unknown>) => Prepared;

function lookup(event: Record<string, unknown>, path: string) {
  let value: unknown = event;
  for (const field of path.split('.')) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, field)) {
      throw new Error(`MCP hook placeholder ${path} was not found`);
    }
    value = (value as Record<string, unknown>)[field];
  }
  return value;
}

/** Placeholders occupying the whole string keep the hook event field's JSON type. */
export function expandMcpInput(template: Record<string, unknown>, event: Record<string, unknown>): Record<string, unknown> {
  let bytes = 0;
  function resolve(value: unknown, depth: number): unknown {
    if (depth > 64) throw new Error('MCP hook input is too deeply nested');
    if (Array.isArray(value)) return value.map(item => resolve(item, depth + 1));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v, depth + 1)]));
    if (typeof value !== 'string') return value;
    const placeholder = /\$\{([^{}]+)\}/g;
    const whole = /^\$\{([^{}]+)\}$/.exec(value);
    const field = (path: string) => {
      const resolved = lookup(event, path);
      bytes += Buffer.byteLength(JSON.stringify(resolved));
      if (bytes > 100_000) throw new Error('MCP hook input exceeds 100000 bytes');
      return resolved;
    };
    if (whole) return field(whole[1]!);
    return value.replace(placeholder, (_, path: string) => {
      const resolved = field(path);
      return typeof resolved === 'string' ? resolved : JSON.stringify(resolved);
    });
  }
  return object(resolve(template, 0));
}

export function mcpHookText(result: unknown): string {
  const { content } = object(result);
  if (!Array.isArray(content)) throw new Error('Expected MCP tools/call content');
  const text = content.flatMap(item => item?.type === 'text' && typeof item.text === 'string' ? [item.text] : []).join('\n');
  if (Buffer.byteLength(text) > 64 * 1024) throw new Error('Hook output exceeded 64 KiB');
  return text.trim();
}
