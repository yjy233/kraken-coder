import { createHash } from 'node:crypto';
import { apiUrl, boundedText } from './http.js';

interface ModelWindow { windowTokens: number; maxInputTokens?: number }
const cache = new Map<string, { expires: number; result: Promise<ModelWindow | undefined> }>();

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

async function fetchModelWindow(url: URL, model: string, apiKey?: string): Promise<ModelWindow | undefined> {
  const response = await fetch(url, {
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
    redirect: 'error',
    signal: AbortSignal.timeout(2500),
  });
  if (!response.ok) {
    await response.body?.cancel();
    return;
  }
  const { data } = JSON.parse(await boundedText(response));
  if (!Array.isArray(data)) return;
  const entry = data.find(item => item?.id === model);
  const limits = entry?.token_limits;
  const windowTokens = positiveInteger(limits?.context_window)
    ?? positiveInteger(entry?.context_window) ?? positiveInteger(entry?.context_length);
  if (!windowTokens) return;
  const maxInputTokens = positiveInteger(limits?.max_input_token_length)
    ?? positiveInteger(entry?.max_input_tokens);
  return { windowTokens, maxInputTokens };
}

/** Best effort: OpenAI-compatible model listings do not all publish context metadata. */
export function discoverModelWindow(baseUrl: string, model: string, apiKey?: string): Promise<ModelWindow | undefined> {
  const url = new URL(apiUrl(baseUrl, 'models'));
  const credential = apiKey ? createHash('sha256').update(apiKey).digest('hex') : '';
  const key = JSON.stringify([url.href, model, credential]);
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return cached.result;
  const entry = {
    expires: Date.now() + 60_000,
    result: fetchModelWindow(url, model, apiKey).catch(() => undefined).then(window => {
      if (window) entry.expires = Date.now() + 60 * 60_000;
      return window;
    }),
  };
  cache.set(key, entry);
  return entry.result;
}
