import type { Config } from '../config.js';

export const modelProfiles = {
  volcengine: {
    label: '火山方舟', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    modelEnv: 'KRAKEN_VOLCENGINE_MODEL', keyEnv: 'KRAKEN_VOLCENGINE_API_KEY',
  },
  openrouter: {
    label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1',
    modelEnv: 'KRAKEN_OPENROUTER_MODEL', keyEnv: 'KRAKEN_OPENROUTER_API_KEY',
  },
} as const;

export type ModelProvider = keyof typeof modelProfiles;
export function isModelProvider(value: unknown): value is ModelProvider {
  return typeof value === 'string' && Object.hasOwn(modelProfiles, value);
}

export function profileForBaseUrl(baseUrl: string): ModelProvider | undefined {
  let normalized: string;
  try { normalized = new URL(baseUrl).href.replace(/\/$/, ''); }
  catch { return undefined; }
  for (const id of ['volcengine', 'openrouter'] as const) {
    if (normalized === modelProfiles[id].baseUrl) return id;
  }
  return undefined;
}

// Generic credentials belong to the original compatible endpoint. Keep that assignment
// intact on disk when switching so it remains attributable after a restart.
function legacyProfile(): ModelProvider | undefined {
  return profileForBaseUrl(process.env.KRAKEN_BASE_URL ?? '');
}
export function rememberedModel(id: ModelProvider): string {
  return process.env[modelProfiles[id].modelEnv] || (id === legacyProfile() ? process.env.KRAKEN_MODEL : '') || '';
}
export function profileApiKey(id: ModelProvider): string | undefined {
  return process.env[modelProfiles[id].keyEnv] || (id === legacyProfile() ? process.env.KRAKEN_API_KEY : undefined);
}
export function apiKeyForConfig(config: Config): string | undefined {
  if (config.modelProvider !== undefined && (config.provider !== 'compatible' || profileForBaseUrl(config.baseUrl) !== config.modelProvider)) {
    throw new Error('Invalid model provider endpoint');
  }
  if (config.provider === 'demo') return undefined;
  if (config.provider === 'responses') return process.env.OPENAI_API_KEY;
  const id = profileForBaseUrl(config.baseUrl);
  if (!id) return process.env.KRAKEN_API_KEY;
  // A legacy caller may supply the base URL via --base-url or config.json.
  return profileApiKey(id) || (!config.modelProvider && !process.env.KRAKEN_BASE_URL ? process.env.KRAKEN_API_KEY : undefined);
}
export function isValidProfileKey(value: unknown): value is string {
  return typeof value === 'string' && /^[!-~]{1,4096}$/.test(value) && !/[\r\n]/.test(value);
}
export function validateModelId(model: string): void {
  if (typeof model !== 'string' || !/^[a-zA-Z0-9@~][a-zA-Z0-9._/:@+~-]{0,255}$/.test(model)) {
    throw new Error('请输入有效的模型 ID。');
  }
}
export function modelConfig(config: Config, id: ModelProvider, model: string): Config {
  validateModelId(model);
  return { ...config, provider: 'compatible', modelProvider: id, baseUrl: modelProfiles[id].baseUrl, model };
}
