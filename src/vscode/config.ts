import * as vscode from 'vscode';
import type {
  ModelApiMode,
  ModelProvider,
  ModelReasoningDisplay,
  ModelReasoningEffort,
  ModelSettings
} from '../shared/types';
import { KrakenFileConfig, getKrakenConfig, normalizeBaseUrl, updateGlobalKrakenConfig } from './krakenConfig';

type ManagedProvider = Exclude<ModelProvider, 'openai-compatible'>;

export function getModelSettings(): ModelSettings {
  const config = getKrakenConfig();
  return {
    baseUrl: config.model.baseUrl,
    provider: config.model.provider,
    api: config.model.api,
    model: config.model.name,
    apiKey: config.model.apiKey,
    reasoning: config.model.reasoning,
    cache: config.model.cache,
    providers: config.providers,
    ...(config.model.proxy ? { proxy: config.model.proxy } : {})
  };
}

export async function ensureModelConfigured(): Promise<ModelSettings | undefined> {
  let current = getModelSettings();
  if (!current.model) {
    const model = await vscode.window.showInputBox({
      title: 'Kraken model name',
      prompt: 'Enter the model name to use.',
      ignoreFocusOut: true,
      placeHolder: 'qwen3.6-plus'
    });

    if (!model?.trim()) {
      return undefined;
    }

    await updateGlobalKrakenConfig({
      model: {
        name: model.trim()
      }
    });

    current = {
      ...current,
      model: model.trim()
    };
  }

  if (!current.apiKey) {
    const providerLabel = getProviderLabel(current.provider);
    const apiKey = await vscode.window.showInputBox({
      title: `Kraken ${providerLabel} API key`,
      prompt: `Enter the API key for ${providerLabel}.`,
      password: true,
      ignoreFocusOut: true,
      placeHolder: 'sk-...'
    });

    if (!apiKey?.trim()) {
      return undefined;
    }

    await updateGlobalKrakenConfig({
      ...buildProviderApiKeyPatch(current.provider, apiKey.trim())
    });

    current = {
      ...current,
      apiKey: apiKey.trim()
    };
  }

  return current;
}

export async function configureModel(): Promise<void> {
  ConfigPanel.show();
}

class ConfigPanel {
  private static current?: ConfigPanel;

  static show(): void {
    if (ConfigPanel.current) {
      ConfigPanel.current.panel.reveal(vscode.ViewColumn.One);
      ConfigPanel.current.render();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'krakenConfig',
      'Kraken Config',
      vscode.ViewColumn.One,
      { enableScripts: true }
    );
    ConfigPanel.current = new ConfigPanel(panel);
  }

  private constructor(private readonly panel: vscode.WebviewPanel) {
    this.panel.onDidDispose(() => {
      ConfigPanel.current = undefined;
    });
    this.panel.webview.onDidReceiveMessage((message: unknown) => {
      this.handleMessage(message).catch((error: unknown) => {
        const text = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(text);
        this.panel.webview.postMessage({ type: 'error', message: text });
      });
    });
    this.render();
  }

  render(): void {
    const config = getKrakenConfig();
    this.panel.webview.html = getConfigHtml(this.panel.webview, configToForm(config));
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!isRecord(message)) {
      return;
    }
    if (message.type === 'save' && isRecord(message.values)) {
      const patch = formToConfig(message.values);
      const configPath = await updateGlobalKrakenConfig(patch);
      vscode.window.showInformationMessage(`Kraken config saved: ${configPath}`);
      this.panel.webview.postMessage({ type: 'saved', path: configPath });
      return;
    }
    if (message.type === 'openFile') {
      const configPath = getKrakenConfig().paths.globalConfigPath;
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(configPath));
      await vscode.window.showTextDocument(document, { preview: false });
    }
  }
}

