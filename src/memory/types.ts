export interface MemoryConfig {
  enabled: boolean;
  autoRead: boolean;
  maxChars: number;
  allowWrite: boolean;
}

export interface MemoryPaths {
  globalRoot: string;
  globalUserPath: string;
  workspaceRoot?: string;
  workspaceProjectPath?: string;
  workspaceDecisionsPath?: string;
  workspacePreferencesPath?: string;
}

export interface MemoryFile {
  scope: 'global' | 'workspace';
  label: string;
  path: string;
  content: string;
}

export interface LoadedMemory {
  files: MemoryFile[];
  promptBlock: string;
  truncated: boolean;
}

export type MemoryScope = 'global' | 'workspace';
