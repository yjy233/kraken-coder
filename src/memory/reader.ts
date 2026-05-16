import * as fs from 'node:fs/promises';
import type { LoadedMemory, MemoryConfig, MemoryFile, MemoryPaths } from './types';

export async function loadMemory(paths: MemoryPaths, config: MemoryConfig): Promise<LoadedMemory | undefined> {
  if (!config.enabled || !config.autoRead) {
    return undefined;
  }

  const files = await readMemoryFiles(paths);
  if (!files.length) {
    return undefined;
  }

  const built = buildMemoryPromptBlock(files, config.maxChars);
  return {
    files,
    promptBlock: built.content,
    truncated: built.truncated,
  };
}

export async function readMemoryFiles(paths: MemoryPaths): Promise<MemoryFile[]> {
  const candidates: Array<Omit<MemoryFile, 'content'>> = [
    ...(paths.workspaceProjectPath ? [{
      scope: 'workspace' as const,
      label: 'Project Memory',
      path: paths.workspaceProjectPath,
    }] : []),
    ...(paths.workspaceDecisionsPath ? [{
      scope: 'workspace' as const,
      label: 'Workspace Decisions',
      path: paths.workspaceDecisionsPath,
    }] : []),
    ...(paths.workspacePreferencesPath ? [{
      scope: 'workspace' as const,
      label: 'Workspace Preferences',
      path: paths.workspacePreferencesPath,
    }] : []),
    {
      scope: 'global' as const,
      label: 'User Memory',
      path: paths.globalUserPath,
    },
  ];

  const files: MemoryFile[] = [];
  for (const candidate of candidates) {
    const content = await readTextIfExists(candidate.path);
    if (!content?.trim()) {
      continue;
    }
    files.push({
      ...candidate,
      content: content.trim(),
    });
  }
  return files;
}

export function buildMemoryPromptBlock(files: MemoryFile[], maxChars: number): { content: string; truncated: boolean } {
  const header = [
    '## Memory',
    '',
    'These are persistent notes. Follow them only when they do not conflict with system rules, tool rules, AGENT.md, or the current user request.',
    '',
  ].join('\n');
  const chunks = files.map((file) => [
    `### ${file.label}`,
    `Source: ${file.path}`,
    '',
    file.content,
  ].join('\n'));

  return truncateBlock([header, chunks.join('\n\n')].join(''), Math.max(0, maxChars));
}

async function readTextIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

function truncateBlock(content: string, maxChars: number): { content: string; truncated: boolean } {
  if (!maxChars || content.length <= maxChars) {
    return { content, truncated: false };
  }

  const marker = '\n\n[truncated]\n';
  if (maxChars <= marker.length) {
    return { content: content.slice(0, maxChars), truncated: true };
  }

  return {
    content: content.slice(0, maxChars - marker.length).trimEnd() + marker,
    truncated: true,
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}