interface ConfigFormValues {
  modelSelection: string;
  modelProvider: string;
  modelBaseUrl: string;
  modelName: string;
  openrouterApiKey: string;
  openaiApiKey: string;
  anthropicApiKey: string;
  qwenApiKey: string;
  aicodemirrorApiKey: string;
  modelProxy: string;
  modelReasoningEnabled: boolean;
  modelReasoningEffort: string;
  modelReasoningDisplay: string;
  modelReasoningBudgetTokens: number;
  modelReasoningPreserve: boolean;
  modelReasoningMaxStoredTokens: number;
  modelCacheEnabled: boolean;
  modelCacheRetention: string;
  openaiApi: string;
  openaiEffort: string;
  openaiPromptCacheKey: string;
  openaiPromptCacheRetention: string;
  anthropicThinking: string;
  anthropicEffort: string;
  anthropicThinkingBudgetTokens: number;
  anthropicMaxTokens: number;
  anthropicPreserveThinking: boolean;
  anthropicCacheTtl: string;
  qwenEnableThinking: boolean;
  qwenThinkingBudget: number;
  qwenPreserveThinking: boolean;
  contextMaxChars: number;
  agentBrowserBin: string;
  agentBrowserMaxOutput: number;
  agentBrowserDefaultTimeout: number;
  agentMaxSteps: number;
  agentBrowserAllowedDomains: string;
  skillsDir: string;
  lspAdapter: string;
  lspMaxResults: number;
  lspHoverMaxChars: number;
  lspTimeoutMs: number;
  memoryEnabled: boolean;
  memoryAutoRead: boolean;
  memoryMaxChars: number;
  memoryAllowWrite: boolean;
  episodesEnabled: boolean;
  episodesAutoCapture: boolean;
  episodesAutoRecall: boolean;
  episodesMaxRecalled: number;
  episodesMaxChars: number;
  episodesStoreTranscript: boolean;
  sessionsEnabled: boolean;
}

interface SupportedModelOption {
  id: string;
  label: string;
  defaultProvider: Exclude<ModelProvider, 'openai-compatible'>;
  upstreamProvider: 'qwen' | 'openai' | 'anthropic' | 'aicodemirror';
  defaultApi: ModelApiMode;
  model: string;
  baseUrl: string;
  effortOptions: ModelReasoningEffort[];
}

interface ProviderOption {
  id: ManagedProvider;
  label: string;
  baseUrl: string;
  api: ModelApiMode;
}

