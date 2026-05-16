import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { expandHomePath, parseBoolean, parseInteger } from '../utils/helpers';
import { getWorkspaceRoot } from './workspace';

type TomlPrimitive = string | number | boolean;
type TomlValue = TomlPrimitive | TomlPrimitive[];
type ParsedToml = Record<string, unknown>;

export interface KrakenFileConfig {
  model?: {
    baseUrl?: string;
    name?: string;
    proxy?: string;
  };
  context?: {
    maxChars?: number;
  };
  agent?: {
    autoApply?: boolean;
    allowTerminal?: boolean;
    allowFileWriteTool?: boolean;
    allowBrowserTool?: boolean;
    browserBin?: string;
    browserMaxOutput?: number;
    browserDefaultTimeout?: number;
    browserAllowedDomains?: string | string[];
  };
  skills?: {
    dir?: string;
  };
  memory?: {
    enabled?: boolean;
    autoRead?: boolean;
    maxChars?: number;
    allowWrite?: boolean;
  };
  episodes?: {
    enabled?: boolean;
    autoCapture?: boolean;
    autoRecall?: boolean;
    maxRecalled?: number;
    maxChars?: number;
    storeTranscript?: boolean;
  };
}

export interface KrakenConfig {
  model: {
    baseUrl: string;
    name: string;
    proxy?: string;
  };
  context: {
    maxChars: number;
  };
  agent: {
    autoApply: boolean;
    allowTerminal: boolean;
    allowFileWriteTool: boolean;
    allowBrowserTool: boolean;
    browserBin: string;
    browserMaxOutput: number;
    browserDefaultTimeout: number;
    browserAllowedDomains?: string;
  };
  skills: {
    dir?: string;
  };
  memory: {
    enabled: boolean;
    autoRead: boolean;
    maxChars: number;
    allowWrite: boolean;
  };
  episodes: {
    enabled: boolean;
    autoCapture: boolean;
    autoRecall: boolean;
    maxRecalled: number;
    maxChars: number;
    storeTranscript: boolean;
  };
  paths: {
    globalRoot: string;
    globalConfigPath: string;
    globalSkillDir: string;
    legacyGlobalSkillDir: string;
    builtinSkillDir: string;
    workspaceRoot?: string;
    workspaceConfigPath?: string;
    workspaceSkillDir?: string;
    legacyWorkspaceSkillDir?: string;
  };
}

export interface KrakenConfigOptions {
  extensionRoot?: string;
}

const krakenDirName = 'kraken-coder';

export function getGlobalKrakenRoot(): string {
  return path.join(os.homedir(), krakenDirName);
}

export function getGlobalConfigPath(): string {
  return path.join(getGlobalKrakenRoot(), 'config', 'config.toml');
}

export function getGlobalSkillDir(): string {
  return path.join(getGlobalKrakenRoot(), 'skills');
}

export function getLegacyGlobalSkillDir(): string {
  return path.join(getGlobalKrakenRoot(), 'skill');
}

export function getWorkspaceKrakenRoot(): string | undefined {
  const root = getWorkspaceRoot();
  return root ? path.join(root.fsPath, krakenDirName) : undefined;
}

export function getWorkspaceConfigPath(): string | undefined {
  const workspaceRoot = getWorkspaceKrakenRoot();
  return workspaceRoot ? path.join(workspaceRoot, 'config', 'config.toml') : undefined;
}

export function getWorkspaceSkillDir(): string | undefined {
  const root = getWorkspaceRoot();
  return root ? path.join(root.fsPath, '.kraken-coder', 'skills') : undefined;
}

export function getLegacyWorkspaceSkillDir(): string | undefined {
  const workspaceRoot = getWorkspaceKrakenRoot();
  return workspaceRoot ? path.join(workspaceRoot, 'skill') : undefined;
}

export function getBuiltinSkillDir(extensionRoot?: string): string {
  const root = normalizeOptionalPath(extensionRoot) ?? path.resolve(__dirname, '..', '..');
  return path.join(root, 'resources', 'skills');
}

