import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { runTurn, createProvider } from '../core/agent.js';
import { saveTimeoutEnv, validateConfig, type Config, type TimeoutSettings } from '../config.js';
import { errorText } from '../core/validation.js';
import type { Event, Message, Provider } from '../core/types.js';
import { Workspace } from '../tools/workspace.js';
import type { Approve } from '../tools/registry.js';
import { listSessions, readSession, SessionStore, sessionId, type RecordLine } from '../session/store.js';
import type { ApiError, PendingApproval, PendingInput, ServerFrame, ServerInfo, SessionSnapshot, SessionSummary, TurnState } from './protocol.js';

export interface AgentServerOptions {
  config: Config;
  workspace: string;
  home: string;
  allowShell?: boolean;
  provider?: Provider;
  port?: number;
  token?: string;
  webRoot?: string;
  /** File used by the CLI at startup; settings only update the two timeout keys. */
  envFile?: string;
}
export interface AgentServer {
  /** Loopback HTTP origin; pass the token using Authorization, never in a query. */
  url: string;
  token: string;
  close(): Promise<void>;
}
class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
interface ApprovalWaiter { approval: PendingApproval; settle(approved: boolean): void }
interface LiveSession {
  turn: TurnState;
  controller: AbortController;
  approvals: Map<string, ApprovalWaiter>;
  inputs: PendingInput[];
  followUpsPaused: boolean;
  done?: Promise<void>;
}
const fail = (status: number, code: string, message: string): never => { throw new HttpError(status, code, message); };
const BODY_LIMIT = 128_000;
const MESSAGE_LIMIT = 32_000;
const QUEUE_LIMIT = 16;

/** Expose returned reasoning text; raw provider items and encrypted state stay in the journal. */
function visible(event: Event): Event | undefined {
  if (event.type === 'instructions.snapshot') return;
  if (event.type !== 'message') return event;
  const m = event.message as Message;
  return { type: 'message', message: { role: m.role, content: m.content,
    ...(m.role === 'user' && m.steered ? { steered: true } : {}),
    ...(m.role === 'assistant' && m.reasoningContent?.trim() ? { reasoningContent: m.reasoningContent } : {}),
    ...(m.toolCalls ? { toolCalls: m.toolCalls } : {}), ...(m.toolCallId ? { toolCallId: m.toolCallId } : {}) } };
}
function summary(id: string, records: RecordLine[]): SessionSummary {
  const user = records.find(r => r.event.type === 'message' && (r.event.message as Message).role === 'user');
  return { id, title: user ? (user.event.message as Message).content.replace(/\s+/g, ' ').slice(0, 72) : '新会话', updatedAt: records.at(-1)?.time ?? new Date().toISOString() };
}
function previousTurn(records: RecordLine[]): TurnState | null {
  const start = records.findLastIndex(r => r.event.type === 'turn.started');
  if (start < 0) return null;
  const end = records.slice(start).findLast(r => ['turn.completed', 'turn.cancelled', 'turn.failed'].includes(r.event.type));
  return { id: `previous-${records[start]!.seq}`, status: end ? end.event.type.slice(5) as TurnState['status'] : 'failed',
    ...(!end ? { error: '上次运行已中断；未完成工具的结果未知。发送新消息时由会话恢复处理。' } : typeof end.event.error === 'string' ? { error: end.event.error } : {}) };
}
function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') fail(415, 'content_type', 'Use application/json');
  if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') fail(415, 'content_encoding', 'Compressed request bodies are unsupported');
  if (Number(req.headers['content-length'] ?? 0) > BODY_LIMIT) fail(413, 'body_too_large', 'Request body exceeds 128 KB');
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > BODY_LIMIT) fail(413, 'body_too_large', 'Request body exceeds 128 KB');
    chunks.push(Buffer.from(chunk));
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(400, 'invalid_json', 'Invalid JSON body'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'invalid_body', 'Expected a JSON object');
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) fail(400, 'invalid_body', 'Unexpected request field');
}
function messageText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > MESSAGE_LIMIT) return fail(400, 'invalid_message', 'message must contain 1–32000 characters');
  return value;
}

