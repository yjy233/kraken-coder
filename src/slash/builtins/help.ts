import type { SlashCommand } from '../types';

export const helpCommand: SlashCommand = {
  name: 'help',
  aliases: ['?'],
  description: 'Show available slash commands.',
  usage: '/help',
  execute: async (_invocation, context) => {
    context.postAssistantMessage([
      'Available slash commands:',
      '',
      '- `/init [--force] [--refresh] [--dry-run]`: Create a reviewable AGENT.md and workspace Kraken config proposal.',
      '- `/help`: Show available slash commands.',
      '- `/clear`: Clear the current chat session.',
    ].join('\n'));
  },
};