export function getKrakenConfig(options: KrakenConfigOptions = {}): KrakenConfig {
  const vscodeConfig = vscode.workspace.getConfiguration('kraken');
  const workspaceRoot = getWorkspaceRoot()?.fsPath;
  const workspaceConfigPath = getWorkspaceConfigPath();
  const workspaceSkillDir = getWorkspaceSkillDir();
  const legacyWorkspaceSkillDir = getLegacyWorkspaceSkillDir();
  const fileConfig = mergeFileConfig(
    readKrakenConfigFile(getGlobalConfigPath()),
    workspaceConfigPath ? readKrakenConfigFile(workspaceConfigPath) : {}
  );

  const agent = fileConfig.agent ?? {};
  const context = fileConfig.context ?? {};
  const model = fileConfig.model ?? {};
  const skills = fileConfig.skills ?? {};
  const memory = fileConfig.memory ?? {};
  const episodes = fileConfig.episodes ?? {};

  const skillsDirValue = firstNonEmptyString(
    skills.dir,
    getVSCodeConfigValue<string>(vscodeConfig, 'skills.dir'),
    process.env.KRAKEN_SKILLS_DIR
  );
  const skillsDir = normalizeOptionalPath(skillsDirValue);

  const browserAllowedDomains = normalizeDomainList(firstNonEmptyStringOrArray(
    agent.browserAllowedDomains,
    getVSCodeConfigValue<string>(vscodeConfig, 'agent.browserAllowedDomains'),
    process.env.AGENT_BROWSER_ALLOWED_DOMAINS
  ));

  return {
    model: {
      baseUrl: normalizeBaseUrl(stringValue(
        model.baseUrl,
        getVSCodeConfigValue<string>(vscodeConfig, 'model.baseUrl'),
        'https://api.openai.com/v1'
      )),
      name: stringValue(model.name, getVSCodeConfigValue<string>(vscodeConfig, 'model.name'), '').trim(),
      ...(normalizeOptionalString(model.proxy) ? { proxy: normalizeOptionalString(model.proxy) } : {}),
    },
    context: {
      maxChars: numberValue(context.maxChars, getVSCodeConfigValue<number>(vscodeConfig, 'context.maxChars'), 60000),
    },
    agent: {
      autoApply: booleanValue(agent.autoApply, getVSCodeConfigValue<boolean>(vscodeConfig, 'agent.autoApply'), false),
      allowTerminal: booleanValue(
        agent.allowTerminal,
        getVSCodeConfigValue<boolean>(vscodeConfig, 'agent.allowTerminal'),
        parseBoolean(process.env.ALLOW_SHELL_TOOL, false)
      ),
      allowFileWriteTool: booleanValue(
        agent.allowFileWriteTool,
        getVSCodeConfigValue<boolean>(vscodeConfig, 'agent.allowFileWriteTool'),
        parseBoolean(process.env.ALLOW_FILE_WRITE_TOOL, false)
      ),
      allowBrowserTool: booleanValue(
        agent.allowBrowserTool,
        getVSCodeConfigValue<boolean>(vscodeConfig, 'agent.allowBrowserTool'),
        parseBoolean(process.env.ALLOW_AGENT_BROWSER, false)
      ),
      browserBin: stringValue(
        agent.browserBin,
        getVSCodeConfigValue<string>(vscodeConfig, 'agent.browserBin'),
        process.env.AGENT_BROWSER_BIN,
        'agent-browser'
      ),
      browserMaxOutput: numberValue(
        agent.browserMaxOutput,
        getVSCodeConfigValue<number>(vscodeConfig, 'agent.browserMaxOutput'),
        parseInteger(process.env.AGENT_BROWSER_MAX_OUTPUT, 50000)
      ),
      browserDefaultTimeout: numberValue(
        agent.browserDefaultTimeout,
        getVSCodeConfigValue<number>(vscodeConfig, 'agent.browserDefaultTimeout'),
        parseInteger(process.env.AGENT_BROWSER_DEFAULT_TIMEOUT, 25000)
      ),
      ...(browserAllowedDomains ? { browserAllowedDomains } : {}),
    },
    skills: {
      ...(skillsDir ? { dir: skillsDir } : {}),
    },
    memory: {
      enabled: booleanValue(memory.enabled, getVSCodeConfigValue<boolean>(vscodeConfig, 'memory.enabled'), true),
      autoRead: booleanValue(memory.autoRead, getVSCodeConfigValue<boolean>(vscodeConfig, 'memory.autoRead'), true),
      maxChars: numberValue(memory.maxChars, getVSCodeConfigValue<number>(vscodeConfig, 'memory.maxChars'), 8000),
      allowWrite: booleanValue(memory.allowWrite, getVSCodeConfigValue<boolean>(vscodeConfig, 'memory.allowWrite'), false),
    },
    episodes: {
      enabled: booleanValue(episodes.enabled, getVSCodeConfigValue<boolean>(vscodeConfig, 'episodes.enabled'), true),
      autoCapture: booleanValue(
        episodes.autoCapture,
        getVSCodeConfigValue<boolean>(vscodeConfig, 'episodes.autoCapture'),
        true
      ),
      autoRecall: booleanValue(episodes.autoRecall, getVSCodeConfigValue<boolean>(vscodeConfig, 'episodes.autoRecall'), true),
      maxRecalled: numberValue(episodes.maxRecalled, getVSCodeConfigValue<number>(vscodeConfig, 'episodes.maxRecalled'), 3),
      maxChars: numberValue(episodes.maxChars, getVSCodeConfigValue<number>(vscodeConfig, 'episodes.maxChars'), 12000),
      storeTranscript: booleanValue(
        episodes.storeTranscript,
        getVSCodeConfigValue<boolean>(vscodeConfig, 'episodes.storeTranscript'),
        true
      ),
    },
    paths: {
      globalRoot: getGlobalKrakenRoot(),
      globalConfigPath: getGlobalConfigPath(),
      globalSkillDir: getGlobalSkillDir(),
      legacyGlobalSkillDir: getLegacyGlobalSkillDir(),
      builtinSkillDir: getBuiltinSkillDir(options.extensionRoot),
      ...(workspaceRoot ? { workspaceRoot } : {}),
      ...(workspaceConfigPath ? { workspaceConfigPath } : {}),
      ...(workspaceSkillDir ? { workspaceSkillDir } : {}),
      ...(legacyWorkspaceSkillDir ? { legacyWorkspaceSkillDir } : {}),
    },
  };
}

