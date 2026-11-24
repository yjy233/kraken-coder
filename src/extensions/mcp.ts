// Local plugin MCP tools over the newline-delimited JSON-RPC stdio transport.
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import type { Emit } from '../core/types.js';
import { errorText, object } from '../core/validation.js';
import { params, str, type Prepared, type ToolRegistry } from '../tools/registry.js';

type Plugin = { name: string; root: string; mcpServers: Record<string, unknown> };
type JsonObject = Record<string, unknown>;
const versions = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const safeEnvironment = ['PATH', 'HOME', 'USER', 'TMPDIR', 'LANG', 'LC_ALL'];
const maxFrame = 1_048_576;

function strings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every(s => typeof s === 'string' && !s.includes('\0'))) {
    throw new Error(`MCP ${field} must be an array of strings`);
  }
  return value;
}

function timeout(value: unknown, fallbackSeconds: number): number {
  if (value === undefined) return fallbackSeconds * 1000;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error('MCP timeout must be a positive number of seconds');
  }
  return Math.max(1, Math.ceil(Math.min(value, 120) * 1000));
}

function serverConfig(plugin: Plugin, input: JsonObject) {
  if (input.url !== undefined || (input.type !== undefined && input.type !== 'stdio')) {
    throw new Error('Only local stdio MCP servers are supported');
  }
  if (typeof input.command !== 'string' || !input.command.trim() || input.command.includes('\0')) {
    throw new Error('MCP command must be a nonempty executable name');
  }
  if (input.cwd !== undefined && typeof input.cwd !== 'string') throw new Error('Invalid MCP cwd');
  const expand = (value: string) => value.replace(/\$\{(?:CODEX_PLUGIN_ROOT|CLAUDE_PLUGIN_ROOT|PLUGIN_ROOT)\}/g, () => plugin.root);
  const env: NodeJS.ProcessEnv = Object.create(null);
  for (const name of safeEnvironment) if (process.env[name] !== undefined) env[name] = process.env[name];
  if (input.env_vars !== undefined && strings(input.env_vars, 'env_vars').some(name => !safeEnvironment.includes(name))) {
    throw new Error('Forwarding additional host environment variables is unsupported');
  }
  for (const [key, value] of Object.entries(object(input.env ?? {}))) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || value.includes('\0')) throw new Error('Invalid MCP env entry');
    env[key] = expand(value);
  }
  env.CODEX_PLUGIN_ROOT = plugin.root;
  env.CLAUDE_PLUGIN_ROOT = plugin.root;
  env.PLUGIN_ROOT = plugin.root;
  const allowed = input.enabled_tools === undefined ? undefined : new Set(strings(input.enabled_tools, 'enabled_tools'));
  const denied = new Set(strings(input.disabled_tools ?? [], 'disabled_tools'));
  return {
    command: expand(input.command), args: strings(input.args ?? [], 'args').map(expand),
    cwd: resolve(plugin.root, expand(input.cwd ?? '.')), env,
    startupMs: timeout(input.startup_timeout_sec, 10), toolMs: timeout(input.tool_timeout_sec, 60),
    allows: (tool: string) => !denied.has(tool) && (allowed === undefined || allowed.has(tool)),
  };
}
type Server = ReturnType<typeof serverConfig>;

class StdioClient {
  private child;
  private nextId = 1;
  private pending = new Map<number, { resolve(value: JsonObject): void; reject(error: Error): void }>();
  private closed = false;
  private ready?: Promise<void>;

