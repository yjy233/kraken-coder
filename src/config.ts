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
  requestTimeoutMs: number; turnTimeoutMs: number;
}
export type TimeoutSettings = Pick<Config, 'requestTimeoutMs' | 'turnTimeoutMs'>;
export const defaults: Config = {
  provider: 'demo', mode: 'reference', approval: 'ask', model: '', baseUrl: '',
  maxSteps: 16, contextChars: 120_000, requestTimeoutMs: 180_000, turnTimeoutMs: 10_800_000,
};
export function loadEnv(path: string): void {
  if (!existsSync(path)) return;
  const values = parseEnv(readFileSync(path, 'utf8'));
  for (const [key, value] of Object.entries(values)) {
    if ((key.startsWith('KRAKEN_') || key === 'OPENAI_API_KEY') && process.env[key] === undefined) process.env[key] = value;
  }
}
export function validateConfig(config: Config): Config {
  const choices: Record<string, string[]> = { provider: ['demo', 'responses', 'compatible'], mode: ['reference', 'learner'], approval: ['read-only', 'ask', 'workspace-write', 'full-auto'] };
  for (const [key, values] of Object.entries(choices)) if (!values.includes(config[key as keyof Config] as string)) throw new Error(`Invalid ${key}`);
  for (const [key, min, max] of [['maxSteps', 1, 100], ['contextChars', 1000, 2_000_000], ['requestTimeoutMs', 1, 600_000], ['turnTimeoutMs', 1, 10_800_000]] as const) {
    const n = config[key]; if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`${key} must be an integer between ${min} and ${max}`);
  }
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
  if (process.env.KRAKEN_MODEL) env.model = process.env.KRAKEN_MODEL;
  if (process.env.KRAKEN_BASE_URL) env.baseUrl = process.env.KRAKEN_BASE_URL;
  if (process.env.KRAKEN_REQUEST_TIMEOUT_MS !== undefined) env.requestTimeoutMs = Number(process.env.KRAKEN_REQUEST_TIMEOUT_MS);
  if (process.env.KRAKEN_TURN_TIMEOUT_MS !== undefined) env.turnTimeoutMs = Number(process.env.KRAKEN_TURN_TIMEOUT_MS);
  return validateConfig({ ...defaults, ...saved, ...env, ...overrides });
}

/** Update only timeout assignments; preserve provider credentials and comments. */
export function saveTimeoutEnv(path: string, settings: TimeoutSettings): void {
  validateConfig({ ...defaults, ...settings });
  let source = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const original = parseEnv(source);
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  for (const [key, value] of [['KRAKEN_REQUEST_TIMEOUT_MS', settings.requestTimeoutMs], ['KRAKEN_TURN_TIMEOUT_MS', settings.turnTimeoutMs]] as const) {
    const assignment = new RegExp(`^[\\t ]*(?:export[\\t ]+)?${key}[\\t ]*=[^\\r\\n]*`, 'gm');
    if (assignment.test(source)) source = source.replace(assignment, `${key}=${value}`);
    else source += (source && !source.endsWith('\n') ? newline : '') + `${key}=${value}${newline}`;
  }
  const parsed = parseEnv(source), keys = ['KRAKEN_REQUEST_TIMEOUT_MS', 'KRAKEN_TURN_TIMEOUT_MS'];
  if (Object.entries(original).some(([key, value]) => !keys.includes(key) && parsed[key] !== value)
    || parsed.KRAKEN_REQUEST_TIMEOUT_MS !== String(settings.requestTimeoutMs) || parsed.KRAKEN_TURN_TIMEOUT_MS !== String(settings.turnTimeoutMs)) {
    throw new Error('无法安全更新 .env 的时限字段，请手动修改这两项后重启服务。');
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, source, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
