import type { ModelReply, Provider } from '../core/types.js';
import type { HookRunner } from './hooks.js';

type LifecycleHooks = Pick<HookRunner, 'handles' | 'run'>;

// Provider errors may contain request bodies or credential-bearing URLs supplied by an SDK.
function failureDescription(error: unknown): string {
  if (error instanceof Error) {
    if (/^Provider HTTP [1-5]\d\d$/.test(error.message)) return error.message;
    if (error.name === 'TimeoutError' || error.message.startsWith('模型单次请求超时（')) return 'Provider request timed out';
  }
  return 'Provider request failed';
}

export function withModelHooks(provider: Provider, hooks: LifecycleHooks): Provider {
  if (!hooks.handles('PreModelRequest') && !hooks.handles('PostModelRequest')) return provider;
  return {
    name: provider.name,
    async complete(messages, tools, signal) {
      signal.throwIfAborted();
      // These are observers. Their stdout cannot replace the prompt, answer, or tool calls.
      if (hooks.handles('PreModelRequest')) await hooks.run('PreModelRequest', {}, signal);
      signal.throwIfAborted();
      let reply: ModelReply;
      try {
        reply = await provider.complete(messages, tools, signal);
      } catch (error) {
        // An aborted caller has withdrawn permission for further process launches.
        signal.throwIfAborted();
        if (hooks.handles('PostModelRequest')) {
          const cancelled = error instanceof Error && error.name === 'AbortError';
          await hooks.run('PostModelRequest', {
            status: cancelled ? 'cancelled' : 'failed',
            error: cancelled ? null : failureDescription(error),
            token_usage: null,
          }, signal);
        }
        throw error;
      }
      signal.throwIfAborted();
      if (hooks.handles('PostModelRequest')) {
        await hooks.run('PostModelRequest', { status: 'completed', error: null, token_usage: null }, signal);
      }
      return reply;
    },
  };
}

export async function withCompactHooks<T>(hooks: LifecycleHooks, shouldCompact: () => boolean, compact: () => T, signal: AbortSignal): Promise<T> {
  const pre = hooks.handles('PreCompact'), post = hooks.handles('PostCompact');
  signal.throwIfAborted();
  if ((!pre && !post) || !shouldCompact()) return compact();
  const fields = { trigger: 'auto' };
  if (pre) {
    const outcome = await hooks.run('PreCompact', fields, signal);
    if (outcome.block) throw new Error(outcome.block);
  }
  signal.throwIfAborted();
  const result = await compact();
  if (post) {
    const outcome = await hooks.run('PostCompact', fields, signal);
    if (outcome.block) throw new Error(outcome.block);
  }
  return result;
}
