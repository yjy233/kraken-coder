import { listEpisodes, readEpisodeSummary } from '../../episodes/recall';
import type { SlashCommand } from '../types';

export const episodesCommand: SlashCommand = {
  name: 'episodes',
  aliases: ['episode'],
  description: 'List or show recorded task episodes for this workspace.',
  usage: '/episodes [list|show|open] [episode-id]',
  execute: async (invocation, context) => {
    const action = invocation.positionals[0]?.toLowerCase() || 'list';

    if (action === 'list') {
      const episodes = await listEpisodes(context.workspaceRoot);
      if (!episodes.length) {
        context.postAssistantMessage('No episodes found for this workspace.');
        return;
      }
      context.postAssistantMessage([
        'Recent episodes:',
        '',
        ...episodes.slice(0, 20).map((episode) => `- \`${episode.id}\` (${episode.branch}) ${episode.title}`),
      ].join('\n'));
      return;
    }

    if (action === 'show' || action === 'open') {
      const episodeId = invocation.positionals[1];
      if (!episodeId) {
        throw new Error(`/episodes ${action} requires an episode id.`);
      }
      const episode = await readEpisodeSummary(context.workspaceRoot, episodeId);
      if (!episode) {
        throw new Error(`Episode not found: ${episodeId}`);
      }
      if (action === 'open') {
        await context.openFile(episode.path);
        context.postAssistantMessage(`Opened episode summary: ${episode.path}`);
        return;
      }
      context.postAssistantMessage([
        `# ${episode.title}`,
        '',
        `- Episode: ${episode.id}`,
        `- Branch: ${episode.branch}`,
        `- Updated: ${episode.updatedAt}`,
        `- Path: ${episode.path}`,
        '',
        episode.summary,
      ].join('\n'));
      return;
    }

    context.postAssistantMessage([
      `Unknown episodes action: ${action}`,
      '',
      'Usage:',
      `- \`${episodesCommand.usage}\``,
    ].join('\n'));
  },
};
