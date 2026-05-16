import type { SlashCommand } from '../types';

export const helpCommand: SlashCommand = {
  name: 'help',
  aliases: ['?'],
  description: 'Show available slash commands.',
  usage: '/help',
  execute: async (_invocation, context) => {
    context.postAssistantMessage(context.getSlashHelp());
  },
};
