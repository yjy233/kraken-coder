import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import type { Mode, Policy } from './core/types.js';
import { object } from './core/validation.js';
import { isModelProvider, isValidProfileKey, modelConfig, modelProfiles, profileForBaseUrl, rememberedModel, validateModelId, type ModelProvider } from './providers/profiles.js';
import { apiUrl } from './providers/http.js';
export interface Config {
  provider: 'demo' | 'responses' | 'compatible'; mode: Mode; approval: Policy;
  modelProvider?: ModelProvider;
  model: string; baseUrl: string; maxSteps: number; contextChars: number;
  /** null: discover model window, 0: use contextChars, positive: manual token window. */
  contextWindowTokens: number | null;
  contextCompactRatio: number;
  requestTimeoutMs: number; turnTimeoutMs: number;
  /** Explicit local plugin packages and additional standalone skill directories. */
  plugins?: string[];
  skillRoots?: string[];
  hookFiles?: string[];
}
export type TimeoutSettings = Pick<Config, 'requestTimeoutMs' | 'turnTimeoutMs'>;
export type RuntimeSettings = TimeoutSettings & Pick<Config, 'approval' | 'contextWindowTokens' | 'contextCompactRatio'>;
export const defaults: Config = {
  provider: 'demo', modelProvider: undefined, mode: 'reference', approval: 'ask', model: '', baseUrl: '',
  maxSteps: 16, contextChars: 120_000, contextWindowTokens: null, contextCompactRatio: 0.8,
  requestTimeoutMs: 180_000, turnTimeoutMs: 10_800_000,
  plugins: [], skillRoots: [], hookFiles: [],
};
export function loadEnv(path: string): void {
  if (!existsSync(path)) return;
  const values = parseEnv(readFileSync(path, 'utf8'));
  for (const [key, value] of Object.entries(values)) {
    if ((key.startsWith('KRAKEN_') || key === 'OPENAI_API_KEY') && process.env[key] === undefined) process.env[key] = value;
  }
}
export function validateConfig(config: Config): Config {
  for (const key of ['plugins', 'skillRoots', 'hookFiles'] as const) {
    const paths = config[key] === undefined ? [] : config[key];
    if (!Array.isArray(paths) || paths.length > 64 ||
        paths.some(path => typeof path !== 'string' || !isAbsolute(path) || path.includes('\0'))) {
      throw new Error(`${key} must be an array of up to 64 absolute local paths`);
    }
    config[key] = [...new Set(paths.map(path => resolve(path)))];
  }
  const choices: Record<string, string[]> = { provider: ['demo', 'responses', 'compatible'], mode: ['reference', 'learner'], approval: ['read-only', 'ask', 'auto-review', 'workspace-write', 'full-auto'] };
  for (const [key, values] of Object.entries(choices)) if (!values.includes(config[key as keyof Config] as string)) throw new Error(`Invalid ${key}`);
  for (const [key, min, max] of [['maxSteps', 1, 100], ['contextChars', 1000, 2_000_000], ['requestTimeoutMs', 1, 600_000], ['turnTimeoutMs', 1, 10_800_000]] as const) {
    const n = config[key]; if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`${key} must be an integer between ${min} and ${max}`);
  }
  const window = config.contextWindowTokens ?? null;
  if (window !== null && (!Number.isSafeInteger(window) || window < 0)) throw new Error('Invalid contextWindowTokens');
  const ratio = config.contextCompactRatio === undefined ? defaults.contextCompactRatio : config.contextCompactRatio;
  if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio < 0.1 || ratio > 0.95) throw new Error('contextCompactRatio must be between 0.1 and 0.95');
  config.contextWindowTokens = window;
  config.contextCompactRatio = ratio;
  if (typeof config.model !== 'string' || typeof config.baseUrl !== 'string') throw new Error('model/baseUrl must be strings');
  if (config.provider !== 'demo') {
    if (!config.model.trim()) throw new Error('Set --model or KRAKEN_MODEL to a tool-capable model available to your account');
    config.baseUrl ||= config.provider === 'responses' ? 'https://api.openai.com/v1' : '';
    if (!config.baseUrl) throw new Error('compatible provider requires --base-url or KRAKEN_BASE_URL');
    apiUrl(config.baseUrl, '');
  }
  if (config.modelProvider !== undefined) {
    if (!isModelProvider(config.modelProvider) || config.provider !== 'compatible' || profileForBaseUrl(config.baseUrl) !== config.modelProvider) {
      throw new Error('Invalid model provider endpoint');
    }
    validateModelId(config.model);
  }
  return config;
}
export function loadConfig(home: string, overrides: Partial<Config>): Config {
  const path = resolve(home, 'config.json');
  const saved = existsSync(path) ? object(JSON.parse(readFileSync(path, 'utf8'))) : {};
  for (const key of Object.keys(saved)) if (!Object.hasOwn(defaults, key)) throw new Error(`Unknown config field: ${key}`);
  const env: Partial<Config> = {};
  if (process.env.KRAKEN_PROVIDER) env.provider = process.env.KRAKEN_PROVIDER as Config['provider'];
  if (process.env.KRAKEN_APPROVAL !== undefined) env.approval = process.env.KRAKEN_APPROVAL as Policy;
  if (process.env.KRAKEN_MODEL) env.model = process.env.KRAKEN_MODEL;
  if (process.env.KRAKEN_BASE_URL) env.baseUrl = process.env.KRAKEN_BASE_URL;
  if (process.env.KRAKEN_REQUEST_TIMEOUT_MS !== undefined) env.requestTimeoutMs = Number(process.env.KRAKEN_REQUEST_TIMEOUT_MS);
  if (process.env.KRAKEN_TURN_TIMEOUT_MS !== undefined) env.turnTimeoutMs = Number(process.env.KRAKEN_TURN_TIMEOUT_MS);
  if (process.env.KRAKEN_CONTEXT_WINDOW_TOKENS !== undefined) {
    const tokens = process.env.KRAKEN_CONTEXT_WINDOW_TOKENS;
    env.contextWindowTokens = tokens === 'auto' ? null : Number(tokens);
  }
  if (process.env.KRAKEN_CONTEXT_COMPACT_RATIO !== undefined) env.contextCompactRatio = Number(process.env.KRAKEN_CONTEXT_COMPACT_RATIO);
  const config = { ...defaults, ...saved, ...env, ...overrides };
  const selected = overrides.modelProvider ?? process.env.KRAKEN_MODEL_PROVIDER ?? saved.modelProvider;
  if (selected && (!overrides.provider || overrides.provider === 'compatible') && overrides.baseUrl === undefined) {
    if (!isModelProvider(selected)) throw new Error('KRAKEN_MODEL_PROVIDER must be volcengine or openrouter');
    const model = overrides.model ?? (rememberedModel(selected) ||
      (profileForBaseUrl(config.baseUrl) === selected ? config.model : ''));
    if (!model) throw new Error(`请设置 ${modelProfiles[selected].modelEnv} 或 --model。`);
    return validateConfig(modelConfig(config, selected, model));
  }
  delete config.modelProvider;
  return validateConfig(config);
}

