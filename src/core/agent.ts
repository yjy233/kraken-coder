import { validateConfig, type Config } from '../config.js';
import type { Emit, Message, Provider } from './types.js';
import { errorText } from './validation.js';
import { algorithms } from '../learning/index.js';
import { Workspace } from '../tools/workspace.js';
import { ToolRegistry, type Approve } from '../tools/registry.js';
import { registerBuiltins } from '../tools/builtins.js';
import { Instructions, listSkills, systemPrompt } from '../context/instructions.js';
import { SessionStore } from '../session/store.js';
import { DemoProvider } from '../providers/demo.js';
import { CompatibleProvider } from '../providers/compatible.js';
import { ResponsesProvider } from '../providers/responses.js';
export interface AgentOptions {
  config: Config; workspace: string; home: string; session: string;
  allowShell?: boolean; approve?: Approve; emit?: Emit; provider?: Provider;
}
export function createProvider(config: Config, emit: Emit): Provider {
  if (config.provider === 'demo') return new DemoProvider();
  const apiKey = config.provider === 'responses' ? process.env.OPENAI_API_KEY : process.env.KRAKEN_API_KEY;
  if (config.provider === 'responses' && !apiKey) throw new Error('Set OPENAI_API_KEY for Responses');
  const http = { model: config.model, baseUrl: config.baseUrl, apiKey, timeoutMs: config.requestTimeoutMs };
  return config.provider === 'responses' ? new ResponsesProvider(http, emit) : new CompatibleProvider(http, algorithms(config.mode).decodeChat);
}
export async function runTurn(options: AgentOptions, input: string, signal: AbortSignal = new AbortController().signal): Promise<{ answer: string; session: string; journal: string }> {
  if (!input.trim()) throw new Error('Message cannot be empty');
  const config = validateConfig({ ...options.config }), alg = algorithms(config.mode);
  const workspace = await Workspace.open(options.workspace);
  let store: SessionStore | undefined;
  const emit: Emit = event => {
    // delta 是临时显示事件；完成后的 assistant 才是模型上下文和持久化依据。
    if (event.type !== 'model.delta') store?.append(event);
    options.emit?.(event);
  };
  const provider = options.provider ?? createProvider(config, emit);
  store = SessionStore.open(options.home, { id: options.session, workspace: workspace.root, provider: provider.name });
  const active = AbortSignal.any([signal, AbortSignal.timeout(config.turnTimeoutMs)]);
  try {
    active.throwIfAborted();
    const instructions = new Instructions(workspace), skills = await listSkills(workspace);
    const system: Message = { role: 'system', content: await systemPrompt(workspace, instructions, skills) };
    const raw = store.messages(), restored = alg.replay(raw);
    const checkpoint = (message: Message): void => emit({ type: 'message', message });
    for (const repair of restored.slice(raw.length)) checkpoint(repair);
    emit({ type: 'turn.started', session: options.session, mode: config.mode, approval: config.approval, shellEnabled: options.allowShell === true });
    emit({ type: 'instructions.snapshot', content: system.content });
    const user: Message = { role: 'user', content: input }; checkpoint(user);
    const registry = new ToolRegistry({ policy: config.approval, shellEnabled: options.allowShell === true, algorithms: alg, approve: options.approve ?? (async () => false), emit });
    registerBuiltins(registry, workspace, alg, instructions, skills, emit);
    const schemas = registry.schemas(), schemaChars = JSON.stringify(schemas).length;
    const answer = await alg.runLoop([system, ...restored, user], {
      provider, tools: schemas, maxSteps: config.maxSteps, signal: active, emit, checkpoint,
      execute: (call, s) => registry.execute(call, s),
      context(messages) {
        const context = alg.fitContext(messages, config.contextChars - schemaChars);
        if (context.length !== messages.length) emit({ type: 'context.trimmed', beforeMessages: messages.length, afterMessages: context.length });
        return context;
      },
    });
    active.throwIfAborted();
    emit({ type: 'turn.completed', session: options.session, answer });
    return { answer, session: options.session, journal: store.path };
  } catch (error) { emit({ type: active.aborted ? 'turn.cancelled' : 'turn.failed', error: errorText(error) }); throw error; }
  finally { store.close(); }
}