export async function updateGlobalKrakenConfig(patch: KrakenFileConfig): Promise<string> {
  const configPath = getGlobalConfigPath();
  const existing = readKrakenConfigFile(configPath);
  const updated = mergeFileConfig(existing, patch);
  await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
  await fs.promises.writeFile(configPath, serializeKrakenToml(updated), 'utf8');
  return configPath;
}

export function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function readKrakenConfigFile(configPath: string): KrakenFileConfig {
  if (!fs.existsSync(configPath)) {
    return {};
  }

  try {
    return normalizeParsedConfig(parseToml(fs.readFileSync(configPath, 'utf8')));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Failed to read Kraken config ${configPath}: ${message}`);
    return {};
  }
}

function parseToml(content: string): ParsedToml {
  const root: ParsedToml = {};
  let sectionPath: string[] = [];

  for (const rawLine of content.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) {
      continue;
    }

    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      sectionPath = splitDottedKey(sectionMatch[1] ?? '');
      ensureObject(root, sectionPath);
      continue;
    }

    const equalsIndex = findUnquotedEquals(line);
    if (equalsIndex < 0) {
      throw new Error(`Invalid TOML line: ${rawLine}`);
    }

    const keyPath = splitDottedKey(line.slice(0, equalsIndex).trim());
    if (keyPath.length === 0) {
      throw new Error(`Invalid TOML key: ${rawLine}`);
    }

    setNestedValue(root, [...sectionPath, ...keyPath], parseTomlValue(line.slice(equalsIndex + 1)));
  }

  return root;
}

function normalizeParsedConfig(parsed: ParsedToml): KrakenFileConfig {
  const model = asRecord(parsed.model);
  const context = asRecord(parsed.context);
  const agent = asRecord(parsed.agent);
  const skills = asRecord(parsed.skills);
  const memory = asRecord(parsed.memory);
  const episodes = asRecord(parsed.episodes);
  const config: KrakenFileConfig = {};

  if (model) {
    const baseUrl = firstDefined(getString(model, 'baseUrl'), getString(model, 'base_url'));
    const name = firstDefined(getString(model, 'name'), getString(model, 'model'));
    const proxy = getString(model, 'proxy');
    config.model = {
      ...(baseUrl !== undefined ? { baseUrl } : {}),
      ...(name !== undefined ? { name } : {}),
      ...(proxy !== undefined ? { proxy } : {}),
    };
  }

  if (context) {
    const maxChars = firstDefined(getNumber(context, 'maxChars'), getNumber(context, 'max_chars'));
    config.context = {
      ...(maxChars !== undefined ? { maxChars } : {}),
    };
  }

  if (agent) {
    const autoApply = firstDefined(getBoolean(agent, 'autoApply'), getBoolean(agent, 'auto_apply'));
    const allowTerminal = firstDefined(getBoolean(agent, 'allowTerminal'), getBoolean(agent, 'allow_terminal'));
    const allowFileWriteTool = firstDefined(
      getBoolean(agent, 'allowFileWriteTool'),
      getBoolean(agent, 'allow_file_write_tool')
    );
    const allowBrowserTool = firstDefined(getBoolean(agent, 'allowBrowserTool'), getBoolean(agent, 'allow_browser_tool'));
    const browserBin = firstDefined(getString(agent, 'browserBin'), getString(agent, 'browser_bin'));
    const browserMaxOutput = firstDefined(getNumber(agent, 'browserMaxOutput'), getNumber(agent, 'browser_max_output'));
    const browserDefaultTimeout = firstDefined(
      getNumber(agent, 'browserDefaultTimeout'),
      getNumber(agent, 'browser_default_timeout')
    );
    const browserAllowedDomains = firstDefined(
      getStringOrStringArray(agent, 'browserAllowedDomains'),
      getStringOrStringArray(agent, 'browser_allowed_domains')
    );

    config.agent = {
      ...(autoApply !== undefined ? { autoApply } : {}),
      ...(allowTerminal !== undefined ? { allowTerminal } : {}),
      ...(allowFileWriteTool !== undefined ? { allowFileWriteTool } : {}),
      ...(allowBrowserTool !== undefined ? { allowBrowserTool } : {}),
      ...(browserBin !== undefined ? { browserBin } : {}),
      ...(browserMaxOutput !== undefined ? { browserMaxOutput } : {}),
      ...(browserDefaultTimeout !== undefined ? { browserDefaultTimeout } : {}),
      ...(browserAllowedDomains !== undefined ? { browserAllowedDomains } : {}),
    };
  }

  if (skills) {
    const dir = firstDefined(getString(skills, 'dir'), getString(skills, 'directory'));
    config.skills = {
      ...(dir !== undefined ? { dir } : {}),
    };
  }

  if (memory) {
    const enabled = getBoolean(memory, 'enabled');
    const autoRead = firstDefined(getBoolean(memory, 'autoRead'), getBoolean(memory, 'auto_read'));
    const maxChars = firstDefined(getNumber(memory, 'maxChars'), getNumber(memory, 'max_chars'));
    const allowWrite = firstDefined(getBoolean(memory, 'allowWrite'), getBoolean(memory, 'allow_write'));
    config.memory = {
      ...(enabled !== undefined ? { enabled } : {}),
      ...(autoRead !== undefined ? { autoRead } : {}),
      ...(maxChars !== undefined ? { maxChars } : {}),
      ...(allowWrite !== undefined ? { allowWrite } : {}),
    };
  }

  if (episodes) {
    const enabled = getBoolean(episodes, 'enabled');
    const autoCapture = firstDefined(getBoolean(episodes, 'autoCapture'), getBoolean(episodes, 'auto_capture'));
    const autoRecall = firstDefined(getBoolean(episodes, 'autoRecall'), getBoolean(episodes, 'auto_recall'));
    const maxRecalled = firstDefined(getNumber(episodes, 'maxRecalled'), getNumber(episodes, 'max_recalled'));
    const maxChars = firstDefined(getNumber(episodes, 'maxChars'), getNumber(episodes, 'max_chars'));
    const storeTranscript = firstDefined(getBoolean(episodes, 'storeTranscript'), getBoolean(episodes, 'store_transcript'));
    config.episodes = {
      ...(enabled !== undefined ? { enabled } : {}),
      ...(autoCapture !== undefined ? { autoCapture } : {}),
      ...(autoRecall !== undefined ? { autoRecall } : {}),
      ...(maxRecalled !== undefined ? { maxRecalled } : {}),
      ...(maxChars !== undefined ? { maxChars } : {}),
      ...(storeTranscript !== undefined ? { storeTranscript } : {}),
    };
  }

  return config;
}

function mergeFileConfig(base: KrakenFileConfig, override: KrakenFileConfig): KrakenFileConfig {
  return {
    ...(mergeSection(base.model, override.model) ? { model: mergeSection(base.model, override.model) } : {}),
    ...(mergeSection(base.context, override.context) ? { context: mergeSection(base.context, override.context) } : {}),
    ...(mergeSection(base.agent, override.agent) ? { agent: mergeSection(base.agent, override.agent) } : {}),
    ...(mergeSection(base.skills, override.skills) ? { skills: mergeSection(base.skills, override.skills) } : {}),
    ...(mergeSection(base.memory, override.memory) ? { memory: mergeSection(base.memory, override.memory) } : {}),
    ...(mergeSection(base.episodes, override.episodes) ? { episodes: mergeSection(base.episodes, override.episodes) } : {}),
  };
}

function mergeSection<T extends Record<string, unknown>>(base?: T, override?: T): T | undefined {
  const merged = {
    ...(base ?? {}),
    ...(override ?? {}),
  } as T;
  return Object.keys(merged).length ? merged : undefined;
}

function serializeKrakenToml(config: KrakenFileConfig): string {
  const sections: string[] = [];
  pushSection(sections, 'model', config.model);
  pushSection(sections, 'context', config.context);
  pushSection(sections, 'agent', config.agent);
  pushSection(sections, 'skills', config.skills);
  pushSection(sections, 'memory', config.memory);
  pushSection(sections, 'episodes', config.episodes);
  return sections.join('\n\n').trimEnd() + '\n';
}

function pushSection(sections: string[], name: string, values?: Record<string, unknown>): void {
  if (!values) {
    return;
  }

  const lines = Object.entries(values)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key} = ${formatTomlValue(value)}`);

  if (lines.length) {
    sections.push([`[${name}]`, ...lines].join('\n'));
  }
}

function formatTomlValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(formatTomlValue).join(', ')}]`;
  }
  if (typeof value === 'boolean' || typeof value === 'number') {
    return String(value);
  }
  return JSON.stringify(String(value ?? ''));
}

function stripTomlComment(line: string): string {
  let quote: '"' | "'" | undefined;
  let escaped = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote === '"') {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        quote = undefined;
      }
      continue;
    }
    if (quote === "'") {
      if (char === "'") {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '#') {
      return line.slice(0, index);
    }
  }

  return line;
}

function findUnquotedEquals(line: string): number {
  let quote: '"' | "'" | undefined;
  let escaped = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote === '"') {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        quote = undefined;
      }
      continue;
    }
    if (quote === "'") {
      if (char === "'") {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '=') {
      return index;
    }
  }

  return -1;
}

function parseTomlValue(rawValue: string): TomlValue {
  const value = rawValue.trim();
  if (value.startsWith('[') && value.endsWith(']')) {
    return splitTomlArray(value.slice(1, -1)).map(parseTomlValue) as TomlPrimitive[];
  }
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  if (/^[+-]?\d+(?:\.\d+)?$/.test(value)) {
    return Number(value);
  }
  return value;
}

function splitTomlArray(value: string): string[] {
  const items: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let escaped = false;

  for (const char of value) {
    if (quote === '"') {
      current += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        quote = undefined;
      }
      continue;
    }
    if (quote === "'") {
      current += char;
      if (char === "'") {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === ',') {
      if (current.trim()) {
        items.push(current.trim());
      }
      current = '';
      continue;
    }
    current += char;
  }

  if (current.trim()) {
    items.push(current.trim());
  }
  return items;
}

function splitDottedKey(value: string): string[] {
  return value.split('.').map((part) => part.trim()).filter(Boolean);
}

function ensureObject(root: ParsedToml, keyPath: string[]): ParsedToml {
  let current = root;
  for (const key of keyPath) {
    const value = current[key];
    if (!asRecord(value)) {
      current[key] = {};
    }
    current = current[key] as ParsedToml;
  }
  return current;
}

function setNestedValue(root: ParsedToml, keyPath: string[], value: TomlValue): void {
  const parent = ensureObject(root, keyPath.slice(0, -1));
  const key = keyPath[keyPath.length - 1];
  if (!key) {
    throw new Error('Invalid empty TOML key');
  }
  parent[key] = value;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function getString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function getStringOrStringArray(record: Record<string, unknown>, key: string): string | string[] | undefined {
  const value = record[key];
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return value;
  }
  return undefined;
}

function getNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function getBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}

function firstDefined<T>(...values: Array<T | undefined>): T | undefined {
  return values.find((value) => value !== undefined);
}

function firstNonEmptyString(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => typeof value === 'string' && value.trim());
}

function firstNonEmptyStringOrArray(
  ...values: Array<string | string[] | undefined>
): string | string[] | undefined {
  return values.find((value) => {
    if (Array.isArray(value)) {
      return value.some((item) => item.trim());
    }
    return typeof value === 'string' && value.trim();
  });
}

function getVSCodeConfigValue<T>(config: vscode.WorkspaceConfiguration, key: string): T | undefined {
  const inspected = config.inspect<T>(key);
  return firstDefined(inspected?.workspaceFolderValue, inspected?.workspaceValue, inspected?.globalValue);
}

function stringValue(...values: Array<string | undefined>): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function numberValue(...values: Array<number | undefined>): number {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return 0;
}

function booleanValue(...values: Array<boolean | undefined>): boolean {
  for (const value of values) {
    if (typeof value === 'boolean') {
      return value;
    }
  }
  return false;
}

function normalizeOptionalPath(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim()
    ? path.resolve(expandHomePath(value.trim()))
    : undefined;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeDomainList(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const domains = value.map((item) => String(item).trim()).filter(Boolean);
    return domains.length ? domains.join(',') : undefined;
  }
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  return undefined;
}