  constructor(private config: Server, onClose: () => void) {
    const child = this.child = spawn(config.command, config.args, {
      cwd: config.cwd, env: config.env, stdio: ['pipe', 'pipe', 'ignore'], detached: process.platform !== 'win32', windowsHide: true,
    });
    this.onClose = onClose;
    let partial = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (this.closed) return;
      try {
        const lines = (partial + chunk).split('\n');
        partial = lines.pop()!;
        if (partial.length > maxFrame) throw new Error('MCP message exceeds size limit');
        for (const line of lines) {
          if (Buffer.byteLength(line) > maxFrame) throw new Error('MCP message exceeds size limit');
          if (line.trim()) this.receive(object(JSON.parse(line)));
        }
      } catch (error) { this.close(new Error(`Invalid MCP message: ${errorText(error)}`)); }
    });
    child.once('error', error => this.close(error));
    child.stdin.on('error', error => this.close(error));
    child.stdout.once('end', () => this.close(new Error('MCP server closed stdout')));
    child.once('exit', (code, signal) => this.close(new Error(`MCP server exited (${signal ?? code})`)));
  }

  private onClose: () => void;

  private send(message: JsonObject): void {
    if (this.closed) throw new Error('MCP connection closed');
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  }

  private receive(message: JsonObject): void {
    if (message.jsonrpc !== '2.0') throw new Error('Expected JSON-RPC 2.0');
    if (typeof message.method === 'string') {
      if (message.id !== undefined) {
        if (message.method === 'ping') this.send({ id: message.id, result: {} });
        else this.send({ id: message.id, error: { code: -32601, message: 'Client method not supported' } });
      }
      return;
    }
    const reply = typeof message.id === 'number' && this.pending.get(message.id);
    if (!reply) throw new Error('Unexpected MCP response ID');
    if (message.error !== undefined) {
      const error = object(message.error);
      reply.reject(new Error(`MCP error ${error.code}: ${String(error.message).slice(0, 2000)}`));
    } else reply.resolve(object(message.result));
    this.pending.delete(message.id as number);
  }

  private request(method: string, params: JsonObject, signal: AbortSignal): Promise<JsonObject> {
    signal.throwIfAborted();
    if (this.closed) throw new Error('MCP connection closed');
    const id = this.nextId++;
    const abort = () => this.close(new Error(`MCP ${method}: ${errorText(signal.reason)}`));
    signal.addEventListener('abort', abort, { once: true });
    return new Promise<JsonObject>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ id, method, params });
    }).finally(() => {
      signal.removeEventListener('abort', abort);
      this.pending.delete(id);
    });
  }

  private async initialize(signal: AbortSignal): Promise<void> {
    try {
      const reply = await this.request('initialize', { protocolVersion: versions[0], capabilities: {}, clientInfo: { name: 'kraken-coder', version: '0.1.0' } },
        AbortSignal.any([signal, AbortSignal.timeout(this.config.startupMs)]));
      if (!versions.includes(String(reply.protocolVersion))) throw new Error('Unsupported MCP protocol version');
      object(object(reply.capabilities).tools);
      this.send({ method: 'notifications/initialized' });
    } catch (error) {
      this.close(new Error(errorText(error)));
      throw error;
    }
  }

  async invoke(method: string, parameters: JsonObject, signal: AbortSignal): Promise<JsonObject> {
    signal.throwIfAborted();
    this.ready ??= this.initialize(signal);
    await this.ready;
    return this.request(method, parameters, AbortSignal.any([signal, AbortSignal.timeout(this.config.toolMs)]));
  }

  close(reason = new Error('MCP session ended')): void {
    if (this.closed) return;
    this.closed = true;
    for (const request of this.pending.values()) request.reject(reason);
    this.pending.clear();
    this.child.stdin.destroy();
    if (this.child.pid) {
      try {
        if (process.platform === 'win32') this.child.kill('SIGKILL');
        else process.kill(-this.child.pid, 'SIGKILL');
      } catch { /* The server already exited. */ }
    }
    this.onClose();
  }
}

export interface PluginMcp {
  prepareHook(pluginName: string | undefined, server: string, tool: string, args: JsonObject): Prepared;
  close(): void;
}

function configuredServers(plugins: readonly Plugin[], diagnose: (plugin: string, server: string, message: string) => void): Map<string, Server> {
  const servers = new Map<string, Server>();
  for (const plugin of plugins) {
    for (const [name, raw] of Object.entries(plugin.mcpServers)) {
      if (!/^[\w.-]{1,128}$/.test(name)) {
        diagnose(plugin.name, '(invalid name)', 'Invalid MCP server name');
        continue;
      }
      const id = `${plugin.name}:${name}`;
      try {
        const input = object(raw);
        if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new Error('MCP enabled must be a boolean');
        if (input.enabled === false) continue;
        servers.set(id, serverConfig(plugin, input));
      } catch (error) {
        diagnose(plugin.name, name, errorText(error));
      }
    }
  }
  return servers;
}

