import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ChatMessage } from '../shared/types';
import { buildEpisodeDir, buildEpisodePaths } from './paths';
import type { EpisodeMeta, EpisodeRecordInput } from './types';

export async function recordEpisode(input: EpisodeRecordInput): Promise<string | undefined> {
  if (!input.config.enabled || !input.config.autoCapture || !input.workspaceRoot) {
    return undefined;
  }

  const episodeRoot = buildEpisodePaths(input.workspaceRoot).root;
  if (!episodeRoot) {
    return undefined;
  }

  const now = new Date();
  const id = buildEpisodeId(now, input.userText);
  const episodeDir = buildEpisodeDir(episodeRoot, id);
  const meta: EpisodeMeta = {
    id,
    branch: input.branch,
    title: buildTitle(input.userText),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    status: 'closed',
    tags: inferTags(input),
  };

  await fs.mkdir(path.join(episodeDir, 'artifacts'), { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(episodeDir, 'meta.toml'), serializeEpisodeMeta(meta), 'utf8'),
    fs.writeFile(path.join(episodeDir, 'summary.md'), buildSummary(input, meta), 'utf8'),
    fs.writeFile(path.join(episodeDir, 'changes.md'), buildChanges(input), 'utf8'),
    input.config.storeTranscript
      ? fs.writeFile(path.join(episodeDir, 'transcript.jsonl'), buildTranscript(input.messages), 'utf8')
      : Promise.resolve(),
  ]);

  return episodeDir;
}

function buildEpisodeId(date: Date, userText: string): string {
  const stamp = date.toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, '')
    .replace('T', '-');
  return `${stamp}-${slugify(buildTitle(userText))}`.slice(0, 96);
}

function buildTitle(userText: string): string {
  const firstLine = userText.trim().split(/\r?\n/)[0]?.trim() || 'Kraken task';
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'task';
}

function inferTags(input: EpisodeRecordInput): string[] {
  const tags = new Set<string>();
  for (const change of input.result.changes ?? []) {
    const ext = path.extname(change.path).replace('.', '');
    if (ext) tags.add(ext);
  }
  for (const tool of input.toolMessages) {
    if (tool.toolName) tags.add(tool.toolName);
  }
  return Array.from(tags).slice(0, 12);
}

function serializeEpisodeMeta(meta: EpisodeMeta): string {
  return [
    `id = ${JSON.stringify(meta.id)}`,
    `branch = ${JSON.stringify(meta.branch)}`,
    `title = ${JSON.stringify(meta.title)}`,
    `createdAt = ${JSON.stringify(meta.createdAt)}`,
    `updatedAt = ${JSON.stringify(meta.updatedAt)}`,
    `status = ${JSON.stringify(meta.status)}`,
    `tags = [${meta.tags.map((tag) => JSON.stringify(tag)).join(', ')}]`,
    '',
  ].join('\n');
}

function buildSummary(input: EpisodeRecordInput, meta: EpisodeMeta): string {
  const lines = [
    `# ${meta.title}`,
    '',
    '## User Goal',
    '',
    input.userText.trim(),
    '',
    '## Result Summary',
    '',
    input.result.summary || 'No summary returned.',
  ];

  if (input.result.changes?.length) {
    lines.push('', '## Files Changed', '', ...input.result.changes.map((change) => `- \`${change.path}\` (${change.type})${change.rationale ? `: ${change.rationale}` : ''}`));
  }

  if (input.result.commands?.length) {
    lines.push('', '## Commands', '', ...input.result.commands.map((command) => `- \`${command.command}\`${command.rationale ? `: ${command.rationale}` : ''}`));
  }

  if (input.result.followUps?.length) {
    lines.push('', '## Follow-ups', '', ...input.result.followUps.map((item) => `- ${item}`));
  }

  return lines.join('\n') + '\n';
}

function buildChanges(input: EpisodeRecordInput): string {
  const lines = ['# Changes', ''];
  if (input.result.changes?.length) {
    lines.push('## Modified Files', '', ...input.result.changes.map((change) => {
      return `- \`${change.path}\` (${change.type})${change.rationale ? `: ${change.rationale}` : ''}`;
    }), '');
  } else {
    lines.push('No structured file changes were returned.', '');
  }

  if (input.toolMessages.length) {
    lines.push('## Tool Activity', '', ...input.toolMessages.map((message) => {
      const status = message.status ? ` ${message.status}` : '';
      return `- ${message.toolName ?? 'tool'}${status}: ${message.content.slice(0, 160).replace(/\s+/g, ' ')}`;
    }), '');
  }

  return lines.join('\n');
}

function buildTranscript(messages: ChatMessage[]): string {
  return messages.map((message) => JSON.stringify({
    role: message.role,
    kind: message.kind ?? 'text',
    toolName: message.toolName,
    content: message.content,
    createdAt: new Date(message.createdAt).toISOString(),
  })).join('\n') + '\n';
}