const openRouterBaseUrl = 'https://openrouter.ai/api/v1';
const aiCodeMirrorBaseUrl = 'https://api.aicodemirror.com/api/codex/backend-api/codex/v1';
const providerOptions: ProviderOption[] = [
  { id: 'openrouter', label: 'OpenRouter', baseUrl: openRouterBaseUrl, api: 'chat-completions' },
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', api: 'responses' },
  { id: 'anthropic', label: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', api: 'messages' },
  { id: 'qwen', label: 'Qwen / DashScope', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', api: 'chat-completions' },
  { id: 'aicodemirror', label: 'AICodeMirror', baseUrl: aiCodeMirrorBaseUrl, api: 'responses' },
];

const supportedModelOptions: SupportedModelOption[] = [
  {
    id: 'qwen/qwen3.6-plus',
    label: 'qwen/qwen3.6-plus',
    defaultProvider: 'openrouter',
    upstreamProvider: 'qwen',
    defaultApi: 'chat-completions',
    model: 'qwen/qwen3.6-plus',
    baseUrl: openRouterBaseUrl,
    effortOptions: ['low', 'medium', 'high'],
  },
  {
    id: 'openai/gpt-5.4',
    label: 'openai/gpt-5.4',
    defaultProvider: 'openrouter',
    upstreamProvider: 'openai',
    defaultApi: 'chat-completions',
    model: 'openai/gpt-5.4',
    baseUrl: openRouterBaseUrl,
    effortOptions: ['low', 'medium', 'high'],
  },
  {
    id: 'openai/gpt-5.5',
    label: 'openai/gpt-5.5',
    defaultProvider: 'openrouter',
    upstreamProvider: 'openai',
    defaultApi: 'chat-completions',
    model: 'openai/gpt-5.5',
    baseUrl: openRouterBaseUrl,
    effortOptions: ['none', 'low', 'medium', 'high', 'xhigh'],
  },
  {
    id: 'anthropic/claude-opus-4.7-fast',
    label: 'anthropic/claude-opus-4.7-fast',
    defaultProvider: 'openrouter',
    upstreamProvider: 'anthropic',
    defaultApi: 'chat-completions',
    model: 'anthropic/claude-opus-4.7-fast',
    baseUrl: openRouterBaseUrl,
    effortOptions: ['low', 'medium', 'high'],
  },
  {
    id: 'anthropic/claude-sonnet-4.6',
    label: 'anthropic/claude-sonnet-4.6',
    defaultProvider: 'openrouter',
    upstreamProvider: 'anthropic',
    defaultApi: 'chat-completions',
    model: 'anthropic/claude-sonnet-4.6',
    baseUrl: openRouterBaseUrl,
    effortOptions: ['low', 'medium', 'high'],
  },
  {
    id: 'aicodemirror/gpt-5.4',
    label: 'aicodemirror/gpt-5.4',
    defaultProvider: 'aicodemirror',
    upstreamProvider: 'aicodemirror',
    defaultApi: 'responses',
    model: 'gpt-5.4',
    baseUrl: aiCodeMirrorBaseUrl,
    effortOptions: ['low', 'medium', 'high'],
  },
  {
    id: 'aicodemirror/gpt-5.5',
    label: 'aicodemirror/gpt-5.5',
    defaultProvider: 'aicodemirror',
    upstreamProvider: 'aicodemirror',
    defaultApi: 'responses',
    model: 'gpt-5.5',
    baseUrl: aiCodeMirrorBaseUrl,
    effortOptions: ['none', 'low', 'medium', 'high', 'xhigh'],
  },
];

function configToForm(config: ReturnType<typeof getKrakenConfig>): ConfigFormValues {
  const selectedModel = getSelectedModelOption(config);
  return {
    modelSelection: selectedModel.option.id,
    modelProvider: config.model.provider,
    modelBaseUrl: selectedModel.matched ? config.model.baseUrl : selectedModel.option.baseUrl,
    modelName: config.model.name,
    openrouterApiKey: getProviderApiKeyForForm(config, 'openrouter'),
    openaiApiKey: getProviderApiKeyForForm(config, 'openai'),
    anthropicApiKey: getProviderApiKeyForForm(config, 'anthropic'),
    qwenApiKey: getProviderApiKeyForForm(config, 'qwen'),
    aicodemirrorApiKey: getProviderApiKeyForForm(config, 'aicodemirror'),
    modelProxy: config.model.proxy ?? '',
    modelReasoningEnabled: config.model.reasoning.enabled,
    modelReasoningEffort: config.model.reasoning.effort,
    modelReasoningDisplay: config.model.reasoning.display,
    modelReasoningBudgetTokens: config.model.reasoning.budgetTokens,
    modelReasoningPreserve: config.model.reasoning.preserve,
    modelReasoningMaxStoredTokens: config.model.reasoning.maxStoredTokens,
    modelCacheEnabled: config.model.cache.enabled,
    modelCacheRetention: config.model.cache.retention,
    openaiApi: config.providers.openai.api,
    openaiEffort: config.providers.openai.effort,
    openaiPromptCacheKey: config.providers.openai.promptCacheKey,
    openaiPromptCacheRetention: config.providers.openai.promptCacheRetention,
    anthropicThinking: config.providers.anthropic.thinking,
    anthropicEffort: config.providers.anthropic.effort,
    anthropicThinkingBudgetTokens: config.providers.anthropic.thinkingBudgetTokens,
    anthropicMaxTokens: config.providers.anthropic.maxTokens,
    anthropicPreserveThinking: config.providers.anthropic.preserveThinking,
    anthropicCacheTtl: config.providers.anthropic.cacheTtl,
    qwenEnableThinking: config.providers.qwen.enableThinking,
    qwenThinkingBudget: config.providers.qwen.thinkingBudget,
    qwenPreserveThinking: config.providers.qwen.preserveThinking,
    contextMaxChars: config.context.maxChars,
    agentBrowserBin: config.agent.browserBin,
    agentBrowserMaxOutput: config.agent.browserMaxOutput,
    agentBrowserDefaultTimeout: config.agent.browserDefaultTimeout,
    agentMaxSteps: config.agent.maxSteps,
    agentBrowserAllowedDomains: config.agent.browserAllowedDomains ?? '',
    skillsDir: config.skills.dir ?? '',
    lspAdapter: config.lsp.adapter,
    lspMaxResults: config.lsp.maxResults,
    lspHoverMaxChars: config.lsp.hoverMaxChars,
    lspTimeoutMs: config.lsp.timeoutMs,
    memoryEnabled: config.memory.enabled,
    memoryAutoRead: config.memory.autoRead,
    memoryMaxChars: config.memory.maxChars,
    memoryAllowWrite: config.memory.allowWrite,
    episodesEnabled: config.episodes.enabled,
    episodesAutoCapture: config.episodes.autoCapture,
    episodesAutoRecall: config.episodes.autoRecall,
    episodesMaxRecalled: config.episodes.maxRecalled,
    episodesMaxChars: config.episodes.maxChars,
    episodesStoreTranscript: config.episodes.storeTranscript,
    sessionsEnabled: config.sessions.enabled,
  };
}

function formToConfig(values: Record<string, unknown>): KrakenFileConfig {
  const selectedModel = resolveSupportedModel(stringValue(values.modelSelection, ''));
  const selectedProvider = resolveProviderOption(stringValue(values.modelProvider, selectedModel.defaultProvider));
  return {
    model: {
      baseUrl: normalizeBaseUrl(stringValue(values.modelBaseUrl, selectedProvider.baseUrl)),
      provider: selectedProvider.id,
      api: selectedProvider.api,
      name: selectedModel.model,
      proxy: stringValue(values.modelProxy, ''),
      reasoning: {
        enabled: booleanValue(values.modelReasoningEnabled),
        effort: enumValue<ModelReasoningEffort>(
          values.modelReasoningEffort,
          ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
          'medium'
        ),
        display: enumValue<ModelReasoningDisplay>(
          values.modelReasoningDisplay,
          ['hidden', 'summary', 'visible'],
          'hidden'
        ),
        budgetTokens: Math.max(0, Math.floor(numberValue(values.modelReasoningBudgetTokens, 0))),
        preserve: booleanValue(values.modelReasoningPreserve),
        maxStoredTokens: Math.max(0, Math.floor(numberValue(values.modelReasoningMaxStoredTokens, 4096))),
      },
      cache: {
        enabled: booleanValue(values.modelCacheEnabled),
        strategy: booleanValue(values.modelCacheEnabled) ? 'auto' : 'disabled',
        retention: stringValue(values.modelCacheRetention, 'in_memory'),
      },
    },
    providers: {
      openrouter: {
        apiKey: stringValue(values.openrouterApiKey, ''),
      },
      openai: {
        apiKey: stringValue(values.openaiApiKey, ''),
        api: enumValue<'responses' | 'chat-completions'>(
          values.openaiApi,
          ['responses', 'chat-completions'],
          'responses'
        ),
        effort: enumValue<ModelReasoningEffort>(
          values.openaiEffort,
          ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
          'medium'
        ),
        promptCacheKey: stringValue(values.openaiPromptCacheKey, 'workspace'),
        promptCacheRetention: stringValue(values.openaiPromptCacheRetention, 'in_memory'),
      },
      anthropic: {
        apiKey: stringValue(values.anthropicApiKey, ''),
        api: 'messages',
        thinking: enumValue<'auto' | 'adaptive' | 'enabled' | 'disabled'>(
          values.anthropicThinking,
          ['auto', 'adaptive', 'enabled', 'disabled'],
          'adaptive'
        ),
        effort: enumValue<ModelReasoningEffort>(
          values.anthropicEffort,
          ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
          'medium'
        ),
        thinkingBudgetTokens: Math.max(0, Math.floor(numberValue(values.anthropicThinkingBudgetTokens, 16000))),
        maxTokens: Math.max(1, Math.floor(numberValue(values.anthropicMaxTokens, 32000))),
        preserveThinking: booleanValue(values.anthropicPreserveThinking),
        cacheTtl: enumValue<'5m' | '1h'>(values.anthropicCacheTtl, ['5m', '1h'], '5m'),
      },
      qwen: {
        apiKey: stringValue(values.qwenApiKey, ''),
        api: 'chat-completions',
        enableThinking: booleanValue(values.qwenEnableThinking),
        thinkingBudget: Math.max(0, Math.floor(numberValue(values.qwenThinkingBudget, 8192))),
        preserveThinking: booleanValue(values.qwenPreserveThinking),
        cacheMode: 'auto',
      },
      aicodemirror: {
        apiKey: stringValue(values.aicodemirrorApiKey, ''),
      },
    },
    context: {
      maxChars: numberValue(values.contextMaxChars, 60000),
    },
    agent: {
      browserBin: stringValue(values.agentBrowserBin, 'agent-browser'),
      browserMaxOutput: numberValue(values.agentBrowserMaxOutput, 50000),
      browserDefaultTimeout: numberValue(values.agentBrowserDefaultTimeout, 25000),
      maxSteps: numberValue(values.agentMaxSteps, 8),
      browserAllowedDomains: parseDomainList(values.agentBrowserAllowedDomains),
    },
    skills: {
      dir: stringValue(values.skillsDir, ''),
    },
    lsp: {
      adapter: stringValue(values.lspAdapter, 'auto'),
      maxResults: numberValue(values.lspMaxResults, 50),
      hoverMaxChars: numberValue(values.lspHoverMaxChars, 4000),
      timeoutMs: numberValue(values.lspTimeoutMs, 8000),
    },
    memory: {
      enabled: booleanValue(values.memoryEnabled),
      autoRead: booleanValue(values.memoryAutoRead),
      maxChars: numberValue(values.memoryMaxChars, 8000),
      allowWrite: booleanValue(values.memoryAllowWrite),
    },
    episodes: {
      enabled: booleanValue(values.episodesEnabled),
      autoCapture: booleanValue(values.episodesAutoCapture),
      autoRecall: booleanValue(values.episodesAutoRecall),
      maxRecalled: numberValue(values.episodesMaxRecalled, 3),
      maxChars: numberValue(values.episodesMaxChars, 12000),
      storeTranscript: booleanValue(values.episodesStoreTranscript),
    },
    sessions: {
      enabled: booleanValue(values.sessionsEnabled),
    },
  };
}

function getConfigHtml(webview: vscode.Webview, values: ConfigFormValues): string {
  const nonce = createNonce();
  const data = JSON.stringify(values).replace(/</g, '\\u003c');
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>Kraken Config</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      margin: 0;
      padding: 0;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    .page {
      max-width: 980px;
      margin: 0 auto;
      padding: 18px;
    }
    .topbar {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 18px;
      border-bottom: 1px solid var(--vscode-panel-border);
      padding-bottom: 12px;
    }
    h1 {
      flex: 1;
      margin: 0;
      font-size: 20px;
      font-weight: 600;
    }
    h2 {
      margin: 22px 0 10px;
      font-size: 14px;
      font-weight: 600;
      color: var(--vscode-foreground);
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 12px 14px;
    }
    label {
      display: grid;
      gap: 5px;
      min-width: 0;
    }
    .label {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }
    input[type="text"],
    input[type="password"],
    input[type="number"],
    select {
      width: 100%;
      min-height: 30px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      padding: 5px 7px;
      font: inherit;
    }
    .check {
      display: flex;
      align-items: center;
      gap: 8px;
      min-height: 30px;
      padding: 3px 0;
    }
    .check input {
      margin: 0;
    }
    button {
      border: 0;
      border-radius: 4px;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      padding: 6px 10px;
      font: inherit;
      cursor: pointer;
    }
    button.secondary {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
    }
    .status {
      min-height: 18px;
      margin-top: 12px;
      color: var(--vscode-descriptionForeground);
    }
    section[hidden] {
      display: none;
    }
  </style>
</head>
<body>
  <div class="page">
    <div class="topbar">
      <h1>Kraken Config</h1>
      <button class="secondary" id="openFile" type="button">Open TOML</button>
      <button id="save" type="button">Save</button>
    </div>
    <form id="form">
      ${section('Model', [
        select('modelSelection', 'Model', supportedModelOptions.map((option) => [option.id, option.label])),
        select('modelProvider', 'Request provider', providerOptions.map((option) => [option.id, option.label])),
        text('modelBaseUrl', 'Base URL'),
        text('modelProxy', 'HTTP proxy'),
      ])}
      ${section('Provider API Keys', [
        password('openrouterApiKey', 'OpenRouter API key'),
        password('openaiApiKey', 'OpenAI API key'),
        password('anthropicApiKey', 'Anthropic API key'),
        password('qwenApiKey', 'Qwen API key'),
        password('aicodemirrorApiKey', 'AICodeMirror API key'),
      ])}
      ${section('Reasoning / Thinking', [
        checkbox('modelReasoningEnabled', 'Enable reasoning'),
        select('modelReasoningEffort', 'Effort', effortOptions(values.modelReasoningEffort)),
        select('modelReasoningDisplay', 'Display', [
          ['hidden', 'Hidden'],
          ['summary', 'Summary'],
          ['visible', 'Visible'],
        ]),
        number('modelReasoningBudgetTokens', 'Budget tokens'),
        checkbox('modelReasoningPreserve', 'Preserve reasoning'),
        number('modelReasoningMaxStoredTokens', 'Max stored tokens'),
      ])}
      ${section('Cache Optimization', [
        checkbox('modelCacheEnabled', 'Enable provider cache optimization'),
        text('modelCacheRetention', 'OpenAI retention'),
      ])}
      ${section('GPT / OpenAI', [
        select('openaiApi', 'API', [
          ['responses', 'Responses'],
          ['chat-completions', 'Chat Completions'],
        ]),
        select('openaiEffort', 'Effort', effortOptions(values.openaiEffort)),
        text('openaiPromptCacheKey', 'Prompt cache key'),
        text('openaiPromptCacheRetention', 'Prompt cache retention'),
      ], 'openai')}
      ${section('Claude', [
        select('anthropicThinking', 'Thinking', [
          ['auto', 'Auto'],
          ['adaptive', 'Adaptive'],
          ['enabled', 'Enabled'],
          ['disabled', 'Disabled'],
        ]),
        select('anthropicEffort', 'Effort', effortOptions(values.anthropicEffort)),
        number('anthropicThinkingBudgetTokens', 'Thinking budget tokens'),
        number('anthropicMaxTokens', 'Max tokens'),
        checkbox('anthropicPreserveThinking', 'Preserve thinking'),
        select('anthropicCacheTtl', 'Cache TTL', [
          ['5m', '5m'],
          ['1h', '1h'],
        ]),
      ], 'anthropic')}
      ${section('Qwen', [
        checkbox('qwenEnableThinking', 'Enable thinking'),
        number('qwenThinkingBudget', 'Thinking budget'),
        checkbox('qwenPreserveThinking', 'Preserve thinking'),
      ], 'qwen')}
      ${section('Context', [
        number('contextMaxChars', 'Max context chars'),
      ])}
      ${section('Agent Tools', [
        text('agentBrowserBin', 'Browser tool executable'),
        number('agentBrowserMaxOutput', 'Browser max output chars'),
        number('agentBrowserDefaultTimeout', 'Browser timeout ms'),
        number('agentMaxSteps', 'Max agent steps'),
        text('agentBrowserAllowedDomains', 'Browser allowed domains'),
      ])}
      ${section('Skills', [
        text('skillsDir', 'Custom skills directory'),
      ])}
      ${section('LSP Tools', [
        text('lspAdapter', 'Adapter (auto, vscode, process)'),
        number('lspMaxResults', 'Max LSP results'),
        number('lspHoverMaxChars', 'Hover max chars'),
        number('lspTimeoutMs', 'LSP timeout ms'),
      ])}
      ${section('Memory', [
        checkbox('memoryEnabled', 'Enable memory'),
        checkbox('memoryAutoRead', 'Auto read memory'),
        number('memoryMaxChars', 'Memory max chars'),
        checkbox('memoryAllowWrite', 'Allow memory tool writes'),
      ])}
      ${section('Episodes', [
        checkbox('episodesEnabled', 'Enable episodes'),
        checkbox('episodesAutoCapture', 'Auto capture episodes'),
        checkbox('episodesAutoRecall', 'Auto recall episodes'),
        number('episodesMaxRecalled', 'Max recalled episodes'),
        number('episodesMaxChars', 'Episode max chars'),
        checkbox('episodesStoreTranscript', 'Store transcript'),
      ])}
      ${section('Sessions', [
        checkbox('sessionsEnabled', 'Enable session switcher storage'),
      ])}
    </form>
    <div class="status" id="status"></div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const initialValues = ${data};
    const modelProfiles = ${JSON.stringify(supportedModelOptions).replace(/</g, '\\u003c')};
    const providerOptions = ${JSON.stringify(providerOptions).replace(/</g, '\\u003c')};
    const statusEl = document.getElementById('status');
    let lastSelectedModelId = '';
    for (const [key, value] of Object.entries(initialValues)) {
      const input = document.querySelector('[name="' + key + '"]');
      if (!input) continue;
      if (input.type === 'checkbox') {
        input.checked = Boolean(value);
      } else {
        input.value = value ?? '';
      }
    }
    const modelSelect = document.querySelector('[name="modelSelection"]');
    const providerSelect = document.querySelector('[name="modelProvider"]');
    lastSelectedModelId = modelSelect?.value || modelProfiles[0]?.id || '';
    applySelectedModel(false, false);
    modelSelect?.addEventListener('change', () => {
      applySelectedModel(true, false);
    });
    providerSelect?.addEventListener('change', () => {
      applySelectedModel(false, true);
    });
    document.getElementById('save').addEventListener('click', () => {
      vscode.postMessage({ type: 'save', values: collectValues() });
    });
    document.getElementById('openFile').addEventListener('click', () => {
      vscode.postMessage({ type: 'openFile' });
    });
    window.addEventListener('message', (event) => {
      if (event.data?.type === 'saved') {
        statusEl.textContent = 'Saved: ' + event.data.path;
      }
      if (event.data?.type === 'error') {
        statusEl.textContent = event.data.message;
      }
    });
    function collectValues() {
      const values = {};
      for (const input of document.querySelectorAll('[name]')) {
        values[input.name] = input.type === 'checkbox' ? input.checked : input.value;
      }
      return values;
    }
    function applySelectedModel(updateBaseUrl, updateProviderDefaults) {
      const selected = modelProfiles.find((profile) => profile.id === modelSelect?.value) || modelProfiles[0];
      if (!selected) return;
      const baseUrlInput = document.querySelector('[name="modelBaseUrl"]');
      const provider = providerOptions.find((option) => option.id === providerSelect?.value)
        || providerOptions.find((option) => option.id === selected.defaultProvider)
        || providerOptions[0];
      const previous = modelProfiles.find((profile) => profile.id === lastSelectedModelId);
      if (providerSelect && (!providerSelect.value || updateBaseUrl)) {
        providerSelect.value = selected.defaultProvider;
      }
      const activeProvider = providerSelect
        ? providerOptions.find((option) => option.id === providerSelect.value) || provider
        : provider;
      if (
        (updateBaseUrl || updateProviderDefaults) &&
        baseUrlInput &&
        (
          !baseUrlInput.value
          || !previous
          || baseUrlInput.value === previous.baseUrl
          || providerOptions.some((option) => option.baseUrl === baseUrlInput.value)
        )
      ) {
        baseUrlInput.value = activeProvider.baseUrl;
      }
      const openaiApi = document.querySelector('[name="openaiApi"]');
      if (updateProviderDefaults && activeProvider.id === 'openai' && openaiApi) {
        openaiApi.value = activeProvider.api;
      }
      lastSelectedModelId = selected.id;
      syncEffortOptions(selected);
      const visibleProvider = selected.upstreamProvider || selected.defaultProvider;
      for (const section of document.querySelectorAll('[data-provider-section]')) {
        section.hidden = section.getAttribute('data-provider-section') !== visibleProvider;
      }
    }
    function syncEffortOptions(selected) {
      for (const name of ['modelReasoningEffort', 'openaiEffort', 'anthropicEffort']) {
        const select = document.querySelector('[name="' + name + '"]');
        if (!select) continue;
        const current = select.value;
        select.innerHTML = '';
        for (const effort of selected.effortOptions || ['low', 'medium', 'high']) {
          const option = document.createElement('option');
          option.value = effort;
          option.textContent = formatEffortLabel(effort);
          select.appendChild(option);
        }
        select.value = Array.from(select.options).some((option) => option.value === current)
          ? current
          : 'medium';
      }
    }
    function formatEffortLabel(effort) {
      if (effort === 'xhigh') return 'XHigh';
      return String(effort || '').slice(0, 1).toUpperCase() + String(effort || '').slice(1);
    }
  </script>
</body>
</html>`;
}

function section(title: string, controls: string[], provider?: SupportedModelOption['upstreamProvider']): string {
  const providerAttr = provider ? ` data-provider-section="${escapeHtml(provider)}"` : '';
  return `<section${providerAttr}><h2>${escapeHtml(title)}</h2><div class="grid">${controls.join('')}</div></section>`;
}

function text(name: keyof ConfigFormValues, label: string): string {
  return `<label><span class="label">${escapeHtml(label)}</span><input type="text" name="${name}"></label>`;
}

function password(name: keyof ConfigFormValues, label: string): string {
  return `<label><span class="label">${escapeHtml(label)}</span><input type="password" name="${name}"></label>`;
}

function number(name: keyof ConfigFormValues, label: string): string {
  return `<label><span class="label">${escapeHtml(label)}</span><input type="number" name="${name}"></label>`;
}

function select(name: keyof ConfigFormValues, label: string, options: Array<[string, string]>): string {
  const optionHtml = options
    .map(([value, title]) => `<option value="${escapeHtml(value)}">${escapeHtml(title)}</option>`)
    .join('');
  return `<label><span class="label">${escapeHtml(label)}</span><select name="${name}">${optionHtml}</select></label>`;
}

function checkbox(name: keyof ConfigFormValues, label: string): string {
  return `<label class="check"><input type="checkbox" name="${name}"><span>${escapeHtml(label)}</span></label>`;
}

function effortOptions(current: string): Array<[ModelReasoningEffort, string]> {
  const values: ModelReasoningEffort[] = ['low', 'medium', 'high'];
  if (isReasoningEffort(current) && !values.includes(current)) {
    values.unshift(current);
  }
  return values.map((value) => [value, effortLabel(value)]);
}

function effortLabel(value: ModelReasoningEffort): string {
  if (value === 'xhigh') {
    return 'XHigh';
  }
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function isReasoningEffort(value: string): value is ModelReasoningEffort {
  return ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value);
}

function getSelectedModelOption(config: ReturnType<typeof getKrakenConfig>): {
  option: SupportedModelOption;
  matched: boolean;
} {
  const matched = supportedModelOptions.find((option) =>
    option.defaultProvider === config.model.provider && option.model === config.model.name
  ) ?? supportedModelOptions.find((option) =>
    option.model === config.model.name || stripProviderPrefix(option.model) === config.model.name
  );
  if (matched) {
    return { option: matched, matched: true };
  }

  return { option: supportedModelOptions[0], matched: false };
}

function resolveSupportedModel(value: string): SupportedModelOption {
  return supportedModelOptions.find((option) => option.id === value) ?? supportedModelOptions[0];
}

function resolveProviderOption(value: string): ProviderOption {
  return providerOptions.find((option) => option.id === value) ?? providerOptions[0];
}

function getProviderApiKeyForForm(
  config: ReturnType<typeof getKrakenConfig>,
  provider: ManagedProvider
): string {
  const configured = config.providers[provider].apiKey;
  if (configured) {
    return configured;
  }
  return config.model.provider === provider ? config.model.apiKey : '';
}

function buildProviderApiKeyPatch(provider: ModelProvider, apiKey: string): KrakenFileConfig {
  switch (provider) {
    case 'openrouter':
      return { providers: { openrouter: { apiKey } } };
    case 'openai':
      return { providers: { openai: { apiKey } } };
    case 'anthropic':
      return { providers: { anthropic: { apiKey } } };
    case 'qwen':
      return { providers: { qwen: { apiKey } } };
    case 'aicodemirror':
      return { providers: { aicodemirror: { apiKey } } };
    case 'openai-compatible':
    default:
      return { model: { apiKey } };
  }
}

function getProviderLabel(provider: ModelProvider): string {
  switch (provider) {
    case 'openrouter':
      return 'OpenRouter';
    case 'openai':
      return 'OpenAI';
    case 'anthropic':
      return 'Anthropic';
    case 'qwen':
      return 'Qwen';
    case 'aicodemirror':
      return 'AICodeMirror';
    case 'openai-compatible':
    default:
      return 'provider';
  }
}

function stripProviderPrefix(value: string): string {
  return value.includes('/') ? value.split('/').at(-1) ?? value : value;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value.trim() : fallback;
}

function numberValue(value: unknown, fallback: number): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function booleanValue(value: unknown): boolean {
  return value === true || value === 'true';
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  const normalized = stringValue(value, fallback).toLowerCase();
  return allowed.includes(normalized as T) ? normalized as T : fallback;
}

function parseDomainList(value: unknown): string[] {
  return parseCommaList(value);
}

function parseCommaList(value: unknown): string[] {
  return stringValue(value, '').split(',').map((item) => item.trim()).filter(Boolean);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

function createNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i += 1) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
