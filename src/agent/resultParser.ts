import { AgentResult } from '../shared/types';

export function parseAgentResult(raw: string): AgentResult {
  const jsonText = extractJson(raw);
  if (!jsonText) {
    return {
      summary: raw.trim()
    };
  }

  try {
    const parsed = JSON.parse(jsonText) as Partial<AgentResult>;
    return normalizeAgentResult(parsed, raw);
  } catch {
    return {
      summary: raw.trim()
    };
  }
}

function extractJson(raw: string): string | undefined {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  const firstBrace = raw.indexOf('{');
  const lastBrace = raw.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return raw.slice(firstBrace, lastBrace + 1);
  }

  return undefined;
}

function normalizeAgentResult(parsed: Partial<AgentResult>, fallback: string): AgentResult {
  const commands = Array.isArray(parsed.commands)
    ? parsed.commands.filter((command) => typeof command?.command === 'string')
    : undefined;

  const followUps = Array.isArray(parsed.followUps)
    ? parsed.followUps.filter((item): item is string => typeof item === 'string')
    : undefined;

  return {
    summary: typeof parsed.summary === 'string' && parsed.summary.trim() ? parsed.summary.trim() : fallback.trim(),
    commands,
    followUps
  };
}
