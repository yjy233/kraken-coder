import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { Emit } from '../core/types.js';
import { errorText, object } from '../core/validation.js';
import type { LocalPlugin } from './catalog.js';
import { expandMcpInput, mcpHookText, type PrepareMcpHook } from './mcp-hook.js';

const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Stop', 'Interrupt',
  'PreModelRequest', 'PostModelRequest', 'PreCompact', 'PostCompact'] as const;
export type HookEvent = typeof events[number];
type Handler = {
  event: HookEvent; source: string; root?: string;
  matches(value: string): boolean;
  timeoutMs: number; background: boolean;
} & ({ type: 'command'; command: string } | { type: 'mcp_tool'; server: string; tool: string; input: Record<string, unknown> });
type HookResult = { code: number | null; stdout: string; stderr: string };
type Action = { preview: string; run(signal: AbortSignal): Promise<HookResult> };
export interface HookOutcome {
  block?: string;
  context?: string;
  updatedInput?: Record<string, unknown>;
  ask?: boolean;
}
interface HookSession {
  cwd: string; session_id: string; transcript_path: string; turn_id: string; model: string; permission_mode: string;
}
type Authorize = (preview: string, signal: AbortSignal) => Promise<boolean>;

function matcher(pattern: unknown): (value: string) => boolean {
  if (pattern === undefined || pattern === '' || pattern === '*') return () => true;
  if (typeof pattern !== 'string' || pattern.length > 256) throw new Error('Invalid hook matcher');
  if (/^[a-zA-Z0-9_|]+$/.test(pattern)) {
    const names = new Set(pattern.split('|'));
    return value => names.has(value);
  }
  let regex: RegExp;
  try { regex = new RegExp(pattern); } catch { throw new Error('Invalid regular expression in hook matcher'); }
  return value => regex.test(value);
}

function parseHandler(raw: unknown, event: HookEvent, source: string, root: string | undefined, matches: Handler['matches']): Handler {
  const hook = object(raw);
  if (hook.async !== undefined && typeof hook.async !== 'boolean') throw new Error('Hook async must be a boolean');
  const timeout = hook.timeout ?? 30;
  if (typeof timeout !== 'number' || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120) throw new Error('Hook timeout must be 1–120 seconds');
  const common = { event, matches, timeoutMs: timeout * 1000, root, source, background: hook.async === true };
  if (hook.type === 'command') {
    if (typeof hook.command !== 'string' || !hook.command.trim() || hook.command.length > 8_000) throw new Error('Invalid hook command');
    return { ...common, type: 'command', command: hook.command };
  }
  if (hook.type === 'mcp_tool') {
    if (common.background || typeof hook.server !== 'string' || !hook.server || typeof hook.tool !== 'string' || !hook.tool) throw new Error('Invalid mcp_tool hook');
    return { ...common, type: 'mcp_tool', server: hook.server, tool: hook.tool, input: object(hook.input ?? {}) };
  }
  throw new Error('Unsupported hook handler type');
}

function parseFile(file: Record<string, unknown>, source: string, root: string | undefined, out: Handler[], warn: (message: string) => void) {
  for (const [name, entries] of Object.entries(object(file.hooks))) {
    if (!events.includes(name as HookEvent)) { warn(`${source}: unsupported hook event ${name}`); continue; }
    const diagnostic = (error: unknown) => warn(`${source} / ${name}: ${errorText(error)}`);
    if (!Array.isArray(entries)) { diagnostic('Expected hook groups'); continue; }
    for (const entry of entries) {
      try {
        const group = object(entry);
        const matches = matcher(group.matcher);
        if (!Array.isArray(group.hooks)) throw new Error('Expected hooks array');
        for (const raw of group.hooks) {
          if (out.length >= 128) { diagnostic('Too many hook handlers (max 128)'); return; }
          try { out.push(parseHandler(raw, name as HookEvent, source, root, matches)); }
          catch (error) { diagnostic(error); }
        }
      } catch (error) { diagnostic(error); }
    }
  }
}

