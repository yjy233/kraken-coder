import { validateConfig, type Config } from '../config.js';
import { randomUUID } from 'node:crypto';
import type { Emit, LoopRuntime, Message, Provider } from './types.js';
import { errorText } from './validation.js';
import { algorithms } from '../learning/index.js';
import { Workspace } from '../tools/workspace.js';
import { ToolRegistry, type Approve } from '../tools/registry.js';
import { registerBuiltins } from '../tools/builtins.js';
import { Instructions, systemPrompt } from '../context/instructions.js';
import { loadExtensionCatalog } from '../extensions/catalog.js';
import { createHookRunner, type HookRunner } from '../extensions/hooks.js';
import { prepareSkillMessage, withSkillContext } from '../extensions/mentions.js';
import { registerPluginMcp } from '../extensions/mcp.js';
import { withModelHooks, withCompactHooks } from '../extensions/model-hooks.js';
import { contextSize, fitModelContext, resolveContextBudget } from '../context/budget.js';
import { createReviewer } from '../permissions/reviewer.js';
import { SessionStore } from '../session/store.js';
import { DemoProvider } from '../providers/demo.js';
import { CompatibleProvider } from '../providers/compatible.js';
import { ResponsesProvider } from '../providers/responses.js';
export interface AgentOptions {
  config: Config; workspace: string; home: string; session: string;
  allowShell?: boolean; approve?: Approve; emit?: Emit; provider?: Provider;
  takeSteering?: LoopRuntime['takeSteering'];
}
const processInstance = randomUUID();
export function createProvider(config: Config, emit: Emit): Provider {
  if (config.provider === 'demo') return new DemoProvider();
  const apiKey = config.provider === 'responses' ? process.env.OPENAI_API_KEY : process.env.KRAKEN_API_KEY;
  if (config.provider === 'responses' && !apiKey) throw new Error('Set OPENAI_API_KEY for Responses');
  const http = { model: config.model, baseUrl: config.baseUrl, apiKey, timeoutMs: config.requestTimeoutMs };
  return config.provider === 'responses' ? new ResponsesProvider(http, emit) : new CompatibleProvider(http, algorithms(config.mode).decodeChat, emit);
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
  const deadline = AbortSignal.timeout(config.turnTimeoutMs), active = AbortSignal.any([signal, deadline]);
  let mcp: ReturnType<typeof registerPluginMcp> | undefined;
  let hooks: HookRunner | undefined;
  try {
    active.throwIfAborted();
    const catalog = await loadExtensionCatalog(workspace, config.plugins, config.skillRoots);
    for (const message of catalog.diagnostics) emit({ type: 'extension.warning', message });
    const instructions = new Instructions(workspace), skills = catalog.skills;
    const system: Message = { role: 'system', content: await systemPrompt(workspace, instructions, skills) };
    const raw = store.messages(), restored = alg.replay(raw);
    const userMessages = [input];
    const checkpoint = (message: Message): void => {
      if (message.role === 'user' && message.steered && !message.hookFeedback) userMessages.push(message.content);
      emit({ type: 'message', message });
    };
    for (const repair of restored.slice(raw.length)) checkpoint(repair);
    emit({ type: 'turn.started', session: options.session, mode: config.mode, approval: config.approval, shellEnabled: options.allowShell === true });
    emit({ type: 'instructions.snapshot', content: system.content });
    let user: Message | undefined;
    const hasHookSources = !!config.hookFiles?.length || catalog.plugins.some(p => p.hooks.length !== 0);
    if (hasHookSources) {
      // Record receipt before approvals. A rejected submission must never enter model replay.
      emit({ type: 'turn.input', content: input });
    } else {
      user = await prepareSkillMessage(input, skills, workspace);
      checkpoint(user);
    }
    const budget = await resolveContextBudget(config, options.provider === undefined);
    active.throwIfAborted();
    const reviewer = config.approval === 'auto-review' && config.provider !== 'demo'
      ? createReviewer(() => createProvider(config, () => {}), workspace.root, userMessages, budget)
      : undefined;
    const registry = new ToolRegistry({
      policy: config.approval, workspace: workspace.root, shellEnabled: options.allowShell === true,
      algorithms: alg, approve: options.approve ?? (async () => false), reviewer, emit,
    });
    registerBuiltins(registry, workspace, alg, instructions, skills, emit);
    mcp = registerPluginMcp(registry, catalog.plugins, emit);
    const permissionModes = { 'read-only': 'plan', ask: 'default', 'auto-review': 'default', 'workspace-write': 'acceptEdits', 'full-auto': 'bypassPermissions' };
    hooks = await createHookRunner(catalog.plugins, config.hookFiles ?? [], {
      cwd: workspace.root, session_id: options.session, transcript_path: store.path, turn_id: randomUUID(),
      model: config.model || provider.name, permission_mode: permissionModes[config.approval],
    }, (preview, s) => registry.authorizeHook(preview, s), emit, mcp.prepareHook);
    const turnHooks = hooks;
    registry.hooks = turnHooks;
    let startContext: string | undefined;
    if (turnHooks.handles('SessionStart') && !store.records.some(r => r.event.type === 'hook.session' && r.event.processInstance === processInstance)) {
      const source = store.records.filter(r => r.event.type === 'turn.started').length === 1 ? 'startup' : 'resume';
      const start = await turnHooks.run('SessionStart', { source }, active);
      if (start.block) throw new Error(`SessionStart blocked: ${start.block}`);
      startContext = start.context;
      emit({ type: 'hook.session', processInstance, source });
    }
    const prepareUser = async (text: string, initialContext?: string): Promise<Message> => {
      const submit = await turnHooks.run('UserPromptSubmit', { prompt: text }, active);
      if (submit.block) throw new Error(`UserPromptSubmit blocked: ${submit.block}`);
      const message = await prepareSkillMessage(text, skills, workspace);
      const context = [initialContext, submit.context].filter(Boolean).join('\n');
      if (context) message.hookContext = context;
      return message;
    };
    if (!user) {
      user = await prepareUser(input, startContext);
      checkpoint(user);
    }
    const schemas = registry.schemas();
    const schemaSize = contextSize(schemas, budget);
    let stopHookActive = false;
    const answer = await alg.runLoop([system, ...restored, user], {
      provider: withModelHooks(provider, turnHooks), tools: schemas, maxSteps: config.maxSteps, signal: active, emit, checkpoint, takeSteering: options.takeSteering,
      prepareSteering: text => prepareUser(text),
      beforeFinish: turnHooks.handles('Stop') ? async answer => {
        const stop = await turnHooks.run('Stop', { last_assistant_message: answer, stop_hook_active: stopHookActive }, active);
        if (stop.block) {
          stopHookActive = true;
          return '[Stop hook feedback]\n' + stop.block;
        }
      } : undefined,
      execute: (call, s) => registry.execute(call, s),
      async context(messages) {
        const withHooks = messages.map(message => {
          if (!message.hookContext) return message;
          const { hookContext, ...rest } = message;
          return { ...rest, content: rest.content + '\n\n[Hook context]\n' + hookContext };
        });
        const expanded = withSkillContext(withHooks, budget, schemaSize);
        const limit = budget.source === 'fallback' ? budget.thresholdChars : budget.thresholdTokens;
        const { context, compacted } = await withCompactHooks(turnHooks,
          () => contextSize(expanded, budget) + schemaSize > limit,
          () => fitModelContext(expanded, budget, schemaSize, alg.fitContext), active);
        if (context.length !== messages.length || compacted) {
          emit({ type: 'context.trimmed', beforeMessages: messages.length, afterMessages: context.length, toolResults: compacted });
        }
        return context;
      },
    });
    active.throwIfAborted();
    emit({ type: 'turn.completed', session: options.session, answer });
    return { answer, session: options.session, journal: store.path };
  } catch (error) {
    // Cancellation must not open a new approval prompt. Observers may only run if shell is already authorized.
    if (signal.aborted && hooks?.handles('Interrupt') && config.approval === 'full-auto' && options.allowShell) {
      try { await hooks.run('Interrupt', {}, AbortSignal.timeout(1000)); } catch { /* cancellation wins */ }
    }
    const failure = !signal.aborted && deadline.aborted ? new Error(`整轮任务超时（${config.turnTimeoutMs / 1000} 秒，包含模型、工具和审批等待）。可在运行设置或 KRAKEN_TURN_TIMEOUT_MS 中调整。`, { cause: error }) : error;
    emit({ type: signal.aborted ? 'turn.cancelled' : 'turn.failed', error: errorText(failure) });
    throw failure;
  }
  finally {
    try { mcp?.close(); await hooks?.close(); } finally { store.close(); }
  }
}
