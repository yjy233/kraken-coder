import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { runTurn, createProvider } from '../core/agent.js';
import { saveModelSelection, saveRuntimeEnv, validateConfig, type Config, type RuntimeSettings } from '../config.js';
import { apiKeyForConfig, isModelProvider, isValidProfileKey, modelConfig, modelProfiles, profileApiKey, profileForBaseUrl, rememberedModel, type ModelProvider } from '../providers/profiles.js';
import { listChatModels } from '../providers/models.js';
import { resolveContextBudget } from '../context/budget.js';
import { errorText } from '../core/validation.js';
import type { Event, Message, Provider } from '../core/types.js';
import { Workspace } from '../tools/workspace.js';
import { extensionInventory } from '../extensions/inventory.js';
import type { ApprovalDecision, Approve } from '../tools/registry.js';
import { listSessions, readSession, SessionStore, sessionId, sessionProvidersMatch, type RecordLine } from '../session/store.js';
import type { ApiError, ModelSelection, PendingApproval, PendingInput, ServerFrame, ServerInfo, ServerSettings, SessionSnapshot, SessionSummary, TurnState } from './protocol.js';

export interface AgentServerOptions {
  config: Config;
  workspace: string;
  home: string;
  allowShell?: boolean;
  provider?: Provider;
  port?: number;
  webRoot?: string;
  /** Pending inputs handed over by a stopped server. Never starts a turn on boot. */
  pausedQueues?: Pick<SessionSnapshot, 'session' | 'inputs'>[];
  /** File used by the CLI at startup for runtime settings. */
  envFile?: string;
}
export interface AgentServer {
  /** Loopback HTTP origin for both Web and local API clients. */
  url: string;
  close(): Promise<void>;
}
class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
interface ApprovalWaiter { approval: PendingApproval; settle(decision: ApprovalDecision): void }
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
    ...(m.role === 'user' && m.hookFeedback ? { hookFeedback: true } : {}),
    ...(m.role === 'assistant' && m.reasoningContent?.trim() ? { reasoningContent: m.reasoningContent } : {}),
    ...(m.toolCalls ? { toolCalls: m.toolCalls } : {}), ...(m.toolCallId ? { toolCallId: m.toolCallId } : {}) } };
}
function summary(id: string, records: RecordLine[]): SessionSummary {
  const first = records.find(r => r.event.type === 'turn.input' || (r.event.type === 'message' && (r.event.message as Message).role === 'user'))?.event;
  const input = first?.type === 'turn.input' ? String(first.content) : (first?.message as Message | undefined)?.content;
  return { id, title: input?.replace(/\s+/g, ' ').slice(0, 72) || '新会话', updatedAt: records.at(-1)?.time ?? new Date().toISOString() };
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
  let config = validateConfig({ ...options.config });
  const workspace = (await Workspace.open(options.workspace)).root, home = resolve(options.home);
  const port = options.port ?? 4317;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('port must be between 0 and 65535');
  let providerOverride = options.provider;
  let providerName = (providerOverride ?? createProvider(config, () => {})).name;
  const activeProfile = () => config.provider === 'compatible' && !providerOverride ? profileForBaseUrl(config.baseUrl) : undefined;
  const selectedKey = (id: ModelProvider) => profileApiKey(id) ?? (id === activeProfile() ? apiKeyForConfig(config) : undefined);
  const modelSelection = async (forCatalog?: ModelProvider, previewKey?: string): Promise<ModelSelection> => {
    const activeId = activeProfile();
    const view: ModelSelection = { active: { provider: activeId ?? null, model: config.provider === 'demo' ? '' : config.model },
      providers: (Object.keys(modelProfiles) as ModelProvider[]).map(id => ({ id, label: modelProfiles[id].label,
        configured: !!selectedKey(id), model: id === activeId ? config.model : rememberedModel(id) })), models: [] };
    if (!forCatalog) return view;
    const key = previewKey ?? selectedKey(forCatalog);
    if (forCatalog === 'volcengine' && !key) {
      view.catalogError = '输入火山方舟 API Key 后可以获取模型列表。';
      return view;
    }
    try {
      view.models = await listChatModels(modelProfiles[forCatalog].baseUrl, key);
    } catch (error) {
      // Upstream response bodies and fetch errors can reference private request data.
      const status = /^Provider HTTP (\d{3})$/.exec(errorText(error))?.[1];
      view.catalogError = `获取模型列表失败${status ? `（HTTP ${status}）` : ''}，可重试或手动填写模型 ID。`;
    }
    return view;
  };
  const info = (): ServerInfo => ({
    version: 1, workspace, provider: config.provider, modelProvider: activeProfile(), model: config.provider === 'demo' ? '' : config.model,
    mode: config.mode, approval: config.approval, shellEnabled: options.allowShell === true,
    requestTimeoutMs: config.requestTimeoutMs, turnTimeoutMs: config.turnTimeoutMs,
  });
  const runtimeSettings = async (): Promise<ServerSettings> => {
    // Snapshot before awaiting discovery so the reported threshold matches the ratio.
    const current = { ...config };
    return { approval: current.approval, requestTimeoutMs: current.requestTimeoutMs, turnTimeoutMs: current.turnTimeoutMs,
      contextWindowTokens: current.contextWindowTokens, contextCompactRatio: current.contextCompactRatio,
      contextBudget: await resolveContextBudget(current, providerOverride === undefined) };
  };
  const live = new Map<string, LiveSession>();
  const listeners = new Map<string, Set<ServerResponse>>();
  let active: string | undefined, stopping = false, origin = '';
  const webRoot = options.webRoot ?? fileURLToPath(new URL('../../web/', import.meta.url));
  const assets: Record<string, [string, string]> = {
    '/': [join(webRoot, 'index.html'), 'text/html; charset=utf-8'],
    '/index.html': [join(webRoot, 'index.html'), 'text/html; charset=utf-8'],
    '/app.js': [join(webRoot, 'app.js'), 'text/javascript; charset=utf-8'],
    '/styles.css': [join(webRoot, 'styles.css'), 'text/css; charset=utf-8'],
    '/conversation.css': [join(webRoot, 'conversation.css'), 'text/css; charset=utf-8'],
    '/kraken-avatar.jpg': [join(webRoot, 'kraken-avatar.jpg'), 'image/jpeg'],
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
    if (!meta || meta.type !== 'session.created' || meta.workspace !== workspace || !sessionProvidersMatch(meta.provider, providerName)) fail(409, 'session_mismatch', 'Session belongs to a different workspace/provider/model');
    return records;
  };
  const pending = (state?: LiveSession): PendingApproval[] => [...(state?.approvals.values() ?? [])].map(item => item.approval);
  for (const { session, inputs } of options.pausedQueues ?? []) {
    const records = recordsFor(session.id), turn = previousTurn(records);
    if (!turn || records.at(-1)?.time !== session.updatedAt || live.has(session.id)) {
      throw new Error('Paused queue does not match the latest session snapshot');
    }
    live.set(session.id, { turn, controller: new AbortController(), approvals: new Map(),
      inputs: structuredClone(inputs), followUpsPaused: true });
  }
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
  const requestApproval = (id: string, state: LiveSession): Approve => (request, signal) => new Promise<ApprovalDecision>((resolveApproval, reject) => {
    signal.throwIfAborted();
    const approval: PendingApproval = { id: randomUUID(), turnId: state.turn.id, ...request };
    const finish = (decision: ApprovalDecision, aborted = false): void => {
      if (!state.approvals.delete(approval.id)) return;
      signal.removeEventListener('abort', abort);
      publishState(id, state);
      if (aborted) reject(signal.reason); else resolveApproval(decision);
    };
    const abort = (): void => finish(false, true);
    state.approvals.set(approval.id, { approval, settle: decision => finish(decision) });
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
        await runTurn({ config: { ...config }, workspace, home, session: id, allowShell: options.allowShell, provider: providerOverride, emit, approve: requestApproval(id, state), takeSteering }, message, state.controller.signal);
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
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    void (async () => {
      const actualPort = new URL(origin).port;
      const suffix = actualPort ? `:${actualPort}` : '';
      const hosts = new Set([`127.0.0.1${suffix}`, `localhost${suffix}`]);
      if (!req.headers.host || !hosts.has(req.headers.host)) fail(403, 'host_denied', 'Host must match the local server');
      if (req.headers.origin !== undefined && req.headers.origin !== `http://${req.headers.host}`) fail(403, 'origin_denied', 'Cross-origin requests are not allowed');
      const url = new URL(req.url ?? '/', origin), path = url.pathname;
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
      // Browser subresource requests may omit Origin. Another localhost port is also a separate origin.
      const site = req.headers['sec-fetch-site'];
      if (site !== undefined && site !== 'same-origin' && site !== 'none') fail(403, 'origin_denied', 'Cross-origin requests are not allowed');
      if (stopping) fail(503, 'stopping', 'Server is shutting down');
      if (req.method === 'GET' && path === '/api/v1/info') { json(res, 200, info()); return; }
      if (req.method === 'GET' && path === '/api/v1/extensions') { json(res, 200, await extensionInventory(workspace, config)); return; }
      if (path === '/api/v1/model-selection' && req.method === 'GET') {
        const id = url.searchParams.get('provider');
        if (id !== null && !isModelProvider(id)) return fail(400, 'invalid_provider', '请选择火山方舟或 OpenRouter。');
        json(res, 200, await modelSelection(id ?? undefined)); return;
      }
      if (req.method === 'POST' && (path === '/api/v1/model-selection' || path === '/api/v1/model-selection/catalog')) {
        const preview = path.endsWith('/catalog');
        const input = await body(req);
        fields(input, preview ? ['provider', 'apiKey'] : ['provider', 'model', 'apiKey']);
        const { provider, model, apiKey } = input;
        if (!isModelProvider(provider)) return fail(400, 'invalid_provider', '请选择火山方舟或 OpenRouter。');
        if (apiKey !== undefined && !isValidProfileKey(apiKey)) return fail(400, 'invalid_key', '请检查 API Key 格式。');
        if (preview) { json(res, 200, await modelSelection(provider, apiKey)); return; }
        if (typeof model !== 'string') return fail(400, 'invalid_model', '请填写模型 ID。');
        let next: Config;
        try { next = modelConfig(config, provider, model); }
        catch { return fail(400, 'invalid_model', '请检查模型 ID。'); }
        if (!(apiKey ?? selectedKey(provider))) return fail(400, 'missing_key', '请先为该平台配置 API Key。');
        // Incompatible saved threads become hidden after the switch. Keep their active work reachable.
        if (!activeProfile() && (active || [...live.values()].some(session => session.inputs.length))) {
          return fail(409, 'turn_busy', '请先结束当前任务并处理待发消息，再切换服务商。');
        }
        saveModelSelection(options.envFile ?? join(workspace, '.env'), provider, model, apiKey, config);
        config = next;
        providerOverride = undefined;
        providerName = createProvider(config, () => {}).name;
        json(res, 200, await modelSelection()); return;
      }
      if (path === '/api/v1/settings') {
        if (req.method === 'GET') { json(res, 200, await runtimeSettings()); return; }
        if (req.method === 'POST') {
          const input = await body(req);
          fields(input, ['approval', 'requestTimeoutMs', 'turnTimeoutMs', 'contextWindowTokens', 'contextCompactRatio']);
          if (!Object.keys(input).length) fail(400, 'invalid_settings', '请提供要修改的设置。');
          if (('requestTimeoutMs' in input || 'turnTimeoutMs' in input)
            && (typeof input.requestTimeoutMs !== 'number' || typeof input.turnTimeoutMs !== 'number')) fail(400, 'invalid_settings', '请提供两个时限数值（毫秒）。');
          if ((input.contextWindowTokens !== undefined && input.contextWindowTokens !== null && typeof input.contextWindowTokens !== 'number')
            || (input.contextCompactRatio !== undefined && typeof input.contextCompactRatio !== 'number')) {
            return fail(400, 'invalid_settings', '请检查模型窗口和上下文压缩比例。');
          }
          let next: Config;
          try { next = validateConfig({ ...config, ...input }); }
          catch (error) { return fail(400, 'invalid_settings', errorText(error)); }
          const changes: Partial<RuntimeSettings> = {};
          if (input.requestTimeoutMs !== undefined) {
            changes.requestTimeoutMs = next.requestTimeoutMs;
            changes.turnTimeoutMs = next.turnTimeoutMs;
          }
          if (input.approval !== undefined) changes.approval = next.approval;
          if (input.contextWindowTokens !== undefined) changes.contextWindowTokens = next.contextWindowTokens;
          if (input.contextCompactRatio !== undefined) changes.contextCompactRatio = next.contextCompactRatio;
          saveRuntimeEnv(options.envFile ?? join(workspace, '.env'), changes);
          Object.assign(config, changes);
          json(res, 200, await runtimeSettings()); return;
        }
      }
      if (path === '/api/v1/sessions') {
        if (req.method === 'GET') {
          const sessions = listSessions(home).filter((item: any) => item.workspace === workspace && sessionProvidersMatch(item.provider, providerName)).map((item: any) => summary(item.id, recordsFor(item.id))).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
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
      // A model switch can occur while a POST body is arriving. Check turn admission
      // after the body has been read, against the selection used to start that turn.
      if (req.method !== 'POST' || tail !== 'turns') recordsFor(id);
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
        recordsFor(id);
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
        const input = await body(req); fields(input, ['approved', 'remember']);
        if (typeof input.approved !== 'boolean') return fail(400, 'invalid_approval', 'approved must be a boolean');
        if (input.remember !== undefined && typeof input.remember !== 'boolean') return fail(400, 'invalid_approval', 'remember must be a boolean');
        const waiter = live.get(id)?.approvals.get(approval[1]!);
        if (!waiter) return fail(409, 'stale_approval', 'Approval was already handled or cancelled');
        if (input.remember && (!input.approved || !waiter.approval.commandPrefix)) return fail(400, 'invalid_approval', 'Only an approved command with an offered prefix can be remembered');
        waiter.settle(input.remember ? 'remember' : input.approved); json(res, 200, { ok: true }); return;
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
  return { url: origin, close() {
    return closing ??= (async () => {
      stopping = true;
      for (const state of live.values()) if (state.turn.status === 'running') state.controller.abort(new Error('Server is shutting down'));
      await Promise.all([...live.values()].map(state => state.done));
      for (const clients of listeners.values()) for (const res of clients) res.end();
      await new Promise<void>((resolveClosed, reject) => { server.close(error => error ? reject(error) : resolveClosed()); server.closeAllConnections(); });
    })();
  } };
}