async function commandHook(handler: Extract<Handler, {type: 'command'}>, cwd: string, input: string, signal: AbortSignal) {
  signal.throwIfAborted();
  if (process.platform === 'win32') throw new Error('Command hooks require macOS or Linux');
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['HOME', 'PATH', 'USER', 'TMPDIR', 'LANG', 'LC_ALL']) if (process.env[key]) env[key] = process.env[key];
  if (handler.root) env.PLUGIN_ROOT = env.CLAUDE_PLUGIN_ROOT = env.CODEX_PLUGIN_ROOT = handler.root;
  return await new Promise<{code: number | null; stdout: string; stderr: string}>((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', handler.command], { cwd, env, detached: true, stdio: 'pipe' });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let bytes = 0, failure = '';
    function kill() {
      if (child.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ }
    }
    function collect(chunks: Buffer[], chunk: Buffer) {
      bytes += chunk.byteLength;
      if (bytes <= 64 * 1024) chunks.push(chunk);
      else { failure = 'Hook output exceeded 64 KiB'; kill(); }
    }
    const timer = setTimeout(() => { failure = 'Hook timed out'; kill(); }, handler.timeoutMs);
    signal.addEventListener('abort', kill, { once: true });
    child.stdout.on('data', (b: Buffer) => collect(stdout, b));
    child.stderr.on('data', (b: Buffer) => collect(stderr, b));
    child.stdin.on('error', () => { /* a hook may exit without reading stdin */ });
    child.on('error', err => { failure = err.message; });
    child.once('close', code => {
      clearTimeout(timer);
      signal.removeEventListener('abort', kill);
      if (signal.aborted) reject(signal.reason);
      else if (failure) reject(new Error(failure));
      else resolve({ code, stdout: Buffer.concat(stdout).toString('utf8').trim(), stderr: Buffer.concat(stderr).toString('utf8').trim() });
    });
    if (signal.aborted) kill();
    child.stdin.end(input + '\n');
  });
}

function interpret(event: HookEvent, stdout: string): HookOutcome {
  const hasTextContext = event === 'SessionStart' || event === 'UserPromptSubmit';
  if (!stdout.startsWith('{')) return hasTextContext && stdout ? { context: stdout } : {};
  const out = object(JSON.parse(stdout));
  const details = out.hookSpecificOutput === undefined ? {} : object(out.hookSpecificOutput);
  if (details.hookEventName !== undefined && details.hookEventName !== event) throw new Error('Hook output targets another event');
  const result: HookOutcome = {};
  if (typeof details.additionalContext === 'string') result.context = details.additionalContext;
  if (event === 'PermissionRequest' && details.decision !== undefined) {
    const decision = object(details.decision);
    if (decision.behavior === 'deny') result.block = String(decision.message || 'Permission request denied by hook');
  }
  if (out.continue === false) {
    // For Stop, continue:false accepts the stop, even if a block is also present.
    if (event !== 'Stop') result.block = String(out.stopReason || 'Hook stopped processing');
    return result;
  }
  if (out.decision === 'block' || details.permissionDecision === 'deny') {
    result.block = String(details.permissionDecisionReason || out.reason || 'Blocked by hook');
  } else if (event === 'PreToolUse') {
    result.ask = details.permissionDecision === 'ask';
    if (details.updatedInput !== undefined) result.updatedInput = object(details.updatedInput);
  }
  return result;
}

export class HookRunner {
  private readonly shutdown = new AbortController();
  private readonly pending = new Set<Promise<void>>();
  constructor(private handlers: Handler[], private session: HookSession, private authorize: Authorize, private emit: Emit, private prepareMcp?: PrepareMcpHook) {}
  handles(event: HookEvent) { return this.handlers.some(handler => handler.event === event); }
  async close(): Promise<void> {
    this.shutdown.abort();
    await Promise.allSettled(this.pending);
  }
  private action(handler: Handler, payload: Record<string, unknown>): Action {
    if (handler.type === 'command') {
      const root = handler.root ? `\nPLUGIN_ROOT: ${handler.root}` : '';
      return { preview: `cwd: ${this.session.cwd}${root}\n$ ${handler.command}`,
        run: signal => commandHook(handler, this.session.cwd, JSON.stringify(payload), signal) };
    }
    if (!this.prepareMcp) throw new Error('MCP hook executor is unavailable');
    const args = expandMcpInput(handler.input, payload);
    const prepared = this.prepareMcp(handler.root ? handler.source : undefined, handler.server, handler.tool, args);
    return { preview: prepared.preview, run: async signal => {
      const active = AbortSignal.any([signal, AbortSignal.timeout(handler.timeoutMs)]);
      const result = await prepared.run(active);
      return { code: 0, stdout: mcpHookText(result), stderr: '' };
    } };
  }
  private background(handler: Handler, action: Action, signal: AbortSignal): void {
    const active = AbortSignal.any([signal, this.shutdown.signal]);
    const event = handler.event, source = handler.source;
    const job = action.run(active).then(result => {
      this.emit({ type: 'hook.end', event, source, status: result.code === 0 ? 'ok' : 'error', exitCode: result.code });
    }, error => {
      this.emit({ type: 'hook.end', event, source, status: active.aborted ? 'cancelled' : 'error', message: errorText(error) });
    }).finally(() => this.pending.delete(job));
    this.pending.add(job);
  }

