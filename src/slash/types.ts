import type { FileChange } from '../shared/types';
import type { Skill } from '../skills/types';

export interface SlashCommandInvocation {
  raw: string;
  name: string;
  argsText: string;
  flags: Record<string, string | boolean>;
  positionals: string[];
}

export interface SlashCommandContext {
  workspaceRoot?: string;
  globalRoot: string;
  getSlashHelp: () => string;
  postAssistantMessage: (content: string) => void;
  postProgress: (message: string) => void;
  clearSession: () => Promise<void>;
  addReviewableChangeProposal: (summary: string, changes: FileChange[]) => Promise<string>;
  openFile: (filePath: string) => Promise<void>;
  getAvailableSkills: () => Skill[];
  runAgent: (userText: string) => Promise<void>;
}

export interface SlashCommand {
  name: string;
  aliases?: string[];
  description: string;
  usage: string;
  execute: (invocation: SlashCommandInvocation, context: SlashCommandContext) => Promise<void>;
}
