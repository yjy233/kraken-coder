import type { SlashCommand } from '../types';

export const clearCommand: SlashCommand = {
  name: 'clear',
  description: 'Clear the current chat session.',
  usage: '/clear',
  execute: async (_invocation, context) => {
    await context.clearSession();
  },
};