/** Metadata for the extension inventory. Inspecting manifests never connects or runs a command. */
export function inspectPluginMcp(plugins: readonly Plugin[]): { servers: string[]; diagnostics: string[] } {
  const diagnostics: string[] = [];
  const servers = configuredServers(plugins, (plugin, server, message) => diagnostics.push(`${plugin}:${server}: ${message}`));
  return { servers: [...servers.keys()], diagnostics };
}

export function registerPluginMcp(registry: ToolRegistry, plugins: readonly Plugin[], emit: Emit): PluginMcp {
  const servers = configuredServers(plugins, (plugin, server, message) => emit({ type: 'extension.diagnostic', plugin, server, message }));
  const clients = new Map<string, StdioClient>();
  let stopped = false;
  const serverParam = { type: 'string' as const, enum: [...servers.keys()] };
  function prepare(args: JsonObject, method: 'tools/list' | 'tools/call') {
    const id = String(args.server), config = servers.get(id);
    if (!config) throw new Error(`Unknown MCP server: ${id}`);
    const parameters: JsonObject = {};
    if (method === 'tools/call') {
      const tool = String(args.tool);
      if (!tool.trim() || tool.length > 256) throw new Error('Invalid MCP tool name');
      if (!config.allows(tool)) throw new Error(`MCP tool is disabled: ${tool}`);
      parameters.name = tool;
      parameters.arguments = object(JSON.parse(String(args.arguments_json ?? '{}')));
    } else if (args.cursor !== undefined) parameters.cursor = args.cursor;
    return {
      preview: `MCP ${id}\ncwd: ${config.cwd}\nexecutable and arguments: ${JSON.stringify([config.command, ...config.args])}\n${method}: ${JSON.stringify(parameters)}`,
      run: async (signal: AbortSignal) => {
        signal.throwIfAborted();
        if (stopped) throw new Error('MCP turn ended');
        let client = clients.get(id);
        if (!client) {
          client = new StdioClient(config, () => clients.delete(id));
          clients.set(id, client);
        }
        const result = await client.invoke(method, parameters, signal);
        if (method === 'tools/list') {
          if (!Array.isArray(result.tools)) throw new Error('Invalid MCP tools/list result');
          return { tools: result.tools.filter(tool => typeof tool?.name === 'string' && config.allows(tool.name)), nextCursor: result.nextCursor };
        }
        if (result.isError === true) {
          const detail = Array.isArray(result.content) ? result.content.find(item => item?.type === 'text')?.text : '';
          throw new Error(`MCP tool failed: ${String(detail || parameters.name).slice(0, 2000)}`);
        }
        return result;
      },
    };
  }
  if (servers.size) {
    registry.register({ name: 'mcp_list_tools', effect: 'shell', description: 'Discover tools of a local plugin MCP server, with an optional next-page cursor.',
      parameters: params({ server: serverParam, cursor: str(2000) }, ['server']), prepare: async args => prepare(args, 'tools/list') });
    // The remote schemas may use arbitrary JSON Schema; encode arguments as JSON to preserve those types in both Providers.
    registry.register({ name: 'mcp_call_tool', effect: 'shell', description: 'Call a named MCP tool on the selected plugin server. Supply arguments_json as a JSON object string matching its discovered inputSchema.',
      parameters: params({ server: serverParam, tool: str(256), arguments_json: str(64000) }, ['server', 'tool']), prepare: async args => prepare(args, 'tools/call') });
  }
  return {
    prepareHook(pluginName, server, tool, args) {
      let id = server;
      if (!server.includes(':')) {
        if (pluginName) id = `${pluginName}:${server}`;
        else {
          const candidates = [...servers.keys()].filter(key => key.endsWith(':' + server));
          if (candidates.length > 1) throw new Error(`Ambiguous MCP server "${server}". Use its plugin:server name.`);
          id = candidates[0] ?? server;
        }
      }
      // Capture the exact arguments presented for approval even if the hook input changes later.
      const serialized = JSON.stringify(object(args));
      if (serialized.length > 64_000) throw new Error('MCP hook arguments exceed 64000 characters');
      return prepare({ server: id, tool, arguments_json: serialized }, 'tools/call');
    },
    close() { stopped = true; for (const client of clients.values()) client.close(); },
  };
}
