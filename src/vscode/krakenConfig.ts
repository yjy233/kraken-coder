import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { expandHomePath, parseInteger } from '../utils/helpers';
import { getWorkspaceRoot } from './workspace';
import type { LspLanguage } from '../lsp/types';
import type {
  ModelApiMode,
  ModelCacheStrategy,
  ModelProvider,
  ModelReasoningDisplay,
  ModelReasoningEffort
} from '../shared/types';

type TomlPrimitive = string | number | boolean;
type TomlValue = TomlPrimitive | TomlPrimitive[];
type ParsedToml = Record<string, unknown>;

export interface KrakenFileConfig {
  model?: {
    baseUrl?: string;
    name?: string;
    proxy?: string;
    apiKey?: string;
    provider?: ModelProvider;
    api?: ModelApiMode;
    reasoning?: Partial<KrakenModelReasoningConfig>;
    cache?: Partial<KrakenModelCacheConfig>;
  };
  providers?: Partial<KrakenProviderFileConfig>;
  context?: {
    maxChars?: number;
  };
  agent?: {
    autoApply?: boolean;
    browserBin?: string;
    browserMaxOutput?: number;
    browserDefaultTimeout?: number;
    maxSteps?: number;
    browserAllowedDomains?: string | string[];
  };
  skills?: {
    dir?: string;
  };
  lsp?: {
    adapter?: string;
    maxResults?: number;
    hoverMaxChars?: number;
    timeoutMs?: number;
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
  sessions?: {
    enabled?: boolean;
  };
}

export interface KrakenModelReasoningConfig {
  enabled: boolean;
  effort: ModelReasoningEffort;
  display: ModelReasoningDisplay;
  budgetTokens: number;
  preserve: boolean;
  maxStoredTokens: number;
}

export interface KrakenModelCacheConfig {
  enabled: boolean;
  strategy: ModelCacheStrategy;
  retention: string;
}

export interface KrakenProviderFileConfig {
  openai: {
    api?: 'responses' | 'chat-completions';
    effort?: ModelReasoningEffort;
    promptCacheKey?: string;
    promptCacheRetention?: string;
  };
  anthropic: {
    api?: 'messages';
    thinking?: 'auto' | 'adaptive' | 'enabled' | 'disabled';
    effort?: ModelReasoningEffort;
    thinkingBudgetTokens?: number;
    maxTokens?: number;
    preserveThinking?: boolean;
    cacheTtl?: string;
  };
  qwen: {
    api?: 'chat-completions';
    enableThinking?: boolean;
    thinkingBudget?: number;
    preserveThinking?: boolean;
    cacheMode?: 'auto' | 'explicit' | 'implicit' | 'disabled';
  };
}

export interface KrakenConfig {
  model: {
    baseUrl: string;
    name: string;
    proxy?: string;
    apiKey: string;
    provider: ModelProvider;
    api: ModelApiMode;
    reasoning: KrakenModelReasoningConfig;
    cache: KrakenModelCacheConfig;
  };
  providers: {
    openai: Required<KrakenProviderFileConfig['openai']>;
    anthropic: Required<KrakenProviderFileConfig['anthropic']>;
    qwen: Required<KrakenProviderFileConfig['qwen']>;
  };
  context: {
    maxChars: number;
  };
  agent: {
    autoApply: boolean;
    browserBin: string;
    browserMaxOutput: number;
    browserDefaultTimeout: number;
    maxSteps: number;
    browserAllowedDomains?: string;
  };
  skills: {
    dir?: string;
  };
  lsp: {
    adapter: 'auto' | 'vscode' | 'process';
    languages: LspLanguage[];
    maxResults: number;
    hoverMaxChars: number;
    timeoutMs: number;
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
  sessions: {
    enabled: boolean;
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
  const reasoning = model.reasoning ?? {};
  const cache = model.cache ?? {};
  const providers = fileConfig.providers ?? {};
  const openai = providers.openai ?? {};
  const anthropic = providers.anthropic ?? {};
  const qwen = providers.qwen ?? {};
  const skills = fileConfig.skills ?? {};
  const lsp = fileConfig.lsp ?? {};
  const memory = fileConfig.memory ?? {};
  const episodes = fileConfig.episodes ?? {};
  const sessions = fileConfig.sessions ?? {};

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
        'https://openrouter.ai/api/v1'
      )),
      name: stringValue(model.name, getVSCodeConfigValue<string>(vscodeConfig, 'model.name'), 'qwen/qwen3.6-plus').trim(),
      apiKey: stringValue(model.apiKey, ''),
      provider: normalizeModelProvider(stringValue(
        model.provider,
        getVSCodeConfigValue<string>(vscodeConfig, 'model.provider'),
        'openrouter'
      )),
      api: normalizeModelApi(stringValue(
        model.api,
        getVSCodeConfigValue<string>(vscodeConfig, 'model.api'),
        'chat-completions'
      )),
      reasoning: {
        enabled: booleanValue(reasoning.enabled, getVSCodeConfigValue<boolean>(vscodeConfig, 'model.reasoning.enabled'), true),
        effort: normalizeReasoningEffort(stringValue(
          reasoning.effort,
          getVSCodeConfigValue<string>(vscodeConfig, 'model.reasoning.effort'),
          'medium'
        )),
        display: normalizeReasoningDisplay(stringValue(
          reasoning.display,
          getVSCodeConfigValue<string>(vscodeConfig, 'model.reasoning.display'),
          'hidden'
        )),
        budgetTokens: Math.max(
          0,
          Math.floor(numberValue(
            reasoning.budgetTokens,
            getVSCodeConfigValue<number>(vscodeConfig, 'model.reasoning.budgetTokens'),
            0
          ))
        ),
        preserve: booleanValue(reasoning.preserve, getVSCodeConfigValue<boolean>(vscodeConfig, 'model.reasoning.preserve'), false),
        maxStoredTokens: Math.max(
          0,
          Math.floor(numberValue(
            reasoning.maxStoredTokens,
            getVSCodeConfigValue<number>(vscodeConfig, 'model.reasoning.maxStoredTokens'),
            4096
          ))
        ),
      },
      cache: {
        enabled: booleanValue(cache.enabled, getVSCodeConfigValue<boolean>(vscodeConfig, 'model.cache.enabled'), true),
        strategy: normalizeCacheStrategy(stringValue(
          cache.strategy,
          getVSCodeConfigValue<string>(vscodeConfig, 'model.cache.strategy'),
          'auto'
        )),
        retention: stringValue(
          cache.retention,
          getVSCodeConfigValue<string>(vscodeConfig, 'model.cache.retention'),
          'in_memory'
        ),
      },
      ...(normalizeOptionalString(model.proxy) ? { proxy: normalizeOptionalString(model.proxy) } : {}),
    },
    providers: {
      openai: {
        api: normalizeOpenAIApi(stringValue(openai.api, getVSCodeConfigValue<string>(vscodeConfig, 'providers.openai.api'), 'responses')),
        effort: normalizeReasoningEffort(stringValue(openai.effort, getVSCodeConfigValue<string>(vscodeConfig, 'providers.openai.effort'), 'medium')),
        promptCacheKey: stringValue(
          openai.promptCacheKey,
          getVSCodeConfigValue<string>(vscodeConfig, 'providers.openai.promptCacheKey'),
          'workspace'
        ),
        promptCacheRetention: stringValue(
          openai.promptCacheRetention,
          getVSCodeConfigValue<string>(vscodeConfig, 'providers.openai.promptCacheRetention'),
          'in_memory'
        ),
      },
      anthropic: {
        api: 'messages',
        thinking: normalizeAnthropicThinking(stringValue(
          anthropic.thinking,
          getVSCodeConfigValue<string>(vscodeConfig, 'providers.anthropic.thinking'),
          'adaptive'
        )),
        effort: normalizeReasoningEffort(stringValue(
          anthropic.effort,
          getVSCodeConfigValue<string>(vscodeConfig, 'providers.anthropic.effort'),
          'medium'
        )),
        thinkingBudgetTokens: Math.max(
          0,
          Math.floor(numberValue(
            anthropic.thinkingBudgetTokens,
            getVSCodeConfigValue<number>(vscodeConfig, 'providers.anthropic.thinkingBudgetTokens'),
            16000
          ))
        ),
        maxTokens: Math.max(
          1,
          Math.floor(numberValue(
            anthropic.maxTokens,
            getVSCodeConfigValue<number>(vscodeConfig, 'providers.anthropic.maxTokens'),
            32000
          ))
        ),
        preserveThinking: booleanValue(
          anthropic.preserveThinking,
          getVSCodeConfigValue<boolean>(vscodeConfig, 'providers.anthropic.preserveThinking'),
          true
        ),
        cacheTtl: normalizeCacheTtl(stringValue(
          anthropic.cacheTtl,
          getVSCodeConfigValue<string>(vscodeConfig, 'providers.anthropic.cacheTtl'),
          '5m'
        )),
      },
      qwen: {
        api: 'chat-completions',
        enableThinking: booleanValue(
          qwen.enableThinking,
          getVSCodeConfigValue<boolean>(vscodeConfig, 'providers.qwen.enableThinking'),
          true
        ),
        thinkingBudget: Math.max(
          0,
          Math.floor(numberValue(
            qwen.thinkingBudget,
            getVSCodeConfigValue<number>(vscodeConfig, 'providers.qwen.thinkingBudget'),
            8192
          ))
        ),
        preserveThinking: booleanValue(
          qwen.preserveThinking,
          getVSCodeConfigValue<boolean>(vscodeConfig, 'providers.qwen.preserveThinking'),
          false
        ),
        cacheMode: normalizeQwenCacheMode(stringValue(
          qwen.cacheMode,
          getVSCodeConfigValue<string>(vscodeConfig, 'providers.qwen.cacheMode'),
          'auto'
        )),
      },
    },
    context: {
      maxChars: numberValue(context.maxChars, getVSCodeConfigValue<number>(vscodeConfig, 'context.maxChars'), 60000),
    },
    agent: {
      autoApply: booleanValue(agent.autoApply, getVSCodeConfigValue<boolean>(vscodeConfig, 'agent.autoApply'), false),
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
      maxSteps: Math.max(
        1,
        Math.floor(numberValue(
          agent.maxSteps,
          getVSCodeConfigValue<number>(vscodeConfig, 'agent.maxSteps'),
          8
        ))
      ),
      ...(browserAllowedDomains ? { browserAllowedDomains } : {}),
    },
    skills: {
      ...(skillsDir ? { dir: skillsDir } : {}),
    },
    lsp: {
      adapter: normalizeLspAdapter(stringValue(
        lsp.adapter,
        getVSCodeConfigValue<string>(vscodeConfig, 'lsp.adapter'),
        'auto'
      )),
      languages: ['typescript', 'go', 'python'],
      maxResults: Math.max(
        1,
        Math.floor(numberValue(lsp.maxResults, getVSCodeConfigValue<number>(vscodeConfig, 'lsp.maxResults'), 50))
      ),
      hoverMaxChars: Math.max(
        0,
        Math.floor(numberValue(lsp.hoverMaxChars, getVSCodeConfigValue<number>(vscodeConfig, 'lsp.hoverMaxChars'), 4000))
      ),
      timeoutMs: Math.max(
        1000,
        Math.floor(numberValue(lsp.timeoutMs, getVSCodeConfigValue<number>(vscodeConfig, 'lsp.timeoutMs'), 8000))
      ),
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
    sessions: {
      enabled: booleanValue(sessions.enabled, getVSCodeConfigValue<boolean>(vscodeConfig, 'sessions.enabled'), true),
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
  const providers = asRecord(parsed.providers);
  const context = asRecord(parsed.context);
  const agent = asRecord(parsed.agent);
  const skills = asRecord(parsed.skills);
  const lsp = asRecord(parsed.lsp);
  const memory = asRecord(parsed.memory);
  const episodes = asRecord(parsed.episodes);
  const sessions = asRecord(parsed.sessions);
  const config: KrakenFileConfig = {};

  if (model) {
    const baseUrl = firstDefined(getString(model, 'baseUrl'), getString(model, 'base_url'));
    const name = firstDefined(getString(model, 'name'), getString(model, 'model'));
    const proxy = getString(model, 'proxy');
    const apiKey = firstDefined(getString(model, 'apiKey'), getString(model, 'api_key'));
    const provider = getString(model, 'provider');
    const api = getString(model, 'api');
    const modelReasoning = asRecord(model.reasoning);
    const modelCache = asRecord(model.cache);
    config.model = {
      ...(baseUrl !== undefined ? { baseUrl } : {}),
      ...(name !== undefined ? { name } : {}),
      ...(proxy !== undefined ? { proxy } : {}),
      ...(apiKey !== undefined ? { apiKey } : {}),
      ...(provider !== undefined ? { provider: normalizeModelProvider(provider) } : {}),
      ...(api !== undefined ? { api: normalizeModelApi(api) } : {}),
      ...(modelReasoning ? { reasoning: normalizeReasoningSection(modelReasoning) } : {}),
      ...(modelCache ? { cache: normalizeCacheSection(modelCache) } : {}),
    };
  }

  if (providers) {
    const openai = asRecord(providers.openai);
    const anthropic = asRecord(providers.anthropic);
    const qwen = asRecord(providers.qwen);
    config.providers = {
      ...(openai ? { openai: normalizeOpenAIProviderSection(openai) } : {}),
      ...(anthropic ? { anthropic: normalizeAnthropicProviderSection(anthropic) } : {}),
      ...(qwen ? { qwen: normalizeQwenProviderSection(qwen) } : {}),
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
    const browserBin = firstDefined(getString(agent, 'browserBin'), getString(agent, 'browser_bin'));
    const browserMaxOutput = firstDefined(getNumber(agent, 'browserMaxOutput'), getNumber(agent, 'browser_max_output'));
    const browserDefaultTimeout = firstDefined(
      getNumber(agent, 'browserDefaultTimeout'),
      getNumber(agent, 'browser_default_timeout')
    );
    const maxSteps = firstDefined(getNumber(agent, 'maxSteps'), getNumber(agent, 'max_steps'));
    const browserAllowedDomains = firstDefined(
      getStringOrStringArray(agent, 'browserAllowedDomains'),
      getStringOrStringArray(agent, 'browser_allowed_domains')
    );

    config.agent = {
      ...(autoApply !== undefined ? { autoApply } : {}),
      ...(browserBin !== undefined ? { browserBin } : {}),
      ...(browserMaxOutput !== undefined ? { browserMaxOutput } : {}),
      ...(browserDefaultTimeout !== undefined ? { browserDefaultTimeout } : {}),
      ...(maxSteps !== undefined ? { maxSteps } : {}),
      ...(browserAllowedDomains !== undefined ? { browserAllowedDomains } : {}),
    };
  }

  if (skills) {
    const dir = firstDefined(getString(skills, 'dir'), getString(skills, 'directory'));
    config.skills = {
      ...(dir !== undefined ? { dir } : {}),
    };
  }

  if (lsp) {
    const enabled = getBoolean(lsp, 'enabled');
    const adapter = getString(lsp, 'adapter');
    const languages = getStringArray(lsp, 'languages');
    const maxResults = firstDefined(getNumber(lsp, 'maxResults'), getNumber(lsp, 'max_results'));
    const hoverMaxChars = firstDefined(getNumber(lsp, 'hoverMaxChars'), getNumber(lsp, 'hover_max_chars'));
    const timeoutMs = firstDefined(getNumber(lsp, 'timeoutMs'), getNumber(lsp, 'timeout_ms'));
    config.lsp = {
      ...(enabled !== undefined ? { enabled } : {}),
      ...(adapter !== undefined ? { adapter } : {}),
      ...(languages !== undefined ? { languages } : {}),
      ...(maxResults !== undefined ? { maxResults } : {}),
      ...(hoverMaxChars !== undefined ? { hoverMaxChars } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
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

  if (sessions) {
    const enabled = getBoolean(sessions, 'enabled');
    config.sessions = {
      ...(enabled !== undefined ? { enabled } : {}),
    };
  }

  return config;
}

function mergeFileConfig(base: KrakenFileConfig, override: KrakenFileConfig): KrakenFileConfig {
  return {
    ...(mergeModelSection(base.model, override.model) ? { model: mergeModelSection(base.model, override.model) } : {}),
    ...(mergeProvidersSection(base.providers, override.providers) ? { providers: mergeProvidersSection(base.providers, override.providers) } : {}),
    ...(mergeSection(base.context, override.context) ? { context: mergeSection(base.context, override.context) } : {}),
    ...(mergeSection(base.agent, override.agent) ? { agent: mergeSection(base.agent, override.agent) } : {}),
    ...(mergeSection(base.skills, override.skills) ? { skills: mergeSection(base.skills, override.skills) } : {}),
    ...(mergeSection(base.lsp, override.lsp) ? { lsp: mergeSection(base.lsp, override.lsp) } : {}),
    ...(mergeSection(base.memory, override.memory) ? { memory: mergeSection(base.memory, override.memory) } : {}),
    ...(mergeSection(base.episodes, override.episodes) ? { episodes: mergeSection(base.episodes, override.episodes) } : {}),
    ...(mergeSection(base.sessions, override.sessions) ? { sessions: mergeSection(base.sessions, override.sessions) } : {}),
  };
}

function mergeModelSection(
  base?: KrakenFileConfig['model'],
  override?: KrakenFileConfig['model']
): KrakenFileConfig['model'] | undefined {
  const merged = mergeSection(base, override);
  if (!merged) {
    return undefined;
  }
  const reasoning = mergeSection(base?.reasoning, override?.reasoning);
  const cache = mergeSection(base?.cache, override?.cache);
  return {
    ...merged,
    ...(reasoning ? { reasoning } : {}),
    ...(cache ? { cache } : {}),
  };
}

function mergeProvidersSection(
  base?: Partial<KrakenProviderFileConfig>,
  override?: Partial<KrakenProviderFileConfig>
): Partial<KrakenProviderFileConfig> | undefined {
  const openai = mergeSection(base?.openai, override?.openai);
  const anthropic = mergeSection(base?.anthropic, override?.anthropic);
  const qwen = mergeSection(base?.qwen, override?.qwen);
  const merged = {
    ...(openai ? { openai } : {}),
    ...(anthropic ? { anthropic } : {}),
    ...(qwen ? { qwen } : {}),
  };
  return Object.keys(merged).length ? merged : undefined;
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
  const model = config.model
    ? { ...config.model, reasoning: undefined, cache: undefined }
    : undefined;
  pushSection(sections, 'model', model);
  pushSection(sections, 'model.reasoning', config.model?.reasoning);
  pushSection(sections, 'model.cache', config.model?.cache);
  pushSection(sections, 'providers.openai', config.providers?.openai);
  pushSection(sections, 'providers.anthropic', config.providers?.anthropic);
  pushSection(sections, 'providers.qwen', config.providers?.qwen);
  pushSection(sections, 'context', config.context);
  pushSection(sections, 'agent', config.agent);
  pushSection(sections, 'skills', config.skills);
  pushSection(sections, 'lsp', config.lsp);
  pushSection(sections, 'memory', config.memory);
  pushSection(sections, 'episodes', config.episodes);
  pushSection(sections, 'sessions', config.sessions);
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

function getStringArray(record: Record<string, unknown>, key: string): string[] | undefined {
  const value = record[key];
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : undefined;
}

function getNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function getBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}

function normalizeReasoningSection(record: Record<string, unknown>): Partial<KrakenModelReasoningConfig> {
  const enabled = getBoolean(record, 'enabled');
  const effort = getString(record, 'effort');
  const display = getString(record, 'display');
  const budgetTokens = firstDefined(getNumber(record, 'budgetTokens'), getNumber(record, 'budget_tokens'));
  const preserve = getBoolean(record, 'preserve');
  const maxStoredTokens = firstDefined(getNumber(record, 'maxStoredTokens'), getNumber(record, 'max_stored_tokens'));

  return {
    ...(enabled !== undefined ? { enabled } : {}),
    ...(effort !== undefined ? { effort: normalizeReasoningEffort(effort) } : {}),
    ...(display !== undefined ? { display: normalizeReasoningDisplay(display) } : {}),
    ...(budgetTokens !== undefined ? { budgetTokens } : {}),
    ...(preserve !== undefined ? { preserve } : {}),
    ...(maxStoredTokens !== undefined ? { maxStoredTokens } : {}),
  };
}

function normalizeCacheSection(record: Record<string, unknown>): Partial<KrakenModelCacheConfig> {
  const enabled = getBoolean(record, 'enabled');
  const strategy = getString(record, 'strategy');
  const retention = getString(record, 'retention');

  return {
    ...(enabled !== undefined ? { enabled } : {}),
    ...(strategy !== undefined ? { strategy: normalizeCacheStrategy(strategy) } : {}),
    ...(retention !== undefined ? { retention } : {}),
  };
}

function normalizeOpenAIProviderSection(
  record: Record<string, unknown>
): Partial<KrakenProviderFileConfig['openai']> {
  const api = getString(record, 'api');
  const effort = getString(record, 'effort');
  const promptCacheKey = firstDefined(getString(record, 'promptCacheKey'), getString(record, 'prompt_cache_key'));
  const promptCacheRetention = firstDefined(
    getString(record, 'promptCacheRetention'),
    getString(record, 'prompt_cache_retention')
  );

  return {
    ...(api !== undefined ? { api: normalizeOpenAIApi(api) } : {}),
    ...(effort !== undefined ? { effort: normalizeReasoningEffort(effort) } : {}),
    ...(promptCacheKey !== undefined ? { promptCacheKey } : {}),
    ...(promptCacheRetention !== undefined ? { promptCacheRetention } : {}),
  };
}

function normalizeAnthropicProviderSection(
  record: Record<string, unknown>
): Partial<KrakenProviderFileConfig['anthropic']> {
  const api = getString(record, 'api');
  const thinking = getString(record, 'thinking');
  const effort = getString(record, 'effort');
  const thinkingBudgetTokens = firstDefined(
    getNumber(record, 'thinkingBudgetTokens'),
    getNumber(record, 'thinking_budget_tokens')
  );
  const maxTokens = firstDefined(getNumber(record, 'maxTokens'), getNumber(record, 'max_tokens'));
  const preserveThinking = firstDefined(
    getBoolean(record, 'preserveThinking'),
    getBoolean(record, 'preserve_thinking')
  );
  const cacheTtl = firstDefined(getString(record, 'cacheTtl'), getString(record, 'cache_ttl'));

  return {
    ...(api !== undefined ? { api: 'messages' } : {}),
    ...(thinking !== undefined ? { thinking: normalizeAnthropicThinking(thinking) } : {}),
    ...(effort !== undefined ? { effort: normalizeReasoningEffort(effort) } : {}),
    ...(thinkingBudgetTokens !== undefined ? { thinkingBudgetTokens } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(preserveThinking !== undefined ? { preserveThinking } : {}),
    ...(cacheTtl !== undefined ? { cacheTtl: normalizeCacheTtl(cacheTtl) } : {}),
  };
}

function normalizeQwenProviderSection(
  record: Record<string, unknown>
): Partial<KrakenProviderFileConfig['qwen']> {
  const api = getString(record, 'api');
  const enableThinking = firstDefined(getBoolean(record, 'enableThinking'), getBoolean(record, 'enable_thinking'));
  const thinkingBudget = firstDefined(getNumber(record, 'thinkingBudget'), getNumber(record, 'thinking_budget'));
  const preserveThinking = firstDefined(
    getBoolean(record, 'preserveThinking'),
    getBoolean(record, 'preserve_thinking')
  );
  const cacheMode = firstDefined(getString(record, 'cacheMode'), getString(record, 'cache_mode'));

  return {
    ...(api !== undefined ? { api: 'chat-completions' } : {}),
    ...(enableThinking !== undefined ? { enableThinking } : {}),
    ...(thinkingBudget !== undefined ? { thinkingBudget } : {}),
    ...(preserveThinking !== undefined ? { preserveThinking } : {}),
    ...(cacheMode !== undefined ? { cacheMode: normalizeQwenCacheMode(cacheMode) } : {}),
  };
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

function normalizeModelProvider(value: string): ModelProvider {
  const normalized = value.trim().toLowerCase();
  if (
    normalized === 'openai' ||
    normalized === 'openrouter' ||
    normalized === 'anthropic' ||
    normalized === 'qwen' ||
    normalized === 'openai-compatible'
  ) {
    return normalized;
  }
  return 'openai-compatible';
}

function normalizeModelApi(value: string): ModelApiMode {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'responses' || normalized === 'messages' || normalized === 'chat-completions') {
    return normalized;
  }
  return 'chat-completions';
}

function normalizeOpenAIApi(value: string): 'responses' | 'chat-completions' {
  return value.trim().toLowerCase() === 'chat-completions' ? 'chat-completions' : 'responses';
}

function normalizeReasoningEffort(value: string): ModelReasoningEffort {
  const normalized = value.trim().toLowerCase();
  if (
    normalized === 'none' ||
    normalized === 'minimal' ||
    normalized === 'low' ||
    normalized === 'medium' ||
    normalized === 'high' ||
    normalized === 'xhigh' ||
    normalized === 'max'
  ) {
    return normalized;
  }
  return 'medium';
}

function normalizeReasoningDisplay(value: string): ModelReasoningDisplay {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'hidden' || normalized === 'summary' || normalized === 'visible') {
    return normalized;
  }
  return 'hidden';
}

function normalizeCacheStrategy(value: string): ModelCacheStrategy {
  const normalized = value.trim().toLowerCase();
  if (
    normalized === 'auto' ||
    normalized === 'auto-prefix' ||
    normalized === 'explicit' ||
    normalized === 'explicit-blocks' ||
    normalized === 'implicit' ||
    normalized === 'disabled'
  ) {
    return normalized;
  }
  return 'auto';
}

function normalizeAnthropicThinking(value: string): 'auto' | 'adaptive' | 'enabled' | 'disabled' {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'auto' || normalized === 'adaptive' || normalized === 'enabled' || normalized === 'disabled') {
    return normalized;
  }
  return 'adaptive';
}

function normalizeQwenCacheMode(value: string): 'auto' | 'explicit' | 'implicit' | 'disabled' {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'auto' || normalized === 'explicit' || normalized === 'implicit' || normalized === 'disabled') {
    return normalized;
  }
  return 'auto';
}

function normalizeCacheTtl(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === '5m' || normalized === '1h') {
    return normalized;
  }
  return '5m';
}

function normalizeLspAdapter(value: string): KrakenConfig['lsp']['adapter'] {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'vscode' || normalized === 'process') {
    return normalized;
  }
  return 'auto';
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
