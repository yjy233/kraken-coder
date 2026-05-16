import * as path from 'node:path';
import type { EpisodePaths } from './types';

export function buildEpisodePaths(workspaceRoot?: string): EpisodePaths {
  return {
    ...(workspaceRoot ? { root: path.join(workspaceRoot, '.kraken-coder', 'episodes') } : {}),
  };
}

export function buildEpisodeDir(root: string, episodeId: string): string {
  return path.join(root, episodeId);
}
