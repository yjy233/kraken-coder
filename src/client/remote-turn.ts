import { AgentClient, AgentClientError } from './client.js';
import type { Emit, Event } from '../core/types.js';
import type { Approve } from '../tools/registry.js';
import type { PendingApproval, TurnState } from '../server/protocol.js';

function deferred() {
  let resolve!: () => void, reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** Terminal adapter: the server owns execution; this client only observes and replies. */
export async function runRemoteTurn(options: {
  client: AgentClient; session: string; message: string; emit: Emit; approve: Approve; signal: AbortSignal;
}): Promise<string> {
  const { client, session, emit, approve, signal } = options;
  signal.throwIfAborted();
  const subscription = new AbortController();
  const ready = deferred(), finished = deferred();
  // A connection may fail before its corresponding await is reached.
  void ready.promise.catch(() => {}); void finished.promise.catch(() => {});
  let expected: string | undefined, starting = false;
  const turns = new Map<string, TurnState>(), answers = new Map<string, string>();
  const earlyEvents = new Map<string, Event[]>();
  const prompts = new Map<string, AbortController>(), seen = new Set<string>();
  const initialTimeout = setTimeout(() => subscription.abort(new Error('Connecting to agent server timed out')), 15_000);
  const reconcile = (turn: TurnState | null, pending: PendingApproval[]): void => {
    if (turn) turns.set(turn.id, turn);
    const ids = new Set(pending.map(item => item.id));
    for (const [id, controller] of prompts) if (!ids.has(id)) { controller.abort(); prompts.delete(id); }
    // Never answer approvals from a different client's active turn.
    for (const request of pending) if (request.turnId === expected && !seen.has(request.id)) {
      seen.add(request.id);
      const controller = new AbortController(); prompts.set(request.id, controller);
      const approvalSignal = AbortSignal.any([controller.signal, subscription.signal, signal]);
      void (async () => {
        try {
          const approved = await approve(request, approvalSignal);
          if (!approvalSignal.aborted) await client.approve(session, request.id, approved);
        } catch (error) {
          if (!approvalSignal.aborted && !(error instanceof AgentClientError && error.status === 409)) {
            finished.reject(error);
          }
        } finally { prompts.delete(request.id); }
      })();
    }
    const own = expected ? turns.get(expected) : undefined;
    if (own && own.status !== 'running') {
      if (own.status === 'completed') finished.resolve();
      else finished.reject(new Error(own.error || `Turn ${own.status}`));
    }
  };
  let pending: PendingApproval[] = [];
  const watching = client.watchSession(session, frame => {
    if (frame.type === 'snapshot') {
      clearTimeout(initialTimeout); ready.resolve(); pending = frame.snapshot.approvals;
      reconcile(frame.snapshot.turn, pending);
    } else if (frame.type === 'state') {
      pending = frame.approvals; reconcile(frame.turn, pending);
    } else {
      if (frame.turnId === expected) emit(frame.event);
      else if (!expected) earlyEvents.set(frame.turnId, [...(earlyEvents.get(frame.turnId) ?? []), frame.event]);
      if (frame.event.type === 'turn.completed') answers.set(frame.turnId, String(frame.event.answer ?? ''));
    }
  }, subscription.signal).catch(error => {
    ready.reject(error); finished.reject(new Error(`Lost connection to agent server; the turn may still be running. Reconnect to session ${session}.`, { cause: error }));
  });
  const cancel = (): void => {
    if (expected) void client.cancelTurn(session, expected).catch(error => {
      if (!(error instanceof AgentClientError && error.status === 409)) finished.reject(error);
    });
    else if (!starting) { ready.reject(signal.reason); subscription.abort(signal.reason); }
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    await ready.promise;
    signal.throwIfAborted();
    starting = true;
    const turn = await client.startTurn(session, options.message);
    expected = turn.id;
    for (const event of earlyEvents.get(expected) ?? []) emit(event);
    earlyEvents.clear();
    if (signal.aborted) cancel();
    reconcile(null, pending);
    await finished.promise;
    return answers.get(expected) ?? '';
  } finally {
    clearTimeout(initialTimeout); signal.removeEventListener('abort', cancel);
    subscription.abort(); for (const controller of prompts.values()) controller.abort();
    await watching;
  }
}
