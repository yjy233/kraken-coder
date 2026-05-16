import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { MemoryPaths, MemoryScope } from './types';

export async function appendMemoryNote(paths: MemoryPaths, scope: MemoryScope, content: string): Promise<string> {
  const filePath = resolveMemoryWritePath(paths, scope);
  if (!filePath) {
    throw new Error('Workspace memory requires an open workspace folder.');
  }
  assertMemoryContentAllowed(content);

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, formatMemoryNote(content), 'utf8');
  return filePath;
}

export async function ensureMemoryFile(paths: MemoryPaths, scope: MemoryScope): Promise<string> {
  const filePath = resolveMemoryWritePath(paths, scope);
  if (!filePath) {
    throw new Error('Workspace memory requires an open workspace folder.');
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fs.access(filePath);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      await fs.writeFile(filePath, defaultMemoryContent(scope), 'utf8');
    } else {
      throw error;
    }
  }
  return filePath;
}

export function resolveMemoryWritePath(paths: MemoryPaths, scope: MemoryScope): string | undefined {
  return scope === 'global' ? paths.globalUserPath : paths.workspaceProjectPath;
}

export function assertMemoryContentAllowed(content: string): void {
  const trimmed = content.trim();
  if (!trimmed) {
    throw new Error('Memory content is empty.');
  }
  if (looksLikeSecret(trimmed)) {
    throw new Error('Refusing to write likely secret content to memory. Use SecretStorage or environment variables instead.');
  }
}

function formatMemoryNote(content: string): string {
  const date = new Date().toISOString().slice(0, 10);
  return [
    '',
    '## Notes',
    '',
    `- ${date}: ${content.trim()}`,
    '',
  ].join('\n');
}

function defaultMemoryContent(scope: MemoryScope): string {
  return scope === 'global'
    ? '# User Memory\n\n## Preferences\n\n'
    : '# Project Memory\n\n## Stable Facts\n\n';
}

function looksLikeSecret(content: string): boolean {
  return [
    /api[_-]?key\s*[:=]/i,
    /secret\s*[:=]/i,
    /token\s*[:=]/i,
    /password\s*[:=]/i,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /\bsk-[A-Za-z0-9_-]{20,}/,
  ].some((pattern) => pattern.test(content));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}
