import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import type { Mode, Policy } from './core/types.js';
import { object } from './core/validation.js';
import { apiUrl } from './providers/http.js';
export interface Config {
  provider: 'demo' | 'responses' | 'compatible'; mode: Mode; approval: Policy;
  model: string; baseUrl: string; maxSteps: number; contextChars: number;
  /** null: discover model window, 0: use contextChars, positive: manual token window. */
  contextWindowTokens: number | null;
  contextCompactRatio: number;
  requestTimeoutMs: number; turnTimeoutMs: number;
}
export type TimeoutSettings = Pick<Config, 'requestTimeoutMs' | 'turnTimeoutMs'>;
export type RuntimeSettings = TimeoutSettings & Pick<Config, 'approval' | 'contextWindowTokens' | 'contextCompactRatio'>;
export const defaults: Config = {
  provider: 'demo', mode: 'reference', approval: 'ask', model: '', baseUrl: '',
  maxSteps: 16, contextChars: 120_000, contextWindowTokens: null, contextCompactRatio: 0.8,
  requestTimeoutMs: 180_000, turnTimeoutMs: 10_800_000,
};
export function loadEnv(path: string): void {
  if (!existsSync(path)) return;
  const values = parseEnv(readFileSync(path, 'utf8'));
  for (const [key, value] of Object.entries(values)) {
    if ((key.startsWith('KRAKEN_') || key === 'OPENAI_API_KEY') && process.env[key] === undefined) process.env[key] = value;
  }
}
export function validateConfig(config: Config): Config {
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
  return validateConfig({ ...defaults, ...saved, ...env, ...overrides });
}

/** Update allowlisted settings assignments; preserve provider credentials and comments. */
export function saveRuntimeEnv(path: string, settings: Partial<RuntimeSettings>): void {
  validateConfig({ ...defaults, ...settings });
  let source = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const original = parseEnv(source);
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const entries: [string, string][] = [];
  if (settings.requestTimeoutMs !== undefined) entries.push(['KRAKEN_REQUEST_TIMEOUT_MS', String(settings.requestTimeoutMs)]);
  if (settings.turnTimeoutMs !== undefined) entries.push(['KRAKEN_TURN_TIMEOUT_MS', String(settings.turnTimeoutMs)]);
  if (settings.approval !== undefined) entries.push(['KRAKEN_APPROVAL', settings.approval]);
  if (settings.contextWindowTokens !== undefined) entries.push(['KRAKEN_CONTEXT_WINDOW_TOKENS', String(settings.contextWindowTokens ?? 'auto')]);
  if (settings.contextCompactRatio !== undefined) entries.push(['KRAKEN_CONTEXT_COMPACT_RATIO', String(settings.contextCompactRatio)]);
  for (const [key, value] of entries) {
    const assignment = new RegExp(`^[\\t ]*(?:export[\\t ]+)?${key}[\\t ]*=[^\\r\\n]*`, 'gm');
    if (assignment.test(source)) source = source.replace(assignment, `${key}=${value}`);
    else source += (source && !source.endsWith('\n') ? newline : '') + `${key}=${value}${newline}`;
  }
  const parsed = parseEnv(source), keys = new Set(entries.map(([key]) => key));
  if (Object.entries(original).some(([key, value]) => !keys.has(key) && parsed[key] !== value)
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
