import type { Config, RuntimeSettings, TimeoutSettings } from '../config.js';
import type { ContextBudget } from '../context/budget.js';
import type { Event } from '../core/types.js';
import type { ApprovalRequest } from '../tools/registry.js';
import type { ModelProvider } from '../providers/profiles.js';
export type { ExtensionInventory } from '../extensions/inventory.js';

/** Versioned transport boundary shared by browser, CLI and future IDE clients. */
export const API_VERSION = 1;
export interface ServerSettings extends RuntimeSettings { contextBudget: ContextBudget }
export interface ModelSelection {
  active: { provider: ModelProvider | null; model: string };
  providers: { id: ModelProvider; label: string; configured: boolean; model: string }[];
  models: string[];
  catalogError?: string;
}
export interface ModelSelectionInput { provider: ModelProvider; model: string; apiKey?: string }
export interface ServerInfo extends TimeoutSettings {
  version: 1;
  workspace: string;
  provider: Config['provider'];
  modelProvider?: ModelProvider;
  model: string;
  mode: Config['mode'];
  approval: Config['approval'];
  shellEnabled: boolean;
}
export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: string;
}
export interface TurnState {
  id: string;
  status: 'running' | 'completed' | 'cancelled' | 'failed';
  error?: string;
}
export interface PendingApproval extends ApprovalRequest {
  id: string;
  turnId: string;
}
export interface PendingInput {
  id: string;
  turnId: string;
  kind: 'steer' | 'follow_up';
  message: string;
}
export interface SessionSnapshot {
  session: SessionSummary;
  events: Event[];
  turn: TurnState | null;
  approvals: PendingApproval[];
  inputs: PendingInput[];
}
/** Each subscription/reconnection starts with a snapshot; clients replace their view. */
export type ServerFrame =
  | { type: 'snapshot'; snapshot: SessionSnapshot }
  | { type: 'event'; sessionId: string; turnId: string; event: Event }
  | { type: 'state'; sessionId: string; turn: TurnState | null; approvals: PendingApproval[]; inputs: PendingInput[] };
export interface ApiError { error: { code: string; message: string } }
