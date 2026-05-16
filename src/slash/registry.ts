import { clearCommand } from './builtins/clear';
import { episodesCommand } from './builtins/episodes';
import { helpCommand } from './builtins/help';
import { initCommand } from './builtins/init';
import { memoryCommand } from './builtins/memory';
import { skillCommand } from './builtins/skill';
import type { SlashCommand } from './types';

const builtins: SlashCommand[] = [
  helpCommand,
  initCommand,
  memoryCommand,
  episodesCommand,
  skillCommand,
  clearCommand,
];

export function getSlashCommands(): SlashCommand[] {
  return builtins;
}

export function findSlashCommand(name: string): SlashCommand | undefined {
  const normalized = name.toLowerCase();
  return builtins.find((command) => {
    return command.name === normalized || command.aliases?.includes(normalized);
  });
}

export function buildSlashHelp(): string {
  return [
    'Available slash commands:',
    '',
    ...builtins.map((command) => `- \`${command.usage}\`: ${command.description}`),
  ].join('\n');
}
