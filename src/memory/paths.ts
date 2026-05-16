import * as path from 'node:path';
import type { MemoryPaths } from './types';

export function buildMemoryPaths(options: {
  globalRoot: string;
  workspaceRoot?: string;
}): MemoryPaths {
  const globalRoot = path.join(options.globalRoot, 'memory');
  const workspaceRoot = options.workspaceRoot
    ? path.join(options.workspaceRoot, '.kraken-coder', 'memory')
    : undefined;

  return {
    globalRoot,
    globalUserPath: path.join(globalRoot, 'user.md'),
    ...(workspaceRoot ? {
      workspaceRoot,
      workspaceProjectPath: path.join(workspaceRoot, 'project.md'),
      workspaceDecisionsPath: path.join(workspaceRoot, 'decisions.md'),
      workspacePreferencesPath: path.join(workspaceRoot, 'preferences.md'),
    } : {}),
  };
}

export function getWorkspaceMemoryDefaultPath(paths: MemoryPaths): string | undefined {
  return paths.workspaceProjectPath;
}
