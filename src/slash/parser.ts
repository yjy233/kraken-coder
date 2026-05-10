import type { SlashCommandInvocation } from './types';

export function parseSlashCommand(text: string): SlashCommandInvocation | undefined {
  const raw = text.trim();
  if (!raw.startsWith('/')) {
    return undefined;
  }

  const tokens = tokenize(raw);
  const commandToken = tokens[0];
  if (!commandToken || commandToken === '/') {
    return undefined;
  }

  const name = commandToken.slice(1).trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]*$/.test(name)) {
    return undefined;
  }

  const argTokens = tokens.slice(1);
  return {
    raw,
    name,
    argsText: raw.slice(commandToken.length).trim(),
    flags: parseFlags(argTokens),
    positionals: parsePositionals(argTokens),
  };
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let escaped = false;

  for (const char of input) {
    if (quote === '"') {
      if (escaped) {
        current += char;
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }

    if (quote === "'") {
      if (char === "'") {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

function parseFlags(tokens: string[]): Record<string, string | boolean> {
  const flags: Record<string, string | boolean> = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token?.startsWith('--') || token === '--') {
      continue;
    }

    const withoutPrefix = token.slice(2);
    const equalsIndex = withoutPrefix.indexOf('=');
    if (equalsIndex >= 0) {
      const key = normalizeFlagName(withoutPrefix.slice(0, equalsIndex));
      if (key) {
        flags[key] = withoutPrefix.slice(equalsIndex + 1);
      }
      continue;
    }

    const key = normalizeFlagName(withoutPrefix);
    if (!key) {
      continue;
    }

    const next = tokens[index + 1];
    if (next && !next.startsWith('--')) {
      flags[key] = next;
      index += 1;
    } else {
      flags[key] = true;
    }
  }
  return flags;
}

function parsePositionals(tokens: string[]): string[] {
  const positionals: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) {
      continue;
    }
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    if (!token.includes('=') && tokens[index + 1] && !tokens[index + 1]?.startsWith('--')) {
      index += 1;
    }
  }
  return positionals;
}

function normalizeFlagName(value: string): string {
  return value.trim().toLowerCase().replaceAll('-', '_');
}