/** A single owner of turns, approval promises and session streams; transports never run tools themselves. */
export async function startAgentServer(options: AgentServerOptions): Promise<AgentServer> {
  const config = validateConfig({ ...options.config });
  const workspace = (await Workspace.open(options.workspace)).root, home = resolve(options.home);
  const port = options.port ?? 4317;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('port must be between 0 and 65535');
  const token = options.token ?? randomBytes(32).toString('base64url');
  if (token.length < 16 || /\s/.test(token)) throw new Error('Server token must have at least 16 characters without whitespace');
  const providerName = (options.provider ?? createProvider(config, () => {})).name;
  const settings = (): TimeoutSettings => ({ requestTimeoutMs: config.requestTimeoutMs, turnTimeoutMs: config.turnTimeoutMs });
  const info: ServerInfo = { version: 1, workspace, provider: config.provider, model: config.provider === 'demo' ? '' : config.model, mode: config.mode, approval: config.approval, shellEnabled: options.allowShell === true, ...settings() };
  const live = new Map<string, LiveSession>();
  const listeners = new Map<string, Set<ServerResponse>>();
  let active: string | undefined, stopping = false, origin = '';
  const webRoot = options.webRoot ?? fileURLToPath(new URL('../../web/', import.meta.url));
  const assets: Record<string, [string, string]> = {
    '/': [join(webRoot, 'index.html'), 'text/html; charset=utf-8'],
    '/index.html': [join(webRoot, 'index.html'), 'text/html; charset=utf-8'],
    '/app.js': [join(webRoot, 'app.js'), 'text/javascript; charset=utf-8'],
    '/styles.css': [join(webRoot, 'styles.css'), 'text/css; charset=utf-8'],
    '/client.js': [fileURLToPath(new URL('../client/client.js', import.meta.url)), 'text/javascript; charset=utf-8'],
  };
  const recordsFor = (id: string): RecordLine[] => {
    try { sessionId(id); } catch { return fail(400, 'invalid_session', 'Invalid session ID'); }
    let records: RecordLine[];
    try { records = readSession(home, id); } catch (e) {
      if (errorText(e).startsWith('Unknown session:')) return fail(404, 'unknown_session', 'Unknown session');
      throw e;
    }
    const meta = records[0]?.event;
    if (!meta || meta.type !== 'session.created' || meta.workspace !== workspace || meta.provider !== providerName) fail(409, 'session_mismatch', 'Session belongs to a different workspace/provider/model');
    return records;
  };
  const pending = (state?: LiveSession): PendingApproval[] => [...(state?.approvals.values() ?? [])].map(item => item.approval);
  const snapshot = (id: string): SessionSnapshot => {
    const records = recordsFor(id), state = live.get(id);
    return { session: summary(id, records), events: records.flatMap(r => { const event = visible(r.event); return event ? [event] : []; }), turn: state?.turn ?? previousTurn(records), approvals: pending(state), inputs: state?.inputs ?? [] };
  };
  const frame = (res: ServerResponse, value: ServerFrame): void => {
    // A slow/abandoned consumer must not buffer unbounded tool output or block a turn.
    if (res.destroyed || res.writableEnded) return;
    if (res.writableLength > 1_000_000) { res.destroy(); return; }
    res.write(`data: ${JSON.stringify(value)}\n\n`);
  };
  const publish = (id: string, value: ServerFrame): void => { for (const res of listeners.get(id) ?? []) frame(res, value); };
  const publishState = (id: string, state: LiveSession): void => publish(id, { type: 'state', sessionId: id, turn: state.turn, approvals: pending(state), inputs: state.inputs });
  const requestApproval = (id: string, state: LiveSession): Approve => (request, signal) => new Promise<boolean>((resolveApproval, reject) => {
    signal.throwIfAborted();
    const approval: PendingApproval = { id: randomUUID(), turnId: state.turn.id, ...request };
    const finish = (approved: boolean, aborted = false): void => {
      if (!state.approvals.delete(approval.id)) return;
      signal.removeEventListener('abort', abort);
      publishState(id, state);
      if (aborted) reject(signal.reason); else resolveApproval(approved);
    };
    const abort = (): void => finish(false, true);
    state.approvals.set(approval.id, { approval, settle: approved => finish(approved) });
    signal.addEventListener('abort', abort, { once: true });
    publishState(id, state);
  });
  const start = (id: string, message: string): TurnState => {
    if (active) return fail(409, 'turn_busy', 'A turn is already running in this workspace');
    const previous = live.get(id);
    const state: LiveSession = {
      turn: { id: randomUUID(), status: 'running' }, controller: new AbortController(), approvals: new Map(),
      inputs: previous?.inputs ?? [], followUpsPaused: previous?.followUpsPaused ?? false,
    };
    active = id; live.set(id, state); publishState(id, state);
    const emit = (event: Event): void => { const publicEvent = visible(event); if (publicEvent) publish(id, { type: 'event', sessionId: id, turnId: state.turn.id, event: publicEvent }); };
    const takeSteering = (): string[] => {
      const inputs = state.inputs.filter(item => item.kind === 'steer' && item.turnId === state.turn.id);
      if (inputs.length) {
        state.inputs = state.inputs.filter(item => !inputs.includes(item));
        publishState(id, state);
      }
      return inputs.map(item => item.message);
    };
    // Do not await the turn in the HTTP handler: client disconnection never owns its lifetime.
    state.done = (async () => {
      try {
        await runTurn({ config, workspace, home, session: id, allowShell: options.allowShell, provider: options.provider, emit, approve: requestApproval(id, state), takeSteering }, message, state.controller.signal);
        state.turn = { ...state.turn, status: 'completed' };
      } catch (error) {
        const cancelled = state.controller.signal.aborted || (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name));
        state.turn = { ...state.turn, status: cancelled ? 'cancelled' : 'failed', error: errorText(error) };
      } finally {
        const steerWaiting = state.inputs.some(item => item.kind === 'steer' && item.turnId === state.turn.id);
        if (state.turn.status !== 'completed' || steerWaiting) {
          state.followUpsPaused = state.inputs.some(item => item.kind === 'follow_up');
        }
        for (const waiter of state.approvals.values()) waiter.settle(false);
        active = undefined;
        publishState(id, state);
        if (!stopping && !state.followUpsPaused) startFollowUp(id, state);
      }
    })();
    return state.turn;
  };
  const startFollowUp = (id: string, state: LiveSession): TurnState | undefined => {
    const index = state.inputs.findIndex(item => item.kind === 'follow_up');
    if (index === -1) return;
    const [next] = state.inputs.splice(index, 1);
    state.followUpsPaused = false;
    return start(id, next!.message);
  };
  const server = createServer((req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    void (async () => {
      const actualPort = new URL(origin).port;
      const suffix = actualPort ? `:${actualPort}` : '';
      const hosts = new Set([`127.0.0.1${suffix}`, `localhost${suffix}`]);
      if (!req.headers.host || !hosts.has(req.headers.host)) fail(403, 'host_denied', 'Host must match the local server');
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) fail(403, 'origin_denied', 'Cross-origin requests are not allowed');
      const path = new URL(req.url ?? '/', origin).pathname;
      if (!path.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') fail(405, 'method_not_allowed', 'Use GET');
        const asset = Object.hasOwn(assets, path) ? assets[path]! : undefined;
        if (!asset) return fail(404, 'not_found', 'Not found');
        let content: Buffer;
        try { content = await readFile(asset[0]); } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'ENOENT') return fail(404, 'asset_missing', 'Web assets are missing');
          throw e;
        }
        res.writeHead(200, { 'Content-Type': asset[1], 'Cache-Control': 'no-cache' });
        res.end(req.method === 'HEAD' ? undefined : content); return;
      }
      const supplied = req.headers.authorization ?? '', expected = `Bearer ${token}`;
      if (Buffer.byteLength(supplied) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) fail(401, 'unauthorized', 'A server access token is required');
      if (stopping) fail(503, 'stopping', 'Server is shutting down');
      if (req.method === 'GET' && path === '/api/v1/info') { json(res, 200, info); return; }
      if (path === '/api/v1/settings') {
        if (req.method === 'GET') { json(res, 200, settings()); return; }
        if (req.method === 'POST') {
          const input = await body(req); fields(input, ['requestTimeoutMs', 'turnTimeoutMs']);
          if (typeof input.requestTimeoutMs !== 'number' || typeof input.turnTimeoutMs !== 'number') fail(400, 'invalid_settings', '请提供两个时限数值（毫秒）。');
          let next: Config;
          try { next = validateConfig({ ...config, ...input }); }
          catch { return fail(400, 'invalid_settings', '单次模型请求需在 1 毫秒～10 分钟之间，整轮任务需在 1 毫秒～3 小时之间。'); }
          const limits = { requestTimeoutMs: next.requestTimeoutMs, turnTimeoutMs: next.turnTimeoutMs };
          saveTimeoutEnv(options.envFile ?? join(workspace, '.env'), limits);
          Object.assign(config, limits); Object.assign(info, limits);
          json(res, 200, limits); return;
        }
      }
      if (path === '/api/v1/sessions') {
        if (req.method === 'GET') {
          const sessions = listSessions(home).filter((item: any) => item.workspace === workspace && item.provider === providerName).map((item: any) => summary(item.id, recordsFor(item.id))).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
          json(res, 200, { sessions }); return;
        }
        if (req.method === 'POST') {
          fields(await body(req), []);
          const id = randomUUID();
          const store = SessionStore.open(home, { id, workspace, provider: providerName }); store.close();
          json(res, 201, { session: summary(id, recordsFor(id)) }); return;
        }
      }
      const match = /^\/api\/v1\/sessions\/([^/]+)(?:\/(.*))?$/.exec(path);
      if (!match) return fail(404, 'not_found', 'Unknown API endpoint');
      const id = match[1]!, tail = match[2];
      recordsFor(id);
      if (req.method === 'GET' && tail === undefined) { json(res, 200, snapshot(id)); return; }
      if (req.method === 'GET' && tail === 'events') {
        const first = snapshot(id);
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        frame(res, { type: 'snapshot', snapshot: first });
        let clients = listeners.get(id);
        if (!clients) { clients = new Set(); listeners.set(id, clients); }
        clients.add(res);
        const heartbeat = setInterval(() => { if (res.destroyed || res.writableEnded) return; if (res.writableLength > 1_000_000) res.destroy(); else res.write(': heartbeat\n\n'); }, 15_000);
        heartbeat.unref();
        res.on('close', () => { clearInterval(heartbeat); clients.delete(res); if (!clients.size) listeners.delete(id); });
        return;
      }
      if (req.method === 'POST' && tail === 'turns') {
        const input = await body(req); fields(input, ['message']);
        json(res, 202, { turn: start(id, messageText(input.message)) }); return;
      }
      if (req.method === 'POST' && tail === 'inputs') {
        const input = await body(req); fields(input, ['turnId', 'kind', 'message']);
        const message = messageText(input.message), kind = input.kind;
        if (kind !== 'steer' && kind !== 'follow_up') return fail(400, 'invalid_input_kind', 'Use steer or follow_up');
        const state = live.get(id);
        if (!state || state.turn.id !== input.turnId || state.turn.status !== 'running' || state.controller.signal.aborted) {
          return fail(409, 'stale_turn', '该回合已结束或正在停止，请检查当前回合后再发送。');
        }
        if (state.inputs.length >= QUEUE_LIMIT) return fail(409, 'queue_full', '待发队列最多保留 16 条消息。');
        const item: PendingInput = { id: randomUUID(), turnId: state.turn.id, kind, message };
        state.inputs.push(item);
        publishState(id, state);
        json(res, 202, { input: item }); return;
      }
      if (req.method === 'POST' && tail === 'inputs/resume') {
        fields(await body(req), []);
        if (active) return fail(409, 'turn_busy', '有任务正在执行，请等待该回合结束。');
        const state = live.get(id);
        const turn = state && startFollowUp(id, state);
        if (!turn) return fail(409, 'empty_queue', '没有待执行的后续任务。');
        json(res, 202, { turn }); return;
      }
      const removal = /^inputs\/([^/]+)\/remove$/.exec(tail ?? '');
      if (req.method === 'POST' && removal) {
        fields(await body(req), []);
        const state = live.get(id);
        const index = state?.inputs.findIndex(item => item.id === removal[1]) ?? -1;
        if (!state || index === -1) return fail(409, 'stale_input', '这条消息已送出或已移除。');
        state.inputs.splice(index, 1);
        if (!state.inputs.some(item => item.kind === 'follow_up')) state.followUpsPaused = false;
        publishState(id, state);
        json(res, 200, { ok: true }); return;
      }
      const cancellation = /^turns\/([^/]+)\/cancel$/.exec(tail ?? '');
      if (req.method === 'POST' && cancellation) {
        fields(await body(req), []);
        const state = live.get(id);
        if (!state || state.turn.id !== cancellation[1] || state.turn.status !== 'running') return fail(409, 'stale_turn', 'Turn is no longer running');
        state.controller.abort(new Error('Cancelled by client')); json(res, 200, { ok: true }); return;
      }
      const approval = /^approvals\/([^/]+)$/.exec(tail ?? '');
      if (req.method === 'POST' && approval) {
        const input = await body(req); fields(input, ['approved']);
        if (typeof input.approved !== 'boolean') return fail(400, 'invalid_approval', 'approved must be a boolean');
        const waiter = live.get(id)?.approvals.get(approval[1]!);
        if (!waiter) return fail(409, 'stale_approval', 'Approval was already handled or cancelled');
        waiter.settle(input.approved); json(res, 200, { ok: true }); return;
      }
      fail(404, 'not_found', 'Unknown API endpoint or method');
    })().catch(error => {
      if (res.headersSent) { res.destroy(); return; }
      const status = error instanceof HttpError ? error.status : 500;
      const value: ApiError = { error: { code: error instanceof HttpError ? error.code : 'server_error', message: error instanceof HttpError ? error.message : errorText(error) } };
      json(res, status, value);
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolveListening, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolveListening(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not determine server address');
  origin = `http://127.0.0.1:${address.port}`;
  let closing: Promise<void> | undefined;
  return { url: origin, token, close() {
    return closing ??= (async () => {
      stopping = true;
      for (const state of live.values()) if (state.turn.status === 'running') state.controller.abort(new Error('Server is shutting down'));
      await Promise.all([...live.values()].map(state => state.done));
      for (const clients of listeners.values()) for (const res of clients) res.end();
      await new Promise<void>((resolveClosed, reject) => { server.close(error => error ? reject(error) : resolveClosed()); server.closeAllConnections(); });
    })();
  } };
}