/** Update allowlisted settings assignments; preserve provider credentials and comments. */
export function saveRuntimeEnv(path: string, settings: Partial<RuntimeSettings>): void {
  validateConfig({ ...defaults, ...settings });
  const entries: [string, string][] = [];
  if (settings.requestTimeoutMs !== undefined) entries.push(['KRAKEN_REQUEST_TIMEOUT_MS', String(settings.requestTimeoutMs)]);
  if (settings.turnTimeoutMs !== undefined) entries.push(['KRAKEN_TURN_TIMEOUT_MS', String(settings.turnTimeoutMs)]);
  if (settings.approval !== undefined) entries.push(['KRAKEN_APPROVAL', settings.approval]);
  if (settings.contextWindowTokens !== undefined) entries.push(['KRAKEN_CONTEXT_WINDOW_TOKENS', String(settings.contextWindowTokens ?? 'auto')]);
  if (settings.contextCompactRatio !== undefined) entries.push(['KRAKEN_CONTEXT_COMPACT_RATIO', String(settings.contextCompactRatio)]);
  writeEnvEntries(path, entries);
}

export function saveModelSelection(path: string, id: ModelProvider, model: string, apiKey?: string, previous?: Config): void {
  if (!isModelProvider(id)) throw new Error('模型平台无效。');
  validateModelId(model);
  const profile = modelProfiles[id];
  const entries: [string, string][] = [['KRAKEN_MODEL_PROVIDER', id], [profile.modelEnv, model]];
  if (apiKey !== undefined) {
    if (!isValidProfileKey(apiKey)) throw new Error('API Key 格式无效。');
    entries.push([profile.keyEnv, apiKey]);
  }
  // The older CLI could supply the compatible endpoint through a flag or config.json;
  // persist the non-secret association so its generic key remains bound after restart.
  if (previous?.provider === 'compatible') {
    const priorId = profileForBaseUrl(previous.baseUrl);
    if (priorId && !previous.modelProvider && process.env.KRAKEN_API_KEY && !process.env.KRAKEN_BASE_URL) {
      entries.push(['KRAKEN_BASE_URL', modelProfiles[priorId].baseUrl]);
    }
    if (priorId && priorId !== id && rememberedModel(priorId) !== previous.model) {
      entries.push([modelProfiles[priorId].modelEnv, previous.model]);
    }
  }
  if (entries.some(([, value]) => /[\r\n\0]/.test(value))) throw new Error('配置值包含无效字符。');
  writeEnvEntries(path, entries);
  for (const [key, value] of entries) process.env[key] = value;
}

function writeEnvEntries(path: string, entries: [string, string][]): void {
  let source = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const original = parseEnv(source);
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  for (const [key, value] of entries) {
    const assignment = new RegExp(`^[\\t ]*(?:export[\\t ]+)?${key}[\\t ]*=[^\\r\\n]*`, 'gm');
    const encodings = [value, `'${value}'`, `"${value}"`, '`' + value + '`'];
    const encoded = encodings.find(candidate => parseEnv(`V=${candidate}`).V === value);
    if (encoded === undefined) throw new Error('无法安全更新 .env 的设置，请手动修改后重启服务。');
    const line = `${key}=${encoded}`;
    if (assignment.test(source)) source = source.replace(assignment, () => line);
    else source += (source && !source.endsWith('\n') ? newline : '') + line + newline;
  }
  const parsed = parseEnv(source), keys = new Set(entries.map(([key]) => key));
  if (Object.entries(original).some(([key, value]) => !keys.has(key) && parsed[key] !== value)
    || Object.keys(parsed).some(key => !keys.has(key) && !Object.hasOwn(original, key))
    || entries.some(([key, value]) => parsed[key] !== value)) {
    throw new Error('无法安全更新 .env 的设置，请手动修改后重启服务。');
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, source, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

export const saveTimeoutEnv = saveRuntimeEnv;
