import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { buildEpisodePaths } from './paths';
import type { EpisodesConfig, LoadedEpisodes, RecalledEpisode } from './types';

export async function recallEpisodes(options: {
  workspaceRoot?: string;
  branch: string;
  query: string;
  config: EpisodesConfig;
}): Promise<LoadedEpisodes | undefined> {
  if (!options.config.enabled || !options.config.autoRecall || !options.workspaceRoot) {
    return undefined;
  }

  const root = buildEpisodePaths(options.workspaceRoot).root;
  if (!root) {
    return undefined;
  }

  const episodes = await readEpisodes(root, options.branch);
  if (!episodes.length) {
    return undefined;
  }

  const selected = rankEpisodes(episodes, options.query).slice(0, Math.max(0, options.config.maxRecalled));
  if (!selected.length) {
    return undefined;
  }

  const built = buildEpisodesPromptBlock(selected, options.config.maxChars);
  return {
    episodes: selected,
    promptBlock: built.content,
    truncated: built.truncated,
  };
}

export async function listEpisodes(workspaceRoot?: string): Promise<RecalledEpisode[]> {
  const root = buildEpisodePaths(workspaceRoot).root;
  if (!root) {
    return [];
  }
  return readEpisodes(root);
}

export async function readEpisodeSummary(workspaceRoot: string | undefined, episodeId: string): Promise<RecalledEpisode | undefined> {
  const root = buildEpisodePaths(workspaceRoot).root;
  if (!root) {
    return undefined;
  }
  const episodeDir = path.resolve(root, episodeId);
  if (episodeDir !== root && !episodeDir.startsWith(root + path.sep)) {
    return undefined;
  }
  return readEpisode(root, episodeId);
}

export function buildEpisodesPromptBlock(episodes: RecalledEpisode[], maxChars: number): { content: string; truncated: boolean } {
  const content = [
    '## Recalled Episodes',
    '',
    'These are summaries of previous task conversations. Use them as context only; verify local files before relying on implementation details.',
    '',
    ...episodes.map((episode) => [
      `### ${episode.title}`,
      `Episode: ${episode.id}`,
      `Branch: ${episode.branch}`,
      `Updated: ${episode.updatedAt}`,
      `Source: ${episode.path}`,
      '',
      episode.summary,
    ].join('\n')),
  ].join('\n\n');

  return truncateBlock(content, Math.max(0, maxChars));
}

async function readEpisodes(root: string, branch?: string): Promise<RecalledEpisode[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const episodes = await Promise.all(entries.map((entry) => readEpisode(root, entry)));
  return episodes
    .filter((episode): episode is RecalledEpisode => Boolean(episode))
    .filter((episode) => !branch || episode.branch === branch || episode.branch === 'unknown')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function readEpisode(root: string, id: string): Promise<RecalledEpisode | undefined> {
  const episodeDir = path.join(root, id);
  const metaPath = path.join(episodeDir, 'meta.toml');
  const summaryPath = path.join(episodeDir, 'summary.md');
  try {
    const [meta, summary] = await Promise.all([
      fs.readFile(metaPath, 'utf8'),
      fs.readFile(summaryPath, 'utf8'),
    ]);
    return {
      id: readTomlString(meta, 'id') ?? id,
      branch: readTomlString(meta, 'branch') ?? 'unknown',
      title: readTomlString(meta, 'title') ?? id,
      updatedAt: readTomlString(meta, 'updatedAt') ?? '',
      path: summaryPath,
      summary: summary.trim(),
    };
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

function rankEpisodes(episodes: RecalledEpisode[], query: string): RecalledEpisode[] {
  const terms = query.toLowerCase().split(/[^a-z0-9\u4e00-\u9fa5]+/).filter((term) => term.length > 1);
  return episodes
    .map((episode) => ({
      episode,
      score: terms.reduce((score, term) => {
        const haystack = `${episode.title}\n${episode.summary}`.toLowerCase();
        return score + (haystack.includes(term) ? 1 : 0);
      }, 0),
    }))
    .sort((a, b) => b.score - a.score || b.episode.updatedAt.localeCompare(a.episode.updatedAt))
    .map((entry) => entry.episode);
}

function readTomlString(content: string, key: string): string | undefined {
  const match = content.match(new RegExp(`^${key}\\s*=\\s*\"([\\s\\S]*?)\"`, 'm'));
  if (!match?.[1]) {
    return undefined;
  }
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return match[1];
  }
}

function truncateBlock(content: string, maxChars: number): { content: string; truncated: boolean } {
  if (!maxChars || content.length <= maxChars) {
    return { content, truncated: false };
  }
  const marker = '\n\n[truncated]\n';
  return {
    content: content.slice(0, Math.max(0, maxChars - marker.length)).trimEnd() + marker,
    truncated: true,
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}
