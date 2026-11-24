import { createHash } from 'node:crypto';
import { apiUrl, boundedText } from './http.js';

interface ModelWindow { windowTokens: number; maxInputTokens?: number }
const cache = new Map<string, { expires: number; result: Promise<ModelWindow | undefined> }>();

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

async function fetchModels(url: URL, apiKey: string | undefined, timeoutMs: number) {
  const response = await fetch(url, {
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Provider HTTP ${response.status}`);
  }
  const { data } = JSON.parse(await boundedText(response));
  if (!Array.isArray(data)) throw new Error('Invalid model catalog');
  return data;
}

/** Exclude explicitly incompatible models while keeping providers with sparse metadata usable. */
export async function listChatModels(baseUrl: string, apiKey?: string): Promise<string[]> {
  const data = await fetchModels(new URL(apiUrl(baseUrl, 'models')), apiKey, 8000);
  const ids = new Set<string>();
  for (const item of data) {
    if (typeof item?.id !== 'string' || !item.id || item.id.length > 256) continue;
    const outputs = item.architecture?.output_modalities ?? item.modalities?.output_modalities;
    if (Array.isArray(outputs) && outputs.length) {
      if (!outputs.includes('text')) continue;
    } else if (item.domain && !['LLM', 'VLM'].includes(item.domain)) continue;
    if (item.features?.tools?.function_calling === false) continue;
    if (Array.isArray(item.supported_parameters) && item.supported_parameters.length && !item.supported_parameters.includes('tools')) continue;
    ids.add(item.id);
  }
  return [...ids].sort();
}

async function fetchModelWindow(url: URL, model: string, apiKey?: string): Promise<ModelWindow | undefined> {
  const data = await fetchModels(url, apiKey, 2500);
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
