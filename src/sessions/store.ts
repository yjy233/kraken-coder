import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createId } from '../shared/id';
import type { ChatMessage, ChatSession, ChatSessionSummary } from '../shared/types';

interface StoredSession {
  session: ChatSession;
  updatedAt: number;
}

export function createEmptyChatSession(title = 'New session'): ChatSession {
  return {
    id: createId('session'),
    title,
    messages: [],
    context: [],
    changeSets: [],
    busy: false,
  };
}

export async function loadLatestSession(workspaceRoot?: string): Promise<ChatSession> {
  const summaries = await listStoredSessions(workspaceRoot);
  const latest = summaries[0];
  if (!latest) {
    return createEmptyChatSession();
  }
  return (await loadSession(workspaceRoot, latest.id)) ?? createEmptyChatSession();
}

export async function listStoredSessions(workspaceRoot?: string): Promise<ChatSessionSummary[]> {
  const root = getSessionsRoot(workspaceRoot);
  if (!root) {
    return [];
  }

  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const sessions = await Promise.all(entries
    .filter((entry) => entry.endsWith('.json'))
    .map(async (entry) => {
      const stored = await readStoredSession(path.join(root, entry));
      return stored ? summarizeSession(stored.session, stored.updatedAt) : undefined;
    }));

  return sessions
    .filter((summary): summary is ChatSessionSummary => Boolean(summary))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function loadSession(workspaceRoot: string | undefined, sessionId: string): Promise<ChatSession | undefined> {
  const root = getSessionsRoot(workspaceRoot);
  if (!root) {
    return undefined;
  }

  const filePath = getSessionPath(root, sessionId);
  const stored = await readStoredSession(filePath);
  return stored?.session;
}

export async function saveSession(workspaceRoot: string | undefined, session: ChatSession): Promise<void> {
  const root = getSessionsRoot(workspaceRoot);
  if (!root) {
    return;
  }

  const normalized = normalizeSession(session);
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(getSessionPath(root, normalized.id), JSON.stringify({
    session: normalized,
    updatedAt: Date.now(),
  }, null, 2), 'utf8');
}

export async function deleteSession(workspaceRoot: string | undefined, sessionId: string): Promise<void> {
  const root = getSessionsRoot(workspaceRoot);
  if (!root) {
    return;
  }
  await fs.rm(getSessionPath(root, sessionId), { force: true });
}

export function getSessionsRoot(workspaceRoot?: string): string | undefined {
  return workspaceRoot ? path.join(workspaceRoot, '.kraken-coder', 'sessions') : undefined;
}

export function summarizeSession(session: ChatSession, updatedAt = Date.now()): ChatSessionSummary {
  return {
    id: session.id,
    title: session.title || inferSessionTitle(session.messages),
    updatedAt,
    messageCount: session.messages.length,
  };
}

function normalizeSession(session: ChatSession): ChatSession {
  return {
    ...session,
    messages: session.messages.map(normalizeMessage),
    title: session.title && session.title !== 'New session'
      ? session.title
      : inferSessionTitle(session.messages),
    busy: false,
    activeRunId: undefined,
    queueLength: 0,
  };
}

function normalizeMessage(message: ChatMessage): ChatMessage {
  if (message.status !== 'queued' && message.status !== 'running') {
    return message;
  }
  return {
    ...message,
    status: 'interrupted',
    metadata: {
      ...(message.metadata ?? {}),
      interrupted: true,
      interruptedAt: Date.now(),
    },
  };
}

function inferSessionTitle(messages: ChatMessage[]): string {
  const firstUser = messages.find((message) => message.role === 'user' && message.kind !== 'tool' && message.kind !== 'thinking');
  const content = firstUser?.content.trim().replace(/\s+/g, ' ');
  if (!content) {
    return 'New session';
  }
  return content.length > 64 ? `${content.slice(0, 61)}...` : content;
}

function getSessionPath(root: string, sessionId: string): string {
  const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '');
  return path.join(root, `${safeId}.json`);
}

async function readStoredSession(filePath: string): Promise<StoredSession | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as Partial<StoredSession>;
    if (!parsed.session || typeof parsed.updatedAt !== 'number') {
      return undefined;
    }
    return {
      session: normalizeSession(parsed.session),
      updatedAt: parsed.updatedAt,
    };
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return undefined;
    }
    return undefined;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}