  async run(event: HookEvent, fields: Record<string, unknown>, signal: AbortSignal, aliases: string[] = []): Promise<HookOutcome> {
    const matchValues = [String(fields.tool_name ?? fields.source ?? fields.trigger ?? ''), ...aliases];
    const joined: HookOutcome = {};
    const modelRequest = event === 'PreModelRequest' || event === 'PostModelRequest';
    const observer = modelRequest || event === 'Interrupt';
    const compact = event === 'PreCompact' || event === 'PostCompact';
    const { turn_id, permission_mode, ...common } = this.session;
    const payload = { ...common, ...(event === 'SessionStart' ? {} : {turn_id}),
      ...(modelRequest || compact ? {} : {permission_mode}), ...fields, hook_event_name: event };
    for (const handler of this.handlers) {
      if (handler.event !== event || (!observer && !matchValues.some(handler.matches))) continue;
      signal.throwIfAborted();
      if (handler.background && this.pending.size >= 4) {
        this.emit({ type: 'hook.end', event, source: handler.source, status: 'skipped', message: 'Four background hooks are already running' });
        continue;
      }
      const label = `${handler.source} / ${event}`;
      let action: Action;
      try { action = this.action(handler, payload); }
      catch (error) {
        this.emit({ type: 'hook.end', event, source: handler.source, status: 'error', message: errorText(error) });
        continue;
      }
      let allowed: boolean;
      try { allowed = await this.authorize(label + '\n' + action.preview, signal); }
      catch (error) {
        signal.throwIfAborted();
        this.emit({ type: 'hook.end', event, source: handler.source, status: 'denied', message: errorText(error) });
        if (!handler.background && (event === 'PreToolUse' || event === 'UserPromptSubmit' || event === 'PostToolUse')) {
          return { block: `Approval denied for ${label}` };
        }
        continue;
      }
      if (!allowed) {
        this.emit({ type: 'hook.end', event, source: handler.source, status: 'skipped' });
        continue;
      }
      this.emit({ type: 'hook.start', event, source: handler.source });
      try {
        if (handler.background) { this.background(handler, action, signal); continue; }
        const result = await action.run(signal);
        let outcome: HookOutcome;
        if (result.code === 2 && !observer && !compact && event !== 'SessionStart' && result.stderr) outcome = { block: result.stderr };
        else if (result.code !== 0) throw new Error(`Hook exited with code ${result.code}: ${result.stderr.slice(0, 1000)}`);
        else if (observer) outcome = {};
        else if (compact) {
          const out = result.stdout.startsWith('{') ? object(JSON.parse(result.stdout)) : {};
          outcome = out.continue === false ? { block: String(out.stopReason || 'Hook stopped compaction') } : {};
        } else outcome = interpret(event, result.stdout);
        if (outcome.context) joined.context = [joined.context, outcome.context].filter(Boolean).join('\n').slice(0, 8_000);
        if (outcome.ask) joined.ask = true;
        if (outcome.updatedInput) joined.updatedInput = outcome.updatedInput;
        if (outcome.block) joined.block = outcome.block.slice(0, 3_000);
        this.emit({ type: 'hook.end', event, source: handler.source, status: joined.block ? 'blocked' : 'ok' });
        if (joined.block) break;
      } catch (error) {
        if (signal.aborted) this.emit({ type: 'hook.end', event, source: handler.source, status: 'cancelled' });
        signal.throwIfAborted();
        this.emit({ type: 'hook.end', event, source: handler.source, status: 'error', message: errorText(error) });
      }
    }
    return joined;
  }
}

async function loadHooks(plugins: readonly LocalPlugin[], files: readonly string[]) {
  const handlers: Handler[] = [], diagnostics: string[] = [];
  const warn = (message: string) => { diagnostics.push(message); };
  for (const plugin of plugins) {
    for (const file of plugin.hooks) {
      try { parseFile(file, plugin.name, plugin.root, handlers, warn); }
      catch (error) { warn(`${plugin.name}: ${errorText(error)}`); }
    }
  }
  for (const path of files) {
    try {
      if (!isAbsolute(path)) throw new Error('Hook file path must be absolute');
      const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await fd.stat();
        if (!stat.isFile() || stat.size > 256 * 1024) throw new Error('Expected a hook configuration file under 256 KiB');
        const contents = await fd.readFile('utf8');
        let file: Record<string, unknown>;
        try { file = object(JSON.parse(contents)); } catch { throw new Error('Invalid hook configuration JSON'); }
        parseFile(file, path, undefined, handlers, warn);
      } finally { await fd.close(); }
    } catch (error) { warn(`${path}: ${errorText(error)}`); }
  }
  return { handlers, diagnostics };
}

export async function inspectHooks(plugins: readonly LocalPlugin[], files: readonly string[] = []) {
  const { handlers, diagnostics } = await loadHooks(plugins, files);
  return { hooks: handlers.map(({ source, event, type, background }) => ({ source, event, type, background })), diagnostics };
}

export async function createHookRunner(plugins: LocalPlugin[], files: readonly string[], session: HookSession, authorize: Authorize, emit: Emit, prepareMcp?: PrepareMcpHook) {
  const { handlers, diagnostics } = await loadHooks(plugins, files);
  for (const message of diagnostics) emit({ type: 'extension.warning', message });
  return new HookRunner(handlers, session, authorize, emit, prepareMcp);
}
