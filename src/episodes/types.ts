import type { AgentResult, ChatMessage } from '../shared/types';

export interface EpisodesConfig {
  enabled: boolean;
  autoCapture: boolean;
  autoRecall: boolean;
  maxRecalled: number;
  maxChars: number;
  storeTranscript: boolean;
}

export interface EpisodePaths {
  root?: string;
}

export interface EpisodeMeta {
  id: string;
  branch: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  status: 'open' | 'closed';
  tags: string[];
}

export interface EpisodeRecordInput {
  workspaceRoot?: string;
  userText: string;
  result: AgentResult;
  messages: ChatMessage[];
  toolMessages: ChatMessage[];
  branch: string;
  config: EpisodesConfig;
}

export interface RecalledEpisode {
  id: string;
  branch: string;
  title: string;
  updatedAt: string;
  path: string;
  summary: string;
}

export interface LoadedEpisodes {
  episodes: RecalledEpisode[];
  promptBlock: string;
  truncated: boolean;
}
