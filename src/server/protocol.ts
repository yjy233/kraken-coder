import type { Config, TimeoutSettings } from '../config.js';
import type { Event, Effect } from '../core/types.js';

/** Versioned transport boundary shared by browser, CLI and future IDE clients. */
export const API_VERSION = 1;
export interface ServerInfo extends TimeoutSettings {
  version: 1;
  workspace: string;
  provider: Config['provider'];
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
export interface PendingApproval {
  id: string;
  turnId: string;
  name: string;
  effect: Effect;
  preview: string;
}
export interface SessionSnapshot {
  session: SessionSummary;
  events: Event[];
  turn: TurnState | null;
  approvals: PendingApproval[];
}
/** Each subscription/reconnection starts with a snapshot; clients replace their view. */
export type ServerFrame =
  | { type: 'snapshot'; snapshot: SessionSnapshot }
  | { type: 'event'; sessionId: string; turnId: string; event: Event }
  | { type: 'state'; sessionId: string; turn: TurnState | null; approvals: PendingApproval[] };
export interface ApiError { error: { code: string; message: string } }
