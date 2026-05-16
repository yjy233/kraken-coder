import { buildMemoryPaths } from '../../memory/paths';
import { readMemoryFiles } from '../../memory/reader';
import { appendMemoryNote, ensureMemoryFile } from '../../memory/writer';
import type { MemoryScope } from '../../memory/types';
import type { SlashCommand } from '../types';

export const memoryCommand: SlashCommand = {
  name: 'memory',
  description: 'Show, append, or open Kraken Coder memory files.',
  usage: '/memory [show|add|open] [--global|--workspace] [text]',
  execute: async (invocation, context) => {
    const action = invocation.positionals[0]?.toLowerCase() || 'show';
    const paths = buildMemoryPaths({
      globalRoot: context.globalRoot,
      workspaceRoot: context.workspaceRoot,
    });

    if (action === 'show') {
      const files = await readMemoryFiles(paths);
      if (!files.length) {
        context.postAssistantMessage('No memory files found.');
        return;
      }
      context.postAssistantMessage([
        'Memory files:',
        '',
        ...files.map((file) => [
          `- ${file.label}`,
          `  - Scope: ${file.scope}`,
          `  - Path: ${file.path}`,
          `  - Characters: ${file.content.length}`,
        ].join('\n')),
      ].join('\n'));
      return;
    }

    if (action === 'add') {
      const scope = getScope(invocation.flags);
      const content = getAddContent(invocation.argsText);
      const filePath = await appendMemoryNote(paths, scope, content);
      context.postAssistantMessage(`Added ${scope} memory: ${filePath}`);
      return;
    }

    if (action === 'open') {
      const scope = getScope(invocation.flags);
      const filePath = await ensureMemoryFile(paths, scope);
      await context.openFile(filePath);
      context.postAssistantMessage(`Opened ${scope} memory: ${filePath}`);
      return;
    }

    context.postAssistantMessage([
      `Unknown memory action: ${action}`,
      '',
      'Usage:',
      `- \`${memoryCommand.usage}\``,
    ].join('\n'));
  },
};

function getScope(flags: Record<string, string | boolean>): MemoryScope {
  if (flags.global !== undefined) {
    return 'global';
  }
  return 'workspace';
}

function getAddContent(argsText: string): string {
  const content = argsText
    .replace(/^add\b/i, '')
    .replace(/--(?:global|workspace)\b/g, '')
    .trim();
  if (!content) {
    throw new Error('/memory add requires text to remember.');
  }
  return content;
}
